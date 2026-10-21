import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { JSDOM } from "jsdom";

register(`data:text/javascript,${encodeURIComponent(`
import { readFile } from "node:fs/promises";
import { pluginModule } from ${JSON.stringify(new URL("../shared/plugin-module.mjs", import.meta.url).href)};
export async function resolve(specifier, context, next) {
  if (specifier.endsWith("?typora-plugin")) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  try { return await next(specifier, context); } catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error; return next(specifier + ".ts", context); }
}
export async function load(url, context, next) {
  if (!url.endsWith("?typora-plugin")) return next(url, context);
  return { format: "module", shortCircuit: true, source: pluginModule(await readFile(new URL(url.slice(0, -"?typora-plugin".length)), "utf8")) };
}`)}`);

const dom = new JSDOM('<!doctype html><body><div id="root"><aside class="sidebar"><div class="sidebar-body sidebar-menu"></div></aside><div class="document-editor"></div></div></body>', { pretendToBeVisual: true, url: "https://editor.test/" });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
for (const key of ["window", "document", "Node", "NodeFilter", "Text", "Element", "HTMLElement", "HTMLInputElement", "HTMLTableCellElement", "HTMLTableRowElement", "MutationObserver", "DOMParser", "getComputedStyle", "Event", "MouseEvent", "KeyboardEvent"]) globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.CSS = { supports: () => true };
const { MarkdownDocument } = await import("../src/editor/model.ts");
const { RichEditor } = await import("../src/editor/RichEditor.ts");
const { PluginRuntime } = await import("../src/plugins/runtime.ts");
const { bundledPlugins } = await import("../src/plugins/catalog.ts");
const { numberedBlocks } = await import("../src/editor/markdown.ts");
const bundled = id => bundledPlugins.find(plugin => plugin.id === id);

// jsdom has no layout: the viewport and block heights are injected through the editor's layout seam, as in window.test.mjs.
const heightByKind = { heading_open: 60, fence: 120, table_open: 150, bullet_list_open: 70 };
function bigDocument(count = 600) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    if (i % 50 === 0) parts.push(`## Section ${i / 50}`);
    else if (i % 50 === 25) parts.push(`### Detail ${(i - 25) / 50}`);
    else if (i % 37 === 13) parts.push("- item " + i + "\n- item " + (i + 1));
    else if (i % 41 === 7) parts.push("```js\nconst block = " + i + ";\n```");
    else if (i % 43 === 9) parts.push(`| a | b |\n| - | - |\n| ${i} | ![cell](cell${i}.png) |`);
    else if (i % 29 === 5) parts.push(`Photo ${i}: ![one](one${i}.png) and ![two](two${i}.png)`);
    else if (i % 47 === 11) parts.push(`$$\nx^${i}\n$$`);
    else if (i % 53 === 15) parts.push(`<div>\n<p>html ${i}</p>\n</div>`);
    else if (i % 31 === 3) parts.push("- list " + i + "\n\n  ```\n  nested " + i + "\n  ```");
    else if (i % 59 === 17) parts.push(`> ## Quoted ${i}`);
    else parts.push(`Paragraph ${i} with **bold** text to fill the line.`);
  }
  return parts.join("\n\n") + "\n";
}
async function fixture({ retain } = {}) {
  const container = document.querySelector(".document-editor"), root = document.createElement("div");
  root.className = "rich-document"; container.append(root);
  const model = new MarkdownDocument(bigDocument()), state = { viewport: { top: 0, height: 400 } };
  const editor = new RichEditor(root, model, "fixture", { change() {}, cursor() {}, image() {}, link() {}, compositionFinished() {} });
  Object.assign(editor.layout, { viewport: () => state.viewport, measure: element => heightByKind[element.dataset.kind] || 40, estimate: () => 50, threshold: 0 }, retain === undefined ? {} : { retain });
  editor.render(false);
  assert.equal(editor.windowed, true);
  const states = {};
  const runtime = new PluginRuntime({ getMarkdown: () => model.text, getPath: () => "/tmp/big.md", getDocumentId: () => "big", getSelection: () => "", insert() {}, replace() {}, setReadOnly() {}, notify() {}, changed: (id, state) => { states[id] = state; }, saveConfig() {}, getNumbered: () => numberedBlocks(model.nodes, model.environment.headings || []) });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const scroll = async top => { state.viewport = { top, height: 400 }; editor.scrolled(); await settle(); };
  const enable = async id => { await runtime.setEnabled(bundled(id), true); assert.equal(states[id].status, "ready", states[id].error); await settle(); };
  return { root, model, editor, runtime, states, scroll, settle, enable, spacers: () => [...root.querySelectorAll(".md-window-spacer")], block: cid => root.querySelector(`[data-cid="${cid}"]`), async close() { await runtime.destroy(); editor.destroy(); root.remove(); } };
}
const click = (element, init = {}) => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));

