import assert from "node:assert/strict";
import { test } from "node:test";
import { noteKey, planMoves, shapeScore } from "../shared/glass-moves.mjs";

function note(id, path, hash, size, headings = ["Note"]) {
  return { id, path, hash, size, shape: { headings, firstLines: [headings[0]], fileName: path.split("/").at(-1) } };
}

function file(path, hash, size, headings = ["Note"]) {
  return { path, hash, size, shape: { headings, firstLines: [headings[0]], fileName: path.split("/").at(-1) } };
}

test("a 500-note folder rename is one prefix swap with every note kept", () => {
  const missing = Array.from({ length: 500 }, (_, index) => note(`n${index}`, `Old/Unit ${index}.md`, `h${index}`, 100 + index, [`Unit ${index}`]));
  const added = Array.from({ length: 500 }, (_, index) => file(`New/Unit ${index}.md`, `h${index}`, 100 + index, [`Unit ${index}`]));
  added.push(file("New/unrelated.md", "new", 20, ["Unrelated"]));
  const plan = planMoves({ missing, added });
  assert.equal(plan.folders.length, 1);
  assert.equal(plan.folders[0].from, "Old");
  assert.equal(plan.folders[0].to, "New");
  assert.equal(plan.folders[0].count, 500);
  assert.equal(plan.moves.length, 0);
  assert.deepEqual(plan.lost, []);
  assert.deepEqual(plan.unmatched, ["New/unrelated.md"]);
});

test("a folder rename with one edited note pairs it by shape, not hash", () => {
  const missing = [note("a", "Old/a.md", "a1", 100, ["Alpha", "One"]), note("b", "Old/b.md", "b1", 100, ["Beta", "Two"])];
  const added = [file("New/a.md", "a2", 108, ["Alpha", "One"]), file("New/b.md", "b1", 100, ["Beta", "Two"])];
  const plan = planMoves({ missing, added });
  assert.equal(plan.folders.length, 1);
  assert.equal(plan.folders[0].count, 2);
  assert.equal(plan.folders[0].exact, 1);
});

test("a single move keeps the note id; an ambiguous copy goes to lost", () => {
  const missing = [note("a", "notes/a.md", "same", 10, ["Alpha"]), note("b", "notes/b.md", "gone", 10, ["Beta"])];
  const added = [file("archive/a.md", "same", 10, ["Alpha"]), file("archive/c.md", "other", 10, ["Gamma"])];
  const plan = planMoves({ missing, added });
  assert.deepEqual(plan.moves.map(move => [move.id, move.to]), [["a", "archive/a.md"]]);
  assert.deepEqual(plan.lost.map(item => item.id), ["b"]);
});

test("a heavily rewritten note at a new path with a new name is lost, never deleted", () => {
  const missing = [note("a", "notes/a.md", "old", 500, ["Kerma", "Dose", "Units"])];
  const added = [file("elsewhere/renamed.md", "new", 60, ["Something", "Else"])];
  const plan = planMoves({ missing, added });
  assert.equal(plan.moves.length, 0);
  assert.deepEqual(plan.lost, [{ id: "a", path: "notes/a.md" }]);
});

test("shape similarity reaches the 0.8 threshold for a same-name edited note", () => {
  const left = { fingerprint: { size: 120, shape: { headings: ["Kerma"], firstLines: ["Kerma and dose"], fileName: "Kerma.md" } } };
  const right = { size: 130, shape: { headings: ["Kerma"], firstLines: ["Kerma and dose"], fileName: "Kerma.md" } };
  assert.ok(shapeScore(left, right) >= 0.8);
  assert.equal(noteKey("Cafe\u0301/Fluoroscopía.md"), "Café/Fluoroscopía.md");
  assert.equal(noteKey("Kerma.md", true), noteKey("kerma.md", true));
});
