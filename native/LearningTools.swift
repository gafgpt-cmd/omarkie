import CoreFoundation
import Darwin
import Foundation

final class NativePayload {
  private struct Endpoint {
    let url: URL
    let origin: String
    let local: Bool

    init?(_ input: Any?) {
      guard let value = input as? String, value.utf16.count <= 2048 else { return nil }
      let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
      guard raw.range(of: #"^https?://"#, options: [.regularExpression, .caseInsensitive]) != nil,
            raw.range(of: #"[\s?#\\]"#, options: .regularExpression) == nil,
            var parts = URLComponents(string: raw), let scheme = parts.scheme?.lowercased(),
            let host = parts.url?.host?.lowercased(), !host.isEmpty,
            parts.user == nil, parts.password == nil else { return nil }
      local = ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)
      guard local || scheme == "https" else { return nil }
      if let port = parts.port {
        guard (0...65535).contains(port) else { return nil }
        if (scheme == "https" && port == 443) || (scheme == "http" && port == 80) { parts.port = nil }
      }
      parts.scheme = scheme
      parts.percentEncodedPath = parts.percentEncodedPath.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression) + "/chat/completions"
      guard let url = parts.url else { return nil }
      let hostForOrigin = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
      origin = "\(scheme)://\(hostForOrigin)" + (parts.port.map { ":\($0)" } ?? "")
      self.url = url
    }
  }