test("window spacers never receive Typora block markers, focus or plugin styles", async () => {
  const f = await fixture();
  try {
    await f.enable("collapse_list");
    assert.ok(f.spacers().length >= 1);
    const check = () => { for (const spacer of f.spacers()) { assert.equal(spacer.getAttribute("cid"), null); assert.equal(spacer.getAttribute("mdtype"), null); assert.equal(spacer.classList.contains("md-focus"), false); } const block = [...f.root.children].find(child => !child.classList.contains("md-window-spacer")); assert.equal(block.getAttribute("cid"), block.dataset.cid); };
    check();
    await f.scroll(12000); assert.equal(f.spacers().length, 2); check();
    f.runtime.documentChanged(); check();
  } finally { await f.close(); }
});

test("auto_number seeds every spacer with what its CSS counts in the blocks the spacer hides: top-level headings, fences and images", async () => {
  const f = await fixture();
  const full = document.createElement("div"); full.className = "rich-document"; document.querySelector(".document-editor").append(full);
  const reference = new RichEditor(full, new MarkdownDocument(f.model.text), "reference", { change() {}, cursor() {}, image() {}, link() {}, compositionFinished() {} });
  Object.assign(reference.layout, { threshold: Infinity }); reference.render(false);
  const blocks = [...full.children].map(element => ({ line: Number(element.dataset.line), element }));
  for (const selector of [".md-fence.md-math", ".md-fence.md-html", "li .md-fence", "blockquote h2"]) assert.ok(full.querySelector(selector), selector);
  reference.destroy(); full.remove();
  const expected = spacer => {
    const line = Number(spacer.nextElementSibling.dataset.line), counts = [0, 0, 0, 0, 0, 0, 0], others = { image: 0, fence: 0 };
    for (const { line: at, element } of blocks) if (at < line) {
      const level = /^H([1-6])$/.exec(element.tagName)?.[1];
      if (level) { counts[level]++; counts[Number(level) + 1] = 0; }
      others.fence += element.matches(".md-fence") + element.querySelectorAll(".md-fence").length;
      others.image += element.matches('.md-inline[data-mark="image"]') + element.querySelectorAll('.md-inline[data-mark="image"]').length;
    }
    return `.md-window-spacer[data-window="${spacer.dataset.window}"]{counter-set:${counts.slice(1).map((count, index) => `content-h${index + 1} ${count}`).join(" ")} ${Object.entries(others).map(([name, count]) => `${name} ${count}`).join(" ")}}`;
  };
  const style = () => document.querySelector("style[data-plugin-window]")?.textContent || "";
  const rules = () => style().split("\n").filter(Boolean).sort(), wanted = () => f.spacers().filter(spacer => spacer.nextElementSibling).map(expected).sort();
  try {
    await f.enable("auto_number");
    const [middle] = f.spacers();
    assert.ok(middle.nextElementSibling, "the middle spacer is followed by the pinned last block");
    assert.match(expected(middle), /content-h2 12 content-h3 1 .* image [1-9]\d* fence [1-9]\d*\}/, "12 sections, the detail heading after the last one, images and fences precede the pinned last block");
    assert.deepEqual(rules(), wanted());
    await f.scroll(12000);
    assert.equal(f.spacers().length, 2);
    assert.match(expected(f.spacers()[0]), /content-h2 [1-9]\d* content-h3 [01] /);
    assert.deepEqual(rules(), wanted());
    const at = f.model.nodes[300].from;
    f.editor.select({ anchor: at, head: at }, false); await f.settle();
    assert.ok(f.spacers().some(spacer => !spacer.nextElementSibling), "a bottom spacer stands for the document end and needs no rule");
    assert.equal(rules().length, f.spacers().length - 1);
    assert.deepEqual(rules(), wanted());
    await f.scroll(0);
    assert.deepEqual(rules(), wanted());
    await f.runtime.setEnabled(bundled("auto_number"), false);
    assert.equal(document.querySelector("style[data-plugin-window]"), null);
  } finally { await f.close(); }
});

