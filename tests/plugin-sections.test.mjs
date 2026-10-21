import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { JSDOM } from "jsdom";

// Load the Vite-only catalog in Node: compile `?typora-plugin` imports like scripts/plugin-build.mjs and resolve extensionless TypeScript imports.
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

const section = '<h1 data-cid="t">Thesis</h1><h2 data-cid="a">Methods</h2><p data-cid="a1">Design</p><h3 data-cid="a2">Sample</h3><p data-cid="a3">Size</p><h2 data-cid="b">Results</h2><p data-cid="b1">Findings</p>';
const dom = new JSDOM(`<!doctype html><html><head></head><body><div id="root"><aside class="sidebar"><div class="sidebar-body sidebar-menu"><nav class="outline outline-content"><button class="outline-item outline-h2"><span class="outline-label">Methods</span></button></nav></div></aside><div class="document-editor"><div class="rich-document">${section}</div></div><article class="print-document"><h2>Methods</h2></article></div></body></html>`, { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "Element", "HTMLElement", "MutationObserver", "Event", "KeyboardEvent", "MouseEvent", "Node", "NodeFilter", "Text", "DOMParser", "getComputedStyle"]) globalThis[key] = dom.window[key];
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.CSS = { supports: () => true };
const { PluginRuntime } = await import("../src/plugins/runtime.ts");
const { bundledPlugins } = await import("../src/plugins/catalog.ts");
const { exportHtml } = await import("../src/editor/print.ts");
const { renderMarkdown } = await import("../src/editor/markdown.ts");
const bundled = id => bundledPlugins.find(plugin => plugin.id === id);
function runtime() {
  const states = {}, saved = [];
  const value = new PluginRuntime({ getMarkdown: () => "# Thesis", getPath: () => "/tmp/thesis.md", getSelection: () => "", insert() {}, replace() {}, setReadOnly() {}, notify() {}, changed: (id, state) => { states[id] = state; }, saveConfig: (id, config) => saved.push({ id, config }) });
  return { value, states, saved };
}
const root = () => document.getElementById("write");
const pluginStyle = id => document.querySelector(`style[data-plugin="${id}"]`)?.textContent || "";

test("every bundled catalog entry loads through the runtime with its shipped configuration", async () => {
  const run = runtime();
  try {
    for (const plugin of bundledPlugins) { await run.value.setEnabled(plugin, true); assert.equal(run.states[plugin.id].status, "ready", `${plugin.id}: ${run.states[plugin.id].error}`); }
    for (const plugin of bundledPlugins) await run.value.setEnabled(plugin, false);
  } finally { await run.value.destroy(); }
  assert.equal(document.querySelector("style[data-plugin]"), null);
});

