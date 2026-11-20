import Darwin
import Foundation
import JavaScriptCore

final class NativeReadingStore {
  struct Scope {
    let root: URL
    let file: URL
    let document: String
  }

  private struct Revision: Equatable {
    let device: dev_t, inode: ino_t, size: off_t
    let modified: Int, modifiedNS: Int, changed: Int, changedNS: Int
    init(_ value: stat) {
      device = value.st_dev; inode = value.st_ino; size = value.st_size
      modified = value.st_mtimespec.tv_sec; modifiedNS = value.st_mtimespec.tv_nsec
      changed = value.st_ctimespec.tv_sec; changedNS = value.st_ctimespec.tv_nsec
    }
  }

  private struct Snapshot {
    var revision: Revision
    var offset: Int
    let entries: JSValue
    var indexed = false
  }

  private let queue = DispatchQueue(label: "org.omarkie.reading-store")
  private let script: URL
  private var core: JSValue?
  private var snapshot: (root: URL, state: Snapshot)?
  private lazy var timestamp: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
  private static let unsafe = "阅读数据路径不安全。"
  private static let damaged = "阅读记录损坏，未更改原文件。"
  private static let invalid = "阅读图层数据无效。"

  init(_ script: URL) { self.script = script }

  static func scope(_ store: DocumentStore, _ id: String) throws -> Scope {
    guard let path = try store.require(id).path, let folder = store.folder else {
      throw NativeFailure("请先打开文件夹并保存文档。")
    }
    let root = canonicalFileURL(folder), file = URL(fileURLWithPath: path).standardizedFileURL
    guard contained(root, file) else { throw NativeFailure(unsafe) }
    return Scope(root: root, file: file, document: String(file.path.dropFirst(root.path.count + 1)))
  }

