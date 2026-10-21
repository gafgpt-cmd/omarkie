import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://editor.test/" });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
for (const key of ["window", "document", "Node", "NodeFilter", "Text", "HTMLElement", "HTMLInputElement", "HTMLTableCellElement", "HTMLTableRowElement", "MutationObserver", "DOMParser", "getComputedStyle"]) globalThis[key] = dom.window[key];
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
const { MarkdownDocument } = await import("../src/editor/model.ts");
const { RichEditor } = await import("../src/editor/RichEditor.ts");

// jsdom has no layout: the viewport and block heights are injected through the layout seam.
const heightByKind = { heading_open: 60, fence: 120, table_open: 150, math_block: 90, bullet_list_open: 70 };
function fixture(text, { viewport = { top: 0, height: 400 }, estimate = 50, threshold } = {}) {
  const container = document.createElement("div"), root = document.createElement("div");
  container.append(root);
  document.body.append(container);
  const model = new MarkdownDocument(text);
  const state = { viewport };
  let editor;
  const layout = {
    viewport: () => state.viewport,
    measure: element => heightByKind[element.dataset.kind] || 40,
    estimate: () => estimate,
  };
  editor = new RichEditor(root, model, "fixture", { change() {}, cursor() {}, image() {}, link() {}, compositionFinished() {} });
  Object.assign(editor.layout, layout, threshold === undefined ? {} : { threshold });
  editor.render(false);
  return { root, model, editor, state, spacers: () => [...root.querySelectorAll(".md-window-spacer")], blocks: () => [...root.querySelectorAll("[data-cid]")], close() { editor.destroy(); container.remove(); } };
}
function bigDocument(count = 600) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    if (i % 50 === 0) parts.push(`## Section ${i / 50}`);
    else if (i % 97 === 3) parts.push("```js\nlet x = " + i + ";\n```");
    else if (i % 89 === 7) parts.push("| a | b |\n| --- | --- |\n| " + i + " | x |");
    else if (i % 61 === 11) parts.push("$$\nx_" + i + "\n$$");
    else if (i % 37 === 13) parts.push("- item " + i + "\n- item " + (i + 1));
    else parts.push(`Paragraph ${i} with **bold** text ș ț and \`code\` to fill the line.`);
  }
  return parts.join("\n\n") + "\n";
}
function input(root, type, data = null) {
  root.dispatchEvent(new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: type, data }));
}

test("small documents render every block without spacers", () => {
  const f = fixture("# Title\n\nOne\n\nTwo\n");
  assert.equal(f.editor.windowed, false);
  assert.equal(f.spacers().length, 0);
  assert.equal(f.blocks().length, f.model.nodes.length);
  f.close();
});

test("a large document renders the viewport window plus the selection's block, with spacers between", () => {
  const f = fixture(bigDocument());
  const count = f.model.nodes.length;
  assert.ok(count > 600);
  assert.equal(f.editor.windowed, true);
  const ranges = f.editor.windowRangesRendered();
  // Viewport 400px with one viewport of overscan at 50px estimates: about 24 blocks from the top.
  assert.equal(ranges[0][0], 0);
  assert.ok(ranges[0][1] >= 16 && ranges[0][1] <= 30, JSON.stringify(ranges));
  // The initial selection sits at the end of the text: the last block is pinned.
  assert.equal(ranges.at(-1)[1], count);
  assert.ok(f.blocks().length < 60, `${f.blocks().length} blocks rendered`);
  assert.equal(f.spacers().length, 1);
  const spacer = f.spacers()[0];
  assert.equal(spacer.previousElementSibling.dataset.cid, f.model.nodes[ranges[0][1] - 1].id);
  assert.equal(spacer.nextElementSibling.dataset.cid, f.model.nodes[ranges[1][0]].id);
  // Rendered blocks were measured (40px paragraphs replace the 50px estimate) and the spacer uses estimates for the rest.
  const estimatedBetween = (ranges[1][0] - ranges[0][1]) * 50;
  assert.equal(parseFloat(spacer.style.height), estimatedBetween);
  f.close();
});

test("point() maps the top spacer to 0, the bottom spacer to the text end and a middle spacer to the next block", () => {
  const f = fixture(bigDocument());
  const middle = f.model.nodes[300].from;
  f.editor.select({ anchor: middle, head: middle }, false);
  const ranges = f.editor.windowRangesRendered();
  // The end of the text is no longer selected, so only the viewport window and the caret block remain.
  assert.equal(ranges.length, 2, JSON.stringify(ranges));
  assert.equal(f.spacers().length, 2);
  const [between, bottom] = f.spacers();
  const selection = window.getSelection();
  // Select-all puts the anchor before the first child and the focus after the last one.
  selection.setBaseAndExtent(f.root, 0, f.root, f.root.children.length);
  assert.deepEqual(f.editor.bookmark(), { anchor: 0, head: f.model.text.length });
  selection.setBaseAndExtent(f.root, [...f.root.children].indexOf(between), f.root, [...f.root.children].indexOf(between));
  assert.equal(f.editor.bookmark().head, f.model.nodes[ranges[1][0]].from);
  selection.setBaseAndExtent(f.root, [...f.root.children].indexOf(bottom), f.root, [...f.root.children].indexOf(bottom));
  assert.equal(f.editor.bookmark().head, f.model.text.length);
  // Points inside spacer elements resolve the same way.
  selection.setBaseAndExtent(bottom, 0, bottom, 0);
  assert.equal(f.editor.bookmark().head, f.model.text.length);
  f.close();
});

