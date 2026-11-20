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
      let store = DocumentStore(directory)
      let plugin = directory.appendingPathComponent("Native-plugin-fixture.js")
      try atomicWrite(plugin, Data("class NativePlugin extends BasePlugin { style() { return '#write { --plugin-fixture: loaded; }' }; call() { this.utils.insertText('插件') } }; module.exports = {plugin: NativePlugin};".utf8))
      _ = try Interchange.installPlugin(plugin, directory: directory)
      _ = try Interchange.installPlugin(Bundle.main.resourceURL!.appendingPathComponent("Plugin-package-fixture"), directory: directory)
      try atomicWrite(directory.appendingPathComponent("Background-fixture.png"),Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNNsAAAAASUVORK5CYII=")!)
      try atomicWrite(directory.appendingPathComponent("native-zotero.json"), Data("[{\"id\":\"watched\",\"type\":\"book\",\"title\":\"Watched native reference\"}]".utf8))
      let record = try store.open(file, id: "webkit-fixture")
      host = NativeWindowHost(
        owner: owner, directory: directory,
        seed: SessionRecord(documents: [record], activeId: record.id, folder: canonicalFileURL(directory).path))
      owner.hosts.append(host)
      host.show(hidden: true)
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
              try await self.checkReaderPersistence()
              exit(0)
            } catch { self.fail(error) }
          }
        } catch { self.fail(error) }
      }
    } catch { fail(error) }
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
    print("PASS: native journal replay, Markdown export and exclusive destination")
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
    let reopened = NativeBibliographies(directory) { _ in }
    guard let live = try reopened.perform(root, "info") as? [String: Any], live["stale"] as? Bool == false,
          let csl = live["csl"] as? String, csl.contains("Updated native reference"), !csl.contains(attachment.path),
          try reopened.perform(root, "open", "new") as? String == canonicalFileURL(attachment).path else {
      throw NativeFailure("Native Zotero replacement, CSL isolation or PDF resolution failed.")
    }
    let options: [String: Any] = ["bibliography": csl, "style": "vancouver"]
    let note = try Interchange.renderedExport(source: "# Note\n\nCitation [@new].\n", workingDirectory: directory, temporaryDirectory: directory, options: options)
    let project = try Interchange.renderedExport(source: "", workingDirectory: directory, temporaryDirectory: directory, options: options, chapters: ["# First\n\nCitation [@new].\n", "# Second\n\nAgain [@new].\n"])
    guard note.contains("Updated native reference"), project.components(separatedBy: "Updated native reference").count == 2 else {
      throw NativeFailure("Single note and project did not share the native bibliography.")
    }
    let output = directory.deletingLastPathComponent()
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
  }
  func fail(_ error: Error) {
    fputs("\(error)\n", stderr)
    exit(1)
  }
}
@main struct WebKitTestMain {
  static func main() {
    setbuf(stdout, nil)
    let app = NSApplication.shared
    let delegate = WebKitTests()
    app.delegate = delegate
    app.setActivationPolicy(.prohibited)
    app.run()
    withExtendedLifetime(delegate) {}
  }
}
