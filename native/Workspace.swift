import AppKit
import Foundation
import Darwin

struct RecentEntry: Codable {
  var path: String
  var name: String
  var folder: Bool
  var pinned: Bool
}
struct FileUndo {
  let from: URL
  let to: URL
  let folder: URL?
  var trashID: String? = nil
}
func moveExclusive(_ from: URL, _ to: URL) throws {
  guard Darwin.renamex_np(from.path, to.path, UInt32(RENAME_EXCL)) == 0 else {
    throw NativeFailure(errno == EEXIST ? "目标已存在，未覆盖任何文件。" : "文件操作无效。")
  }
}
final class Workspace {
  let directory: URL
  var undo: FileUndo?
  init(_ directory: URL) { self.directory = directory }
  var recentURL: URL { directory.appendingPathComponent("recent.json") }
  static func newNote(_ name: String) -> String {
    let title = (name as NSString).deletingPathExtension
    let quoted = String(data: try! JSONSerialization.data(withJSONObject: title, options: [.fragmentsAllowed, .withoutEscapingSlashes]), encoding: .utf8)!
    let now = ISO8601DateFormatter().string(from: Date())
    return "---\ntype: Reference\ntitle: \(quoted)\ntags: []\ngenerated: { by: \"process:editor\", at: \"\(now)\" }\n---\n\n"
  }
  func recent() -> [RecentEntry] {
    (try? JSONDecoder().decode([RecentEntry].self, from: Data(contentsOf: recentURL))) ?? []
  }
  func remember(_ url: URL, folder: Bool) throws {
    let path = url.resolvingSymlinksInPath().standardizedFileURL.path
    var items = recent()
    let pinned = items.first { $0.path == path }?.pinned ?? false
    items.removeAll { $0.path == path }
    items.insert(RecentEntry(path: path, name: url.lastPathComponent, folder: folder, pinned: pinned), at: 0)
    try writeRecent(items)
  }
  func writeRecent(_ items: [RecentEntry]) throws {
    let retained = items.filter(\.pinned) + Array(items.filter { !$0.pinned }.prefix(50))
    try atomicWrite(recentURL, JSONEncoder().encode(retained))
  }
  func recentAction(_ action: String, path: String) throws -> [RecentEntry] {
    var items = recent()
    if action == "clear" { items.removeAll { !$0.pinned } }
    else if action == "remove" { items.removeAll { $0.path == path } }
    else if action == "pin" {
      guard let index = items.firstIndex(where: { $0.path == path && $0.folder }) else { throw NativeFailure("只能置顶最近打开的文件夹。") }
      items[index].pinned.toggle()
    } else { throw NativeFailure("最近项目操作无效。") }
    try writeRecent(items)
    return items
  }
  func authorize(_ path: String, store: DocumentStore, directory: Bool = false) throws -> URL {
    let target = URL(fileURLWithPath: path).standardizedFileURL
    let resolved = canonicalFileURL(target)
    let systemAlias = ["/var/", "/tmp/"].contains { target.path.hasPrefix($0) } && resolved.path == "/private" + target.path
    guard target.path == resolved.path || systemAlias else { throw NativeFailure("文件操作不支持符号链接。") }
    let inFolder = store.folder.map { $0.path == resolved.path || contained($0, resolved) } ?? false
    let opened = store.records.values.contains { $0.path == resolved.path }
    guard inFolder || (!directory && opened) else { throw NativeFailure("请先打开目标文件夹。") }
    return resolved
  }
  func child(_ parent: URL, name: String) throws -> URL {
    guard !name.isEmpty, name != ".", name != "..", !name.hasPrefix("."), name.utf8.count <= 240,
      !name.contains("/"), !name.contains(":"), !name.contains("\\"), !name.contains("\0") else { throw NativeFailure("名称无效，请使用普通文件名。") }
    return parent.appendingPathComponent(name)
  }
  func execute(_ operation: [String: String], store: DocumentStore, trashID: String? = nil, move: (URL, URL) throws -> Void = moveExclusive) throws -> [String: String] {
    let fm = FileManager.default
    let action = operation["action"] ?? ""
    if action == "undo" {
      guard let item = undo else { throw NativeFailure("没有可撤销的文件操作。") }
      guard !fm.fileExists(atPath: item.to.path) else { throw NativeFailure("原位置已被占用，未覆盖任何文件。") }
      // Only restore the exact item retained by the last successful move or Trash operation.
      try move(item.from, item.to)
      undo = nil
      return ["fromPath": item.from.path, "toPath": item.to.path]
    }
    let source = try authorize(operation["path"] ?? store.folder?.path ?? "", store: store,
      directory: ["new-file", "new-folder"].contains(action))
    if source.path == store.folder?.path && ["rename", "move", "trash"].contains(action) { throw NativeFailure("不能在当前文件树中移动或删除根文件夹。") }
    if action == "trash" {
      var trashed: NSURL?
      try fm.trashItem(at: source, resultingItemURL: &trashed)
      if let trashed { undo = FileUndo(from: trashed as URL, to: source, folder: store.folder, trashID: trashID) }
      else { undo = nil }
      return ["removedPath": source.path]
    }
    let destination: URL
    if ["new-file", "new-folder"].contains(action) {
      guard (try source.resourceValues(forKeys: [.isDirectoryKey])).isDirectory == true else { throw NativeFailure("请选择文件夹。") }
      destination = try child(source, name: operation["name"] ?? "")
    } else if action == "move" {
      let parent = try authorize(operation["target"] ?? "", store: store, directory: true)
      guard (try parent.resourceValues(forKeys: [.isDirectoryKey])).isDirectory == true else { throw NativeFailure("移动目标不是文件夹。") }
      destination = parent.appendingPathComponent(source.lastPathComponent)
    } else if ["rename", "duplicate"].contains(action) {
      destination = try child(source.deletingLastPathComponent(), name: operation["name"] ?? "")
    } else { throw NativeFailure("文件操作无效。") }
    guard !fm.fileExists(atPath: destination.path), (["new-file", "new-folder"].contains(action) || !contained(source, destination)) else { throw NativeFailure("目标已存在，或目标位于自身内部。") }
    if action == "new-folder" { try fm.createDirectory(at: destination, withIntermediateDirectories: false) }
    else if action == "new-file" {
      guard ["md", "markdown", "mdown"].contains(destination.pathExtension.lowercased()) else { throw NativeFailure("新建文档需要 Markdown 扩展名。") }
      // O_EXCL prevents an external creator from being overwritten between validation and creation.
      let descriptor = Darwin.open(destination.path, O_CREAT | O_EXCL | O_WRONLY, 0o600)
      guard descriptor >= 0 else { throw NativeFailure("无法创建文档。") }
      let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
      try handle.write(contentsOf: Data(Self.newNote(destination.lastPathComponent).utf8)); try handle.close()
    } else if action == "duplicate" {
      guard (try source.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else { throw NativeFailure("请选择 Markdown 文件。") }
      let owned = store.records.values.first(where: { $0.path == source.path })
      let encoded = try owned.map { try DocumentStore.encode($0.content, encoding: $0.encoding ?? "utf-8", bom: $0.bom ?? false) }
      try fm.copyItem(at: source, to: destination)
      // The latest in-memory draft is the duplicate's content, without saving over the original.
      if let encoded { try atomicWrite(destination, encoded) }
    } else {
      try move(source, destination)
      undo = FileUndo(from: destination, to: source, folder: store.folder)
      return ["fromPath": source.path, "toPath": destination.path]
    }
    return ["newPath": destination.path]
  }
  func vaultSnapshot(_ store: DocumentStore, chaptersOnly: Bool = false) throws -> [String: Any] {
    guard let root = store.folder else { throw NativeFailure("请先打开文件夹") }
    let inventory = try store.scan(), files = inventory["files"] as? [[String: String]] ?? []
    let encodings = Dictionary(store.records.values.compactMap { record in record.path.map { ($0, record.encoding ?? "utf-8") } }, uniquingKeysWith: { first, _ in first })
    var notes = [[String: String]](), assets = [[String: String]](), total = 0, count = 0
    var truncated = (inventory["truncated"] as? Bool ?? false) || (inventory["skipped"] as? Int ?? 0) > 0
    let deadline = Date().addingTimeInterval(5), fm = FileManager.default
    for entry in files where entry["isDirectory"] != "true" {
      if Date() > deadline { truncated = true; break }
      guard let relative = entry["relative"], let token = entry["token"] else { continue }
      let file = try workflowFile(root, relative: relative), size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max
      if size > 8 * 1024 * 1024 || total + size > 64 * 1024 * 1024 { truncated = true; continue }
      let data = try Data(contentsOf: file); total += data.count
      do { let (content, _, _) = try store.decode(data, encoding: data.starts(with: [0xef, 0xbb, 0xbf]) || data.starts(with: [0xff, 0xfe]) || data.starts(with: [0xfe, 0xff]) ? nil : encodings[file.path]); notes.append(["token": token, "relative": relative, "content": content, "path": file.path]) } catch { truncated = true }
    }
    if chaptersOnly { return ["notes": notes, "assets": assets, "truncated": truncated, "folder": root.path] }
    let media = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "mp4", "webm", "ogg", "mp3", "wav", "m4a"]
    func walk(_ directory: URL, depth: Int) throws {
      for file in try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .isHiddenKey]) {
        count += 1
        if count > 50000 || Date() > deadline { truncated = true; return }
        let values = try file.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .isHiddenKey])
        if (file.lastPathComponent.hasPrefix(".") || values.isHidden == true) && !(file.lastPathComponent == ".assets" && values.isDirectory == true) || values.isSymbolicLink == true || file.lastPathComponent == "node_modules" { continue }
        if values.isDirectory == true { if depth < 12 { try walk(file, depth: depth + 1) } else { truncated = true } }
        else if values.isRegularFile == true && media.contains(file.pathExtension.lowercased()) { assets.append(["relative": String(file.path.dropFirst(root.path.count + 1))]) }
      }
    }
    try walk(root, depth: 0)
    return ["notes": notes, "assets": assets, "truncated": truncated]
  }
  func readNotes(_ store: DocumentStore, relatives: [String]) throws -> [[String: String]] {
    guard let root = store.folder else { throw NativeFailure("请先打开文件夹") }
    let notesOnly = ["md", "markdown", "mdown"]
    guard relatives.count <= 64, relatives.allSatisfy({ notesOnly.contains(($0 as NSString).pathExtension.lowercased()) }) else { throw NativeFailure("知识库路径无效") }
    let encodings = Dictionary(store.records.values.compactMap { record in record.path.map { ($0, record.encoding ?? "utf-8") } }, uniquingKeysWith: { first, _ in first })
    var notes = [[String: String]](), total = 0
    for relative in relatives {
      guard let file = try? workflowFile(root, relative: relative),
        let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]), values.isRegularFile == true,
        let size = values.fileSize, size <= 8 * 1024 * 1024, total + size <= 16 * 1024 * 1024,
        let data = try? Data(contentsOf: file) else { continue }
      total += data.count
      let marked = data.starts(with: [0xef, 0xbb, 0xbf]) || data.starts(with: [0xff, 0xfe]) || data.starts(with: [0xfe, 0xff])
      if let (content, _, _) = try? store.decode(data, encoding: marked ? nil : encodings[file.path]) { notes.append(["relative": relative, "content": content]) }
    }
    return notes
  }
  func workflowFile(_ root: URL, relative: String) throws -> URL {
    guard !relative.isEmpty, !relative.hasPrefix("/"), !relative.contains(":"), !relative.contains("\\"), !relative.contains("\0"), !relative.split(separator: "/").contains(where: { $0.hasPrefix(".") && $0 != ".assets" }) else { throw NativeFailure("知识库路径无效") }
    let file = root.appendingPathComponent(relative)
    guard contained(root, file), file.path == canonicalFileURL(file).path else { throw NativeFailure("知识库路径无效") }
    return file
  }
  func exportBundle(_ payload: [String: Any], store: DocumentStore, parent: URL) throws -> String {
    guard let source = store.folder, let notes = payload["notes"] as? [[String: String]], let assets = payload["assets"] as? [[String: String]], let index = payload["index"] as? String, let log = payload["log"] as? String, notes.count <= 1000, assets.count <= 50000, index.utf8.count + log.utf8.count <= 2 * 1024 * 1024 else { throw NativeFailure("压缩包无效") }
    let target = canonicalFileURL(parent), fm = FileManager.default
    guard target != source, !contained(source, target) else { throw NativeFailure("请选择知识库之外的目标位置") }
    let output = target.appendingPathComponent("knowledge-bundle-" + UUID().uuidString)
    var names = Set(["index.md", "log.md"]), total = 0, copies = [(URL, String)]()
    func destination(_ relative: String) throws -> URL {
      let file = try workflowFile(output, relative: relative)
      guard !names.contains(relative.lowercased()) else { throw NativeFailure("压缩包路径无效") }
      names.insert(relative.lowercased()); return file
    }
    for note in notes {
      guard let token = note["token"], let owned = store.tokens[token], contained(source, owned), let relative = note["relative"], let content = note["content"], content.utf8.count <= 8 * 1024 * 1024 else { throw NativeFailure("压缩包无效") }
      total += content.utf8.count; _ = try destination(relative)
    }
    guard total <= 64 * 1024 * 1024 else { throw NativeFailure("压缩包超过大小限制") }
    let media = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "mp4", "webm", "ogg", "mp3", "wav", "m4a"]
    for asset in assets {
      guard let relative = asset["relative"], let reference = asset["source"] else { throw NativeFailure("压缩包无效") }
      let file = try workflowFile(source, relative: reference), values = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]), size = values.fileSize ?? Int.max
      guard media.contains(file.pathExtension.lowercased()), values.isRegularFile == true, size <= 100 * 1024 * 1024 else { throw NativeFailure("压缩包无效") }
      total += size; _ = try destination(relative); copies.append((file, relative))
    }
    guard total <= 512 * 1024 * 1024 else { throw NativeFailure("压缩包超过大小限制") }
    try fm.createDirectory(at: output, withIntermediateDirectories: false)
    for note in notes + [["relative": "index.md", "content": index], ["relative": "log.md", "content": log]] {
      let file = output.appendingPathComponent(note["relative"]!)
      try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data(note["content"]!.utf8).write(to: file, options: .withoutOverwriting)
    }
    for (source, relative) in copies { let file = output.appendingPathComponent(relative); try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true); try fm.copyItem(at: source, to: file) }
    return output.path
  }
  func updateRecent(_ change: [String: String]) throws {
    guard let from = change["fromPath"], let to = change["toPath"] else { return }
    let items = recent().map { item -> RecentEntry in
      var next = item
      if item.path == from || item.path.hasPrefix(from + "/") {
        next.path = to + item.path.dropFirst(from.count); next.name = URL(fileURLWithPath: next.path).lastPathComponent
      }
      return next
    }
    try writeRecent(items)
  }
  static func search(_ files: [[String: String]], query: String, regex: Bool, caseSensitive: Bool, encodings: [String: String] = [:]) throws -> [String: Any] {
    guard !query.isEmpty, query.utf8.count <= 1000 else { return ["matches": [], "truncated": false, "skipped": 0] }
    let expression = try NSRegularExpression(pattern: regex ? query : NSRegularExpression.escapedPattern(for: query), options: caseSensitive ? [] : [.caseInsensitive])
    var matches = [[String: Any]](), truncated = false, skipped = 0, totalBytes = 0
    for file in files where file["isDirectory"] != "true" {
      guard let path = file["path"], let size = try? URL(fileURLWithPath: path).resourceValues(forKeys: [.fileSizeKey]).fileSize,
        size <= 2 * 1024 * 1024, totalBytes + size <= 30 * 1024 * 1024,
        let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
        let decoded = try? DocumentStore(URL(fileURLWithPath: "/")).decode(data, encoding: data.starts(with: [0xef, 0xbb, 0xbf]) || data.starts(with: [0xff, 0xfe]) || data.starts(with: [0xfe, 0xff]) ? nil : encodings[path]) else { skipped += 1; continue }
      totalBytes += size
      for (index, line) in decoded.0.components(separatedBy: "\n").enumerated() {
        let value = line as NSString
        for match in expression.matches(in: line, range: NSRange(location: 0, length: value.length)) {
          if matches.count >= 500 { truncated = true; break }
          let start = max(0, match.range.location - 70), end = min(value.length, max(match.range.location + match.range.length, start + 180))
          matches.append(["token": file["token"] ?? "", "path": path, "name": file["relative"] ?? file["name"] ?? "", "line": index + 1, "column": match.range.location + 1, "length": match.range.length, "preview": value.substring(with: NSRange(location: start, length: end - start))])
        }
        if truncated { break }
      }
      if truncated { break }
    }
    return ["matches": matches, "truncated": truncated, "skipped": skipped]
  }
}
extension DocumentStore {
  func applyPathChange(_ change: [String: String]) {
    func updated(_ record: DocumentRecord) -> DocumentRecord? {
      var record = record
      guard let path = record.path else { return record }
      if let removed = change["removedPath"], path == removed || path.hasPrefix(removed + "/") { return nil }
      if let from = change["fromPath"], let to = change["toPath"], path == from || path.hasPrefix(from + "/") {
        record.path = to + path.dropFirst(from.count); record.name = URL(fileURLWithPath: record.path!).lastPathComponent
      }
      return record
    }
    records = records.compactMapValues(updated)
    closedRecords = closedRecords.compactMapValues(updated)
  }
}
