import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { commonPairs, morphPlan, nearestStop, scrubSegment, WORD_MORPH_LIMIT } from "../shared/fold-morph.mjs";
import { foldDocumentLadder } from "../shared/fold-units.mjs";

const split = text => text.split(/\s+/).filter(Boolean);

test("a sentence-prefix stop keeps the author's leading words and adds only the more marker", () => {
  const full = split("Assess perfusion within the first hour. Cold and wet means low output.");
  const { kept, added } = morphPlan(full, split("Assess perfusion within the first hour. …"));
  assert.deepEqual([...kept], [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(added, [{ after: 5, token: "…" }]);
});

test("an empty stop drops every word and a marker at the start anchors before the first word", () => {
  assert.deepEqual([...morphPlan(split("a b c"), []).kept], [0, 0, 0]);
  assert.deepEqual(morphPlan(split("a b"), split("⋯ a")).added, [{ after: -1, token: "⋯" }]);
});

test("common pairs are a longest common subsequence in order", () => {
  const pairs = commonPairs(split("x a b y c d"), split("a c z d"));
  assert.deepEqual(pairs, [[1, 0], [4, 1], [5, 3]]);
});

test("large token lists fall back to an in-order greedy match", () => {
  const source = Array.from({ length: 6000 }, (_, i) => `w${i % 700}`);
  const target = source.filter((_, i) => i % 3 === 0).concat("…");
  const { kept, added } = morphPlan(source.concat("tail"), target);
  assert.equal(kept.reduce((sum, value) => sum + value, 0), 2000);
  assert.deepEqual(added.map(item => item.token), ["…"]);
});

test("slider positions map to a segment, a nearest stop and clamped steps", () => {
  assert.deepEqual(scrubSegment(2.25, 5), { from: 2, to: 3, fraction: 0.25 });
  assert.deepEqual(scrubSegment(4, 5), { from: 3, to: 4, fraction: 1 });
  assert.deepEqual(scrubSegment(-1, 5), { from: 0, to: 1, fraction: 0 });
  assert.equal(nearestStop(1.6, 5), 2);
  assert.equal(nearestStop(Number.NaN, 5), 0);
  assert.equal(WORD_MORPH_LIMIT, 300);
});

test("every author word in each fixture-12 stop maps onto its Full words", async () => {
  const markdown = await readFile(new URL("fixtures/fold/12-physiology-chapter-10k/input.md", import.meta.url), "utf8");
  const ladder = foldDocumentLadder(markdown);
  for (const { stops } of ladder.byUnit) {
    const full = split(stops.full);
    for (const level of ["brief", "key", "takeaway", "topic"]) {
      const { added } = morphPlan(full, split(stops[level]));
      assert.ok(added.every(item => /^(?:…|`?⋯|\d+|lines?|of|code`?|\|.*)$/.test(item.token)), `${level}: ${added.map(item => item.token).join(" ")}`);
    }
  }
});
