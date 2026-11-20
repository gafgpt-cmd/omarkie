import Darwin
import Foundation

@MainActor final class NativeBibliographies {
  private struct State: Codable, Equatable {
    var raw = ""
    var source: String? = nil
  }
  private struct Reference {
    let id: String, title: String, authors: String, terms: String
    let attachments: [String]
  }
  private struct Vault {
    let file: URL
    var state: State
    var csl: String
    var entries: [Reference]
    var stale = false
    var revision: FileRevision?
  }
  private struct FileRevision: Equatable {
    let inode: ino_t, size: off_t, modified: Int, nanos: Int, changed: Int, changedNanos: Int
    init?(_ file: URL) {
      var value = stat()
      guard lstat(file.path, &value) == 0, (value.st_mode & S_IFMT) == S_IFREG else { return nil }
      inode = value.st_ino; size = value.st_size
      modified = value.st_mtimespec.tv_sec; nanos = value.st_mtimespec.tv_nsec
      changed = value.st_ctimespec.tv_sec; changedNanos = value.st_ctimespec.tv_nsec
    }
  }

  private let directory: URL
  private let changed: (String) -> Void
  private var vaults = [String: Vault]()
  private var timer: Timer?
  init(_ directory: URL, changed: @escaping (String) -> Void) {
    self.directory = canonicalFileURL(directory); self.changed = changed
  }
  deinit { timer?.invalidate() }

