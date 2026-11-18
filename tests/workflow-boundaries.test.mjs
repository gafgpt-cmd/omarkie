import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat, symlink, readlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JSDOM } from "jsdom";
import { DocumentStore, encodeText, digest } from "../electron/store.mjs";
import { Workspace } from "../electron/workspace.mjs";
import { vaultSnapshot, exportBundle } from "../electron/document-workflows.mjs";
import { references, referenceIndex, bundlePlan } from "../shared/references.mjs";
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://editor.test/" });
for (const name of ["window", "document", "DOMParser", "HTMLElement", "Node"]) globalThis[name] = dom.window[name];
const { renderMarkdown, extractHeadings, setMarkdownOptions } = await import("../src/editor/markdown.ts");
const note = (relative, content) => ({ token: relative, relative, content });
const snapshot = (notes, assets = []) => ({ notes, assets: assets.map(relative => ({ relative })), truncated: false });
const defaults = { highlight: true, subscript: true, superscript: true, emoji: true, inlineMath: true };
async function fixture() { return realpath(await mkdtemp(path.join(os.tmpdir(), "workflow-boundaries-"))); }
function article(content) { const element = document.createElement("article"); element.innerHTML = renderMarkdown(content, "fixture"); return element; }

test("copied parenthesis filenames remain complete Markdown destinations and index entries", async () => {
  const root = await fixture(), vault = path.join(root, "vault"), output = path.join(root, "output");
  await mkdir(vault); await mkdir(output);
  const source = '[[draft)final]] [[draft(final]] ![[plot)final.png]] ![[plot(final.png]]\n';
  for (const [name, content] of [["start.md", source], ["draft)final.md", "# Closing\n"], ["draft(final.md", "# Opening\n"], ["plot)final.png", "closing image"], ["plot(final.png", "opening image"]]) await writeFile(path.join(vault, name), content);
  const store = new DocumentStore(path.join(root, "profile")); await store.scan(vault);
  const plan = bundlePlan(await vaultSnapshot(store)), destination = await exportBundle(store, plan, output);
  const copied = article(await readFile(path.join(destination, "notes/start.md"), "utf8"));
  assert.deepEqual([...copied.querySelectorAll("a")].map(link => decodeURIComponent(link.getAttribute("href"))), ["../notes/draft)final.md", "../notes/draft(final.md"]);
  assert.equal(copied.querySelectorAll("img").length, 2);
  for (const image of copied.querySelectorAll("img")) {
    const relative = decodeURIComponent(decodeURIComponent(new URL(image.getAttribute("src")).pathname.split("/").slice(2).join("/")));
    assert.ok(["closing image", "opening image"].includes(await readFile(path.resolve(destination, "notes", relative), "utf8")));
  }
  for (const link of article(await readFile(path.join(destination, "index.md"), "utf8")).querySelectorAll("a")) assert.ok((await stat(path.join(destination, decodeURIComponent(link.getAttribute("href"))))).isFile());
  assert.equal(await readFile(path.join(vault, "start.md"), "utf8"), source);
});

test("HTML anchors share resolution, backlinks and exact href rewrites", () => {
  const source = '# Start\n\n<a class="keep" href="index.md">Home</a>\n<a href=\'a&amp;b.md#target\' title="keep">Entity</a>\n<a href="#start">Self</a>\n<a href="https://example.test/">External</a>\n';
  const value = snapshot([note("start.md", source), note("index.md", "# Home\n"), note("a&b.md", "# Target\n")]);
  const index = referenceIndex(value);
  assert.equal(index.edges.length, 4); assert.equal(index.backlinks(index.notes[1]).length, 1); assert.deepEqual(index.broken, []);
  const plan = bundlePlan(value), copy = article(plan.notes[0].content);
  assert.equal(copy.querySelector("a.keep").getAttribute("href"), "../notes/_index.md");
  assert.equal(copy.querySelector('[title="keep"]').getAttribute("href"), "../notes/a%26b.md#target");
  assert.equal(copy.querySelector("a.keep").textContent, "Home");
  assert.ok(plan.notes[0].content.includes('<a href="https://example.test/">External</a>'));
  assert.equal(copy.querySelectorAll("a").length, 4);
  const bad = referenceIndex(snapshot([note("start.md", '<a href="../outside.md">Escape</a><a data-href="ignored.md">No link</a>')]));
  assert.deepEqual(bad.edges.map(edge => edge.state), ["escape"]);
  assert.equal(value.notes[0].content, source);
});

test("shared dialect matches headings, embeds, math exclusions and parser preferences", () => {
  const source = '# Formula $x$\n\n# HTML <b>visible</b>\n\n# Wiki ![[figure.png]]\n\n# Extras :smile: H~2~O X^2^\n\n$$\n\\text{[[literal]]} #not-tag\n$$\n\nInline $\\text{[[also-literal]]}$ stays literal.\n';
  for (const options of [defaults, { ...defaults, inlineMath: false, emoji: false, subscript: false, superscript: false }]) {
    setMarkdownOptions(options);
    const value = snapshot([note("note.md", source)], ["figure.png"]), expected = extractHeadings(source);
    const index = referenceIndex(value, options);
    assert.deepEqual(index.notes[0].headings.map(({ title, id, line }) => ({ text: title, id, line })), expected.map(({ text, id, line }) => ({ text, id, line })));
    assert.ok(!index.edges.some(edge => edge.ref.target === "literal"));
    if (options.inlineMath) assert.ok(!index.edges.some(edge => edge.ref.target === "also-literal"));
    assert.ok(!index.notes[0].tags.includes("not-tag"));
    if (options.inlineMath) {
      assert.deepEqual(index.broken, []);
      const plan = bundlePlan(value, "2026-01-01", options);
      assert.deepEqual(extractHeadings(plan.notes[0].content).map(heading => heading.id), expected.map(heading => heading.id));
      assert.ok(plan.notes[0].content.includes('\\text{[[literal]]} #not-tag'));
      const from = referenceIndex(snapshot([note("start.md", "[[note#formula]]"), note("note.md", source)], ["figure.png"]), options);
      assert.equal(from.edges.find(edge => edge.ref.target === "note#formula").state, "resolved");
    }
  }
  setMarkdownOptions(defaults);
});

