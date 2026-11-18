import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM('<!doctype html><div id="root"><main class="writing-area"><div class="document-editor"><div class="rich-document"></div></div></main></div>', { url: "http://localhost" });
for (const key of ["window", "document", "Element", "HTMLElement", "HTMLImageElement", "MutationObserver", "Event", "KeyboardEvent", "MouseEvent", "Node", "DOMParser"]) globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.CSS = { supports: () => true };
globalThis.innerWidth = 1200; globalThis.innerHeight = 800;
const { PluginRuntime } = await import("../src/plugins/runtime.ts");
const { MarkdownDocument } = await import("../src/editor/model.ts");
const { renderNode } = await import("../src/editor/richRender.ts");
const { resizedImage, imageRange } = await import("../src/plugins/reading/imageSyntax.ts");
const { imageReferences } = await import("../src/editor/images.ts");
const root = () => document.querySelector(".rich-document");
async function start(id, source, options = {}) {
  root().replaceChildren(); const doc = new MarkdownDocument(source), leaves = new Map();
  for (const node of doc.nodes) root().append(renderNode(node, "fixture", leaves, doc.environment));
  const states = {}, factory = (await import(`../src/plugins/reading/${id}.ts`)).default;
  let markdown = source;
  const run = new PluginRuntime({ getMarkdown: () => markdown, getPath: () => null, getDocumentId: () => "fixture", getSelection: () => "", insert() {}, replace() {}, setReadOnly() {}, notify() {}, changed: (id, state) => states[id] = state, saveConfig() {}, editable: () => true, ...options });
  const definition = { id, name: id, description: "", config: {}, factory };
  await run.setEnabled(definition, true); assert.equal(states[id].status, "ready", states[id].error);
  return { run, doc, leaves, definition, setMarkdown: value => markdown = value };
}
test("callout titles and fold suffixes preserve every source position; folding survives block replacement", async () => {
  const source = "> [!abstract]- A **custom** title\n> first body line\n>\n> second paragraph\n\n> [!tip]+ Open title\n> body\n";
  const state = await start("callouts", source);
  try {
    const quote = root().querySelector("blockquote");
    assert.equal(quote.dataset.alert, "abstract"); assert.ok(quote.classList.contains("reading-folded"));
    assert.match(quote.textContent, /custom/); assert.equal(quote.querySelector("strong").textContent, "custom");
    const firstLeaf = [...state.leaves.values()][0];
    for (let index = 0; index < firstLeaf.raw.length; index++) assert.equal(source[firstLeaf.positions[index]], firstLeaf.raw[index]);
    quote.querySelector("button").click(); assert.equal(quote.classList.contains("reading-folded"), false);
    const replacement = renderNode(state.doc.nodes[0], "fixture", new Map(), state.doc.environment); quote.replaceWith(replacement);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(replacement.querySelector("button").getAttribute("aria-expanded"), "true");
    assert.equal(state.doc.toMarkdown(), source);
    await state.run.setEnabled(state.definition, false);
    assert.equal(root().querySelector(".reading-fold"), null); assert.equal(root().querySelector(".reading-callout"), null);
  } finally { await state.run.destroy(); }
});
test("nested callouts and compact custom titles keep their original leaf positions", async () => {
  const source = '> Plain quote\n>\n> > [!example]-Compact **title**\n> > nested body\n', state = await start('callouts', source);
  try {
    const nested = root().querySelector('blockquote[data-alert="example"]'); assert.ok(nested); assert.ok(nested.classList.contains('reading-folded')); assert.equal(nested.querySelector('strong').textContent, 'title');
    for (const leaf of state.leaves.values()) for (let index = 0; index < leaf.raw.length; index++) assert.equal(source[leaf.positions[index]], leaf.raw[index]);
    assert.equal(state.doc.toMarkdown(), source);
  } finally { await state.run.destroy(); }
});
test("table folding retains the header, restores across replacement, and unloads without edits", async () => {
  const source = "| A | B |\n| --- | --- |\n| one | two |\n", state = await start("foldTables", source);
  try {
    const table = root().querySelector("table"); table.querySelector("button").click();
    assert.equal(table.classList.contains("reading-table-folded"), true); assert.equal(table.querySelectorAll("thead th").length, 2);
    const replacement = renderNode(state.doc.nodes[0], "fixture", new Map(), state.doc.environment); table.closest("[data-cid]").replaceWith(replacement);
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal((replacement.matches("table") ? replacement : replacement.querySelector("table")).classList.contains("reading-table-folded"), true);
    assert.equal(state.doc.toMarkdown(), source);
  } finally { await state.run.destroy(); }
  assert.equal(root().querySelector(".reading-table-fold"), null);
});
test("resizing retains syntax, paths, captions, titles and unrelated attributes", () => {
  for (const [source, expected] of [
    ['![alt](<folder/my image.png> "title")', '![alt](<folder/my image.png> "title"){width=300}'],
    ['![alt](a.png){width="50%" height=100px .rounded}', '![alt](a.png){width="300" height=150px .rounded}'],
    ['<img alt="width=40" src="a.png" width=40 height=20 loading="lazy" />', '<img alt="width=40" src="a.png" width=300 height=150 loading="lazy" />'],
    ["<img src='a.png' style='width:40px;height:20px;color:red'>", "<img src='a.png' style='width:300px;height:150px;color:red' width=\"300\">"],
    ['![[folder/a.png|100x50]]', '![[folder/a.png|300x150]]'],
    ['![[a.png]]', '![[a.png|300]]'],
    ['![[a.png|Caption]]', '![[a.png|Caption]]{width=300}'],
    ['![[a.png|Caption]]{width=100 height=50}', '![[a.png|Caption]]{width=300 height=150}'],
    ['![[a.png|100x50]]{width=200}', '![[a.png|300x150]]{width=300}'],
  ]) assert.equal(resizedImage(source, 300, 150), expected);
  const source = "text ![[my image.png|Caption]]{width=100} tail";
  assert.equal(imageRange(source, 5).source, "![[my image.png|Caption]]{width=100}");
});
test("wiki resize shares dimension grammar and preserves captions, paths and mixed-ending undo", () => {
  for (const [source, expected, expectedHeight] of [
    ['![[folder/my figure.jpg|100 x 50]]', '![[folder/my figure.jpg|300x150]]', '150'],
    ['![[folder/my figure.jpg| 100 X 50 ]]', '![[folder/my figure.jpg|300x150]]', '150'],
    ['![[folder/my figure.jpg|\t100\tx\t50\t]]{width=100}', '![[folder/my figure.jpg|300x150]]{width=300}', '150'],
    ['![[folder/my figure.jpg| 100 x 50 ]]{height=50 .keep}', '![[folder/my figure.jpg|300x150]]{height=150 .keep width=300}', '150'],
    ['![[folder/my figure.jpg| 100 ]]', '![[folder/my figure.jpg|300]]', null],
    ['![[folder/my figure.jpg| 100 ]]{width=100}', '![[folder/my figure.jpg|300]]{width=300}', null],
    ['![[folder/my figure.jpg|\t100\t]]{width=100 height=50}', '![[folder/my figure.jpg|300]]{width=300 height=150}', '150'],
    ['![[folder/my figure.jpg|  Figure caption  ]]', '![[folder/my figure.jpg|  Figure caption  ]]{width=300}', null],
    ['![[folder/my figure.jpg|100 x fifty]]{width=100 height=50}', '![[folder/my figure.jpg|100 x fifty]]{width=300 height=150}', '150'],
    ['![[folder/my figure.jpg|Caption|100]]', '![[folder/my figure.jpg|Caption|100]]{width=300}', null],
    ['![[folder/my figure.jpg|Caption|100]]{width=100 height=50}', '![[folder/my figure.jpg|Caption|100]]{width=300 height=150}', '150'],
  ]) {
    const original = `# Mixed\r\n\n${source}\r\n\nTail.\r\n`, doc = new MarkdownDocument(original);
    const range = imageRange(doc.text, doc.text.indexOf('![[')); assert.equal(range.source, source);
    const replacement = resizedImage(range.source, 300, 150); assert.equal(replacement, expected);
    doc.replace(range.from, range.to, replacement, 'document-command');
    assert.equal(doc.toMarkdown(), original.replace(source, expected));
    const rich = document.createElement('article');
    for (const node of doc.nodes) rich.append(renderNode(node, 'fixture', new Map(), doc.environment));
    const image = rich.querySelector('img'); assert.equal(image.getAttribute('width'), '300'); assert.equal(image.getAttribute('height'), expectedHeight);
    const before = imageReferences(source)[0], after = imageReferences(replacement)[0];
    assert.equal(after.url, 'folder/my figure.jpg'); assert.equal(after.url, before.url); assert.equal(after.alt, before.alt);
    assert.equal(doc.undo(), true); assert.equal(doc.toMarkdown(), original);
    assert.equal(doc.redo(), true); assert.equal(doc.toMarkdown(), original.replace(source, expected));
  }
});
test("wiki captions retain a rendered dimension suffix without changing source", () => {
  const source = "![[my image.png|Caption]]{width=300 height=150}\n", doc = new MarkdownDocument(source), leaves = new Map();
  const node = renderNode(doc.nodes[0], "fixture", leaves, doc.environment), image = node.querySelector("img");
  assert.equal(image.alt, "Caption"); assert.equal(image.getAttribute("width"), "300"); assert.equal(image.getAttribute("height"), "150"); assert.equal(doc.toMarkdown(), source);
  const leaf = [...leaves.values()][0]; assert.equal(leaf.raw, source.trim());
});
test("outline uses full model headings, not the current rendered window, and cleans up", async () => {
  const headings = [{ line: 1, level: 1, text: "First", id: "first" }, { line: 9000, level: 2, text: "Outside window", id: "outside" }], jumps = [];
  const state = await start("rightOutline", "# First\n", { getHeadings: () => headings, jump: line => jumps.push(line) });
  try {
    const panel = document.querySelector(".reading-right-outline"); assert.ok(panel.textContent.includes("Outside window"));
    [...panel.querySelectorAll("button")].find(button => button.textContent === "Outside window").click(); assert.deepEqual(jumps, [9000]);
    panel.querySelector("button").click(); assert.equal(panel.textContent.includes("Outside window"), false);
  } finally { await state.run.destroy(); }
  assert.equal(document.querySelector(".reading-right-outline"), null); assert.equal(document.querySelector(".reading-has-outline"), null);
});
test("a disposed reading instance cannot attach paint callbacks or change width", async () => {
  let api, calls = 0;
  const run = new PluginRuntime({ getMarkdown: () => '', getPath: () => null, getSelection: () => '', insert() {}, replace() {}, setReadOnly() {}, notify() {}, changed() {}, saveConfig() {}, setWidth: () => calls++ });
  const definition = { id: 'late-reading', name: '', description: '', config: {}, factory: context => class extends context.BasePlugin { process() { api = context.utils.reading; } } };
  await run.setEnabled(definition, true); await run.setEnabled(definition, false);
  api.onPaint(() => calls++); api.setWidth(90); assert.equal(calls, 0); await run.destroy();
});
test("slash commands find raw line starts and preserve mixed-ending undo", async () => {
  for (const ending of ['\n\n', '\r\n\r\n', '\r\r', '\r\n\r']) {
    const source = '# Heading' + ending + '/ta'; let changed, replacement;
    const state = await start('slashCommands', source, {
      selectionRange: () => ({ from: source.length, to: source.length, context: 'paragraph_open' }),
      replaceRange: (from, to, text, expected) => { replacement = { from, to, expected }; changed = source.slice(0, from) + text + source.slice(to); return true; },
    });
    try {
      document.dispatchEvent(new Event('selectionchange'));
      const menu = document.querySelector('.reading-slash-menu'); assert.equal(menu.hidden, false);
      const option = menu.querySelector('[role="option"]'); assert.ok(option.textContent.startsWith('/table'));
      option.click(); assert.deepEqual(replacement, { from: source.length - 3, to: source.length, expected: '/ta' });
      assert.equal(changed.slice(0, source.length - 3), source.slice(0, -3)); assert.ok(changed.endsWith('|  |  |'));
      state.doc.replaceSource(changed, 'document-command'); assert.equal(state.doc.toMarkdown(), changed);
      assert.equal(state.doc.undo(), true); assert.equal(state.doc.toMarkdown(), source);
    } finally { await state.run.destroy(); }
  }
});
test("width control uses the shared persisted preference callback and releases its DOM", async () => {
  let width = 80; const state = await start("widthSlider", "text\n", { getWidth: () => width, setWidth: value => width = value });
  const input = document.querySelector(".reading-width-slider input"); input.value = "96"; input.dispatchEvent(new Event("input")); assert.equal(width, 96);
  await state.run.destroy(); assert.equal(document.querySelector(".reading-width-slider"), null);
});
