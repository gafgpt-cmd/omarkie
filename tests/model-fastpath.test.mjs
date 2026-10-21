import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://editor.test/" });
for (const key of ["window", "document", "Node", "HTMLElement", "Element", "DOMParser", "NodeFilter"]) globalThis[key] = dom.window[key];
const { MarkdownDocument } = await import("../src/editor/model.ts");

const blocks = [
  "Plain paragraph with ș, ț, ğ and ı.", "Two line\nparagraph here.", "# Heading", "## Sub *heading*",
  "- item one\n- item two", "1. first\n2. second", "> quoted\n> text", "```js\nlet a = 1;\n```",
  "| a | b |\n| --- | --- |\n| 1 | 2 |", "Footnote ref[^n] here.", "[^n]: the note", "[ref]: https://example.com",
  "Text with [link][ref] and `code`.", "Setext title\n===", "    indented code", "---", "$$\nx^2\n$$", "Line with trailing  \nbreak",
  "# Heading", "## Sub *heading*", "[toc]", "<div>\nhtml\n</div>", "- [ ] task\n- [x] done", "> [!NOTE]\n> alert",
];
const pieces = ["a", "ă", " ", "*", "_", "#", "- ", "1. ", "`", "```", "|", "[", "]", "^", "\n", "\n\n", "=", "---", ">", "    ", "$", "<b>", "ș"];
const structural = ["\n", "\n\n", "# ", "## ", "- ", "> ", "```\n", "```", "|", "---\n", "$$\n", "[^n]", "[^n]: x", "[ref]: y", "    ", "===\n", "<pre>", "</pre>", "[toc]\n", "* * *\n"];
const strip = model => ({
  text: model.text,
  lines: model.lines,
  largestBlock: model.largestBlock,
  nodes: model.nodes.map(({ from, to, source, kind, line }) => ({ from, to, source, kind, line })),
  root: model.root.children.map(({ from, to, source, kind }) => ({ from, to, source, kind })),
  env: JSON.stringify(model["environ" + "ment"]),
});
// The twin always takes the full parse; the model may use either fast path.
function pair(source) {
  const model = new MarkdownDocument(source), twin = new MarkdownDocument(source), used = { paragraph: 0, window: 0 };
  twin.patch = () => false; twin.patchWindow = () => false;
  const patch = model.patch.bind(model), patchWindow = model.patchWindow.bind(model);
  model.patch = (...args) => { const hit = patch(...args); used.paragraph += hit ? 1 : 0; return hit; };
  model.patchWindow = (...args) => { const hit = patchWindow(...args); used.window += hit ? 1 : 0; return hit; };
  return { model, twin, used };
}
function rng(seed) { return n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; }; }

test("paragraph fast path matches the full parse for random edits", () => {
  const random = rng(7); let fast = 0;
  for (let round = 0; round < 300; round++) {
    const source = Array.from({ length: 3 + random(6) }, () => blocks[random(blocks.length)]).join("\n\n") + "\n";
    const { model, twin, used } = pair(source);
    for (let step = 0; step < 12; step++) {
      const paragraphs = model.nodes.filter(node => node.kind === "paragraph_open");
      const target = paragraphs.length && random(4) ? paragraphs[random(paragraphs.length)] : model.nodes[random(model.nodes.length)];
      const from = target.from + random(target.to - target.from + 1);
      const to = Math.min(target.to, from + random(3));
      const insert = random(3) ? pieces[random(pieces.length)] : "";
      for (const doc of [model, twin]) {
        doc.selection = { anchor: from, head: from };
        doc.replace(from, to, insert, "typing", { anchor: from + insert.length, head: from + insert.length });
      }
      assert.deepEqual(strip(model), strip(twin), `round ${round} step ${step}: ${JSON.stringify(model.text)}`);
      assert.equal(model.serialize(), model.text);
    }
    fast += used.paragraph;
  }
  assert.ok(fast > 500, `fast path used ${fast} times`);
});