  nonisolated static func parse(_ text: String, allowEmpty: Bool = false) throws -> [[String: Any]] {
    guard text.utf8.count <= 2 * 1024 * 1024,
          let entries = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [[String: Any]],
          (allowEmpty || !entries.isEmpty), entries.count <= 5000 else { throw NativeFailure("CSL JSON 书目无效") }
    var ids = Set<String>()
    for entry in entries {
      guard let id = entry["id"] as? String,
            id.range(of: #"\A[A-Za-z0-9_.:+/-]{1,256}\z"#, options: .regularExpression) != nil,
            entry["type"] is String, ids.insert(id).inserted else { throw NativeFailure("CSL JSON 书目无效") }
    }
    return entries
  }

  private static func read(_ file: URL, max: Int, prefix: Bool = false) throws -> Data {
    guard canonicalFileURL(file).path == file.path else { throw NativeFailure("文件不是普通文件") }
    let descriptor = open(file.path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    var metadata = stat()
    guard fstat(descriptor, &metadata) == 0, (metadata.st_mode & S_IFMT) == S_IFREG else { throw NativeFailure("文件不是普通文件") }
    guard prefix || metadata.st_size <= max else { throw NativeFailure("书目超过 2 MB") }
    let bytes = try handle.read(upToCount: prefix ? max : Int(metadata.st_size) + 1) ?? Data()
    guard prefix || bytes.count == metadata.st_size else { throw NativeFailure("CSL JSON 书目无效") }
    return bytes
  }

  private static func sourceURL(_ path: String) -> URL? {
    guard path.hasPrefix("/"), !path.hasPrefix("//"), path.utf8.count <= 4096, !path.contains("\0") else { return nil }
    let file = URL(fileURLWithPath: path)
    return file.pathExtension.lowercased() == "json" ? file : nil
  }

  private static func sourceText(_ path: String) throws -> String {
    guard let file = sourceURL(path), let text = try String(data: read(file, max: 2 * 1024 * 1024), encoding: .utf8) else {
      throw NativeFailure("CSL JSON 书目无效")
    }
    return text
  }

  private static func make(_ state: State, file: URL, revision: FileRevision? = nil) throws -> Vault {
    let items = state.raw.isEmpty ? [] : try parse(state.raw, allowEmpty: true)
    let csl = items.isEmpty ? "" : String(decoding: try JSONSerialization.data(withJSONObject: items.map { entry in
      entry.filter { $0.key != "omarkie-pdf" }
    }, options: [.withoutEscapingSlashes]), as: UTF8.self)
    let entries = items.compactMap { item -> Reference? in
      guard let id = item["id"] as? String else { return nil }
      let title = String((item["title"] as? String ?? "").prefix(300))
      let authors = String(((item["author"] as? [[String: Any]]) ?? []).prefix(5).compactMap { ($0["family"] ?? $0["literal"]) as? String }.joined(separator: ", ").prefix(160))
      let attachments = state.source == nil ? [] : Array((item["omarkie-pdf"] as? [String] ?? []).prefix(16))
      return Reference(id: id, title: title, authors: authors, terms: "\(id) \(title) \(authors)".lowercased(), attachments: attachments)
    }
    return Vault(file: file, state: state, csl: csl, entries: entries, revision: revision)
  }

  private func load(_ root: String) throws -> Vault {
    if let vault = vaults[root] { return vault }
    let file = directory.appendingPathComponent("bibliographies/" + hashData(Data(root.utf8)) + ".json")
    let state: State
    do { state = try JSONDecoder().decode(State.self, from: Self.read(file, max: 6 * 1024 * 1024)) }
    catch let error as NSError where error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT) { state = State() }
    catch { throw NativeFailure("CSL JSON 书目无效") }
    if let source = state.source, Self.sourceURL(source) == nil { throw NativeFailure("CSL JSON 书目无效") }
    let vault = try Self.make(state, file: file)
    vaults[root] = vault
    if state.source != nil { refresh(root, forced: true); updateTimer() }
    return vaults[root] ?? vault
  }

  private func save(_ state: State, root: String, file: URL, revision: FileRevision? = nil) throws {
    let vault = try Self.make(state, file: file, revision: revision)
    guard canonicalFileURL(file.deletingLastPathComponent()).path == file.deletingLastPathComponent().path else { throw NativeFailure("CSL JSON 书目无效") }
    try atomicWrite(file, JSONEncoder().encode(state))
    vaults[root] = vault
    updateTimer()
    changed(root)
  }

  private func updateTimer() {
    if !vaults.values.contains(where: { $0.state.source != nil }) { timer?.invalidate(); timer = nil; return }
    if timer == nil {
      timer = Timer.scheduledTimer(withTimeInterval: 0.75, repeats: true) { [weak self] _ in
        Task { @MainActor in
          guard let self else { return }
          for root in Array(self.vaults.keys) { self.refresh(root) }
        }
      }
    }
  }

  private func refresh(_ root: String, forced: Bool = false) {
    guard var vault = vaults[root], let source = vault.state.source else { return }
    let revision = FileRevision(URL(fileURLWithPath: source))
    guard forced || vault.revision != revision else { return }
    do {
      let raw = try Self.sourceText(source)
      if raw != vault.state.raw { try save(State(raw: raw, source: source), root: root, file: vault.file, revision: revision) }
      else {
        let notify = vault.stale
        vault.stale = false; vault.revision = revision; vaults[root] = vault
        if notify { changed(root) }
      }
    } catch {
      let notify = !vault.stale
      vault.stale = true; vault.revision = revision; vaults[root] = vault
      if notify { changed(root) }
    }
  }

  func release(except roots: Set<String>) {
    vaults = vaults.filter { roots.contains($0.key) }
    updateTimer()
  }

  func perform(_ root: String, _ action: String, _ value: String? = nil) throws -> Any? {
    let vault = try load(root)
    switch action {
    case "info":
      return ["csl": vault.csl, "source": vault.state.source.map { URL(fileURLWithPath: $0).lastPathComponent as Any } ?? NSNull(), "stale": vault.stale]
    case "save":
      guard let value else { throw NativeFailure("CSL JSON 书目无效") }
      _ = try Self.parse(value)
      try save(State(raw: value), root: root, file: vault.file)
    case "link":
      guard let value else { return false }
      guard let selected = Self.sourceURL(value) else { throw NativeFailure("CSL JSON 书目无效") }
      let source = canonicalFileURL(selected)
      try save(State(raw: try Self.sourceText(source.path), source: source.path), root: root, file: vault.file, revision: FileRevision(source))
      return true
    case "disconnect": try save(State(raw: vault.state.raw), root: root, file: vault.file)
    case "clear": try save(State(), root: root, file: vault.file)
    case "suggest":
      guard let value, value.range(of: #"\A[A-Za-z0-9_.:+/-]{0,256}\z"#, options: .regularExpression) != nil else { return [] as [[String: String]] }
      let term = value.lowercased()
      var first = [Reference](), rest = [Reference]()
      for entry in vault.entries {
        if entry.id.lowercased().hasPrefix(term) { first.append(entry); if first.count == 8 { break } }
        else if rest.count < 8, entry.terms.contains(term) { rest.append(entry) }
      }
      return (first + rest).prefix(8).map { ["id": $0.id, "title": $0.title, "authors": $0.authors] }
    case "open":
      guard let entry = vault.entries.first(where: { $0.id == value }) else { throw NativeFailure("无法打开引用的本地 PDF") }
      for path in entry.attachments where path.hasPrefix("/") && !path.hasPrefix("//") && path.utf8.count <= 4096 && !path.contains("\0") {
        let file = canonicalFileURL(URL(fileURLWithPath: path))
        if file.pathExtension.lowercased() == "pdf", (try? Self.read(file, max: 5, prefix: true)) == Data("%PDF-".utf8) { return file.path }
      }
      throw NativeFailure("无法打开引用的本地 PDF")
    default: throw NativeFailure("CSL JSON 书目无效")
    }
    return nil
  }
}
