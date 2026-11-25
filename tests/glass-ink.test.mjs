import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { GlassService } from "../electron/glass-service.mjs";
import {
  biteRuns, boxHit, chiselOutline, drawsPointer, fromBoxPoints, inkColors, inkPath, inkWidths,
  splitRuns, toBoxPoints, validInkParts, validInkPoint, validInkPoints,
} from "../shared/ink-core.mjs";
import { replayJournalText } from "../shared/glass-core.mjs";

const scratch = [];
after(async () => { for (const root of scratch) await rm(root, { recursive: true, force: true }); });

const at = (x, y, pressure = 0.5) => [x, y, pressure];

test("a stroke is split per element box and each part follows its own box", () => {
  const boxes = [
    { key: "p1:block", left: 100, top: 100, width: 300, height: 40 },
    { key: "p2:cell:0:1", left: 420, top: 100, width: 120, height: 40 },
    { key: "p3:item:0", left: 100, top: 160, width: 300, height: 30 },
  ];
  const stroke = [at(120, 120), at(260, 122), at(405, 124), at(460, 125), at(520, 127)];
  const runs = splitRuns(stroke, point => boxHit(boxes, { x: point[0], y: point[1] })?.key ?? "");
  assert.deepEqual(runs.map(run => run.key), ["p1:block", "p2:cell:0:1"]);
  // The crossing sample belongs to both halves, so they still meet on screen.
  assert.deepEqual(runs[0].points.at(-1), runs[1].points[0]);
  assert.ok(runs.every(run => run.points.length >= 2));

  const first = toBoxPoints(runs[0].points, boxes[0]);
  // Points near a box edge may sit just outside it and still belong to that box.
  assert.ok(first.every(([x, y]) => Math.abs(x) <= 1.1 && Math.abs(y) <= 1.1));
  // Same box, moved and wider: the stroke keeps its relative place inside it.
  const moved = { left: 40, top: 400, width: 600, height: 80 };
  const back = fromBoxPoints(first, moved);
  back.forEach((point, index) => {
    assert.ok(Math.abs((point[0] - moved.left) / moved.width - first[index][0]) < 1e-6);
    assert.equal(point[2], first[index][2]);
  });
});

test("over the margins ink anchors to the nearest element, and the smallest containing box wins", () => {
  const boxes = [
    { key: "list:block", left: 0, top: 0, width: 400, height: 120 },
    { key: "list:item:0", left: 10, top: 10, width: 380, height: 30 },
    { key: "list:item:1", left: 10, top: 60, width: 380, height: 30 },
  ];
  assert.equal(boxHit(boxes, { x: 200, y: 20 })?.key, "list:item:0");
  assert.equal(boxHit(boxes, { x: 200, y: 80 })?.key, "list:item:1");
  assert.equal(boxHit(boxes, { x: 700, y: 70 })?.key, "list:block", "outside every box the widest element is nearest");
  assert.equal(boxHit(boxes, { x: 200, y: 45 })?.key, "list:block", "inside only the list, the list wins");
  assert.equal(boxHit(boxes.slice(1), { x: 700, y: 70 })?.key, "list:item:1", "a margin doodle still picks the nearest item");
  assert.equal(boxHit(boxes.slice(1), { x: -40, y: 5 })?.key, "list:item:0");
  assert.equal(boxHit([], { x: 0, y: 0 }), undefined);
});

test("pen path follows pressure and the highlighter is a chisel", () => {
  const line = [at(0, 0, 0.2), at(20, 4, 0.4), at(40, 8, 0.8), at(60, 12, 1)];
  const pen = inkPath(line, { tool: "pen", size: 6 });
  const highlighter = inkPath(line, { tool: "highlighter", size: 20 });
  for (const path of [pen, highlighter]) {
    assert.match(path, /^M [-\d.]+ [-\d.]+/);
    assert.match(path, /Z$/);
  }
  assert.notEqual(pen, highlighter);
  const light = inkPath(line.map(([x, y]) => at(x, y, 0.15)), { tool: "pen", size: 6 });
  assert.notEqual(light, pen, "pressure changes the pen outline");

  // Chisel: a broad diagonal, a thin stroke along the nib, and pressure widens it.
  const broad = chiselOutline([at(0, 0), at(60, 60)], 20);
  const thin = chiselOutline([at(0, 0), at(60, -24)], 20);
  const height = outline => Math.max(...outline.map(point => point[1])) - Math.min(...outline.map(point => point[1]));
  assert.ok(height(broad) > height(thin));
  const soft = chiselOutline([at(0, 0, 0.1), at(60, 60, 0.1)], 20);
  const hard = chiselOutline([at(0, 0, 1), at(60, 60, 1)], 20);
  assert.ok(height(hard) > height(soft));
});

test("pen-only drawing once a stylus is present, and a second contact is a palm", () => {
  assert.equal(drawsPointer("pen", { penSeen: false }), true);
  assert.equal(drawsPointer("mouse", { penSeen: true }), true);
  assert.equal(drawsPointer("touch", { penSeen: false }), true, "a finger draws before any pen");
  assert.equal(drawsPointer("touch", { penSeen: true }), false, "palm rejection after a stylus");
  assert.equal(drawsPointer("touch", { penSeen: false, drawing: true }), false, "a second contact mid-stroke");
  assert.equal(drawsPointer("unknown", {}), false);
});