test("windowed re-parse matches the full parse for structural edits anywhere, including separators", () => {
  const random = rng(11); let windowed = 0, total = 0;
  for (let round = 0; round < 400; round++) {
    const source = Array.from({ length: 2 + random(8) }, () => blocks[random(blocks.length)]).join(random(5) ? "\n\n" : "\n") + (random(3) ? "\n" : "");
    const { model, twin, used } = pair(source);
    for (let step = 0; step < 10; step++) {
      // Random position anywhere in the text (separators included), sometimes a multi-block range.
      const from = random(model.text.length + 1), to = Math.min(model.text.length, from + (random(6) ? random(4) : random(40)));
      const insert = random(4) ? structural[random(structural.length)] : random(2) ? pieces[random(pieces.length)] : "";
      for (const doc of [model, twin]) {
        doc.selection = { anchor: Math.min(to, from + random(3)), head: Math.min(to, from + random(3)) };
        doc.replace(from, to, insert, random(2) ? "typing" : "command");
      }
      total++;
      assert.deepEqual(strip(model), strip(twin), `round ${round} step ${step}: ${JSON.stringify(model.text)}`);
      // Caret-block refresh after a selection move must agree as well.
      const caret = random(model.text.length + 1);
      for (const doc of [model, twin]) { doc.selection = { anchor: caret, head: caret }; doc.refreshCaret(); }
      assert.deepEqual(strip(model), strip(twin), `round ${round} step ${step} caret ${caret}`);
    }
    windowed += used.window;
  }
  assert.ok(windowed > total / 10, `windowed parse used ${windowed} of ${total}`);
});

test("without footnotes, references or display math most structural edits avoid the full parse", () => {
  const random = rng(3), used = { paragraph: 0, window: 0, full: 0 };
  const clean = /\[\^|\]:|\$\$/, plain = blocks.filter(block => !clean.test(block)), edits = structural.filter(piece => !clean.test(piece));
  for (let round = 0; round < 200; round++) {
    const model = new MarkdownDocument(Array.from({ length: 4 + random(8) }, () => plain[random(plain.length)]).join("\n\n") + "\n");
    const patch = model.patch.bind(model), patchWindow = model.patchWindow.bind(model);
    model.patch = (...args) => { const hit = patch(...args); if (hit) used.paragraph++; return hit; };
    model.patchWindow = (...args) => { const hit = patchWindow(...args); hit ? used.window++ : used.full++; return hit; };
    for (let step = 0; step < 10; step++) {
      const from = random(model.text.length + 1), to = Math.min(model.text.length, from + random(4));
      model.replace(from, to, edits[random(edits.length)], "command");
    }
  }
  assert.ok(used.full < (used.paragraph + used.window) / 2, JSON.stringify(used));
});

