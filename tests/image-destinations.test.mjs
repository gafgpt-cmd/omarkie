import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { referenceIndex, bundlePlan } from "../shared/references.mjs";
import { DocumentStore } from "../electron/store.mjs";
import { vaultSnapshot, exportBundle } from "../electron/document-workflows.mjs";
const dom = new JSDOM("<!doctype html><body></body>");
for (const key of ["window", "document", "DOMParser", "HTMLElement", "Node"]) globalThis[key] = dom.window[key];
const { imageReferences, updateImageReferences } = await import("../src/editor/images.ts");
const { imageRange, resizedImage } = await import("../src/plugins/reading/imageSyntax.ts");
const { localImageSources, renderMarkdown } = await import("../src/editor/markdown.ts");
const { MarkdownDocument } = await import("../src/editor/model.ts");
const cases = [
  ['![alt](plot(v2).png)', 'plot(v2).png'],
  ['![nested [alt]](plot(v(2)).png "keep ) title")', 'plot(v(2)).png'],
  ['![escaped\\] alt](plot\\(v2\\).png)', 'plot(v2).png'],
  ['![alt](<folder/my plot(v2).png> "keep (title)")', 'folder/my plot(v2).png'],
  ['![alt](folder/my plot(v2).png "keep ) title")', 'folder/my plot(v2).png'],
];
for (const [markup, target] of cases) {
  test(`complete image destination: ${markup}`, async () => {
    const source = `# Source\r\n\n${markup}\r\n\r\n[Report](report(v2).md "note title")\n`, root = await mkdtemp(path.join(os.tmpdir(), "image-destinations-"));
    const vault = path.join(root, "vault"), output = path.join(root, "output"); await mkdir(vault); await mkdir(output);
    await mkdir(path.dirname(path.join(vault, target)), { recursive: true });
    await writeFile(path.join(vault, "start.md"), source); await writeFile(path.join(vault, "report(v2).md"), "# Report\n");
    await writeFile(path.join(vault, target), "synthetic image bytes"); await writeFile(path.join(vault, "unused.png"), "unused");
    const store = new DocumentStore(path.join(root, "profile")); await store.scan(vault);
    const inventory = await vaultSnapshot(store), index = referenceIndex(inventory);
    assert.deepEqual(index.broken, []); assert.deepEqual(index.unused.map(asset => asset.relative), ["unused.png"]);
    const from = index.notes.find(note => note.relative === "start.md"), report = index.notes.find(note => note.relative === "report(v2).md");
    assert.equal(index.resolve(from, target, false).candidates[0].relative, target);
    assert.equal(index.backlinks(report).length, 1);
    const plan = bundlePlan(inventory), destination = await exportBundle(store, plan, output), copied = await readFile(path.join(destination, "notes/start.md"), "utf8");
    const article = document.createElement("article"); article.innerHTML = renderMarkdown(copied, "copy");
    assert.equal(article.querySelector("a").getAttribute("href"), "../notes/report%28v2%29.md");
    const imageURL = decodeURIComponent(new URL(article.querySelector("img").getAttribute("src")).pathname.split("/").slice(2).join("/"));
    assert.equal(decodeURIComponent(imageURL), "../assets/" + target);
    assert.equal(await readFile(path.resolve(destination, "notes", decodeURIComponent(imageURL)), "utf8"), "synthetic image bytes");
    assert.equal(await readFile(path.join(vault, "start.md"), "utf8"), source);
    assert.deepEqual(localImageSources(source), [target]);
    const [image] = imageReferences(source); assert.equal(image.url, target); assert.equal(image.source, markup);
    assert.equal(source.slice(image.from, image.to), markup);
    const changed = updateImageReferences(source, { [target]: "replacement.png" });
    assert.equal(changed.slice(0, image.from), source.slice(0, image.from));
    assert.ok(changed.endsWith(source.slice(image.to)));
    assert.equal(imageReferences(changed)[0].url, "replacement.png");
  });
  test(`resize and undo preserve mixed endings: ${markup}`, () => {
    const source = `Before.\r\n\r\n${markup}\r\n\nAfter.\r\n`, doc = new MarkdownDocument(source);
    const range = imageRange(doc.text, doc.text.indexOf("![")); assert.equal(range.source, markup);
    const resized = resizedImage(range.source, 300, 150); assert.equal(resized, markup + "{width=300}");
    doc.replace(range.from, range.to, resized, "document-command");
    const expected = source.replace(markup, markup + "{width=300}"); assert.equal(doc.toMarkdown(), expected);
    assert.equal(imageReferences(doc.text)[0].url, target);
    assert.equal(doc.undo(), true); assert.equal(doc.toMarkdown(), source);
    assert.equal(doc.redo(), true); assert.equal(doc.toMarkdown(), expected);
  });
}
test("unclosed destinations cannot become partial resize ranges", () => {
  for (const source of ['![alt](plot(v2).png', '![alt](plot(v2.png)', '![alt](<plot(v2).png)']) {
    assert.deepEqual(imageReferences(source), []); assert.equal(imageRange(source, 0), undefined);
  }
});
