import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import readingCore from "../shared/reading-core.cjs";
import { captureAnchor, matchBlock, normalizeText, placeAnchor, placeLandmarks, quoteScore, resolveAnchor, sectionKey, textHash } from "../src/glass/anchor-map.ts";

const core = readingCore(value => createHash("sha256").update(value).digest("hex"));
const digest = value => createHash("sha256").update(value).digest("hex");
const blocks = [
  { block: "Retrieval practice beats rereading.", headings: ["Memory"], line: 3 },
  { block: "Space the reviews over days.", headings: ["Memory"], line: 5 },
  { block: "Interleave related topics.", headings: ["Memory", "Planning"], line: 9 },
  { block: "Unrelated closing remark.", headings: ["Afterword"], line: 13 },
];
const anchor = (text, headings = ["Memory"]) => ({ landmarks: [{ kind: "block", block: text, headings }] });
const resolve = (text, headings = ["Memory"], live = blocks) =>
  core.resolveReadingAnchors([{ id: "glass", anchor: core.readingAnchor({ block: text, headings, line: 1, quote: "" }) }], live)[0].line;

test("a block anchor resolves by hash, section text, or a 0.8 fuzzy match", () => {
  assert.equal(matchBlock(anchor("Retrieval practice beats rereading."), blocks), 3);
  assert.equal(matchBlock(anchor("Space the reviews over days."), blocks), 5);
  assert.equal(matchBlock(anchor("Interleave related topic.", ["Memory", "Planning"]), blocks), 9);
  assert.equal(matchBlock(anchor("Interleave topics.", ["Memory", "Planning"]), blocks), null);
  assert.equal(matchBlock(anchor("Space the reviews over two days."), blocks), 5);
  assert.equal(matchBlock(anchor("Space the reviews, spaced over days."), blocks), 5);
  assert.equal(matchBlock(anchor("Nothing like this paragraph."), blocks), null);
  assert.equal(matchBlock({ landmarks: [] }, blocks), null);
});

test("a renamed heading keeps the paragraph, and a copy never guesses", () => {
  assert.equal(matchBlock(anchor("Retrieval practice beats rereading.", ["Renamed"]), blocks), 3);
  const copy = [...blocks, { block: "Space the reviews over days.", headings: ["Memory"], line: 20 }];
  assert.equal(matchBlock(anchor("Space the reviews over days."), copy), null);
  assert.equal(resolve("Space the reviews over days.", ["Memory"], copy), null);
  const elsewhere = [...blocks, { block: "Space the reviews over days.", headings: ["Afterword"], line: 21 }];
  assert.equal(matchBlock(anchor("Space the reviews over days."), elsewhere), 5);
  assert.equal(resolve("Space the reviews over days.", ["Memory"], elsewhere), 5);
});

test("placement is the live rect in glass space, or orphan", () => {
  const element = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 300, height: 20 }) };
  const hot = [{ block: "Space the reviews over days.", headings: ["Memory"], line: 5, element }];
  const glass = { getBoundingClientRect: () => ({ left: 10, top: 5 }) };
  assert.deepEqual(placeAnchor(anchor("Space the reviews over days."), { x: 2, y: 3 }, hot, glass), { status: "resolved", x: 92, y: 48, width: 300, height: 20 });
  assert.deepEqual(placeAnchor(anchor("Space the reviews over days."), { x: 2, y: 3 }, [], glass), { status: "orphan" });
  assert.deepEqual(placeAnchor({ landmarks: [] }, { x: 0, y: 0 }, hot, glass), { status: "orphan" });
  assert.deepEqual(placeAnchor(anchor("Space the reviews over days."), { x: 0, y: 0 }, [{ ...hot[0], element: undefined }], glass), { status: "orphan" });
});