test("collapse_list keeps the folded state of lists that leave the window and re-enter it rendered afresh", async () => {
  const f = await fixture({ retain: 0 });
  try {
    await f.enable("collapse_list");
    const first = f.root.querySelector("ul[data-cid]"), firstId = first.dataset.cid;
    click(first, { clientX: -18, clientY: 0 }); assert.ok(first.classList.contains("plugin-collapsed-list"));
    await f.scroll(12000);
    assert.equal(f.block(firstId), null);
    const second = f.root.querySelector("ul[data-cid]"), secondId = second.dataset.cid;
    assert.notEqual(secondId, firstId);
    click(second, { clientX: -18, clientY: 0 }); assert.ok(second.classList.contains("plugin-collapsed-list"));
    await f.scroll(18000); await f.scroll(12000);
    await f.scroll(0);
    const back = f.block(firstId);
    assert.notEqual(back, first, "evicted from the LRU, so rendered afresh");
    assert.ok(back.classList.contains("plugin-collapsed-list"), "state merged while the block was outside the window");
    assert.equal(back.textContent, first.textContent);
    await f.scroll(12000);
    assert.ok(f.block(secondId).classList.contains("plugin-collapsed-list"));
    click(f.block(secondId), { clientX: -18, clientY: 0 }); assert.equal(f.block(secondId).classList.contains("plugin-collapsed-list"), false);
    await f.scroll(0); await f.scroll(12000);
    assert.equal(f.block(secondId).classList.contains("plugin-collapsed-list"), false, "unfolding is remembered too");
  } finally { await f.close(); }
});

test("collapse_paragraph folds rendered blocks only, stops at spacers, refolds on return and unloads cleanly", async () => {
  const f = await fixture({ retain: 0 });
  const hidden = () => [...f.root.children].filter(block => block.style.display === "none");
  try {
    await f.enable("collapse_paragraph");
    const heading = f.root.firstElementChild, headingId = heading.dataset.cid;
    assert.equal(heading.tagName, "H2");
    click(heading, { ctrlKey: true });
    assert.ok(heading.classList.contains("plugin-collapsed-paragraph"));
    const folded = hidden();
    assert.ok(folded.length > 5);
    assert.ok(folded.every(block => !block.classList.contains("md-window-spacer")));
    assert.equal(f.spacers()[0].style.display, "");
    assert.equal(f.root.lastElementChild.style.display, "", "blocks after the spacer belong to an unknown section and stay visible");
    await f.scroll(12000);
    assert.equal(f.block(headingId), null);
    await f.scroll(0);
    const again = f.block(headingId);
    assert.notEqual(again, heading);
    assert.ok(again.classList.contains("plugin-collapsed-paragraph"), "folded state restored from the recorder");
    assert.ok(hidden().length > 5);
    assert.equal(f.spacers()[0].style.display, "");
    await f.runtime.setEnabled(bundled("collapse_paragraph"), false);
    assert.deepEqual(hidden(), []);
    assert.equal(f.root.querySelector(".plugin-collapsed-paragraph"), null);
  } finally { await f.close(); }
});
