import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JSDOM } from "jsdom";
import { references, referenceIndex, bundlePlan } from "../shared/references.mjs";
import { validateOKF } from "../shared/frontmatter.mjs";
import { createMarkdown } from "../shared/markdown.mjs";
import { DocumentStore } from "../electron/store.mjs";
import { vaultSnapshot, exportBundle } from "../electron/document-workflows.mjs";
const dom = new JSDOM("<!doctype html><body></body>");
for (const name of ["window", "document", "DOMParser", "HTMLElement", "Node"]) globalThis[name] = dom.window[name];
const { renderMarkdown } = await import("../src/editor/markdown.ts");
const note = (relative, content) => ({ relative, content, token: relative });
function article(content, stock = false) { const element = document.createElement("article"); element.innerHTML = stock ? createMarkdown().render(content) : renderMarkdown(content, "fixture"); return element; }

test("portable names normalize extensions before reserving names and detecting collisions", () => {
  for (const extension of ["markdown", "mdown"]) for (const base of ["index", "log"]) for (const parent of ["", "Folder/"]) for (const upper of [false, true]) {
    const name = (upper ? base.toUpperCase() : base) + "." + (upper ? extension.toUpperCase() : extension), relative = parent + name;
    const source = `[[${relative}|Open]]`, value = { notes: [note("start.md", source), note(relative, "# Target\n")], assets: [], truncated: false };
    const plan = bundlePlan(value), expected = "notes/" + parent + "_" + (upper ? base.toUpperCase() : base) + ".md";
    assert.ok(plan.notes.some(note => note.relative === expected));
    assert.equal(article(plan.notes[0].content).querySelector("a").getAttribute("href"), "../" + expected);
    assert.ok([...article(plan.index).querySelectorAll("a")].some(link => link.getAttribute("href") === expected));
    for (const item of plan.notes) assert.deepEqual(validateOKF(item.content, item.relative.split("/").at(-1)), []);
    assert.equal(value.notes[0].content, source); assert.equal(value.notes[1].relative, relative);
  }
  for (const pair of [["index.md", "index.markdown"], ["Folder/log.mdown", "Folder/_log.md"], ["Folder/index.mdown", "folder/INDEX.markdown"]]) {
    assert.throws(() => bundlePlan({ notes: pair.map(relative => note(relative, "# Target")), assets: [], truncated: false }));
  }
});

for (const eol of ["\n", "\r\n", "\r"]) {
  test(`reference labels, definitions and titles retain rendered meaning: ${JSON.stringify(eol)}`, async () => {
    const source = ['# Source', '', '[Home][home]', '[Multi][multi', 'line]', '[Escaped][br\\]acket]', '[Collapsed][]', '[Shortcut]', '![Photo][photo', 'id]', 'Body[^n].', '[Inline](Target.md "Inline [[literal]] #inline")', '', '[home]: Target.md', ' "Example &amp;amp; [[literal]] #demo"', '[multi', 'line]: Target.md', '[br\\]acket]: Target.md', '[Collapsed]: Target.md', '[Shortcut]: Target.md', '[photo', 'id]: photo.png', " 'Photo [[literal]] #photo'", '', '[^n]: [Foot][home]', '    [[Target]]'].join(eol);
    const parsed = references(source); assert.equal(parsed.references.length, 9); assert.deepEqual(parsed.tags, []);
    assert.ok(!parsed.references.some(ref => ref.target === "literal"));
    assert.equal(parsed.references.find(ref => ref.alias === "Multi").source, '[Multi][multi' + eol + 'line]');
    assert.equal(parsed.references.find(ref => ref.alias === "Photo").source, '![Photo][photo' + eol + 'id]');
    for (const ref of parsed.references) assert.equal(source.slice(ref.from, ref.to), ref.source);
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "reference-style-"))), vault = path.join(root, "vault"), output = path.join(root, "output");
    await mkdir(vault); await mkdir(output); await writeFile(path.join(vault, "start.md"), source); await writeFile(path.join(vault, "Target.md"), "# Target"); await writeFile(path.join(vault, "photo.png"), "image bytes");
    const store = new DocumentStore(path.join(root, "profile")); await store.scan(vault);
    const inventory = await vaultSnapshot(store), index = referenceIndex(inventory), target = index.notes.find(note => note.relative === "Target.md");
    assert.deepEqual(index.broken, []); assert.deepEqual(index.unused, []); assert.equal(index.backlinks(target).length, 8);
    const plan = bundlePlan(inventory), destination = await exportBundle(store, plan, output), copied = await readFile(path.join(destination, "notes/start.md"), "utf8");
    const before = article(source), after = article(copied);
    for (const label of ["Home", "Multi", "Escaped", "Collapsed", "Shortcut", "Inline", "Foot"]) {
      const original = [...before.querySelectorAll("a")].find(link => link.textContent === label), changed = [...after.querySelectorAll("a")].find(link => link.textContent === label);
      assert.ok(original); assert.ok(changed); assert.equal(changed.getAttribute("href"), "../notes/Target.md");
      assert.equal(changed.getAttribute("title"), original.getAttribute("title"));
    }
    assert.equal(article(copied, true).querySelector("img").getAttribute("title"), "Photo [[literal]] #photo");
    const copyIndex = referenceIndex({ notes: [note("notes/start.md", copied), note("notes/Target.md", plan.notes.find(note => note.relative === "notes/Target.md").content)], assets: [{ relative: "assets/photo.png" }], truncated: false });
    assert.deepEqual(copyIndex.broken, []); assert.deepEqual(copyIndex.notes[0].tags, []);
    assert.equal(await readFile(path.join(vault, "start.md"), "utf8"), source);
    assert.equal(await readFile(path.join(destination, "assets/photo.png"), "utf8"), "image bytes");
  });
}
