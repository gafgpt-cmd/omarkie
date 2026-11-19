import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://editor.test/" });
for (const key of ["window", "document", "Node", "HTMLElement", "Element", "DOMParser", "NodeFilter"]) globalThis[key] = dom.window[key];
const { MarkdownDocument } = await import("../src/editor/model.ts");

const shape = model => ({ text: model.text, nodes: model.nodes.map(({ from, to, source, kind, line }) => ({ from, to, source, kind, line })) });

test("undo and redo replay every edit exactly and keep the block tree consistent", () => {
  let seed = 3;
  const random = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pieces = ["a", "ș", " ", "\n", "\n\n", "# ", "- ", "```\n", "|", "[^1]", "**"];
  for (let round = 0; round < 60; round++) {
    const model = new MarkdownDocument("# Title\n\nFirst paragraph here.\n\n- item\n\nLast ț line.\n");
    const texts = [model.text];
    for (let step = 0; step < 15; step++) {
      const from = random(model.text.length + 1), to = Math.min(model.text.length, from + random(4));
      model.replace(from, to, random(4) ? pieces[random(pieces.length)] : "", "command");
      if (model.text !== texts.at(-1)) texts.push(model.text);
    }
    for (let i = texts.length - 2; i >= 0; i--) {
      assert.ok(model.undo());
      assert.equal(model.text, texts[i], `round ${round} undo to ${i}`);
      const fresh = new MarkdownDocument(model.text); fresh.selection = { ...model.selection }; fresh.refreshCaret();
      assert.deepEqual(shape(model).nodes.filter(n => !n.kind.startsWith("empty")), shape(fresh).nodes.filter(n => !n.kind.startsWith("empty")));
    }
    assert.equal(model.undo(), false);
    for (let i = 1; i < texts.length; i++) { assert.ok(model.redo()); assert.equal(model.text, texts[i], `round ${round} redo to ${i}`); }
  }
});

test("typing groups undo in one step, including backspace past the group start", () => {
  const model = new MarkdownDocument("Hello world\n");
  const type = (from, to, insert) => { const caret = insert ? from : to; model.selection = { anchor: caret, head: caret }; model.replace(from, to, insert, "typing", { anchor: from + insert.length, head: from + insert.length }); };
  type(5, 5, ","); type(6, 6, " "); type(7, 7, "d"); type(8, 8, "e"); type(8, 9, ""); type(7, 8, ""); type(6, 7, ""); type(5, 6, ""); type(4, 5, "");
  assert.equal(model.text, "Hell world\n");
  assert.ok(model.undo());
  assert.equal(model.text, "Hello world\n");
  assert.equal(model.canUndo, false);
  assert.ok(model.redo());
  assert.equal(model.text, "Hell world\n");
});

test("a 3 MB document keeps a full undo history", () => {
  const model = new MarkdownDocument("Paragraph text ș ț.\n\n".repeat(150_000));
  for (let i = 0; i < 120; i++) model.replace(i * 3, i * 3, "x", "command");
  let steps = 0;
  while (model.undo()) steps++;
  assert.equal(steps, 100);
});

test("property and rich edits preserve mixed line endings through undo and redo", () => {
  const source = "\uFEFF---\r\ntype: Note\ncustom: keep\r\n---\n\n# Heading\r\nBody\nTail\r";
  const model = new MarkdownDocument(source, "\r\n");
  const at = model.text.indexOf("Body");
  model.replace(at, at + 4, "Edited", "command");
  assert.equal(model.toMarkdown(), source.replace("Body", "Edited"));
  model.undo(); assert.equal(model.toMarkdown(), source);
  const updated = source.replace("type: Note", "type: Reference");
  model.replaceSource(updated, "document-command");
  assert.equal(model.toMarkdown(), updated);
  model.undo(); assert.equal(model.toMarkdown(), source);
  model.redo(); assert.equal(model.toMarkdown(), updated);
});

test("mixed-ending typing and backspace retain one undo group and exact source", () => {
  const source = "# Title\r\n\nHello world\r\nTail\r";
  const model = new MarkdownDocument(source, "\r\n"), base = model.text.indexOf("Hello") + 5;
  const type = (from, to, insert) => {
    const caret = insert ? from : to;
    model.selection = { anchor: caret, head: caret };
    model.replace(from, to, insert, "typing", { anchor: from + insert.length, head: from + insert.length });
  };
  type(base, base, ","); type(base + 1, base + 1, " "); type(base + 2, base + 2, "d"); type(base + 3, base + 3, "e");
  type(base + 3, base + 4, ""); type(base + 2, base + 3, ""); type(base + 1, base + 2, ""); type(base, base + 1, ""); type(base - 1, base, "");
  const edited = source.replace("Hello", "Hell");
  assert.equal(model.toMarkdown(), edited);
  model.undo(); assert.equal(model.toMarkdown(), source); assert.equal(model.canUndo, false);
  model.redo(); assert.equal(model.toMarkdown(), edited);
});

test("mixed-ending composition commits once and cancellation preserves redo", () => {
  const source = "A\r\nB\nC\r", model = new MarkdownDocument(source, "\r\n"), at = model.text.indexOf("B");
  model.beginComposition(); model.replace(at, at + 1, "你好", "composition");
  assert.equal(model.endComposition(), true);
  const edited = source.replace("B", "你好");
  assert.equal(model.toMarkdown(), edited);
  model.undo(); assert.equal(model.toMarkdown(), source);
  model.beginComposition(); model.replace(at, at + 1, "候选", "composition"); model.replaceSource(source, "composition");
  assert.equal(model.endComposition(), false); assert.equal(model.canRedo, true);
  model.redo(); assert.equal(model.toMarkdown(), edited);
});