test("windowed re-parse handles Enter, Backspace-join, lists, tables, fences and headings like the full parse", () => {
  const source = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\ncode\n```\n\n## Title\n\nLast.\n";
  const { model, twin, used } = pair(source);
  const both = (from, to, insert) => { for (const doc of [model, twin]) { doc.selection = { anchor: from, head: from }; doc.replace(from, to, insert, "structure"); } assert.deepEqual(strip(model), strip(twin), JSON.stringify(model.text)); };
  const at = text => model.text.indexOf(text);
  both(at("First") + 5, at("First") + 5, "\n\n");           // Enter splits a paragraph
  both(at("paragraph.") + 10, at("Second"), "");             // Backspace joins the next paragraph
  both(at("- two") + 5, at("- two") + 5, "\n- three");         // list item
  both(at("| 1 | 2 |") + 9, at("| 1 | 2 |") + 9, "\n| 3 | 4 |"); // table row
  both(at("```js"), at("```js") + 5, "");                      // open fence removed: swallows nothing
  both(at("code\n```") + 5, at("code\n```") + 8, "");          // closing fence removed: block grows to the end
  both(at("## Title"), at("## Title") + 2, "###");             // heading level changes, ids keep order
  both(at("### Title"), at("### Title"), "# Title\n\n");       // duplicate heading before: ids renumber via full parse
  both(0, 0, "Intro line\n\n");                               // shifts every later line
  assert.equal(used.window, 6, `windowed parse used ${used.window} times`);
  for (const doc of [model, twin]) { let steps = 0; while (doc.undo()) steps++; assert.equal(steps, 9); }
  assert.deepEqual(strip(model), strip(twin));
  assert.equal(model.text, source);
  for (const doc of [model, twin]) while (doc.redo());
  assert.deepEqual(strip(model), strip(twin));
});

test("undo and redo chains through the windowed parse match a fresh parse after every step", () => {
  const random = rng(5);
  for (let round = 0; round < 40; round++) {
    const source = Array.from({ length: 3 + random(6) }, () => blocks[random(blocks.length)]).join("\n\n") + "\n";
    const { model } = pair(source);
    const texts = [model.text];
    for (let step = 0; step < 12; step++) {
      const from = random(model.text.length + 1), to = Math.min(model.text.length, from + random(5));
      model.replace(from, to, random(3) ? structural[random(structural.length)] : "", "command");
      if (model.text !== texts.at(-1)) texts.push(model.text);
    }
    const check = () => {
      const fresh = new MarkdownDocument(model.text); fresh.selection = { ...model.selection }; fresh.refreshCaret();
      assert.deepEqual(strip(model), strip(fresh), `round ${round}: ${JSON.stringify(model.text)}`);
    };
    for (let i = texts.length - 2; i >= 0; i--) { assert.ok(model.undo()); assert.equal(model.text, texts[i]); check(); }
    for (let i = 1; i < texts.length; i++) { assert.ok(model.redo()); assert.equal(model.text, texts[i]); check(); }
  }
});

test("line helpers agree with a naive count at every position", () => {
  const random = rng(9);
  for (let round = 0; round < 40; round++) {
    const source = Array.from({ length: 2 + random(6) }, () => blocks[random(blocks.length)]).join(random(2) ? "\n\n" : "\n\n\n") + (random(2) ? "\n" : "");
    const model = new MarkdownDocument(source);
    model.selection = { anchor: random(source.length + 1), head: random(source.length + 1) }; model.refreshCaret();
    for (let position = 0; position <= source.length; position++) {
      const before = source.slice(0, position), line = before.split("\n").length;
      assert.equal(model.lineAt(position), line, `line at ${position}`);
      assert.deepEqual(model.cursorAt(position), { line, column: position - before.lastIndexOf("\n") });
    }
    const starts = [0]; for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
    for (let line = 1; line <= starts.length; line++) assert.equal(model.lineStart(line), starts[line - 1], `start of line ${line}`);
    assert.equal(model.lineStart(starts.length + 5), source.length);
    assert.equal(model.lines, starts.length);
    for (let position = 0; position <= source.length; position++) {
      const expected = model.nodes.find(node => position >= node.from && position <= node.to) || model.nodes.at(-1);
      assert.equal(model.nodeAt(position), expected);
      assert.equal(model.node(expected.id), expected);
    }
  }
});

test("large documents parse into blocks; only absurd sizes or giant blocks are oversized", () => {
  const paragraph = "Paragraph text ș ț with **bold** and `code`.\n\n";
  const big = new MarkdownDocument(paragraph.repeat(25_000));
  assert.ok(big.text.length > 1_000_000);
  assert.ok(big.nodes.length > 20_000);
  assert.equal(big.oversized(), false);
  big.selection = { anchor: 10, head: 10 };
  big.replace(9, 9, "\n\n", "structure");
  assert.equal(big.nodes[0].source, "Paragraph");
  assert.equal(big.nodes.length, 25_002);
  assert.equal(big.serialize(), big.text);
  const giant = new MarkdownDocument("```\n" + "x".repeat(300_000) + "\n```\n");
  assert.equal(giant.oversized(), true);
  const huge = new MarkdownDocument("a".repeat(12_000_001));
  assert.equal(huge.oversized(), true);
  assert.equal(huge.nodes.length, 0);
  assert.equal(huge.root.children[0].kind, "source");
  assert.equal(huge.serialize(), huge.text);
});
