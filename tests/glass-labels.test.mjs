import assert from "node:assert/strict";
import test from "node:test";
import { labelBox, labelFields, labelPoint, validLabelTarget } from "../shared/glass-labels.mjs";

const anchor = { version: 1, landmarks: [{ kind: "heading", value: { path: ["Anatomy"] } }] };

test("a label target is an image magnet or a page image with an anchor", () => {
  assert.equal(validLabelTarget({ kind: "magnet", magnet: "img-1" }), true);
  assert.equal(validLabelTarget({ kind: "element", element: "el-1", anchor }), true);
  assert.equal(validLabelTarget({ kind: "magnet", magnet: "" }), false);
  assert.equal(validLabelTarget({ kind: "element", element: "el-1" }), false);
  assert.equal(validLabelTarget({ kind: "sticky", magnet: "img-1" }), false);
});

test("label fields keep the pin normalised and the leader inside limits", () => {
  const fields = labelFields({ kind: "label", target: { kind: "magnet", magnet: "img-1" }, text: "Median nerve", nx: 0.25, ny: 0.75 });
  assert.equal(fields.nx, 0.25);
  assert.equal(fields.ny, 0.75);
  assert.equal(fields.hidden, false);
  assert.equal(fields.marked, false);
  assert.throws(() => labelFields({ kind: "label", target: { kind: "magnet", magnet: "img-1" }, text: "x", nx: 1.2 }),
    /between 0 and 1/);
  assert.throws(() => labelFields({ kind: "label", target: { kind: "magnet", magnet: "img-1" }, text: " " }), /needs text/);
});

test("partial edits can hide or reveal one label without resending the target", () => {
  assert.deepEqual(labelFields({ hidden: true }, true), { hidden: true });
  assert.deepEqual(labelFields({ marked: true }, true), { marked: true });
  assert.throws(() => labelFields({ dx: 4_001 }, true), /-4,000 and 4,000/);
});

test("the pin point tracks the picture box; the text box follows the leader", () => {
  const box = { x: 100, y: 200, width: 400, height: 300 };
  assert.deepEqual(labelPoint(box, 0.5, 0.5), { x: 300, y: 350 });
  assert.deepEqual(labelPoint(box, 0, 0), { x: 100, y: 200 });
  assert.deepEqual(labelBox({ x: 300, y: 350 }, 20, -16), { left: 320, top: 334, width: 80 });
});