test("restore() renders a far block and typing there edits the model at the right offset", () => {
  const f = fixture(bigDocument());
  const node = f.model.nodes[450], at = node.from + 10;
  assert.equal(f.root.querySelector(`[data-cid="${node.id}"]`), null);
  f.model.selection = { anchor: at, head: at };
  f.editor.restore();
  assert.ok(f.root.querySelector(`[data-cid="${node.id}"]`));
  assert.equal(f.editor.bookmark().head, at);
  const before = f.model.text;
  input(f.root, "insertText", "X");
  assert.equal(f.model.text, before.slice(0, at) + "X" + before.slice(at));
  assert.equal(f.editor.bookmark().head, at + 1);
  input(f.root, "insertParagraph");
  assert.equal(f.model.text, before.slice(0, at) + "X\n\n" + before.slice(at));
  f.editor.undo(); f.editor.undo();
  assert.equal(f.model.text, before);
  assert.equal(f.editor.bookmark().head, at);
  f.close();
});

test("scrolling shifts the window and brings elements back from the LRU untouched", () => {
  const f = fixture(bigDocument());
  const first = f.blocks()[1];
  first.dataset.marker = "kept";
  const id = first.dataset.cid;
  f.state.viewport = { top: 12000, height: 400 };
  f.editor.scrolled();
  assert.equal(f.root.contains(first), false);
  assert.ok(f.editor.windowRangesRendered()[0][0] > 100, JSON.stringify(f.editor.windowRangesRendered()));
  assert.equal(f.spacers().length, 2, "top and bottom spacer");
  // The top spacer sums measured heights of the first window and estimates for the rest.
  const [start] = f.editor.windowRangesRendered()[0];
  const expected = f.model.nodes.slice(0, start).reduce((sum, node) => sum + (f.editor.heights.get(node.id) ?? 50), 0);
  assert.equal(parseFloat(f.spacers()[0].style.height), expected);
  // Measurements replace estimates while scrolling into new blocks, which may cost one extra render;
  // once settled, small scrolls inside the window do not move it.
  const settle = () => { let before, after = JSON.stringify(f.editor.windowRangesRendered()); for (let i = 0; i < 10; i++) { before = after; f.editor.scrolled(); after = JSON.stringify(f.editor.windowRangesRendered()); if (after === before) break; } return after; };
  settle();
  f.state.viewport = { top: 12050, height: 400 };
  const ranges = settle();
  f.state.viewport = { top: 12090, height: 400 };
  f.editor.scrolled();
  assert.equal(JSON.stringify(f.editor.windowRangesRendered()), ranges);
  assert.ok(f.editor.windowRangesRendered()[0][0] < f.editor.indexAt(12090) && f.editor.windowRangesRendered()[0][1] > f.editor.indexAt(12490), "viewport inside the window");
  f.state.viewport = { top: 0, height: 400 };
  f.editor.scrolled();
  const back = f.root.querySelector(`[data-cid="${id}"]`);
  assert.equal(back, first, "same element object returns from the LRU");
  assert.equal(back.dataset.marker, "kept");
  f.close();
});

test("the LRU is bounded and evicted blocks render again when they return", () => {
  const f = fixture(bigDocument());
  f.editor.layout.retain = 8;
  const first = f.blocks()[1], id = first.dataset.cid;
  for (const top of [6000, 12000, 18000, 24000]) { f.state.viewport = { top, height: 400 }; f.editor.scrolled(); }
  assert.ok(f.editor.detached.size <= 8, `${f.editor.detached.size} detached`);
  f.state.viewport = { top: 0, height: 400 };
  f.editor.scrolled();
  const back = f.root.querySelector(`[data-cid="${id}"]`);
  assert.ok(back);
  assert.notEqual(back, first);
  assert.equal(back.textContent, first.textContent);
  f.close();
});

test("an Enter near the top shifts later blocks; a block returning from the LRU carries its new line", () => {
  const f = fixture(bigDocument());
  const far = f.model.nodes[501], headingId = f.model.nodes[500].id, element = (() => { f.state.viewport = { top: 25000, height: 400 }; f.editor.scrolled(); return f.root.querySelector(`[data-cid="${far.id}"]`); })();
  assert.ok(element);
  const line = Number(element.dataset.line);
  f.state.viewport = { top: 0, height: 400 };
  f.editor.scrolled();
  assert.equal(f.root.contains(element), false);
  const at = f.model.nodes[1].from + 3;
  f.model.selection = { anchor: at, head: at };
  f.editor.restore();
  input(f.root, "insertParagraph");
  f.state.viewport = { top: 25000, height: 400 };
  f.editor.scrolled();
  const again = f.root.querySelector(`[data-cid="${far.id}"]`);
  assert.equal(far.kind, "paragraph_open");
  assert.equal(again, element, "paragraph markup does not depend on its line: element reused");
  // A heading's anchor depends on its line, so the heading before it was rendered afresh.
  const heading = f.model.node(headingId);
  assert.equal(heading.kind, "heading_open");
  assert.equal(Number(f.root.querySelector(`[data-cid="${heading.id}"]`).dataset.line), heading.line);
  assert.equal(Number(again.dataset.line), line + 2);
  assert.equal(f.model.node(far.id).line, line + 2);
  f.close();
});