test("the Glass resolver agrees with the shared reading-core resolver", () => {
  const cases = [
    ["Retrieval practice beats rereading.", ["Memory"]],
    ["Space the reviews over days.", ["Memory"]],
    ["Interleave related topic.", ["Memory", "Planning"]],
    ["Space the reviews over two days.", ["Memory"]],
    ["Space the reviews over days.", ["Afterword"]],
    ["Nothing like this paragraph.", ["Memory"]],
    ["Retrieval practice beats rereading.", ["Renamed"]],
  ];
  for (const [text, headings] of cases) assert.equal(matchBlock(anchor(text, headings), blocks), resolve(text, headings), text);
  assert.equal(normalizeText("  two\twords \n"), "two words");
  assert.equal(sectionKey([" Memory ", "Planning"]), JSON.stringify(["Memory", "Planning"]));
  assert.notEqual(core.readingAnchor({ block: "Space the reviews over days.", headings: ["Memory"], line: 5, quote: "" }).hash,
    core.readingAnchor({ block: "Space the reviews over days.", headings: ["Afterword"], line: 5, quote: "" }).hash);
  assert.equal(core.readingAnchor({ block: " Space  the reviews\nover days. ", headings: ["Memory"], line: 5, quote: "" }).hash, digest(JSON.stringify(["Space the reviews over days.", JSON.stringify(["Memory"])])));
});

const document = "# Memory\n\nAlpha paragraph about retrieval practice.\n\nBeta paragraph about spaced repetition.\n\n## Planning\n\nGamma paragraph about interleaving topics.\n\nUnrelated closing remark.\n";
function blockFixture(text, headings, line, previous) {
  const from = document.indexOf(text, previous);
  const to = from + text.length;
  return { block: text, headings, line, from, to,
    words: (document.slice(0, from).match(/\S+/gu) ?? []).length,
    percent: from / document.length,
    prefix: document.slice(Math.max(0, from - 32), from),
    suffix: document.slice(to, to + 32) };
}
const stack = [
  blockFixture("Alpha paragraph about retrieval practice.", ["Memory"], 3, 0),
  blockFixture("Beta paragraph about spaced repetition.", ["Memory"], 5, 0),
  blockFixture("Gamma paragraph about interleaving topics.", ["Memory", "Planning"], 9, 0),
  blockFixture("Unrelated closing remark.", ["Memory", "Planning"], 11, 0),
];
const anchorOf = block => captureAnchor(block, stack);
const only = (anchor, ...kinds) => ({ landmarks: anchor.landmarks.filter(item => kinds.includes(item.kind)) });

test("capture keeps the six landmark tiers strongest first", () => {
  const anchor = anchorOf(stack[0]);
  assert.equal(anchor.version, 2);
  assert.deepEqual(anchor.landmarks.map(item => item.kind), ["fingerprint", "quote", "heading", "neighbours", "position", "spot"]);
  assert.equal(anchor.landmarks[1].value.prefix.length <= 32, true);
  assert.equal(anchor.landmarks[1].value.exact, stack[0].block);
  assert.equal(anchor.landmarks[3].value.after, textHash(stack[1].block));
  assert.deepEqual(anchor.landmarks[4].value, { line: 3, char: stack[0].from, word: 2, percent: stack[0].from / document.length });
  assert.equal(matchBlock(anchor, stack), 3);
});

test("fingerprint wins exactly, and a renamed section only lowers confidence", () => {
  const anchor = anchorOf(stack[0]);
  assert.deepEqual(resolveAnchor(anchor, stack), { line: 3, confidence: 1, tier: "fingerprint" });
  const renamed = stack.map(block => block.line === 3 ? { ...block, headings: ["Renamed"] } : block);
  assert.ok(resolveAnchor(anchor, renamed).confidence >= 0.85);
  assert.equal(resolveAnchor(anchor, renamed).line, 3);
  assert.equal(resolveAnchor(only(anchor, "fingerprint"), renamed).confidence, 0.85);
  assert.equal(matchBlock(anchor, renamed), 3);
});