  func perform(_ scope: Scope, _ request: [String: Any], current: @escaping () -> Bool = { true }) async throws -> Any {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        continuation.resume(with: Result { try self.operate(scope, request, current) })
      }
    }
  }

  private func logic() throws -> JSValue {
    if let core { return core }
    guard let context = JSContext() else { throw NativeFailure(Self.invalid) }
    let source = try String(contentsOf: script, encoding: .utf8)
    let digest: @convention(block) (String) -> String = { hashData(Data($0.utf8)) }
    context.setObject(digest, forKeyedSubscript: "digest" as NSString)
    guard let result = context.evaluateScript("var module = {};\n" + source + "\nmodule.exports(digest);"),
          result.isObject, context.exception == nil else { throw NativeFailure(Self.invalid) }
    core = result
    return result
  }

  private func call(_ name: String, _ args: [Any], error: String = NativeReadingStore.invalid) throws -> JSValue {
    let core = try logic()
    core.context.exception = nil
    guard let value = core.invokeMethod(name, withArguments: args), core.context.exception == nil else { throw NativeFailure(error) }
    return value
  }

  private static func regular(_ metadata: stat) -> Bool {
    (metadata.st_mode & S_IFMT) == S_IFREG && metadata.st_nlink == 1
  }

  private static func revision(_ descriptor: Int32) throws -> Revision {
    var metadata = stat()
    guard fstat(descriptor, &metadata) == 0, regular(metadata) else { throw NativeFailure(unsafe) }
    return Revision(metadata)
  }

  private static func indexExists(_ directory: Int32) throws -> Bool {
    var metadata = stat()
    if fstatat(directory, "index.json", &metadata, AT_SYMLINK_NOFOLLOW) == 0 {
      guard regular(metadata) else { throw NativeFailure(unsafe) }
      return true
    }
    guard errno == ENOENT else { throw NativeFailure(unsafe) }
    return false
  }

  private func writeIndex(_ directory: Int32, _ state: Snapshot) throws {
    let entries = try call("allEntries", [state.entries]).toArray() ?? []
    var bytes = try JSONSerialization.data(withJSONObject: ["v": 1, "bytes": state.offset, "entries": entries])
    bytes.append(10)
    let temporary = ".index.\(UUID().uuidString).tmp"
    let descriptor = openat(directory, temporary, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { throw NativeFailure(Self.unsafe) }
    let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? file.close(); _ = unlinkat(directory, temporary, 0) }
    try file.write(contentsOf: bytes)
    try file.synchronize()
    _ = try Self.indexExists(directory)
    guard renameat(directory, temporary, directory, "index.json") == 0 else { throw NativeFailure(Self.unsafe) }
  }

  private func operate(_ scope: Scope, _ incoming: [String: Any], _ current: () -> Bool) throws -> Any {
    let exporting = incoming["action"] as? String == "export"
    let request = exporting ? ["action": "list", "scope": "vault", "types": ["note", "card"]] : incoming
    let validated = try call("validate", [request])
    let item = validated.forProperty("item")!
    let writing = !item.isUndefined
    let empty: Any = exporting ? "\n" : [] as [[String: Any]]
    var source = stat()
    guard current(), canonicalFileURL(scope.root).path == scope.root.path, canonicalFileURL(scope.file).path == scope.file.path,
          lstat(scope.file.path, &source) == 0, (source.st_mode & S_IFMT) == S_IFREG else { throw NativeFailure(Self.unsafe) }
    let root = open(scope.root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard root >= 0 else { throw NativeFailure(Self.unsafe) }
    defer { _ = close(root) }
    if writing, mkdirat(root, ".omarkie", 0o700) != 0, errno != EEXIST { throw NativeFailure(Self.unsafe) }
    let directory = openat(root, ".omarkie", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    if directory < 0, !writing, errno == ENOENT { return empty }
    guard directory >= 0 else { throw NativeFailure(Self.unsafe) }
    defer { _ = close(directory) }
    let hasIndex = try Self.indexExists(directory)
    let flags = writing ? O_RDWR | O_APPEND | O_CREAT : O_RDONLY
    let descriptor = openat(directory, "store.jsonl", flags | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
    if descriptor < 0, !writing, errno == ENOENT { return empty }
    guard descriptor >= 0 else { throw NativeFailure(Self.unsafe) }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    let revision = try Self.revision(descriptor)
    var state: Snapshot
    if let snapshot, snapshot.root == scope.root, snapshot.state.revision == revision {
      state = snapshot.state
    } else {
      let bytes = try handle.readToEnd() ?? Data(), end = bytes.lastIndex(of: 10).map { $0 + 1 } ?? 0
      guard try Self.revision(descriptor) == revision else { throw NativeFailure(Self.unsafe) }
      guard let committed = String(bytes: bytes.prefix(end), encoding: .utf8) else { throw NativeFailure(Self.damaged) }
      state = Snapshot(revision: revision, offset: end, entries: try call("readJournal", [committed], error: Self.damaged))
    }
    var entry: [String: Any]?
    if writing {
      guard var value = item.toDictionary() as? [String: Any] else { throw NativeFailure(Self.invalid) }
      value["document"] = scope.document; value["at"] = timestamp.string(from: Date())
      var bytes = try JSONSerialization.data(withJSONObject: ["v": 1, "entry": value])
      bytes.append(10)
      guard current(), try Self.revision(descriptor) == revision else { throw NativeFailure(Self.unsafe) }
      if revision.size != state.offset { try handle.truncate(atOffset: UInt64(state.offset)) }
      try handle.write(contentsOf: bytes)
      try handle.synchronize()
      state.revision = try Self.revision(descriptor)
      state.offset += bytes.count
      try call("indexEntry", [state.entries, value])
      state.indexed = false
      entry = value
    }
    if !state.indexed || !hasIndex {
      // The journal commit remains valid if the derived cache cannot be written.
      do { try writeIndex(directory, state); state.indexed = true } catch {}
    }
    snapshot = (scope.root, state)
    if let entry { return entry }
    let result = try call("query", [state.entries, scope.document, validated])
    if exporting { return try call("readingMarkdown", [result]).toString() ?? "\n" }
    return result.toArray() ?? []
  }

  static func export(_ markdown: String, _ at: URL) throws {
    let fd = open(at.path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw NativeFailure("无法导出。请选择新的文件名。") }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    defer { try? handle.close() }
    try handle.write(contentsOf: Data(markdown.utf8))
    try handle.synchronize()
  }
}
