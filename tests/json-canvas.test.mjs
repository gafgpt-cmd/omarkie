import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  addEdge, addNode, bringToFront, canvasHistory, canvasSubpath, commitCanvas, groupMembers, groupNodes, moveNodes, parseCanvas,
  redoCanvas, removeItems, serializeCanvas, setGeometry, snapToGrid, undoCanvas, updateNode,
} from "../shared/json-canvas.mjs";

const fixture = name => readFile(new URL(`./fixtures/json-canvas/${name}`, import.meta.url), "utf8");
// Order-sensitive structural comparison: IDs, z-order, geometry, unknown keys; never whitespace.
const same = (a, b) => assert.equal(JSON.stringify(JSON.parse(a)), JSON.stringify(JSON.parse(b)));

for (const name of ["sample.canvas", "mixed.canvas"]) test(`${name} round-trips with ids, order, geometry, subpaths, colours, edges and unknown keys intact`, async () => {
  const text = await fixture(name);
  const { canvas, issues, editable } = parseCanvas(text);
  assert.equal(editable, true);
  assert.deepEqual(issues, []);
  same(serializeCanvas(canvas), text);
  assert.match(serializeCanvas(canvas), /^\{\n\t"nodes"/, "tab-indented like Obsidian");
});

test("an edit rewrites only what it touches and keeps unknown keys", async () => {
  const text = await fixture("mixed.canvas");
  const { canvas } = parseCanvas(text);
  const moved = setGeometry(canvas, { "t-roots": { x: 21, y: 39 } });
  const before = JSON.parse(text), after = JSON.parse(serializeCanvas(moved));
  assert.deepEqual(after.nodes[1], { ...before.nodes[1], x: 21, y: 39 });
  assert.deepEqual(Object.keys(after.nodes[1]), Object.keys(before.nodes[1]));
  assert.deepEqual(after.nodes[1]["x-omarkie-test"], { kept: true });
  assert.equal(after["x-omarkie-fixture"], before["x-omarkie-fixture"]);
  assert.deepEqual(after.edges, before.edges);
  for (let index = 0; index < before.nodes.length; index++) if (index !== 1) assert.deepEqual(after.nodes[index], before.nodes[index]);
  assert.equal(setGeometry(moved, { "t-roots": { x: 21 } }), moved, "a no-op gesture keeps the same document");
});

test("unknown node types, broken shapes and duplicate ids open read-only; dangling edges stay editable", () => {
  const unknown = parseCanvas(JSON.stringify({ nodes: [{ id: "a", type: "embed", x: 0, y: 0, width: 10, height: 10, src: "x" }] }));
  assert.equal(unknown.editable, false);
  assert.deepEqual(unknown.issues, [{ kind: "unknown-type", id: "a", type: "embed" }]);
  assert.equal(serializeCanvas(unknown.canvas).includes('"src": "x"'), true, "kept, not stripped");
  assert.equal(parseCanvas('{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":10}]}').editable, false);
  assert.equal(parseCanvas('{"nodes":[{"id":"a","type":"text","text":"","x":0,"y":0,"width":1,"height":1,"color":"red"}]}').editable, false);
  assert.equal(parseCanvas('{"nodes":[{"id":"a","type":"file","file":"x.md","subpath":"Heading","x":0,"y":0,"width":1,"height":1}]}').editable, false);
  const twice = '{"id":"a","type":"text","text":"","x":0,"y":0,"width":1,"height":1}';
  assert.deepEqual(parseCanvas(`{"nodes":[${twice},${twice}]}`).issues, [{ kind: "duplicate-id", id: "a" }]);
  const dangling = parseCanvas(`{"nodes":[${twice}],"edges":[{"id":"e","fromNode":"a","toNode":"gone"}]}`);
  assert.equal(dangling.editable, true);
  assert.deepEqual(dangling.issues, [{ kind: "dangling-edge", id: "e" }]);
  const pruned = removeItems(dangling.canvas, ["a"]);
  assert.deepEqual(pruned.edges, [], "deleting a card removes edges drawn to it");
  assert.deepEqual(removeItems(dangling.canvas, [], []), dangling.canvas);
  assert.equal(parseCanvas("").editable, true);
  for (const bad of ["[]", "nope", '{"nodes":{}}', '{"edges":"x"}']) assert.throws(() => parseCanvas(bad), { code: "CANVAS_INVALID" });
});

test("groups take their members along and sit below them", async () => {
  const { canvas } = parseCanvas(await fixture("mixed.canvas"));
  assert.deepEqual(groupMembers(canvas, "g-anatomy"), ["t-roots", "f-section", "t-plain"]);
  const moved = moveNodes(canvas, ["g-anatomy"], 40, -20);
  const node = id => moved.nodes.find(item => item.id === id);
  assert.equal(moveNodes(canvas, ["g-anatomy"], 0, 0), canvas, "a move that goes nowhere is no undo step");
  assert.deepEqual([node("g-anatomy").x, node("t-roots").x, node("f-block").x], [0, 40, 360]);
  const { canvas: grouped, group } = groupNodes(canvas, ["l-ref", "f-missing"], { id: "g-new", label: "Elsewhere" });
  const order = grouped.nodes.map(item => item.id);
  assert.ok(order.indexOf("g-new") < order.indexOf("f-missing") && order.indexOf("g-new") < order.indexOf("l-ref"));
  assert.deepEqual(groupMembers(grouped, group.id).sort(), ["f-missing", "l-ref"]);
  assert.deepEqual(bringToFront(grouped, ["t-roots"]).nodes.at(-1).id, "t-roots");
});

test("connections validate endpoints and refuse duplicates; one undo entry per gesture", async () => {
  const { canvas } = parseCanvas(await fixture("sample.canvas"));
  const [a, b] = [canvas.nodes[1].id, canvas.nodes[3].id];
  const linked = addEdge(canvas, { id: "edge-new", fromNode: a, toNode: b, toEnd: "arrow" });
  assert.equal(addEdge(linked, { id: "edge-again", fromNode: a, toNode: b, toEnd: "arrow" }), linked);
  assert.throws(() => addEdge(canvas, { id: "x", fromNode: a, toNode: "missing" }));
  assert.throws(() => addEdge(canvas, { id: "x", fromNode: a, toNode: a }));
  assert.throws(() => addNode(canvas, { id: a, type: "text", text: "", x: 0, y: 0, width: 10, height: 10 }));
  let history = canvasHistory(canvas);
  history = commitCanvas(history, linked);
  history = commitCanvas(history, moveNodes(history.canvas, [a], snapToGrid(33), 0));
  assert.equal(history.past.length, 2);
  history = undoCanvas(history);
  assert.equal(history.canvas, linked);
  history = undoCanvas(history);
  assert.equal(history.canvas, canvas);
  assert.equal(undoCanvas(history), history);
  history = redoCanvas(history);
  assert.equal(history.canvas, linked);
  assert.throws(() => updateNode(canvas, a, { file: 7 }));
  assert.equal(updateNode(canvas, canvas.nodes[3].id, { text: "Changed" }).nodes[3].text, "Changed");
});

test("file subpaths find nested headings and blocks outside fenced code", () => {
  const note = "# Plexus\n\n## Blocks\n\n```md\n## Interscalene\nfake\n```\n\n### Interscalene\n\nC5-C6 roots.\n\n### Axillary\n\nTerminal nerves.\n\n## Cords\n\nLateral, posterior and medial. ^cords\n";
  assert.equal(canvasSubpath(note, "#Blocks#Interscalene"), "### Interscalene\n\nC5-C6 roots.");
  assert.equal(canvasSubpath(note, "#blocks"), "## Blocks\n\n```md\n## Interscalene\nfake\n```\n\n### Interscalene\n\nC5-C6 roots.\n\n### Axillary\n\nTerminal nerves.");
  assert.equal(canvasSubpath(note, "#^cords"), "Lateral, posterior and medial.");
  assert.equal(canvasSubpath(note, "#Gone"), null);
  assert.equal(canvasSubpath(note, "#^no such"), null);
  assert.equal(canvasSubpath(note), note);
});