test("snapshot retains opened legacy encodings, BOM precedence, hashes and malformed-file refusal", async () => {
  const root = await fixture(), vault = path.join(root, "vault"), output = path.join(root, "output"); await mkdir(vault); await mkdir(output);
  const file = path.join(vault, "legacy.md"), text = "# Café\r\n\r\nBody é\r\n", bytes = encodeText(text, "windows-1252");
  await writeFile(file, bytes);
  const store = new DocumentStore(path.join(root, "profile")), record = await store.open(file, false, "windows-1252"); await store.scan(vault);
  const inventory = await vaultSnapshot(store);
  assert.equal(inventory.truncated, false); assert.equal(inventory.notes[0].content, text);
  const destination = await exportBundle(store, bundlePlan(inventory), output);
  assert.ok((await readFile(path.join(destination, "notes/legacy.md"), "utf8")).includes("Café"));
  assert.deepEqual(await readFile(file), bytes); assert.equal(store.require(record.id).diskHash, digest(bytes));
  const updated = "# BOM wins\n"; await writeFile(file, encodeText(updated, "utf-16le", true));
  assert.equal((await vaultSnapshot(store)).notes[0].content, updated);
  await writeFile(path.join(vault, "malformed.md"), Buffer.from([0xc3, 0x28]));
  const partial = await vaultSnapshot(store); assert.equal(partial.truncated, true); assert.equal(partial.notes.length, 1);
  assert.throws(() => bundlePlan(partial));
});

for (const action of ["rename", "move", "undo"]) for (const directory of [false, true]) {
  test(`exclusive ${action} preserves both ${directory ? "directories" : "files"} on a late destination collision`, async () => {
    const root = await fixture(), source = path.join(root, directory ? "source" : "source.md"), child = path.join(root, "child"); await mkdir(child);
    if (directory) { await mkdir(source); await writeFile(path.join(source, "sentinel.md"), "source sentinel"); }
    else await writeFile(source, "source sentinel");
    const store = new DocumentStore(path.join(root, "profile")), workspace = new Workspace(store.dataDir); await store.scan(root);
    const doc = await store.open(directory ? path.join(source, "sentinel.md") : source); store.records.get(doc.id).content = "dirty draft";
    let operation = { action, path: source, ...(action === "move" ? { target: child } : { name: directory ? "renamed" : "renamed.md" }) };
    if (action === "undo") { const change = await workspace.execute({ action: "rename", path: source, name: directory ? "renamed" : "renamed.md" }, store); workspace.apply(change, store); operation = { action: "undo" }; }
    const from = action === "undo" ? workspace.undo.from : source, destination = action === "undo" ? workspace.undo.to : action === "move" ? path.join(child, path.basename(source)) : path.join(root, operation.name);
    const ownedPath = store.require(doc.id).path, undo = workspace.undo;
    const absent = workspace.absent.bind(workspace); let independent;
    workspace.absent = async file => { await absent(file); if (file === destination) { if (directory) { await mkdir(file); independent = (await stat(file)).ino; } else await writeFile(file, "destination sentinel", { flag: "wx" }); } };
    await assert.rejects(workspace.execute(operation, store));
    assert.equal(await readFile(directory ? path.join(from, "sentinel.md") : from, "utf8"), "source sentinel");
    if (directory) { assert.equal((await stat(destination)).ino, independent); await assert.rejects(readFile(path.join(destination, "sentinel.md"))); }
    else assert.equal(await readFile(destination, "utf8"), "destination sentinel");
    assert.equal(store.require(doc.id).path, ownedPath); assert.equal(store.require(doc.id).content, "dirty draft"); assert.equal(workspace.undo, undo);
  });
}

test("exclusive movement refuses a dangling destination symlink and preserves ordinary directory undo", async () => {
  const root = await fixture(), source = path.join(root, "source.md"), destination = path.join(root, "destination.md"), outside = path.join(root, "missing.md");
  await writeFile(source, "source sentinel");
  const store = new DocumentStore(path.join(root, "profile")), workspace = new Workspace(store.dataDir); await store.scan(root);
  if (process.platform !== "win32") {
    await symlink(outside, destination);
    await assert.rejects(workspace.execute({ action: "rename", path: source, name: "destination.md" }, store));
    assert.equal(await readlink(destination), outside); assert.equal(await readFile(source, "utf8"), "source sentinel");
  }
  const folder = path.join(root, "folder"); await mkdir(folder); await writeFile(path.join(folder, "note.md"), "nested bytes"); await store.scan(root);
  const change = await workspace.execute({ action: "rename", path: folder, name: "renamed" }, store);
  assert.equal(await readFile(path.join(change.toPath, "note.md"), "utf8"), "nested bytes");
  await workspace.execute({ action: "undo" }, store);
  assert.equal(await readFile(path.join(folder, "note.md"), "utf8"), "nested bytes");
});