test("clipboard across a spacer copies the Markdown source instead of the partial DOM", () => {
  const f = fixture(bigDocument());
  window.getSelection().setBaseAndExtent(f.root, 0, f.root, f.root.children.length);
  const copied = f.editor.clipboard();
  assert.equal(copied.markdown, f.model.text);
  assert.equal(copied.plain, f.model.text);
  assert.equal(copied.html, "");
  f.close();
});

test("a caret left on the root or a spacer is moved into the block it stands for", () => {
  const f = fixture(bigDocument());
  const selection = window.getSelection();
  selection.setBaseAndExtent(f.root, f.root.children.length, f.root, f.root.children.length);
  document.dispatchEvent(new window.Event("selectionchange"));
  assert.deepEqual(f.model.selection, { anchor: f.model.text.length, head: f.model.text.length });
  const focus = selection.focusNode, focusElement = focus.nodeType === 1 ? focus : focus.parentElement;
  assert.ok(focusElement.closest("[data-leaf]"), "caret placed inside a leaf");
  selection.setBaseAndExtent(f.root, 0, f.root, 0);
  document.dispatchEvent(new window.Event("selectionchange"));
  assert.deepEqual(f.model.selection, { anchor: 0, head: 0 });
  assert.equal(f.editor.windowRangesRendered()[0][0], 0);
  f.close();
});

test("select-all then typing replaces the whole document through the model", () => {
  const f = fixture(bigDocument());
  window.getSelection().setBaseAndExtent(f.root, 0, f.root, f.root.children.length);
  input(f.root, "insertText", "fresh");
  assert.equal(f.model.text, "fresh");
  assert.equal(f.editor.windowed, false);
  f.editor.undo();
  assert.equal(f.model.text, bigDocument());
  f.close();
});

test("a window shift never moves the caret's block, so the DOM selection survives scrolling", () => {
  const f = fixture(bigDocument());
  const node = f.model.nodes[200], at = node.from + 5;
  f.editor.select({ anchor: at, head: at }, false);
  const selection = window.getSelection(), focus = selection.focusNode, offset = selection.focusOffset;
  assert.ok(f.root.querySelector(`[data-cid="${node.id}"]`).contains(focus));
  // Scroll above and below the caret: spacers appear and disappear around its block.
  for (const top of [9000, 0, 12000, 9800, 300]) {
    f.state.viewport = { top, height: 400 };
    f.editor.scrolled();
    assert.equal(selection.focusNode, focus, `focus node kept at scroll ${top}`);
    assert.equal(selection.focusOffset, offset);
    assert.equal(f.editor.bookmark().head, at);
  }
  f.close();
});

test("windowed and full editors agree on text and selection for random edits across the document", () => {
  const text = bigDocument(120);
  const windowed = fixture(text, { threshold: 0, viewport: { top: 0, height: 200 } }), full = fixture(text, { threshold: Infinity });
  assert.equal(windowed.editor.windowed, true);
  assert.equal(full.editor.windowed, false);
  let seed = 17;
  const random = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const types = ["insertText", "insertText", "insertParagraph", "deleteContentBackward", "deleteContentForward", "insertLineBreak"];
  for (let step = 0; step < 150; step++) {
    const at = random(windowed.model.text.length + 1), type = types[random(types.length)], data = type === "insertText" ? ["a", "ș", " ", "*", "#"][random(5)] : null;
    const bookmarks = [];
    for (const f of [windowed, full]) {
      f.editor.select({ anchor: at, head: at });
      input(f.root, type, data);
      // Read the DOM selection while it still belongs to this editor.
      bookmarks.push(f.editor.bookmark());
    }
    assert.equal(windowed.model.text, full.model.text, `step ${step} ${type} at ${at}`);
    assert.deepEqual(bookmarks[0], bookmarks[1], `step ${step} selection`);
    assert.deepEqual(windowed.model.selection, full.model.selection, `step ${step} model selection`);
    assert.ok(windowed.blocks().length <= full.blocks().length);
  }
  for (let i = 0; i < 20; i++) { windowed.editor.undo(); full.editor.undo(); }
  assert.equal(windowed.model.text, full.model.text);
  windowed.close(); full.close();
});

test("a task checkbox toggles its own box after text above it moved the cached block", () => {
  const f = fixture("Intro text.\n\n- [ ] buy milk\n", { threshold: 1000 });
  f.model.replace(0, 0, "New line above. ", "command");
  f.editor.render(false);
  f.root.querySelector("input[data-task]").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(f.model.text, "New line above. Intro text.\n\n- [x] buy milk\n");
  f.close();
});
