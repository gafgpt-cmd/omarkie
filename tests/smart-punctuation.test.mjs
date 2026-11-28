import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://editor.test/" });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
for (const key of ["window", "document", "Node", "NodeFilter", "Text", "Element", "HTMLElement", "HTMLInputElement", "HTMLTableCellElement", "HTMLTableRowElement", "MutationObserver", "DOMParser", "getComputedStyle"]) globalThis[key] = dom.window[key];
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
const { MarkdownDocument } = await import("../src/editor/model.ts");
const { RichEditor } = await import("../src/editor/RichEditor.ts");
const { renderMarkdown } = await import("../src/editor/markdown.ts");
const { smartEdits } = await import("../src/editor/smartPunctuation.ts");

// Synthetic lecture-handout fixture: prose in three languages plus everything that must stay literal.
const source = [
  "# The \"quiet\" block",
  "",
  "EN: She said \"local anaesthesia\" isn't 'routine'... -- or is it? Onset---then spread.",
  "Dose 10--20 mg, -5 °C, height 5'10\", pages 1...5, run --verbose, `\"code\" -- ...` and $a--b$.",
  "Escaped \\\"marks\\\" stay, <https://example.test/a--b...> and https://example.test/x--y stay.",
  "",
  "ES: Dijo \"bloqueo del plexo\" -- con 'calma'... y 2--3 ml.",
  "",
  "CA: Va dir \"bloqueig\" -- l'anestèsia... i *\"èmfasi\"*.",
  "",
  "| \"cell\" | 'one' |",
  "|---|---|",
  "| a -- b | 3--4 |",
  "",
  "```",
  "\"fenced\" -- ...",
  "```",
  "",
].join("\n");

const glyphs = /[“”‘’«»—–…]/g;
function exported(style) {
  const holder = document.createElement("div");
  holder.innerHTML = renderMarkdown(source, "fixture", { smartPunctuation: style });
  return holder;
}
function reading(style) {
  const container = document.createElement("div"), root = document.createElement("div");
  container.append(root); document.body.append(container);
  const model = new MarkdownDocument(source, "\n");
  let changes = 0;
  const editor = new RichEditor(root, model, "fixture", { change: () => changes++, cursor() {}, image() {}, link() {}, compositionFinished() {} });
  editor.setOptions({ spellcheck: false, tabSize: 2, typewriter: false, readOnly: true, smartPunctuation: style });
  editor.render(false);
  return { root, model, editor, changes: () => changes, close() { editor.destroy(); container.remove(); } };
}
// What a reader sees: drawn glyphs instead of their hidden source, no syntax markers.
function visible(element) {
  const copy = element.cloneNode(true);
  for (const smart of copy.querySelectorAll(".md-smart")) smart.replaceWith(smart.dataset.smart);
  for (const hidden of copy.querySelectorAll(".md-meta,.md-object-source")) hidden.remove();
  return copy.textContent;
}

test("smart punctuation is off by default and leaves export output untouched", () => {
  assert.equal(exported("off").innerHTML, exported(undefined).innerHTML);
  assert.equal(exported("off").textContent.match(glyphs), null);
});

test("English export changes only opted-in prose", () => {
  const text = exported("en").textContent;
  for (const expected of ["The “quiet” block", "She said “local anaesthesia” isn’t ‘routine’… – or is it? Onset—then spread.", "Dose 10--20 mg, -5 °C, height 5'10\", pages 1...5, run --verbose,", "\"code\" -- ...", "Escaped \"marks\" stay, https://example.test/a--b... and https://example.test/x--y stay.", "“cell”", "a – b", "3--4", "\"fenced\" -- ..."]) assert.ok(text.includes(expected), expected);
  assert.ok(!/a–b|a—b/.test(text), "math stays literal");
});

test("Spanish and Catalan use angle quotes; apostrophes stay typographic", () => {
  for (const style of ["es", "ca"]) {
    const text = exported(style).textContent;
    assert.ok(text.includes("Dijo «bloqueo del plexo» – con ‘calma’… y 2--3 ml."), style);
    assert.ok(text.includes("Va dir «bloqueig» – l’anestèsia… i «èmfasi»."), style);
    assert.ok(text.includes("The «quiet» block"), style);
  }
});

test("reading view draws the same glyphs as export, keeps source offsets and never dirties the note", () => {
  for (const style of ["en", "es", "ca"]) {
    const f = reading(style);
    try {
      const shown = [...f.root.querySelectorAll(".md-smart")].map(element => element.dataset.smart).join("");
      assert.equal(shown, exported(style).textContent.match(glyphs).join(""), `${style}: reading matches export`);
      assert.equal(f.model.toMarkdown(), source);
      assert.equal(f.changes(), 0);
      // The DOM text is still the source text, so offsets and copied text follow the file.
      for (const leaf of f.root.querySelectorAll("[data-leaf]")) assert.ok(!glyphs.test(leaf.textContent));
      // Any escaped ASCII punctuation renders once, as in export.
      assert.ok(visible(f.root).includes('Escaped "marks" stay, https://example.test/a--b... and https://example.test/x--y stay.'));
      assert.ok(visible(f.root).includes(style === "en" ? "She said “local anaesthesia” isn’t ‘routine’… – or is it?" : "Dijo «bloqueo del plexo» – con ‘calma’…"));
      const line = source.indexOf("EN:"), end = source.indexOf("\n", line);
      for (let position = line; position <= end; position++) {
        f.model.selection = { anchor: position, head: position };
        f.editor.restore();
        assert.equal(f.editor.bookmark().head, position, `${style}: caret ${position}`);
      }
      f.model.selection = { anchor: line, head: end };
      f.editor.restore();
      assert.equal(f.editor.clipboard().plain, source.slice(line, end));
    } finally { f.close(); }
  }
});

test("toggling the style re-renders without a transaction; editable rendering stays literal", () => {
  const f = reading("en");
  try {
    assert.ok(f.root.querySelector(".md-smart"));
    f.editor.setOptions({ spellcheck: false, tabSize: 2, typewriter: false, readOnly: true, smartPunctuation: "off" });
    f.editor.render(false);
    assert.equal(f.root.querySelector(".md-smart"), null);
    f.editor.setOptions({ spellcheck: false, tabSize: 2, typewriter: false, readOnly: false, smartPunctuation: "en" });
    f.editor.render(false);
    assert.equal(f.root.querySelector(".md-smart"), null);
    assert.equal(f.changes(), 0);
    assert.equal(f.model.canUndo, false);
    assert.equal(f.model.toMarkdown(), source);
  } finally { f.close(); }
});

test("rules: matched pairs only, digits and longer runs stay literal", () => {
  const run = (text, style = "en") => {
    const edits = smartEdits([{ text }], style);
    let out = text;
    for (const edit of [...edits].reverse()) out = out.slice(0, edit.at) + edit.glyph + out.slice(edit.at + edit.length);
    return out;
  };
  assert.equal(run("\"open only"), "\"open only");
  assert.equal(run("isn't it"), "isn’t it");
  assert.equal(run('a \\"b\\" c'), 'a \\"b\\" c');
  assert.equal(run("a ---- b -- c"), "a ---- b – c");
  assert.equal(run("x.... y"), "x.... y");
  assert.equal(run("\"Answer 5\""), "\"Answer 5\"");
  assert.equal(run("\"quoted\"", "off"), "\"quoted\"");
});
