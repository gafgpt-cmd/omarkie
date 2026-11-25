import assert from "node:assert/strict";
import test from "node:test";
import {
  angleDegrees, formatMeasure, lineLength, measureLabel, scaleFromLine, unitsPerPixel,
} from "../shared/glass-visual.mjs";

const frame = [400, 300];
const line = [[0.1, 0.1], [0.6, 0.1]];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("scale math keeps the unit the clinician typed", () => {
  const scale = scaleFromLine(line, 100, "mm", 1, frame);
  close(unitsPerPixel(scale), 0.5);
  close(lineLength([[0.2, 0.4], [0.7, 0.4]], scale, frame), 100);
  assert.equal(formatMeasure(lineLength([[0.2, 0.4], [0.7, 0.4]], scale, frame), scale.unit, scale.precision), "100.0 mm");
});

test("a measured line keeps its value when the picture is resized", () => {
  const scale = scaleFromLine(line, 100, "mm", 1, frame);
  const measure = { type: "line", points: [[0.2, 0.4], [0.7, 0.4]] };
  assert.equal(measureLabel(measure, scale, [800, 600]), "100.0 mm");
  assert.equal(measureLabel(measure, scale, [200, 150]), "100.0 mm");
});

test("a different unit is never converted silently", () => {
  const scale = scaleFromLine(line, 100, "cm", 2, frame);
  assert.equal(scale.unit, "cm");
  assert.equal(scale.length, 100);
  close(lineLength([[0.2, 0.4], [0.7, 0.4]], scale, frame), 100);
  assert.equal(formatMeasure(100, scale.unit, scale.precision), "100.00 cm");
  assert.throws(() => scaleFromLine(line, 100, "um", 1, frame));
});

test("angle math uses the frame aspect: three points, vertex first", () => {
  assert.equal(angleDegrees([[0, 0], [1, 0], [0, 1]], [100, 100]), 90);
  assert.equal(angleDegrees([[0.5, 0.5], [1, 0.5], [0.5, 1]], [200, 100]), 90);
  assert.equal(angleDegrees([[0.5, 0.5], [1, 0.5], [1, 1]], [100, 100]), 45);
  assert.equal(angleDegrees([[0.5, 0.5], [1, 0.5], [0.5, 0.5 + 0.5 * (100 / 200)]], [200, 100]), 90);
});

test("a zero arm has no angle", () => {
  assert.equal(angleDegrees([[0.5, 0.5], [0.5, 0.5], [1, 1]], frame), null);
});
