import assert from "node:assert/strict";
import { test } from "node:test";
import { glassWindow } from "../src/glass/glass-window.ts";
import { bulkReanchor } from "../src/glass/reanchor.ts";
import { indexBlocks } from "../src/glass/anchor-map.ts";
import { captureAnchor } from "../shared/anchor-core.mjs";

const item = (id, y, height = 100) => ({ id, y, height });

test("the glass window mounts what intersects the viewport and culls the rest", () => {
  const items = [item("a", 0), item("b", 2_000), item("c", 5_000), item("d", 9_000)];
  const result = glassWindow(items, { top: 1_900, height: 800 }, { overscan: 600 });
  assert.deepEqual([...result.mounted].sort(), ["b"]);
  assert.equal(result.culled, 3);
  assert.equal(result.inView, 1);
});

test("the focused magnet is force-mounted when it scrolls out", () => {
  const items = [item("a", 0), item("b", 9_000)];
  const result = glassWindow(items, { top: 0, height: 800 }, { force: ["b"] });
  assert.deepEqual([...result.mounted].sort(), ["a", "b"]);
  assert.deepEqual(result.forced, ["b"]);
});

test("a crowded band keeps the magnets nearest the viewport centre up to the cap", () => {
  const items = Array.from({ length: 12 }, (_, index) => item(`m${index}`, index * 100));
  const result = glassWindow(items, { top: 0, height: 1_200 }, { overscan: 0, cap: 4 });
  assert.equal(result.mounted.size, 4);
  assert.deepEqual([...result.mounted].sort(), ["m4", "m5", "m6", "m7"]);
});

test("before the first measurement every magnet mounts once", () => {
  const result = glassWindow([item("a", 0), item("b", 5_000)], { top: 0, height: 0 });
  assert.equal(result.mounted.size, 2);
  assert.equal(result.culled, 0);
});

const oldBlocks = [
  { block: "Retrieval practice beats rereading.", headings: ["Memoria"], line: 3 },
  { block: "Space the reviews over days.", headings: ["Memoria"], line: 5 },
  { block: "Interleave related topics.", headings: ["Memoria"], line: 9 },
  { block: "Dosis de carga en el paciente anciano.", headings: ["Farmacología"], line: 13 },
  { block: "Renal clearance falls with age.", headings: ["Farmacología"], line: 15 },
  { block: "This paragraph disappears in the new edition.", headings: ["Old"], line: 19 },
];
const newBlocks = [
  { block: "Inserted preface for the new edition.", headings: ["Memoria"], line: 1 },
  { block: "Interleave related topics in blocks.", headings: ["Memoria"], line: 3 },
  { block: "Space the reviews over several days.", headings: ["Memoria"], line: 5 },
  { block: "Retrieval práctica beats rereading.", headings: ["Memoria"], line: 7 },
  { block: "Dosis de carga en el paciente anciano.", headings: ["Farmacología clínica"], line: 11 },
  { block: "Kidney clearance falls with age.", headings: ["Farmacología clínica"], line: 13 },
];

test("bulk re-anchor sorts a new edition into placed, check and tray without losing old context", () => {
  const entries = oldBlocks.map((block, index) => ({ id: `m${index}`, anchor: captureAnchor(block, oldBlocks) }));
  const rows = bulkReanchor(entries, newBlocks, indexBlocks(newBlocks));
  const states = Object.fromEntries(rows.map(row => [row.id, row.state]));
  assert.equal(states.m0, "placed", "same words, same section");
  assert.equal(states.m1, "placed", "rewritten end of paragraph stays a quote match");
  assert.equal(states.m3, "placed", "Spanish paragraph survives a heading rename");
  assert.equal(states.m5, "tray", "deleted paragraph opens the tray");
  for (const row of rows) {
    assert.ok(row.old.quote.length > 0, `${row.id} keeps the old quote`);
    assert.equal(row.old.heading, oldBlocks[Number(row.id.slice(1))].headings.join(" › "));
  }
  const placed = rows.find(row => row.id === "m4");
  assert.ok(placed.candidate?.quote.includes("Kidney"), "the new text is shown beside the old");
});

test("re-anchoring folds accents, so Spanish and English text find the same home", () => {
  const source = [{ block: "Presión arterial y frecuencia cardíaca.", headings: ["Fisiología"], line: 1 }];
  const target = [{ block: "Presion arterial y frecuencia cardiaca.", headings: ["Fisiologia"], line: 1 }];
  const [row] = bulkReanchor([{ id: "m", anchor: captureAnchor(source[0], source) }], target, indexBlocks(target));
  assert.equal(row.state, "placed");
  assert.equal(row.line, 1);
});

test("200 magnets re-anchor over a 1,000-page note inside the frame budget", () => {
  const words = "steady review keeps the useful detail available for later recall".split(" ");
  const blocks = Array.from({ length: 20_000 }, (_, index) => ({
    block: `Paragraph ${index} ${words[index % words.length]} ${words[(index * 7) % words.length]}.`,
    headings: [`Section ${Math.floor(index / 20)}`],
    line: index * 2 + 1,
  }));
  const anchors = Array.from({ length: 200 }, (_, index) => ({
    id: `m${index}`,
    anchor: captureAnchor(blocks[Math.floor((index / 200) * blocks.length)], blocks),
  }));
  const started = performance.now();
  const rows = bulkReanchor(anchors, blocks, indexBlocks(blocks));
  const elapsed = performance.now() - started;
  assert.equal(rows.length, 200);
  assert.ok(rows.every(row => row.state === "placed"), "every original paragraph is found");
  assert.ok(elapsed < 150, `bulk re-anchor took ${elapsed.toFixed(1)} ms`);
});