test("bundled auto_number numbers headings, outline and TOC with CSS counters and keeps them in exported HTML", async () => {
  const run = runtime(), plugin = bundled("auto_number");
  try {
    await run.value.setEnabled(plugin, true); assert.equal(run.states.auto_number.status, "ready", run.states.auto_number.error);
    assert.equal(root().querySelector('h2[data-cid="a"]').getAttribute("mdtype"), "heading"); assert.ok(root().querySelector('h2[data-cid="a"]').classList.contains("md-heading"));
    const style = pluginStyle("auto_number");
    assert.match(style, /:is\(\.rich-document,\.print-document\) > h2:before.*counter-increment: content-h2; content: counter\(content-h2, decimal\) "\. "/);
    assert.match(style, /\.outline-content \.outline-h2 \.outline-label:before \{counter-increment: outline-h2; content: counter\(outline-h2, decimal\) "\. "/);
    assert.match(style, /\.outline-content \{ counter-reset: outline-h1 outline-h2; \}/); assert.doesNotMatch(style, /md-toc-content/);
    const actions = run.value.actions("auto_number");
    assert.deepEqual(actions.slice(0, 2).map(action => [action.name, action.checked]), [["大纲编号", true], ["正文编号", true]]);
    assert.deepEqual(actions.filter(action => action.value.startsWith("set_layout")).map(action => [action.value, action.checked]).filter(([, checked]) => checked), [["set_layout@Layout::Decimal-H2", true]]);
    await run.value.invoke("auto_number", "toggle_config@ENABLE_TOC");
    assert.equal(run.saved.at(-1).config.ENABLE_TOC, true); assert.match(pluginStyle("auto_number"), /\.md-toc-content \.md-toc-h2 a:before \{counter-increment: toc-h2; content: counter\(toc-h2, decimal\) "\. "/);
    await run.value.invoke("auto_number", "set_layout@Layout::Decimal-H1");
    assert.deepEqual(run.saved.at(-1).config.LAYOUTS.filter(layout => layout.selected).map(layout => layout.name), ["Layout::Decimal-H1"]);
    assert.match(pluginStyle("auto_number"), /> h1:before.*content: counter\(content-h1, decimal\) "\. "/);
    assert.match(pluginStyle("auto_number"), /> h3:before.*counter\(content-h1, decimal\) "\." counter\(content-h2, decimal\) "\." counter\(content-h3, decimal\) " "/);
    const exported = exportHtml(document.querySelector(".print-document"));
    assert.match(exported, /<style data-plugin-export>body \{font-variant-ligatures: no-common-ligatures;\}[^]*\.print-document\) > h2:before/); assert.doesNotMatch(exported, /#write/);
    await run.value.setEnabled(plugin, false);
    assert.equal(pluginStyle("auto_number"), ""); assert.doesNotMatch(exportHtml(document.querySelector(".print-document")), /data-plugin-export/);
  } finally { await run.value.destroy(); }
});

test("[TOC] markup carries the Typora classes the numbering CSS targets", () => {
  const toc = new DOMParser().parseFromString(renderMarkdown("[TOC]\n\n# Thesis\n\n## Methods\n\n### Sample\n", "doc"), "text/html").querySelector("nav.markdown-toc");
  assert.ok(toc.classList.contains("md-toc-content"));
  assert.deepEqual([...toc.children].map(item => [item.className, item.querySelector("a")?.textContent]), [["md-toc-item md-toc-h1", "Thesis"], ["md-toc-item md-toc-h2", "Methods"], ["md-toc-item md-toc-h3", "Sample"]]);
});

test("bundled collapse_paragraph folds a section on Ctrl+click, survives block replacement, expands by command and unloads", async () => {
  const run = runtime(), plugin = bundled("collapse_paragraph"), write = root();
  const click = (selector, init) => write.querySelector(selector).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  const hidden = () => [...write.children].filter(block => block.style.display === "none").map(block => block.dataset.cid);
  try {
    await run.value.setEnabled(plugin, true); assert.equal(run.states.collapse_paragraph.status, "ready", run.states.collapse_paragraph.error);
    assert.match(pluginStyle("collapse_paragraph"), /plugin-collapsed-paragraph::after/);
    click('h2[data-cid="a"]', {}); assert.deepEqual(hidden(), []);
    click('h2[data-cid="a"]', { ctrlKey: true });
    assert.ok(write.querySelector('h2[data-cid="a"]').classList.contains("plugin-collapsed-paragraph")); assert.deepEqual(hidden(), ["a1", "a2", "a3"]);
    write.innerHTML = section; run.value.documentChanged();
    assert.ok(write.querySelector('h2[data-cid="a"]').classList.contains("plugin-collapsed-paragraph")); assert.deepEqual(hidden(), ["a1", "a2", "a3"]);
    const actions = run.value.actions("collapse_paragraph");
    assert.deepEqual(actions.slice(0, 2).map(action => action.name), ["折叠全部章节", "展开全部章节"]); assert.equal(actions.find(action => action.value === "toggle_current").disabled, true);
    assert.equal(actions.find(action => action.value === "record_collapse_state").checked, true);
    await run.value.invoke("collapse_paragraph", "expand_all"); assert.deepEqual(hidden(), []); assert.equal(write.querySelector(".plugin-collapsed-paragraph"), null);
    await run.value.invoke("collapse_paragraph", "collapse_all"); assert.deepEqual(hidden(), ["a", "a1", "a2", "a3", "b", "b1"]);
    await run.value.setEnabled(plugin, false);
    assert.deepEqual(hidden(), []); assert.equal(write.querySelector(".plugin-collapsed-paragraph"), null); assert.equal(pluginStyle("collapse_paragraph"), "");
    click('h2[data-cid="a"]', { ctrlKey: true }); assert.deepEqual(hidden(), []);
  } finally { await run.value.destroy(); write.innerHTML = section; }
});
