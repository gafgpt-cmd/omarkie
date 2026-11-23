import CryptoKit
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
    let revision: Revision
    let offset: Int
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
  private static let invalid = "阅读图层数据无效。"

  init(_ script: URL) { self.script = script }

  static func recoverVault(_ root: URL) async -> Bool {
    let script = Bundle.main.resourceURL!.appendingPathComponent("reading-core.cjs")
    return await Task.detached {
      do { return try NativeReadingStore(script).transaction(root, writing: false) { _, _, warning in warning } }
      catch { NSLog("Reading journal recovery could not open the journal."); return true }
    }.value
  }

  #if WEBTEST
  var onContention: (() -> Void)?
  var beforeMoveCommit: (() -> Void)?
  var afterMoveIntent: (() -> Void)?
  #endif

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

  func moveEntries(_ folder: URL?, trash: (URL, String)? = nil, restoring: String? = nil,
                   execute: @escaping ((URL, URL) throws -> Void) throws -> [String: String]) async throws -> [String: String] {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        continuation.resume(with: Result {
          guard let folder else { return try execute(moveExclusive) }
          let root = canonicalFileURL(folder)
          return try self.transaction(root, writing: false) { state, append, _ in
              let offset = root.path.count + 1
              let relative = { (url: URL) in String(url.standardizedFileURL.path.dropFirst(offset)) }
              var detached: [String: String]?
              if let state, let (url, id) = trash, contained(root, url) {
                let file = relative(url)
                guard try self.call("validPath", [file]).toBool() else { throw NativeFailure(Self.invalid) }
                detached = ["path": file, "id": id]
                _ = try self.call("checkPending", [state.entries, file, true])
              }
              if let detached { try append(["trash": detached]) }
              do { return try execute { source, destination in
                if let state, let restoring, contained(root, destination), try self.call("hasTrash", [state.entries, restoring]).toBool() {
                  let file = relative(destination)
                  guard try self.call("validPath", [file]).toBool() else { throw NativeFailure(Self.invalid) }
                  _ = try self.call("checkPending", [state.entries, file, true])
                  try append(["restore": ["path": file, "id": restoring]])
                  do { try moveExclusive(source, destination) }
                  catch { try append(["trash": ["path": file, "id": restoring]]); throw error }
                  return
                }
                guard state != nil, contained(root, source), contained(root, destination) else {
                  try moveExclusive(source, destination); return
                }
                let from = relative(source), to = relative(destination)
                guard let state else { throw NativeFailure(Self.unsafe) }
                _ = try self.call("checkMove", [from, to])
                _ = try self.call("checkPending", [state.entries, from, true])
                _ = try self.call("checkPending", [state.entries, to, true])
                let files = try self.call("tracked", [state.entries, from]).toArray() as? [String] ?? []
                let destinationFiles = try self.call("tracked", [state.entries, to]).toArray() as? [String] ?? []
                let collisions = destinationFiles.filter { suffix in
                  let child = suffix.isEmpty ? source : source.appendingPathComponent(suffix)
                  var metadata = stat()
                  return lstat(child.path, &metadata) == 0 && metadata.st_mode & S_IFMT == S_IFREG && canonicalFileURL(child).path == child.path
                }
                let move = ["from": from, "to": to]
                guard var evidence = try Self.moveFingerprint(root, from, files, skipMissing: true) else { throw NativeFailure(Self.unsafe) }
                if evidence.files.isEmpty {
                  guard !collisions.isEmpty, let identity = try Self.moveFingerprint(root, from, []) else { try moveExclusive(source, destination); return }
                  evidence = identity
                }
                guard try self.call("pending", [state.entries]).isNull else { throw NativeFailure(Self.unsafe) }
                try append(["intent": ["from": from, "to": to, "fingerprint": evidence.fingerprint, "files": evidence.files, "collisions": collisions] as [String: Any]])
                do { try moveExclusive(source, destination) }
                catch { try? append(["cancel": true]); throw error }
                try? append(["move": move])
              } } catch {
                if let detached { try append(["restore": detached]) }
                throw error
              }
          }
        })
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

  private func call(_ name: String, _ args: [Any]) throws -> JSValue {
    let core = try logic()
    core.context.exception = nil
    let value = core.invokeMethod(name, withArguments: args)
    if let exception = core.context.exception {
      let code = exception.forProperty("code")?.toString()
      throw NativeFailure(exception.forProperty("message")?.toString() ?? Self.invalid, code == "LEARNING_ERROR" ? "LEARNING_ERROR" : "DOCUMENT_ERROR")
    }
    guard let value else { throw NativeFailure(Self.invalid) }
    return value
  }

  private static func regular(_ metadata: stat) -> Bool {
    (metadata.st_mode & S_IFMT) == S_IFREG && metadata.st_nlink == 1
  }

  private static func moveFingerprint(_ root: URL, _ prefix: String, _ files: [String], skipMissing: Bool = false) throws -> (fingerprint: String, files: [String])? {
    if files.isEmpty && !skipMissing {
      let target = root.appendingPathComponent(prefix)
      var metadata = stat()
      guard lstat(target.path, &metadata) == 0, canonicalFileURL(target).path == target.path,
            metadata.st_mode & S_IFMT == S_IFREG || metadata.st_mode & S_IFMT == S_IFDIR else { return nil }
      let identity = "\(UInt32(bitPattern: metadata.st_dev)):\(metadata.st_ino)"
      return ("0:\(hashData(Data(identity.utf8)))", [])
    }
    var rows = [String]()
    var measured = [String]()
    for suffix in files {
      do {
      let target = root.appendingPathComponent(suffix.isEmpty ? prefix : prefix + "/" + suffix)
      guard canonicalFileURL(target).path == target.path else { if skipMissing { continue }; return nil }
      let fd = open(target.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
      if fd < 0, errno == ENOENT || errno == ENOTDIR {
        if skipMissing { continue }
        return nil
      }
      if fd < 0, skipMissing { continue }
      if fd < 0, errno == ELOOP { return nil }
      guard fd >= 0 else { throw NativeFailure(unsafe) }
      let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
      defer { try? handle.close() }
      var metadata = stat()
      guard fstat(fd, &metadata) == 0 else { throw NativeFailure(unsafe) }
      if skipMissing && metadata.st_mode & S_IFMT != S_IFREG { continue }
      guard metadata.st_mode & S_IFMT == S_IFREG else { return nil }
      var hash = SHA256(), size = 0
      while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
        size += chunk.count
        hash.update(data: chunk)
      }
      let marker = "\(size):" + hash.finalize().map { String(format: "%02x", $0) }.joined()
      measured.append(suffix)
      rows += [suffix, marker]
      } catch { if !skipMissing { throw error } }
    }
    if measured == [""] { return (rows[1], measured) }
    let bytes = Data(rows.joined(separator: "\0").utf8)
    return ("\(bytes.count):\(hashData(bytes))", measured)
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
    return try transaction(scope.root, writing: writing) { state, append, _ in
      var source = stat()
      guard current(), canonicalFileURL(scope.file).path == scope.file.path,
            lstat(scope.file.path, &source) == 0, (source.st_mode & S_IFMT) == S_IFREG else { throw NativeFailure(Self.unsafe) }
      guard let state else { return empty }
      if writing {
        let document = try call("putDocument", [state.entries, scope.document, item, validated.forProperty("owner")!]).toString()
        guard var value = item.toDictionary() as? [String: Any] else { throw NativeFailure(Self.invalid) }
        value["document"] = document; value["at"] = timestamp.string(from: Date())
        try append(["entry": value])
        return value
      }
      let result = try call("query", [state.entries, scope.document, validated])
      if exporting { return try call("readingMarkdown", [result]).toString() ?? "\n" }
      return result.toArray() ?? []
    }
  }

  private func transaction<T>(_ folder: URL, writing: Bool,
                              _ run: (Snapshot?, @escaping ([String: Any]) throws -> Void, Bool) throws -> T) throws -> T {
    let noAppend: ([String: Any]) throws -> Void = { _ in throw NativeFailure(Self.unsafe) }
    guard canonicalFileURL(folder).path == folder.path else { throw NativeFailure(Self.unsafe) }
    let root = open(folder.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard root >= 0 else { throw NativeFailure(Self.unsafe) }
    defer { _ = close(root) }
    if writing, mkdirat(root, ".omarkie", 0o700) != 0, errno != EEXIST { throw NativeFailure(Self.unsafe) }
    let directory = openat(root, ".omarkie", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    if directory < 0, !writing, errno == ENOENT { return try run(nil, noAppend, false) }
    guard directory >= 0 else { throw NativeFailure(Self.unsafe) }
    defer { _ = close(directory) }
    if !writing {
      var metadata = stat()
      if fstatat(directory, "store.jsonl", &metadata, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT,
         fstatat(directory, "journal.lock", &metadata, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT {
        return try run(nil, noAppend, false)
      }
    }
    let lock = openat(directory, "journal.lock", O_CREAT | O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
    guard lock >= 0 else { throw NativeFailure(Self.unsafe) }
    defer { _ = close(lock) }
    _ = try Self.revision(lock)
    let deadline = ProcessInfo.processInfo.systemUptime + 3
    while flock(lock, LOCK_EX | LOCK_NB) != 0 {
      guard (errno == EWOULDBLOCK || errno == EINTR), ProcessInfo.processInfo.systemUptime < deadline else { throw NativeFailure(Self.unsafe) }
      #if WEBTEST
      if errno == EWOULDBLOCK { onContention?() }
      #endif
      Thread.sleep(forTimeInterval: 0.02)
    }
    let hasIndex = try Self.indexExists(directory)
    let flags = O_RDWR | O_APPEND | (writing ? O_CREAT : 0)
    let descriptor = openat(directory, "store.jsonl", flags | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
    if descriptor < 0, !writing, errno == ENOENT { return try run(nil, noAppend, false) }
    guard descriptor >= 0 else { throw NativeFailure(Self.unsafe) }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    func load() throws -> Snapshot {
      let revision = try Self.revision(descriptor)
      if let snapshot, snapshot.root == folder, snapshot.state.revision == revision { return snapshot.state }
      try handle.seek(toOffset: 0)
      let bytes = try handle.readToEnd() ?? Data(), end = bytes.lastIndex(of: 10).map { $0 + 1 } ?? 0
      guard try Self.revision(descriptor) == revision else { throw NativeFailure(Self.unsafe) }
      let prefix = bytes.prefix(end)
      let committed = String(bytes: prefix, encoding: .utf8) ?? prefix.split(separator: 10).map { String(bytes: $0, encoding: .utf8) ?? "!" }.joined(separator: "\n")
      return Snapshot(revision: revision, offset: end, entries: try call("readJournal", [committed]))
    }
    var state = try load()
    func append(_ record: [String: Any]) throws {
      #if WEBTEST
      if record["move"] != nil { beforeMoveCommit?() }
      #endif
      var row = record; row["v"] = 1
      var bytes = try JSONSerialization.data(withJSONObject: row)
      bytes.append(10)
      guard try Self.revision(descriptor) == state.revision else { throw NativeFailure(Self.unsafe) }
      if state.revision.size != state.offset { try handle.truncate(atOffset: UInt64(state.offset)) }
      try handle.write(contentsOf: bytes)
      try handle.synchronize()
      state = try load()
      #if WEBTEST
      if record["intent"] != nil { afterMoveIntent?() }
      #endif
    }
    var warning = try call("badRows", [state.entries]).toInt32() > 0
    if warning { NSLog("Reading journal skipped invalid rows.") }
    if let intent = try call("pending", [state.entries]).toDictionary() as? [String: Any],
       let from = intent["from"] as? String, let to = intent["to"] as? String, let fingerprint = intent["fingerprint"] as? String {
      do {
        let files = intent["files"] as? [String] ?? [""]
        let source = try Self.moveFingerprint(folder, from, files)?.fingerprint == fingerprint, destination = try Self.moveFingerprint(folder, to, files)?.fingerprint == fingerprint
        if source != destination {
          if destination { try append(["move": ["from": from, "to": to]]) }
          else { try append(["cancel": true]) }
        } else { warning = true; NSLog("Reading move recovery could not identify the original document.") }
      } catch { warning = true; NSLog("Reading move recovery could not confirm the destination.") }
    }
    let result = try run(state, append, warning)
    if !state.indexed || !hasIndex {
      // The journal commit remains valid if the derived cache cannot be written.
      do { try writeIndex(directory, state); state.indexed = true } catch {}
    }
    snapshot = (folder, state)
    return result
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
