import assert from "node:assert/strict";
import { test } from "node:test";
import { addNode, canvasSubpath, emptyCanvas, groupNodes, moveNodes, parseCanvas, serializeCanvas, undoCanvas, commitCanvas, canvasHistory } from "../shared/json-canvas.mjs";
import { clipKey, clipSource, headingNode, quoteLine, snapshotNode } from "../shared/papercut.mjs";

// Synthetic ES/CA course module; no real notes or patients.
const note = [
  "# Mòdul 3 · Bloqueig interescalènic",
  "",
  "## Indicaciones",
  "",
  "La cirugía de **hombro** y clavícula distal es la indicación principal.",
  "Cobertura C5–C7 con [[Plexo braquial|plexo]] superior.",
  "",
  "## Evidència",
  "",
  "El bloqueig redueix el dolor postoperatori durant 24 hores.",
  "",
].join("\n");
// The words as Learning hands them over: rendered text, so no markup.
const selected = "La cirugía de hombro y clavícula distal es la indicación principal.";

test("a clip becomes a quoted snapshot with a source link Obsidian follows, and keeps its source", () => {
  const node = snapshotNode({ file: "Cursos/Mòdul 3.md", quote: selected, line: 5, headings: ["Mòdul 3 · Bloqueig interescalènic", "Indicaciones"] }, "Instantánea");
  assert.equal(node.type, "text");
  assert.equal(node.text, `> ${selected}\n\nInstantánea · [[Cursos/Mòdul 3#Indicaciones|Mòdul 3 › Indicaciones]]`);
  assert.deepEqual(clipSource(node), { file: "Cursos/Mòdul 3.md", quote: selected, line: 5, heading: "Indicaciones" });
  assert.equal(node.width, 320);
  assert.ok(node.height >= 120 && node.height <= 520 && node.height % 20 === 0);
  assert.equal(clipSource({ ...node, type: "file" }), null, "only text cards carry clips");
  assert.equal(clipSource({ ...node, [clipKey]: { file: "x.canvas", quote: "q" } }), null, "clip sources are notes");
});

test("a board with clips round-trips as plain JSON Canvas; the source key travels as an unknown field", () => {
  let canvas = addNode(emptyCanvas(), { ...snapshotNode({ file: "Mòdul.md", quote: selected, line: 5 }), id: "clip1", x: 20, y: 40 });
  canvas = addNode(canvas, { ...headingNode({ file: "Mòdul.md", headings: ["Evidència"] }), id: "live1", x: 400, y: 40 });
  const text = serializeCanvas(canvas), reopened = parseCanvas(text);
  assert.equal(reopened.editable, true);
  assert.deepEqual(reopened.issues, []);
  assert.equal(serializeCanvas(reopened.canvas), text);
  const nodes = JSON.parse(text).nodes;
  assert.deepEqual(nodes[1], { id: "live1", type: "file", file: "Mòdul.md", subpath: "#Evidència", x: 400, y: 40, width: 360, height: 280 });
  assert.equal(nodes[0][clipKey].quote, selected);
  assert.ok(!/tutor/i.test(text), "no Tutor state in the exchanged file");
});

test("jump to source finds the passage through markup, follows edits above it, and reports when it moved away", () => {
  const source = { quote: selected, line: 5 };
  assert.equal(quoteLine(note, source), 5, "1-based paragraph start");
  const edited = note.replace("## Indicaciones\n", "## Indicaciones\n\nNota nueva del profesor.\n");
  assert.equal(quoteLine(edited, source), 7);
  assert.equal(quoteLine(note.replace("hombro", "codo"), source), null);
  assert.equal(quoteLine(note, { quote: "Cobertura C5–C7 con plexo superior.", line: 6 }), 5, "wiki alias text matches");
  const twice = `${note}\n${selected}\n`;
  assert.equal(quoteLine(twice, { quote: selected, line: 12 }), 12, "nearest copy to the clipped line");
});

test("the snapshot stays as clipped after a note edit while the live heading card follows the note", () => {
  const snapshot = snapshotNode({ file: "Mòdul.md", quote: selected, line: 5, headings: ["Indicaciones"] });
  const live = headingNode({ file: "Mòdul.md", headings: ["Mòdul 3 · Bloqueig interescalènic", "Evidència"] });
  const frozen = JSON.stringify(snapshot);
  assert.equal(canvasSubpath(note, live.subpath), "## Evidència\n\nEl bloqueig redueix el dolor postoperatori durant 24 hores.");
  const edited = note.replace("24 hores", "12 a 24 hores").replace("hombro", "hombro derecho");
  assert.match(canvasSubpath(edited, live.subpath), /12 a 24 hores/);
  assert.equal(JSON.stringify(snapshot), frozen);
  assert.equal(quoteLine(edited, clipSource(snapshot)), null, "source-moved state, words kept");
});

test("clip, move on the grid, group and undo the move as one step each", () => {
  let history = canvasHistory(addNode(emptyCanvas(), { ...snapshotNode({ file: "Mòdul.md", quote: selected, line: 5 }), id: "clip1", x: 0, y: 0 }));
  history = commitCanvas(history, addNode(history.canvas, { ...headingNode({ file: "Mòdul.md", headings: ["Evidència"] }), id: "live1", x: 400, y: 0 }));
  history = commitCanvas(history, moveNodes(history.canvas, ["clip1"], 40, 60));
  assert.deepEqual([history.canvas.nodes[0].x, history.canvas.nodes[0].y], [40, 60]);
  const grouped = groupNodes(history.canvas, ["clip1", "live1"], { id: "g1", label: "Evidencia" });
  history = commitCanvas(history, grouped.canvas);
  assert.equal(history.canvas.nodes[0].id, "g1", "groups sit below their cards");
  history = undoCanvas(undoCanvas(history));
  assert.deepEqual([history.canvas.nodes[0].x, history.canvas.nodes[0].y], [0, 0]);
});
