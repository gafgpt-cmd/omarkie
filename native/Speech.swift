import Darwin
import Foundation

enum NativeHook {
  static func arguments(_ configured: String) -> [String]? {
    let argv = configured.hasPrefix("[") ? (try? JSONDecoder().decode([String].self, from: Data(configured.utf8))) : [configured]
    guard let argv, !argv.isEmpty, argv.allSatisfy({ !$0.isEmpty && !$0.contains("\0") }) else { return nil }
    return argv
  }

  static func executable(_ command: String, environment: [String: String]) -> URL? {
    let fm = FileManager.default
    let candidate = command.contains("/") ? command : (environment["PATH"] ?? "").components(separatedBy: ":").lazy.map {
      URL(fileURLWithPath: $0.isEmpty ? fm.currentDirectoryPath : $0).appendingPathComponent(command).path
    }.first(where: fm.isExecutableFile(atPath:))
    return candidate.map { URL(fileURLWithPath: $0) }
  }
}

@MainActor final class NativeSpeech {
  private var process: Process?

  func stop() {
    if let process, process.isRunning { _ = Darwin.kill(process.processIdentifier, SIGKILL) }
    process = nil
  }

  func read(_ text: String?, environment: [String: String] = ProcessInfo.processInfo.environment) async throws {
    guard let text else { stop(); return }
    guard text.utf16.count <= 20_000 else { throw NativeFailure("朗读文字过长，请选择较短的段落。") }
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw NativeFailure("没有可朗读的文字。") }
    guard let configured = environment["OMARKIE_TTS"]?.trimmingCharacters(in: .whitespacesAndNewlines), !configured.isEmpty else {
      throw NativeFailure("未配置朗读：请设置 OMARKIE_TTS。")
    }
    guard let argv = NativeHook.arguments(configured) else { throw NativeFailure("朗读设置无效：请检查 OMARKIE_TTS。") }
    let launchError = NativeFailure("无法启动朗读程序：请检查 OMARKIE_TTS。")
    guard let binary = NativeHook.executable(argv[0], environment: environment) else { throw launchError }
    stop()
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("omarkie-speech-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("input")
    try atomicWrite(file, Data(text.utf8))
    let input = try FileHandle(forReadingFrom: file)
    defer { try? input.close() }
    let child = Process()
    child.executableURL = binary
    child.arguments = Array(argv.dropFirst())
    child.standardInput = input; child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
    process = child
    defer { if process === child { process = nil } }
    let status = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Int32, Error>) in
      child.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
      do { try child.run() } catch { continuation.resume(throwing: launchError) }
    }
    if process === child && status != 0 { throw NativeFailure("朗读程序未能完成播放。") }
  }
}
