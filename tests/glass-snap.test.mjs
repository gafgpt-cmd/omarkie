import assert from "node:assert/strict";
import { test } from "node:test";
import { settleDelta, snapBox, snapSetting } from "../shared/glass-snap.mjs";

const box = (x, y, w = 200, h = 120) => ({ x, y, w, h });

test("a magnet snaps its edge to a neighbour's edge and reports the guide", () => {
  const other = box(300, 200, 180, 100);
  const result = snapBox({ box: box(304, 500), others: [other] });
  assert.equal(result.x, 300, "left edges line up");
  const guide = result.guides.find(item => item.axis === "x");
  assert.equal(guide.kind, "edge");
  assert.equal(guide.at, 300);
  assert.deepEqual([guide.from, guide.to], [200, 620], "the guide spans both magnets");
  assert.equal(result.snapped.x, true);
});

test("centres align when the centre is the closest pair", () => {
  const other = box(200, 100, 200, 100);
  const same = snapBox({ box: box(203, 400), others: [other] });
  assert.equal(same.x, 200, "same width: centre and edges tie, the edge wins");
  assert.equal(same.guides.find(item => item.axis === "x").kind, "edge");
  const shifted = snapBox({ box: box(247, 400, 100, 100), others: [other] });
  assert.equal(shifted.x, 250, "a narrower magnet centres on the neighbour's centre");
  assert.equal(shifted.guides.find(item => item.axis === "x").kind, "center");
  assert.equal(shifted.guides.find(item => item.axis === "x").at, 300);
});

test("the page text column edges are guides too", () => {
  const column = { left: 120, right: 820 };
  const left = snapBox({ box: box(124, 400), column });
  assert.equal(left.x, 120);
  assert.equal(left.guides.find(item => item.axis === "x").kind, "column");
  const right = snapBox({ box: box(618, 400, 200), column });
  assert.equal(right.x, 620);
  assert.equal(right.guides.find(item => item.axis === "x").kind, "column");
});

test("dropping near a text line glues the top to that line", () => {
  const lines = [{ y: 300, x: 120, width: 700 }, { y: 324, x: 120, width: 700 }];
  const result = snapBox({ box: box(400, 295), lines });
  assert.equal(result.y, 300, "top sits on the line");
  const guide = result.guides.find(item => item.axis === "y");
  assert.equal(guide.kind, "line");
  assert.equal(guide.from, 120);
  assert.equal(guide.to, 820);
  const far = snapBox({ box: box(400, 240), lines });
  assert.equal(far.y, 240, "out of reach it keeps its own place, rounded to the grid");
  assert.equal(far.guides.some(item => item.kind === "line"), false);
});

test("grid is optional and resizable", () => {
  const free = snapBox({ box: box(203, 417), grid: 8 });
  assert.deepEqual([free.x, free.y], [200, 416]);
  const wide = snapBox({ box: box(203, 417), grid: 24 });
  assert.deepEqual([wide.x, wide.y], [192, 408]);
  assert.deepEqual(snapSetting({ on: false, size: 16 }), { on: false, size: 16 });
  assert.deepEqual(snapSetting({ on: true, size: 7 }), { on: true, size: 8 }, "unknown sizes fall back to 8");
  assert.deepEqual(snapSetting(undefined), { on: true, size: 8 });
});

test("Alt (disabled) keeps the raw place and paints nothing", () => {
  const result = snapBox({ box: box(401, 399), others: [box(400, 100)], lines: [{ y: 398 }], column: { left: 400, right: 800 }, disabled: true });
  assert.deepEqual([result.x, result.y], [401, 399]);
  assert.deepEqual(result.guides, []);
  assert.deepEqual(result.snapped, { x: false, y: false });
  const raw = snapBox({ box: { x: 401.4, y: 399.6, w: 72, h: 72 }, others: [box(400, 100)], disabled: true });
  assert.deepEqual([raw.x, raw.y], [401.4, 399.6], "Alt keeps the hand's sub-pixel place");
});

test("a spacing hint names an even gap beside a neighbour", () => {
  const other = box(200, 300, 100, 100);
  const result = snapBox({ box: box(308, 310, 80, 80), others: [other] });
  const gap = result.guides.find(item => item.kind === "spacing");
  assert.ok(gap, "an 8 px gap between the two is hinted");
  assert.equal(gap.axis, "x");
  assert.equal(gap.gap, 8);
  assert.deepEqual([gap.from, gap.to], [310, 390]);
});

test("guides stay inside the 2 ms budget with 200 magnets", () => {
  const others = Array.from({ length: 200 }, (_, index) => box((index % 20) * 220 + 40, Math.floor(index / 20) * 150 + 20));
  const lines = Array.from({ length: 80 }, (_, index) => ({ y: 290 + index * 22, x: 120, width: 700 }));
  const costs = [];
  for (let index = 0; index < 600; index++) {
    const started = performance.now();
    snapBox({ box: box(402 + (index % 9), 391 + (index % 7)), others, lines, column: { left: 120, right: 820 }, grid: 8 });
    costs.push(performance.now() - started);
  }
  costs.sort((a, b) => a - b);
  const median = costs[costs.length / 2], p95 = costs[Math.ceil(costs.length * 0.95) - 1];
  assert.ok(median < 2, `guides cost ${median.toFixed(3)} ms per move (p95 ${p95.toFixed(3)})`);
});

test("the settle delta is the distance from the hand to the snapped spot", () => {
  assert.deepEqual(settleDelta({ x: 4, y: -3 }, { x: 0, y: 0 }), { x: -4, y: 3 });
  assert.deepEqual(settleDelta(undefined, { x: 3, y: 3 }), { x: 0, y: 0 });
});
