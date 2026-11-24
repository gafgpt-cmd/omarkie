import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import readingCore from "../shared/reading-core.cjs";
import { matchBlock, normalizeText, placeAnchor, sectionKey } from "../src/glass/anchor-map.ts";

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