test("eraser bites a stroke into runs and keeps only drawable remnants", () => {
  const points = Array.from({ length: 12 }, (_, index) => at(index * 10, 0));
  const bitten = biteRuns(points, { x: 55, y: 0 }, 14);
  assert.equal(bitten.length, 2);
  assert.ok(bitten[0].at(-1)[0] < 55 && bitten[1][0][0] > 55);
  assert.equal(biteRuns(points, { x: -10, y: 0 }, 14).length, 1);
  assert.equal(biteRuns(points, { x: 55, y: 0 }, 400).length, 0);
});

test("ink payload validation bounds boxes, points, and sizes", () => {
  const anchor = { version: 2, landmarks: [{ kind: "block", block: "A paragraph.", headings: ["Map"] }] };
  const part = { box: { kind: "cell", row: 0, col: 2, text: "42" }, anchor, points: [at(0.1, 0.2), at(0.3, 0.4)] };
  assert.equal(validInkParts([part]), true);
  assert.equal(validInkParts([{ ...part, box: { kind: "cell", row: -1, col: 0 } }]), false);
  assert.equal(validInkParts([{ ...part, box: { kind: "page" } }]), false);
  assert.equal(validInkParts([{ ...part, points: [[0.1, 0.2]] }]), false, "a point needs its pressure");
  assert.equal(validInkParts([{ ...part, points: [at(9, 0)] }]), false, "way outside the box");
  assert.equal(validInkPoints([at(0, 0, 1.4)]), false);
  assert.equal(validInkPoint(at(0.5, 0.5, 0.3)), true);
  assert.deepEqual(inkWidths.pen, [2, 4, 8]);
  assert.equal(inkColors.highlighter.length, 3);
});

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "omarkie-ink-"));
  scratch.push(root);
  const folder = path.join(root, "vault"), data = path.join(root, "app-data");
  await mkdir(folder, { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(path.join(folder, "ink.md"), "# Ink\n\nA paragraph with a table below.\n");
  return { folder, data };
}

test("the journal stores ink, rejects bad palettes, and keeps a deleted stroke restorable", async () => {
  const environment = await vault();
  const service = await new GlassService({ root: environment.folder, appData: environment.data, device: "test-device" }).open();
  const anchor = { version: 2, landmarks: [{ kind: "block", block: "A paragraph with a table below.", headings: ["Ink"] }] };
  const fields = {
    kind: "ink", layer: "ink", tool: "pen", color: "#24292f", size: 4,
    parts: [{ box: { kind: "block" }, anchor, points: [at(0.1, 0.1, 0.4), at(0.2, 0.15, 0.8)] }],
  };
  try {
    const added = await service.request({ action: "add", note: "ink.md", magnet: "m-ink", fields });
    assert.equal(added.magnet.fields.kind, "ink");
    assert.equal(added.magnet.fields.layer, "ink");
    assert.equal(added.magnet.fields.parts.length, 1);
    const listed = await service.request({ action: "list", note: "ink.md" });
    assert.deepEqual(listed.magnets.map(magnet => magnet.id), ["m-ink"]);

    await assert.rejects(service.request({ action: "add", note: "ink.md", fields: { ...fields, color: "#00ff00" } }), /colour/i);
    await assert.rejects(service.request({ action: "add", note: "ink.md", fields: { ...fields, size: 9 } }), /width/i);
    await assert.rejects(service.request({ action: "add", note: "ink.md", fields: { ...fields, parts: [{ ...fields.parts[0], anchor: { landmarks: [] } }] } }), /anchor/i);
    await assert.rejects(service.request({ action: "add", note: "ink.md", fields: { ...fields, parts: [{ ...fields.parts[0], points: [[0.1, 0.1, "soft"]] }] } }), /parts/i);
    await assert.rejects(service.request({ action: "add", note: "ink.md", fields: { ...fields, tool: "pen", color: "#f5d547" } }), /belong/i);

    const shifted = [{ box: { kind: "block" }, anchor, points: [at(0.3, 0.3), at(0.4, 0.35)] }];
    const changed = await service.request({ action: "set", note: "ink.md", magnet: "m-ink", fields: { parts: shifted } });
    assert.equal(changed.magnet.fields.parts[0].points[0][0], 0.3);
    assert.equal(changed.magnet.fields.tool, "pen");

    const removed = await service.request({ action: "delete", note: "ink.md", magnet: "m-ink" });
    assert.equal(removed.changed, true);
    assert.deepEqual((await service.request({ action: "list", note: "ink.md" })).magnets, []);
    const trash = await service.request({ action: "list", note: "ink.md" });
    assert.equal(trash.trash[0].fields.kind, "ink");
    await service.request({ action: "restore", note: "ink.md", magnet: "m-ink" });
    assert.equal((await service.request({ action: "list", note: "ink.md" })).magnets.length, 1);

    const journal = await service.readJournal(service.journalFor(service.notesByPath.get("ink.md")));
    const replayed = replayJournalText(journal.lines.join("\n"));
    assert.equal(replayed.invalid, 0);
    assert.equal(replayed.magnets.get("m-ink").fields.get("parts").value.length, 1);
  } finally { await service.close(); }
});
