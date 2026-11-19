import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { references, referenceIndex, bundlePlan } from "../shared/references.mjs";
import { frontmatter, properties, setProperties } from "../shared/frontmatter.mjs";
import { DocumentStore } from "../electron/store.mjs";
import { vaultSnapshot, exportBundle } from "../electron/document-workflows.mjs";
const dom = new JSDOM("<!doctype html><body></body>");
for (const name of ["window", "document", "DOMParser", "HTMLElement", "Node"]) globalThis[name] = dom.window[name];
const { renderMarkdown } = await import("../src/editor/markdown.ts");
const note = (relative, content) => ({ relative, content, token: relative });
function article(content) { const value = document.createElement("article"); value.innerHTML = renderMarkdown(content, "fixture"); return value; }

for (const endings of [["\n"], ["\r\n"], ["\r"], ["\r", "\r\n", "\n"]]) for (const bom of ["", "\uFEFF"]) for (const terminated of [false, true]) {
  test(`original offsets and copied bytes: ${JSON.stringify({ endings, bom: !!bom, terminated })}`, async () => {
    const lines = ['---', 'type: Reference', 'title: Source', 'tags: []', 'custom: retained # keep', '---', '# Start', '', '[[Target]] #topic', '`[[code]] #code`', '<span>[[literal]] #html</span>', '$[[math]] #math$', '[Target link](Target.md#end)', '<img', 'alt="A > B"', 'src="photo.png">', '', '# End'];
    const source = bom + lines.map((line, index) => line + (index < lines.length - 1 || terminated ? endings[index % endings.length] : "")).join("");
    const parsed = references(source);
    assert.deepEqual(parsed.references.map(({ target, line }) => ({ target, line })), [{ target: "Target", line: 9 }, { target: "Target.md#end", line: 13 }, { target: "photo.png", line: 14 }]);
    assert.deepEqual(parsed.tags, [{ tag: "topic", line: 9 }]);
    assert.deepEqual(parsed.headings.map(({ id, line }) => ({ id, line })), [{ id: "start", line: 7 }, { id: "end", line: 18 }]);
    for (const ref of parsed.references) {
      assert.equal(source.slice(ref.from, ref.to), ref.source);
      if (ref.destinationRange) assert.equal(ref.source.slice(...ref.destinationRange), ref.target);
    }
    assert.equal(properties(source).custom, "retained");
    const patched = setProperties(source, { title: "Updated", generated: { by: "process:test" } });
    assert.equal(properties(patched).title, "Updated"); assert.equal(properties(patched).custom, "retained");
    assert.equal(frontmatter(patched).body, frontmatter(source).body);
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "reference-endings-"))), vault = path.join(root, "vault"), output = path.join(root, "output");
    await mkdir(vault); await mkdir(output); await writeFile(path.join(vault, "start.md"), source); await writeFile(path.join(vault, "Target.md"), "# End\r"); await writeFile(path.join(vault, "photo.png"), "image bytes");
    const store = new DocumentStore(path.join(root, "profile")); await store.scan(vault);
    const inventory = await vaultSnapshot(store); inventory.notes.find(note => note.relative === "start.md").content = source;
    const index = referenceIndex(inventory); assert.deepEqual(index.broken, []); assert.deepEqual(index.unused, []);
    const from = index.notes.find(note => note.relative === "start.md"); assert.equal(index.resolve(from, "Target#end").line, 1);
    assert.equal(index.tags("topic")[0].relative, "start.md");
    const destination = await exportBundle(store, bundlePlan(inventory), output), copied = await readFile(path.join(destination, "notes/start.md"), "utf8");
    const expected = source.replace('[[Target]]', '[Target](../notes/Target.md)').replace('(Target.md#end)', '(../notes/Target.md#end)').replace('src="photo.png"', 'src="../assets/photo.png"');
    assert.equal(copied, expected); assert.equal(await readFile(path.join(vault, "start.md"), "utf8"), source);
    assert.equal(await readFile(path.join(destination, "assets/photo.png"), "utf8"), "image bytes");
    assert.equal(article(copied).querySelector('a[href="../notes/Target.md#end"]').textContent, "Target link");
    assert.equal(article(copied).querySelector("img").getAttribute("alt"), "A > B");
  });
}

