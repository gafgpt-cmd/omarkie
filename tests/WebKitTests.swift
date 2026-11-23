import AppKit
import CoreGraphics
import PDFKit
import Darwin
import WebKit

final class WebKitTests: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  let owner = NativeApplication()
  var host: NativeWindowHost!
  func applicationDidFinishLaunching(_ notification: Notification) {
    do {
      let directory = owner.directory
      let file = directory.appendingPathComponent("WebKit-fixture.md")
      let source =
        "# WebKit 验收\n\n普通 **粗体** 与 *斜体*。\n\n- [ ] 任务\n\n| 名称 | 内容 |\n| --- | --- |\n| A | B |\n\n```javascript\nconst count = 1;\n```\n\n$$\n\\newcommand{\\myvalue}{x+1}\n$$\n\n$$\n\\myvalue + \\mathbb{R}\n$$\n"
      try atomicWrite(file, Data(source.utf8))
      if let origin = ProcessInfo.processInfo.environment["OMARKIE_TEST_GRAMMAR"] {
        let chapter = "# Diagram chapter\n\n<div class=\"mermaid-block\"><video poster=\"\(origin)/reader-media-project\"></video></div>\n\n``` mermaid\ngraph TD\n A --> B\n```\n\n~~~mermaid\ngraph LR\n Start --> Middle --> Finish\n~~~\n"
        try atomicWrite(directory.appendingPathComponent("Diagram-chapter.md"), Data(chapter.utf8))
      }
      let mediaFolder = directory.appendingPathComponent("preview-media")
      try FileManager.default.createDirectory(at: mediaFolder, withIntermediateDirectories: false)
      let mediaImage = Data(#"<svg xmlns="http://www.w3.org/2000/svg" width="11" height="17"><rect width="11" height="17" fill="green"/></svg>"#.utf8)
      for name in ["local.svg", "fallback.svg"] { try atomicWrite(mediaFolder.appendingPathComponent(name), mediaImage) }
      for phase in ["reading", "clean"] {
        let note = #"<div><img alt="Local image" src="local.svg"></div>"# + "\n"
        try atomicWrite(mediaFolder.appendingPathComponent("Media-\(phase).md"), Data(note.utf8))
      }
      let store = DocumentStore(directory)
      let plugin = directory.appendingPathComponent("Native-plugin-fixture.js")
      try atomicWrite(plugin, Data("class NativePlugin extends BasePlugin { style() { return '#write { --plugin-fixture: loaded; }' }; call() { this.utils.insertText('插件') } }; module.exports = {plugin: NativePlugin};".utf8))
      _ = try Interchange.installPlugin(plugin, directory: directory)
      _ = try Interchange.installPlugin(Bundle.main.resourceURL!.appendingPathComponent("Plugin-package-fixture"), directory: directory)
      try atomicWrite(directory.appendingPathComponent("Background-fixture.png"),Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgaGAAAAEEAIEl6+oTAAAAAElFTkSuQmCC")!)
      try atomicWrite(directory.appendingPathComponent("native-zotero.json"), Data("[{\"id\":\"watched\",\"type\":\"book\",\"title\":\"Watched native reference\",\"author\":[{\"family\":\"García\"}]}]".utf8))
      let record = try store.open(file, id: "webkit-fixture")
      host = NativeWindowHost(
        owner: owner, directory: directory,
        seed: SessionRecord(documents: [record], activeId: record.id, folder: canonicalFileURL(directory).path))
      owner.hosts.append(host)
      host.show(hidden: true)
      host.webView.configuration.userContentController.addUserScript(WKUserScript(
        source: "if (location.pathname.endsWith('/project-diagrams.html')) Object.defineProperty(crypto, 'randomUUID', { value: undefined })",
        injectionTime: .atDocumentStart, forMainFrameOnly: false))
      host.webView.navigationDelegate = self
      DispatchQueue.main.asyncAfter(deadline: .now() + 180) {
        fputs("WebKit test timed out\n", stderr)
        exit(1)
      }
    } catch { fail(error) }
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    do {
      let script = try String(
        contentsOf: Bundle.main.resourceURL!.appendingPathComponent("web-tests.js"), encoding: .utf8
      )
      let environment = ProcessInfo.processInfo.environment
      webView.callAsyncJavaScript(script, arguments: ["uploaderURL": environment["OMARKIE_TEST_UPLOADER"] ?? "", "payloadBaseURL": environment["OMARKIE_TEST_PAYLOAD"] ?? "", "grammarOrigin": environment["OMARKIE_TEST_GRAMMAR"] ?? ""], in: nil, in: .page) { result in
        do {
          let value = try result.get()
          guard let output = value as? [String: Any], output["error"] == nil else {
            throw NativeFailure(String(describing: value))
          }
          let saved = try String(
            contentsOf: self.owner.directory.appendingPathComponent("WebKit-fixture.md"),
            encoding: .utf8)
          guard saved == output["source"] as? String else {
            throw NativeFailure("Native saved bytes differ from the editor document.")
          }
          let pdfURL = self.owner.directory.appendingPathComponent("native-test.pdf")
          guard let pdf = CGPDFDocument(pdfURL as CFURL), pdf.numberOfPages == 1,
            try Data(contentsOf: pdfURL).count < 1_000_000
          else { throw NativeFailure("Native PDF pagination or size is invalid.") }
          print("PASS: native PDF is valid A4 with \(pdf.numberOfPages) pages and bounded size")
          let longURL = self.owner.directory.appendingPathComponent("native-test-long.pdf")
          guard let longPDF = PDFDocument(url: longURL), longPDF.pageCount > 5 else { throw NativeFailure("Long PDF did not paginate.") }
          let longText = longPDF.string ?? ""
          for number in 1...90 { let marker = String(format: "Paragraph-%03d", number); guard longText.components(separatedBy: marker).count == 2 else { throw NativeFailure("PDF lost or duplicated " + marker + " count=" + String(longText.components(separatedBy: marker).count - 1)) } }
          for number in 1...30 { let marker = String(format: "Row-%03d", number); guard longText.components(separatedBy: marker).count == 2 else { throw NativeFailure("PDF lost or duplicated " + marker + " count=" + String(longText.components(separatedBy: marker).count - 1)) } }
          for number in 0..<longPDF.pageCount {
            guard let page = longPDF.page(at: number), abs(page.bounds(for: .mediaBox).width - 612) < 1, page.string?.contains("\(number + 1) / \(longPDF.pageCount)") == true else { throw NativeFailure("PDF paper or page counter is wrong.") }
          }
          print("PASS: long PDF has \(longPDF.pageCount) Letter pages, every paragraph and row once, and correct page counters")
          let complexURL = self.owner.directory.appendingPathComponent("native-complex.pdf")
          guard let complexPDF = PDFDocument(url: complexURL), complexPDF.pageCount >= 1,
            let complexText = complexPDF.string?.precomposedStringWithCompatibilityMapping, complexText.contains("复杂中文文档"), complexText.contains("中文甲"), complexText.contains("中文脚注内容") else { throw NativeFailure("Complex native PDF lost Chinese content or table/footnote text.") }
          print("PASS: complex PDF contains Chinese headings, table cells and footnotes across \(complexPDF.pageCount) pages")
          let html = try String(contentsOf: self.owner.directory.appendingPathComponent("native-test.html"), encoding: .utf8)
          guard html.contains("data:image/"), html.contains("data:font/"), !html.contains("<link rel=\"stylesheet\"") else { throw NativeFailure("HTML export retained live app assets.") }
          print("PASS: HTML export contains embedded fonts and the owned local image")
          guard !html.contains("data-editor-background") else { throw NativeFailure("HTML export included the personal background layer.") }
          let data = try JSONSerialization.data(
            withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
          print(String(data: data, encoding: .utf8)!)
          print("PASS: native WebKit bridge persisted exact editor bytes")
          Task { @MainActor in
            do {
              try await self.checkLearningPersistence()
              try await self.checkInterruptedMove()
              try await self.checkCollisionOnlyRecovery()
              try await self.checkOfflinePDF()
              try await self.checkReaderPersistence()
              try await self.checkMenuLocale()
              try await self.checkShowcaseGrant()
              exit(0)
            } catch { self.fail(error) }
          }
        } catch { self.fail(error) }
      }
    } catch { fail(error) }
  }
  @MainActor func checkShowcaseGrant() async throws {
    _ = try await host.webView.callAsyncJavaScript("""
      const snapshot = await window.desktop.restore();
      if (!snapshot.ok) throw new Error(snapshot.error);
      const showcase = await window.desktop.showcase();
      if (!showcase.ok) throw new Error(showcase.error);
      const { id, name } = showcase.value.document;
      if (name !== "travel-journal.md" || snapshot.value.documents.some(record => record.id === id)) {
        throw new Error("Expected Showcase to open a new travel journal tab");
      }
      const stale = await window.desktop.persist(snapshot.value);
      if (!stale.ok) throw new Error(stale.error);
      const asset = `omarkie-asset://local/${encodeURIComponent(id)}/images/coast-sunrise.jpg`;
      const local = await window.desktop.readResource(asset);
      if (!local.ok || local.value.mime !== "image/jpeg") throw new Error("Stale snapshot revoked the Showcase image grant");
      """, arguments: [:], in: nil, contentWorld: .page)
    print("PASS: stale snapshot preserves the Showcase image grant")
  }
  @MainActor func checkMenuLocale() async throws {
    func waitFor(_ predicate: () -> Bool) async throws {
      let deadline = ContinuousClock.now + .seconds(5)
      while !predicate() {
        guard ContinuousClock.now < deadline else { throw NativeFailure("Native menu focus transition timed out.") }
        try await Task.sleep(nanoseconds: 50_000_000)
      }
    }
    func labels() -> [String?] {
      let items = NSApp.mainMenu?.items.flatMap { $0.submenu?.items ?? [] } ?? []
      return ["clean-converted", "collect-reading"].map { action in
        items.first(where: { $0.representedObject as? String == action })?.title
      }
    }
    let other = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
    defer { other.orderOut(nil) }
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    host.window.makeKeyAndOrderFront(nil)
    try await waitFor { self.host.window.isKeyWindow }
    let english = labels()
    guard english == ["Clean converted text…", "Collect highlights and callouts"] else { throw NativeFailure("English File menu was not built.") }
    host.webView.navigationDelegate = host
    other.makeKeyAndOrderFront(nil)
    try await waitFor { other.isKeyWindow }
    host.rendererReady = false
    _ = try await host.webView.callAsyncJavaScript("""
      window.__omarkie.command({action:'preferences'});
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const select = document.querySelector('select[aria-label="Interface Language"]');
        if (select) {
          select.value = 'es';
          setTimeout(() => select.dispatchEvent(new Event('change', {bubbles:true})), 0);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Language preference did not open');
      """, arguments: [:], in: nil, contentWorld: .page)
    try await waitFor { self.host.rendererReady }
    guard other.isKeyWindow, labels() == english else { throw NativeFailure("Background reload replaced the key window menu.") }
    host.window.makeKeyAndOrderFront(nil)
    try await waitFor { self.host.window.isKeyWindow }
    guard labels() == ["Limpiar texto convertido…", "Recopilar resaltados y avisos"] else {
      throw NativeFailure("Native File menu lost the background renderer locale on focus.")
    }
  }
  @MainActor func checkOfflinePDF() async throws {
    guard let origin = ProcessInfo.processInfo.environment["OMARKIE_TEST_GRAMMAR"] else { throw NativeFailure("Missing PDF fixture origin.") }
    for offline in [false, true] {
      let exporter = PDFExporter(resources: Bundle.main.resourceURL!.appendingPathComponent("dist"), store: host.store, offline: offline)
      let route = offline ? "project-export-media-blocked" : "project-export-media-control"
      let html = "<!doctype html><article class=print-document><h1>Renderer fixture</h1><img src='\(origin)/\(route)'></article>"
      let bytes: Data = try await withCheckedThrowingContinuation { continuation in
        exporter.export(html) { continuation.resume(with: $0) }
      }
      guard PDFDocument(data: bytes)?.string?.contains("Renderer fixture") == true else { throw NativeFailure("PDF resource fixture did not render.") }
      withExtendedLifetime(exporter) {}
    }
  }
  @MainActor func checkInterruptedMove() async throws {
    let root = owner.directory.appendingPathComponent("interrupted-vault")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    let source = root.appendingPathComponent("a.md"), destination = root.appendingPathComponent("b.md")
    try atomicWrite(source, Data("Original".utf8))
    let script = Bundle.main.resourceURL!.appendingPathComponent("reading-core.cjs")
    let reading = NativeReadingStore(script)
    let scope = NativeReadingStore.Scope(root: root, file: source, document: "a.md")
    _ = try await reading.perform(scope, ["action": "put", "item": ["type": "card", "id": "original-card", "front": "Q", "back": "A"]])
    let journal = root.appendingPathComponent(".omarkie/store.jsonl")
    let handle = try FileHandle(forWritingTo: journal)
    try handle.seekToEnd()
    let fingerprint = "8:\(hashData(Data("Original".utf8)))"
    try handle.write(contentsOf: Data("{\"v\":1,\"intent\":{\"from\":\"a.md\",\"to\":\"b.md\",\"fingerprint\":\"\(fingerprint)\"}}\n".utf8))
    try handle.close()
    try FileManager.default.moveItem(at: source, to: destination)
    try atomicWrite(source, Data("Replacement".utf8))
    guard !(await NativeReadingStore.recoverVault(root)) else { throw NativeFailure("Interrupted move produced a recovery warning.") }
    try atomicWrite(destination, Data("Saved before first journal read".utf8))
    let moved = NativeReadingStore.Scope(root: root, file: destination, document: "b.md")
    let original = try await reading.perform(moved, ["action": "list"]) as? [[String: Any]]
    let replacement = try await reading.perform(scope, ["action": "list"]) as? [[String: Any]]
    guard original?.first?["id"] as? String == "original-card", replacement?.isEmpty == true else {
      throw NativeFailure("Interrupted move assigned the card to the replacement.")
    }
    let chapter = root.appendingPathComponent("chapter"), renamed = root.appendingPathComponent("renamed")
    try FileManager.default.createDirectory(at: chapter, withIntermediateDirectories: false)
    for name in ["present", "missing"] {
      let file = chapter.appendingPathComponent(name + ".md")
      try atomicWrite(file, Data(name.utf8))
      let child = NativeReadingStore.Scope(root: root, file: file, document: "chapter/\(name).md")
      _ = try await reading.perform(child, ["action": "put", "item": ["type": "card", "id": name, "front": "Q", "back": "A"]])
    }
    try FileManager.default.removeItem(at: chapter.appendingPathComponent("missing.md"))
    try atomicWrite(chapter.appendingPathComponent("incoming.md"), Data("Incoming without history".utf8))
    try FileManager.default.createSymbolicLink(atPath: chapter.appendingPathComponent("link.md").path, withDestinationPath: "incoming.md")
    try FileManager.default.createDirectory(at: renamed, withIntermediateDirectories: false)
    let stale = renamed.appendingPathComponent("incoming.md")
    try atomicWrite(stale, Data("Deleted destination note".utf8))
    let staleScope = NativeReadingStore.Scope(root: root, file: stale, document: "renamed/incoming.md")
    _ = try await reading.perform(staleScope, ["action": "put", "item": ["type": "card", "id": "stale", "front": "Q", "back": "A"]])
    let staleLink = renamed.appendingPathComponent("link.md")
    try atomicWrite(staleLink, Data("Old regular file".utf8))
    let linkScope = NativeReadingStore.Scope(root: root, file: staleLink, document: "renamed/link.md")
    _ = try await reading.perform(linkScope, ["action": "put", "item": ["type": "card", "id": "stale-link", "front": "Q", "back": "A"]])
    try FileManager.default.removeItem(at: renamed)
    _ = try await reading.moveEntries(root) { move in
      try move(chapter, renamed)
      return [:]
    }
    guard try FileManager.default.destinationOfSymbolicLink(atPath: renamed.appendingPathComponent("link.md").path) == "incoming.md" else {
      throw NativeFailure("Stale link history blocked the folder rename.")
    }
    let entries = try await reading.perform(moved, ["action": "list", "scope": "vault"]) as? [[String: Any]] ?? []
    guard entries.first(where: { $0["id"] as? String == "present" })?["document"] as? String == "renamed/present.md",
          entries.first(where: { $0["id"] as? String == "missing" })?["document"] as? String == "chapter/missing.md",
          !entries.contains(where: { $0["id"] as? String == "stale" }) else {
      throw NativeFailure("Folder rename moved history for a missing descendant.")
    }
  }
  @MainActor func checkCollisionOnlyRecovery() async throws {
    for moved in [false, true] {
      let root = owner.directory.appendingPathComponent(moved ? "collision-after" : "collision-before")
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
      let source = root.appendingPathComponent("source.md"), destination = root.appendingPathComponent("destination.md")
      try atomicWrite(source, Data("Incoming".utf8)); try atomicWrite(destination, Data("Old".utf8))
      let script = Bundle.main.resourceURL!.appendingPathComponent("reading-core.cjs")
      let reading = NativeReadingStore(script)
      let destinationScope = NativeReadingStore.Scope(root: root, file: destination, document: "destination.md")
      _ = try await reading.perform(destinationScope, ["action": "put", "item": ["type": "card", "id": "stale", "front": "Q", "back": "A"]])
      try FileManager.default.removeItem(at: destination)
      let worker = Process()
      worker.executableURL = Bundle.main.executableURL
      worker.arguments = ["--collision-worker", root.path, moved ? "after" : "before"]
      try worker.run()
      defer { if worker.isRunning { worker.terminate() } }
      let deadline = ContinuousClock.now + .seconds(2)
      while !FileManager.default.fileExists(atPath: root.appendingPathComponent("interrupted").path) {
        guard worker.isRunning, ContinuousClock.now < deadline else { throw NativeFailure("Collision worker did not reach the interruption point.") }
        try await Task.sleep(nanoseconds: 10_000_000)
      }
      kill(worker.processIdentifier, SIGKILL)
      worker.waitUntilExit()
      guard worker.terminationReason == .uncaughtSignal, worker.terminationStatus == SIGKILL,
            !(await NativeReadingStore.recoverVault(root)) else { throw NativeFailure("Collision-only move did not recover.") }
      let live = moved ? destinationScope : NativeReadingStore.Scope(root: root, file: source, document: "source.md")
      let entries = try await reading.perform(live, ["action": "list", "scope": "vault"]) as? [[String: Any]] ?? []
      guard entries.compactMap({ $0["id"] as? String }) == (moved ? [] : ["stale"]) else { throw NativeFailure("Collision history resolved incorrectly.") }
      _ = try await reading.perform(live, ["action": "put", "item": ["type": "card", "id": "new", "front": "Q", "back": "A"]])
    }
  }
  @MainActor func checkLearningPersistence() async throws {
    let scope = try NativeReadingStore.scope(host.store, "webkit-fixture")
    let reopened = NativeReadingStore(Bundle.main.resourceURL!.appendingPathComponent("reading-core.cjs"))
    let items = try await reopened.perform(scope, ["action": "list", "scope": "vault"]) as? [[String: Any]]
    guard items?.map({ $0["type"] as? String ?? "" }) == ["note", "card", "answer"],
          items?.last?["rating"] as? Int == 5,
          let markdown = try await reopened.perform(scope, ["action": "export"]) as? String,
          markdown.contains("Native margin note."), markdown.contains("Synthetic question\n\nSynthetic answer") else {
      throw NativeFailure("Native reading journal did not replay notes, cards and ratings into Markdown.")
    }
    let export = owner.directory.appendingPathComponent("native-reading.md")
    try NativeReadingStore.export(markdown, export)
    do {
      try NativeReadingStore.export("Must not overwrite", export)
      throw NativeFailure("Native reading export overwrote an existing file.")
    } catch let error as NativeFailure where error.message == "无法导出。请选择新的文件名。" {}
    guard try String(contentsOf: export, encoding: .utf8) == markdown else { throw NativeFailure("Native reading export bytes differ.") }
    try await checkReadingContention(scope, expected: ["native-note", "native-card", "native-answer", "parallel-a", "parallel-b"])
    let root = canonicalFileURL(owner.directory).appendingPathComponent("first-journal-vault")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    let file = root.appendingPathComponent("first.md"), source = root.appendingPathComponent("source.md")
    try atomicWrite(file, Data("First writer".utf8))
    try atomicWrite(source, Data("Renamed note".utf8))
    let previous = host.store.folder
    _ = try await host.scanVault(root)
    defer { host.store.folder = previous }
    try await checkFirstRename(.init(root: root, file: file, document: "first.md"), source)
    try await checkDeferredTrashPurge(.init(root: root, file: file, document: "first.md"))
    print("PASS: native journal replay, Markdown export and exclusive destination")
  }
  @MainActor func checkDeferredTrashPurge(_ scope: NativeReadingStore.Scope) async throws {
    let core = Bundle.main.resourceURL!.appendingPathComponent("reading-core.cjs")
    let store = NativeReadingStore(core), id = UUID().uuidString
    let trashed = scope.root.appendingPathComponent("trashed.md")
    _ = try await store.moveEntries(scope.root, trash: (scope.file, id)) { move in
      try move(scope.file, trashed)
      return [:]
    }
    let sidecar = scope.root.appendingPathComponent(".omarkie")
    let lock = open(sidecar.appendingPathComponent("journal.lock").path, O_RDWR | O_CLOEXEC)
    guard lock >= 0 else { throw NativeFailure("Could not open the purge test lock.") }
    defer { _ = close(lock) }
    guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw NativeFailure("Could not hold the purge test lock.") }
    await store.discardTrash(scope.root, id)
    let journal = sidecar.appendingPathComponent("store.jsonl")
    let before = try String(contentsOf: journal, encoding: .utf8)
    guard !before.contains("purgeTrash"), flock(lock, LOCK_UN) == 0,
          !(await NativeReadingStore.recoverVault(scope.root)) else { throw NativeFailure("Trash recovery could not reopen the journal.") }
    let after = try String(contentsOf: journal, encoding: .utf8)
    let purges = try after.split(separator: "\n").compactMap { row in
      (try JSONSerialization.jsonObject(with: Data(row.utf8)) as? [String: Any])?["purgeTrash"] as? String
    }
    guard purges == [id], !FileManager.default.fileExists(atPath: scope.file.path) else {
      throw NativeFailure("Reopening the vault did not purge unreachable Trash history.")
    }
  }
  @MainActor func checkFirstRename(_ scope: NativeReadingStore.Scope, _ source: URL) async throws {
    let coordination = owner.directory.appendingPathComponent("first-journal-test")
    try FileManager.default.createDirectory(at: coordination, withIntermediateDirectories: false)
    let child = Process()
    child.executableURL = Bundle.main.executableURL
    child.arguments = ["--reading-worker", scope.root.path, scope.file.path, coordination.path]
    try child.run()
    defer { if child.isRunning { child.terminate() } }
    func waitFor(_ name: String) async throws {
      let deadline = ContinuousClock.now + .seconds(2)
      while !FileManager.default.fileExists(atPath: coordination.appendingPathComponent(name).path) {
        guard child.isRunning, ContinuousClock.now < deadline else { throw NativeFailure("First rename worker did not signal \(name).") }
        try await Task.sleep(nanoseconds: 10_000_000)
      }
    }
    try await waitFor("held")
    let store = owner.readingStore
    store.onContention = { try? atomicWrite(coordination.appendingPathComponent("contended"), Data()) }
    defer { store.onContention = nil }
    let renamed = scope.root.appendingPathComponent("renamed.md")
    let operation = Task {
      try await host.webView.callAsyncJavaScript("return await window.desktop.fileOperation({action:'rename', path:source, name:'renamed.md'})",
                                                 arguments: ["source": source.path], in: nil, contentWorld: .page)
    }
    try await waitFor("contended")
    guard FileManager.default.fileExists(atPath: source.path), !FileManager.default.fileExists(atPath: renamed.path),
          !FileManager.default.fileExists(atPath: scope.root.appendingPathComponent(".omarkie/store.jsonl").path) else {
      throw NativeFailure("First native rename did not wait for the journal lock.")
    }
    try atomicWrite(coordination.appendingPathComponent("release"), Data())
    guard let response = try await operation.value as? [String: Any], response["ok"] as? Bool == true,
          !FileManager.default.fileExists(atPath: source.path), try String(contentsOf: renamed, encoding: .utf8) == "Renamed note" else {
      throw NativeFailure("First native rename did not move the note.")
    }
    try await waitFor("written")
    _ = try await store.perform(.init(root: scope.root, file: renamed, document: "renamed.md"),
                                ["action": "put", "item": ["id": "renamed", "type": "card", "front": "Q", "back": "A"]])
    try atomicWrite(coordination.appendingPathComponent("read"), Data())
    try await waitFor("ids.json")
    child.waitUntilExit()
    let core = Bundle.main.resourceURL!.appendingPathComponent("reading-core.cjs")
    let entries = try await NativeReadingStore(core).perform(scope, ["action": "list", "scope": "vault"]) as? [[String: Any]] ?? []
    let pairs = Set(entries.compactMap { entry -> String? in
      guard let id = entry["id"] as? String, let document = entry["document"] as? String else { return nil }
      return "\(id):\(document)"
    })
    guard child.terminationStatus == 0, pairs == ["parallel-b:first.md", "renamed:renamed.md"] else {
      throw NativeFailure("First native journal stored incorrect paths.")
    }
  }
  @MainActor func checkReadingContention(_ scope: NativeReadingStore.Scope, expected: Set<String>) async throws {
    let core = Bundle.main.resourceURL!.appendingPathComponent("reading-core.cjs")
    let coordination = owner.directory.appendingPathComponent("journal-test")
    try FileManager.default.createDirectory(at: coordination, withIntermediateDirectories: false)
    let child = Process()
    child.executableURL = Bundle.main.executableURL
    child.arguments = ["--reading-worker", scope.root.path, scope.file.path, coordination.path]
    try child.run()
    defer { if child.isRunning { child.terminate() } }
    func waitFor(_ file: String) async throws {
      let deadline = ContinuousClock.now + .seconds(2)
      while !FileManager.default.fileExists(atPath: coordination.appendingPathComponent(file).path) {
        guard child.isRunning, ContinuousClock.now < deadline else { throw NativeFailure("Reading worker did not signal \(file).") }
        try await Task.sleep(nanoseconds: 10_000_000)
      }
    }
    try await waitFor("held")
    let store = NativeReadingStore(core)
    store.onContention = { try? atomicWrite(coordination.appendingPathComponent("contended"), Data()) }
    let journal = scope.root.appendingPathComponent(".omarkie/store.jsonl")
    let before = try Data(contentsOf: journal)
    let put = Task { try await store.perform(scope, ["action": "put", "item": ["id": "parallel-a", "type": "card", "front": "A", "back": "1"]]) }
    try await waitFor("contended")
    let indexFile = scope.root.appendingPathComponent(".omarkie/index.json")
    guard try Data(contentsOf: journal) == before else { throw NativeFailure("Native append escaped the worker lock.") }
    try atomicWrite(coordination.appendingPathComponent("release"), Data())
    _ = try await put.value
    try await waitFor("written")
    try atomicWrite(coordination.appendingPathComponent("read"), Data())
    try await waitFor("ids.json")
    let local = try await store.perform(scope, ["action": "list", "scope": "vault"]) as? [[String: Any]] ?? []
    let remote = try JSONDecoder().decode([String].self, from: Data(contentsOf: coordination.appendingPathComponent("ids.json")))
    guard !FileManager.default.fileExists(atPath: indexFile.path) else { throw NativeFailure("Reading index must stay in memory.") }
    let fresh = NativeReadingStore(core)
    let replayed = try await fresh.perform(scope, ["action": "list", "scope": "vault"]) as? [[String: Any]] ?? []
    for ids in [local.compactMap { $0["id"] as? String }, remote, replayed.compactMap { $0["id"] as? String }] {
      guard ids.count == expected.count, Set(ids) == expected else { throw NativeFailure("Concurrent native writers disagree on commits.") }
    }
    child.waitUntilExit()
    guard child.terminationStatus == 0 else { throw NativeFailure("Native reading worker failed.") }
  }
  @MainActor func checkReaderPersistence() async throws {
    let directory = owner.directory, root = canonicalFileURL(directory).path
    let bibliography = owner.bibliographyService()
    let export = directory.appendingPathComponent("native-zotero.json")
    let attachment = directory.appendingPathComponent("native-cited.pdf")
    try atomicWrite(attachment, Data("%PDF-1.7\n".utf8))
    func waitForInfo(_ stale: Bool, title: String) async throws {
      let deadline = ContinuousClock.now + .seconds(5)
      while ContinuousClock.now < deadline {
        if let info = try bibliography.perform(root, "info") as? [String: Any],
           info["stale"] as? Bool == stale,
           (info["csl"] as? String)?.contains(title) == true { return }
        try await Task.sleep(nanoseconds: 50_000_000)
      }
      throw NativeFailure("Native Zotero watcher did not reach expected state for \(title).")
    }
    try atomicWrite(export, Data("[".utf8))
    try await waitForInfo(true, title: "Watched native reference")
    let updated: [[String: Any]] = [["id": "new", "type": "book", "title": "Updated native reference", "omarkie-pdf": [attachment.path]]]
    try atomicWrite(export, try JSONSerialization.data(withJSONObject: updated))
    try await waitForInfo(false, title: "Updated native reference")
    guard let live = try bibliography.perform(root, "info") as? [String: Any], live["stale"] as? Bool == false,
          let csl = live["csl"] as? String, csl.contains("Updated native reference"), !csl.contains(attachment.path),
          try bibliography.perform(root, "open", "new") as? String == canonicalFileURL(attachment).path else {
      throw NativeFailure("Native Zotero replacement, CSL isolation or PDF resolution failed.")
    }
    let options: [String: Any] = ["bibliography": csl, "style": "vancouver"]
    let note = try Interchange.renderedExport(source: "# Note\n\nCitation [@new].\n", workingDirectory: directory, temporaryDirectory: directory, options: options)
    let project = try Interchange.renderedExport(source: "", workingDirectory: directory, temporaryDirectory: directory, options: options, chapters: ["# First\n\nCitation [@new].\n", "# Second\n\nAgain [@new].\n"])
    guard note.contains("Updated native reference"), project.components(separatedBy: "Updated native reference").count == 2 else {
      throw NativeFailure("Single note and project did not share the native bibliography.")
    }
    let output = directory.deletingLastPathComponent()
    let uiURL = output.appendingPathComponent("native-project-ui.pdf")
    guard PDFDocument(url: uiURL)?.string?.contains("Diagram chapter") == true,
          let uiPDF = CGPDFDocument(uiURL as CFURL) else {
      throw NativeFailure("Native UI project PDF lost the diagram chapter.")
    }
    var imageCount = 0
    for number in 1...uiPDF.numberOfPages {
      var resources: CGPDFDictionaryRef?, objects: CGPDFDictionaryRef?
      guard let page = uiPDF.page(at: number)?.dictionary,
            CGPDFDictionaryGetDictionary(page, "Resources", &resources), let resources,
            CGPDFDictionaryGetDictionary(resources, "XObject", &objects), let objects else { continue }
      CGPDFDictionaryApplyFunction(objects, { _, object, context in
        var stream: CGPDFStreamRef?, subtype: UnsafePointer<CChar>?
        guard CGPDFObjectGetValue(object, .stream, &stream), let stream,
              let dictionary = CGPDFStreamGetDictionary(stream),
              CGPDFDictionaryGetName(dictionary, "Subtype", &subtype), let subtype,
              String(cString: subtype) == "Image" else { return }
        context?.assumingMemoryBound(to: Int.self).pointee += 1
      }, &imageCount)
    }
    guard imageCount == 2 else { throw NativeFailure("Native UI project PDF did not rasterize both diagrams.") }
    let docxURL = output.appendingPathComponent("native-project.docx")
    let pdfURL = output.appendingPathComponent("native-project.pdf")
    guard let converter = Interchange.pandoc(),
          let pdfText = PDFDocument(url: pdfURL)?.string else { throw NativeFailure("Native project files were not generated.") }
    let docxText = String(decoding: try Interchange.run(converter, arguments: [docxURL.path, "--to=plain"], input: nil, directory: directory), as: UTF8.self)
    for text in [docxText, pdfText] {
      guard let first = text.range(of: "First native chapter"),
            let second = text.range(of: "Second native chapter"), first.lowerBound < second.lowerBound,
            text.components(separatedBy: "Watched native reference").count == 2 else {
        throw NativeFailure("Native project output lost chapter order or duplicated the bibliography.")
      }
    }
    print("PASS: native Zotero stale/live state, PDF resolution, chapter order and one citeproc bibliography")
    let cached = directory.appendingPathComponent("bibliographies/" + hashData(Data(root.utf8)) + ".json")
    let before = try Data(contentsOf: cached)
    let restoring = NativeWindowHost(owner: owner, directory: output.appendingPathComponent("restore-window"))
    _ = try await restoring.scanVault(directory)
    owner.hosts.append(restoring)
    defer { owner.hosts.removeAll { $0 === restoring } }
    _ = try await host.openShowcase(names: [])
    guard let nextVault = host.store.folder else { throw NativeFailure("Missing destination vault.") }
    try atomicWrite(restoring.store.dataDirectory.appendingPathComponent("session.json"),
                    JSONEncoder().encode(SessionRecord(documents: [], folder: nextVault.path)))
    _ = try await restoring.handle("restore", [])
    guard restoring.store.folder == nextVault else { throw NativeFailure("Renderer session restore did not switch vaults.") }
    try atomicWrite(export, Data("[{\"id\":\"closed\",\"type\":\"book\",\"title\":\"Closed vault must not refresh\"}]".utf8))
    try await Task.sleep(nanoseconds: 1_600_000_000)
    guard try Data(contentsOf: cached) == before else { throw NativeFailure("Zotero refreshed after the last window left its vault.") }
  }
  func fail(_ error: Error) {
    fputs("\(error)\n", stderr)
    exit(1)
  }
}
@main struct WebKitTestMain {
  static func readingWorker(_ args: [String]) async throws {
    let root = URL(fileURLWithPath: args[2]), file = URL(fileURLWithPath: args[3]), coordination = URL(fileURLWithPath: args[4])
    let scope = NativeReadingStore.Scope(root: root, file: file, document: file.lastPathComponent)
    let store = NativeReadingStore(Bundle.main.resourceURL!.appendingPathComponent("reading-core.cjs"))
    _ = try await store.perform(scope, ["action": "list"])
    _ = try await store.moveEntries(root) { _ in
      try atomicWrite(coordination.appendingPathComponent("held"), Data())
      let deadline = ContinuousClock.now + .seconds(2)
      while !FileManager.default.fileExists(atPath: coordination.appendingPathComponent("release").path) {
        guard ContinuousClock.now < deadline else { throw NativeFailure("Reading lock was not released by the test.") }
        Thread.sleep(forTimeInterval: 0.01)
      }
      return [:]
    }
    _ = try await store.perform(scope, ["action": "put", "item": ["id": "parallel-b", "type": "card", "front": "B", "back": "2"]])
    try atomicWrite(coordination.appendingPathComponent("written"), Data())
    let deadline = ContinuousClock.now + .seconds(2)
    while !FileManager.default.fileExists(atPath: coordination.appendingPathComponent("read").path) {
      guard ContinuousClock.now < deadline else { throw NativeFailure("Reading worker did not receive the list signal.") }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    let entries = try await store.perform(scope, ["action": "list", "scope": "vault"]) as? [[String: Any]] ?? []
    try atomicWrite(coordination.appendingPathComponent("ids.json"), JSONEncoder().encode(entries.compactMap { $0["id"] as? String }))
  }
  static func main() {
    setbuf(stdout, nil)
    if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--collision-worker" {
      Task {
        let root = URL(fileURLWithPath: CommandLine.arguments[2])
        let reading = NativeReadingStore(Bundle.main.resourceURL!.appendingPathComponent("reading-core.cjs"))
        let pause = {
          do { try atomicWrite(root.appendingPathComponent("interrupted"), Data()) }
          catch { exit(1) }
          while true { Thread.sleep(forTimeInterval: 1) }
        }
        if CommandLine.arguments[3] == "after" { reading.beforeMoveCommit = pause }
        else { reading.afterMoveIntent = pause }
        do {
          _ = try await reading.moveEntries(root) { move in
            try move(root.appendingPathComponent("source.md"), root.appendingPathComponent("destination.md"))
            return [:]
          }
        } catch { fputs("\(error)\n", stderr) }
        exit(1)
      }
      dispatchMain()
    }
    if CommandLine.arguments.count == 5, CommandLine.arguments[1] == "--reading-worker" {
      Task {
        do { try await readingWorker(CommandLine.arguments); exit(0) }
        catch { fputs("\(error)\n", stderr); exit(1) }
      }
      dispatchMain()
    }
    let app = NSApplication.shared
    let delegate = WebKitTests()
    app.delegate = delegate
    app.setActivationPolicy(.prohibited)
    app.run()
    withExtendedLifetime(delegate) {}
  }
}