test("quote resolves exact, fuzzy, and refuses a tie", () => {
  const anchor = anchorOf(stack[1]), quoteOnly = only(anchor, "quote");
  assert.deepEqual([resolveAnchor(quoteOnly, stack).line, resolveAnchor(quoteOnly, stack).tier], [5, "quote"]);
  assert.equal(resolveAnchor(quoteOnly, stack).confidence, 0.95);
  const rewritten = stack.map(block => block.line === 5 ? { ...block, block: "Beta paragraph about spreading review sessions." } : block);
  const fuzzy = resolveAnchor(quoteOnly, rewritten);
  assert.equal(fuzzy.line, 5);
  assert.ok(fuzzy.confidence >= 0.5 && fuzzy.confidence < 0.8, `${fuzzy.confidence} must be a dotted check`);
  const twin = [...stack, { ...stack[1], line: 20, from: 900, to: 900 + stack[1].block.length }];
  assert.equal(resolveAnchor(quoteOnly, twin).line, null);
});

test("heading plus neighbours carries a rewritten paragraph", () => {
  const anchor = anchorOf(stack[2]);
  const rewritten = stack.map(block => block.line === 9 ? { ...block, block: "Gamma paragraph now covers interleaving different topics." } : block);
  assert.equal(resolveAnchor(only(anchor, "heading", "neighbours"), rewritten).line, 9);
  assert.equal(resolveAnchor(only(anchor, "heading", "neighbours"), rewritten).confidence, 0.85);
  const both = resolveAnchor(only(anchor, "quote", "heading", "neighbours"), rewritten);
  assert.equal(both.line, 9);
  assert.ok(both.confidence >= 0.5 && both.confidence < 0.8, `${both.confidence} must be a dotted check`);
});

test("position and live mapping place when text changed, and nothing means tray", () => {
  const anchor = anchorOf(stack[3]), positionOnly = only(anchor, "position");
  const position = resolveAnchor(positionOnly, stack);
  assert.equal(position.line, 11);
  assert.ok(position.confidence >= 0.5 && position.confidence < 0.8);
  assert.equal(resolveAnchor(positionOnly, stack, { liveChar: stack[3].from + 2 }).tier, "live");
  assert.equal(resolveAnchor(positionOnly, stack, { liveChar: stack[3].from + 2 }).confidence, 0.95);
  assert.deepEqual(resolveAnchor({ landmarks: [] }, stack), { line: null, confidence: 0, tier: "none" });
  assert.ok(resolveAnchor({ landmarks: [] }, stack).confidence < 0.5);
});

test("placement returns the resolved rect, or the tray when nothing is confident", () => {
  const element = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 300, height: 20 }) };
  const glass = { getBoundingClientRect: () => ({ left: 10, top: 5 }) };
  const live = stack.map(block => block.line === 3 ? { ...block, element } : block);
  const placed = placeLandmarks(anchorOf(stack[0]), { x: 2, y: 3 }, live, glass);
  assert.equal(placed.status, "resolved");
  if (placed.status !== "resolved") return;
  assert.equal(placed.line, 3);
  assert.equal(placed.confidence, 1);
  assert.equal(placed.x, 92 + 150);
  assert.equal(placed.y, 48 + 10);
  const lost = placeLandmarks({ landmarks: [] }, { x: 0, y: 0 }, live, glass);
  assert.deepEqual(lost, { status: "orphan", confidence: 0, tier: "none", line: null });
});

test("quote fuzz is deterministic and clamped below an exact match", () => {
  assert.equal(quoteScore("Space the reviews over days.", "Space the reviews over days."), 1);
  const score = quoteScore("Space the reviews over days.", "Space the reviews, spaced over days.");
  assert.equal(score, quoteScore("Space the reviews over days.", "Space the reviews, spaced over days."));
  assert.ok(score > 0.5 && score < 1);
  assert.equal(quoteScore("", "anything"), 0);
});