  private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
      completionHandler(nil)
    }
  }

  private struct Recipe: Decodable { let summary: String; let followUp: String }
  private let recipeURL: URL
  private var recipe: Recipe?
  private var credential: (origin: String, value: String)?
  private var pending = false

  init(_ recipeURL: URL) { self.recipeURL = recipeURL }

  @MainActor func setKey(_ baseURL: Any?, _ input: Any?) throws {
    if (input as? String) == "" { credential = nil; return }
    guard let endpoint = Endpoint(baseURL), let value = input as? String,
          (1...2048).contains(value.utf8.count), value.utf8.allSatisfy({ (33...126).contains($0) }) else {
      throw NativeFailure("Invalid Payload endpoint or API key.")
    }
    credential = (endpoint.origin, value)
  }

  @MainActor func request(_ input: [String: Any]) async throws -> String {
    guard let endpoint = Endpoint(input["baseUrl"]), (input["confirmedOrigin"] as? String) == endpoint.origin,
          endpoint.local || (input["allowedOrigin"] as? String) == endpoint.origin,
          let model = input["model"] as? String, model.utf16.count <= 256,
          !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw NativeFailure("Configure and allow the Payload endpoint in Preferences.")
    }
    let question = input["question"] as? String
    guard let source = input["source"] as? String, source.utf8.count <= 24_000,
          !source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          input["question"] == nil || question.map({ $0.utf16.count <= 1000 && !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) == true else {
      throw NativeFailure("Use non-empty text up to 24 KB and a question up to 1,000 characters.")
    }
    guard !pending else { throw NativeFailure("Wait for the current Payload request to finish.") }
    pending = true
    defer { pending = false }
    let failure = NativeFailure("Payload failed. Check the endpoint, model, and API key.")
    do {
      let recipe = try self.recipe ?? JSONDecoder().decode(Recipe.self, from: Data(contentsOf: recipeURL))
      self.recipe = recipe
      var messages = [["role": "system", "content": question == nil ? recipe.summary : recipe.summary + "\n" + recipe.followUp], ["role": "user", "content": source]]
      if let question { messages.append(["role": "user", "content": question]) }
      let limit = (input["modernLimit"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } == true ? "max_completion_tokens" : "max_tokens"
      var request = URLRequest(url: endpoint.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 45)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      if let credential, credential.origin == endpoint.origin { request.setValue("Bearer " + credential.value, forHTTPHeaderField: "Authorization") }
      request.httpBody = try JSONSerialization.data(withJSONObject: ["model": model.trimmingCharacters(in: .whitespacesAndNewlines), "messages": messages, "stream": false, limit: question == nil ? 768 : 384])
      let configuration = URLSessionConfiguration.ephemeral
      configuration.httpShouldSetCookies = false
      configuration.httpCookieStorage = nil
      configuration.urlCredentialStorage = nil
      configuration.timeoutIntervalForResource = 45
      let session = URLSession(configuration: configuration)
      defer { session.invalidateAndCancel() }
      let (bytes, response) = try await session.bytes(for: request, delegate: NoRedirect())
      guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status), response.expectedContentLength <= 64_000 else { throw failure }
      var data = Data()
      if response.expectedContentLength > 0 { data.reserveCapacity(Int(response.expectedContentLength)) }
      for try await byte in bytes {
        guard data.count < 64_000 else { throw failure }
        data.append(byte)
      }
      guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let choices = object["choices"] as? [[String: Any]], let message = choices.first?["message"] as? [String: Any],
            let content = (message["content"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !content.isEmpty else { throw failure }
      return content
    } catch { throw failure }
  }
}

enum NativeClean {
  private static let passes = "1,2,3,4,5,6,7"

  static func run(_ body: String, environment: [String: String] = ProcessInfo.processInfo.environment) throws -> String? {
    guard body.utf8.count <= DocumentStore.maxBytes else { throw NativeFailure("文件内容无效或超过 20 MB。") }
    guard let configured = environment["OMARKIE_CLEAN_SCRIPT"], !configured.isEmpty else { return nil }
    let argv = configured.hasPrefix("[") ? (try? JSONDecoder().decode([String].self, from: Data(configured.utf8))) : [configured]
    guard let argv, let command = argv.first, argv.allSatisfy({ !$0.isEmpty && !$0.contains("\0") }) else { throw NativeFailure("清理脚本设置无效。") }
    let fm = FileManager.default
    let failure = NativeFailure("清理脚本失败。文档未更改。")
    let candidate = command.contains("/") ? command : (environment["PATH"] ?? "").components(separatedBy: ":").lazy.map {
      URL(fileURLWithPath: $0.isEmpty ? fm.currentDirectoryPath : $0).appendingPathComponent(command).path
    }.first(where: fm.isExecutableFile(atPath:))
    guard let candidate else { throw failure }
    let directory = fm.temporaryDirectory.appendingPathComponent("omarkie-clean-" + UUID().uuidString)
    do {
      try fm.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
      defer { try? fm.removeItem(at: directory) }
      let source = directory.appendingPathComponent("source.md"), report = directory.appendingPathComponent("report.json")
      try atomicWrite(source, Data(body.utf8))
      let process = Process()
      process.executableURL = URL(fileURLWithPath: candidate)
      process.arguments = Array(argv.dropFirst()) + [source.path, "--passes", passes, "--report", report.path]
      process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
      let finished = DispatchSemaphore(value: 0)
      process.terminationHandler = { _ in finished.signal() }
      try process.run()
      if finished.wait(timeout: .now() + 120) == .timedOut {
        if process.isRunning { _ = Darwin.kill(process.processIdentifier, SIGKILL) }
        process.waitUntilExit()
        throw failure
      }
      guard process.terminationStatus == 0,
            let batch = try JSONSerialization.jsonObject(with: readRegular(report)) as? [[String: Any]],
            let statuses = batch.first?["passes"] as? [String: [String: Any]],
            (1...7).allSatisfy({ statuses["p0\($0)"]?["status"] as? String == "ok" }),
            let output = try String(data: readRegular(source), encoding: .utf8),
            !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw failure }
      return output
    } catch { throw failure }
  }

  private static func readRegular(_ url: URL) throws -> Data {
    let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard descriptor >= 0 else { throw NativeFailure("清理脚本失败。文档未更改。") }
    let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? file.close() }
    var metadata = stat()
    guard fstat(descriptor, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG,
          metadata.st_size <= DocumentStore.maxBytes, let bytes = try file.read(upToCount: DocumentStore.maxBytes + 1),
          bytes.count <= DocumentStore.maxBytes else { throw NativeFailure("清理脚本失败。文档未更改。") }
    return bytes
  }
}