test("raw HTML examples stay literal while actual HTML destinations remain portable", () => {
  const source = '<pre>\n[[literal]] #example [Markdown](missing.md)\n&lt;img src="encoded.png"&gt;\n</pre>\n\n<div title="literal <script>">\n<a href="index.md">Home</a>\n<img src="photo.png" alt="A > B">\n<script>\n<img src="script.png"> [[opaque]] #script\n\n</script>\n<style><a href="style.md">opaque</a></style>\n<textarea><img src="textarea.png"> [[opaque]]</textarea>\n<!-- <img src="comment.png"> [[comment]] #comment -->\n<pre>[[nested]] #nested</pre>\n</div>\n';
  for (const exists of [false, true]) {
    const value = { notes: [note("start.md", source), note("index.md", "# Home"), ...(exists ? [note("literal.md", "# Literal")] : [])], assets: [{ relative: "photo.png" }], truncated: false };
    const index = referenceIndex(value); assert.deepEqual(index.edges.map(edge => edge.ref.target), ["index.md", "photo.png"]);
    assert.deepEqual(index.broken, []); assert.deepEqual(index.unused, []); assert.deepEqual(index.notes[0].tags, []);
    const plan = bundlePlan(value), before = article(source), after = article(plan.notes[0].content);
    assert.deepEqual([...after.querySelectorAll("pre")].map(node => node.textContent), [...before.querySelectorAll("pre")].map(node => node.textContent));
    assert.equal(after.querySelector("a").textContent, "Home"); assert.equal(after.querySelector("a").getAttribute("href"), "../notes/_index.md");
    assert.equal(after.querySelectorAll("img").length, 1); assert.equal(after.querySelector("img").getAttribute("alt"), "A > B");
    assert.deepEqual(plan.assets.map(asset => asset.source), ["photo.png"]); assert.equal(value.notes[0].content, source);
  }
});
for (const tag of ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext"]) {
  test(`opaque HTML content is not a resource inventory: ${tag}`, () => {
    const source = `<${tag}>\n[[literal]] #example <img src="fake.png">\n\n${tag === "plaintext" ? '' : `</${tag}>`}`;
    const parsed = references(source); assert.deepEqual(parsed.references, []); assert.deepEqual(parsed.tags, []);
    const copy = bundlePlan({ notes: [note("start.md", source)], assets: [], truncated: false }).notes[0].content;
    assert.equal(article(copy).textContent, article(source).textContent);
  });
}

test("duplicate-name inventories append buckets with bounded traversal and keep ambiguity", () => {
  const count = 20000, value = { notes: [note("start.md", "![[image.png]]")], assets: Array.from({ length: count }, (_, index) => ({ relative: `folder-${index}/image.png` })), truncated: false };
  const original = Array.prototype[Symbol.iterator]; let visits = 0, index;
  Array.prototype[Symbol.iterator] = function*() { for (const item of original.call(this)) { visits++; yield item; } };
  try { index = referenceIndex(value); } finally { Array.prototype[Symbol.iterator] = original; }
  assert.ok(visits < count * 64, `${visits} array iterator visits`);
  assert.equal(index.edges[0].state, "ambiguous"); assert.equal(index.edges[0].candidates.length, count); assert.deepEqual(index.unused, []);
  assert.equal(index.resolve(index.notes[0], "folder-19999/image.png").candidates[0].relative, "folder-19999/image.png");
  assert.throws(() => bundlePlan(value), /ambiguous/);
  const aliases = { notes: [note("start.md", "[[Label]]"), note("Folder/A.md", '---\naliases: [Label, LABEL]\n---\n'), note("folder/a.md", '---\naliases: [Label]\n---\n')], assets: [], truncated: false };
  const duplicate = referenceIndex(aliases), from = duplicate.notes[0];
  for (const target of ["Label", "folder/a.md"]) { const resolved = duplicate.resolve(from, target); assert.equal(resolved.state, "ambiguous"); assert.equal(resolved.candidates.length, 2); }
  assert.throws(() => bundlePlan(aliases));
  const unique = referenceIndex({ ...aliases, notes: aliases.notes.slice(0, 2) });
  assert.equal(unique.resolve(unique.notes[0], "LABEL").state, "resolved");
  assert.equal(aliases.notes[1].content, '---\naliases: [Label, LABEL]\n---\n');
});
