import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyGesture, gestureAction, gestureDefaults } from "../shared/glass-gestures.mjs";

const ellipse = (steps, gap = 0, cx = 200, cy = 200, rx = 80, ry = 30) => {
  const points = Array.from({ length: steps }, (_, index) => {
    const angle = gap + (index / steps) * (Math.PI * 2 - gap);
    return [cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry];
  });
  return gap ? points : points.concat([[cx + rx, cy]]);
};

const arrow = [
  [100, 100], [150, 100], [200, 100], [240, 100],
  [228, 88], [240, 100], [228, 112], [240, 100],
  [226, 90], [240, 100], [226, 110], [240, 100],
];

test("a closed loop around words is a confident circle", () => {
  const result = classifyGesture(ellipse(64));
  assert.equal(result.kind, "circle");
  assert.equal(result.reason, "closed");
  assert.ok(result.confidence >= gestureDefaults.confident);
  assert.equal(gestureAction(result, { hasText: true }), "bubble");
});

test("a loose loop is still ink unless its chip is used", () => {
  const result = classifyGesture(ellipse(64, 0.6));
  assert.equal(result.kind, "circle");
  assert.equal(result.reason, "loose");
  assert.ok(result.confidence < gestureDefaults.confident);
});

test("a circle without enclosed text never makes a bubble", () => {
  const result = classifyGesture(ellipse(64));
  assert.equal(gestureAction(result, { hasText: false }), "none");
});

test("a half arc is not a circle", () => {
  const arc = ellipse(32).slice(0, 18);
  assert.equal(classifyGesture(arc).kind, "none");
});

test("a figure eight is a lasso, never a circle", () => {
  const lasso = [];
  for (let index = 0; index < 64; index++) {
    const angle = (index / 64) * Math.PI * 4;
    lasso.push([200 + Math.sin(angle) * 70, 200 + Math.cos(angle) * 30]);
  }
  const result = classifyGesture(lasso);
  assert.equal(result.kind, "none");
  assert.equal(result.reason, "lasso");
});

test("a tap shorter than the 24 px gate stays ink", () => {
  const result = classifyGesture([[10, 10], [16, 12], [20, 14], [22, 15]]);
  assert.equal(result.kind, "none");
  assert.equal(result.reason, "too-short");
});

test("a flat stroke under a text line is an underline", () => {
  const line = [[100, 100], [150, 101], [220, 100], [300, 102]];
  const result = classifyGesture(line, { lines: [{ top: 90, bottom: 112 }] });
  assert.equal(result.kind, "underline");
  assert.equal(result.confidence, 0.9);
  assert.equal(gestureAction(result), "highlight");
});

test("the same flat stroke in blank margin is not an underline", () => {
  const line = [[100, 500], [150, 501], [220, 500], [300, 502]];
  assert.equal(classifyGesture(line).kind, "none");
});

test("a diagonal stroke with a head is an arrow", () => {
  const result = classifyGesture(arrow);
  assert.equal(result.kind, "arrow");
  assert.ok(result.confidence >= 0.8);
  assert.equal(gestureAction(result, { hasEnds: true }), "connector");
});

test("an arrow between nothing never becomes a connector", () => {
  assert.equal(gestureAction(classifyGesture(arrow), { hasEnds: false }), "none");
});

test("a plain diagonal is not an arrow", () => {
  const diagonal = Array.from({ length: 16 }, (_, index) => [100 + index * 12, 100 + index * 8]);
  assert.equal(classifyGesture(diagonal).kind, "none");
});

test("a scribble is neither underline nor circle", () => {
  const scribble = [];
  for (let index = 0; index < 48; index++) scribble.push([100 + (index % 6) * 14, 200 + (index % 3) * 10]);
  const result = classifyGesture(scribble, { lines: [{ top: 190, bottom: 210 }] });
  assert.equal(result.kind, "none");
});
