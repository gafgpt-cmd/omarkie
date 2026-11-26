import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { GlassService } from "../electron/glass-service.mjs";
import { replayJournalText, stickyColors, visibleMagnets } from "../shared/glass-core.mjs";
import { indexBlocks, matchBlock, matchIndexed } from "../src/glass/anchor-map.ts";
import { anchorOf, nearestBlock, newStickyId, offsetIn, snapped, stickyDefaults, stickyFields, stickyFromMagnet } from "../src/glass/glass-model.ts";

const scratch = [];
after(async () => { for (const root of scratch) await rm(root, { recursive: true, force: true }); });

const anchor = (text, headings = ["Memory"], line = 3) => ({ landmarks: [{ kind: "block", block: text, headings, line }] });
const blocks = [
  { block: "Retrieval practice beats rereading.", headings: ["Memory"], line: 3 },
  { block: "Space the reviews over days.", headings: ["Memory"], line: 5 },
  { block: "Interleave related topics.", headings: ["Memory", "Planning"], line: 9 },
  { block: "Unrelated closing remark.", headings: ["Afterword"], line: 13 },
];

function box(left, top, width, height) {
  return { getBoundingClientRect: () => ({ left, top, right: left + width, bottom: top + height, width, height }) };
}

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "omarkie-glass-sticky-"));
  scratch.push(root);
  const data = path.join(root, "app-data"), folder = path.join(root, "vault");
  await mkdir(folder, { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(path.join(folder, "map.md"), "# Map\n\nContour lines close together mean a steep slope.\n\nA saddle is a low point between two summits.\n");
  const service = await new GlassService({ root: folder, appData: data, device: "test-device" }).open();
  return { root, folder, service };
}

test("a sticky note round-trips through the journal with every field the model writes", async () => {
  const { service } = await vault();
  try {
    const note = { id: "m-sticky", text: "Steep = close contours", color: "rose", anchor: anchor("Contour lines close together mean a steep slope."),
      x: -16, y: 24, w: 248, h: 176, folded: false };
    const added = await service.request({ action: "add", note: "map.md", magnet: note.id, fields: stickyFields(note) });
    assert.equal(added.magnet.kind, "sticky");
    assert.equal(added.magnet.fields.anchor.landmarks[0].block, "Contour lines close together mean a steep slope.");

    const listed = await service.request({ action: "list", note: "map.md" });
    assert.deepEqual(listed.magnets.map(item => stickyFromMagnet(item)), [note]);
    assert.deepEqual(listed.trash, []);

    const moved = await service.request({ action: "set", note: "map.md", magnet: note.id, fields: { x: 32, y: -8, w: 264, h: 152 } });
    assert.equal(moved.magnet.fields.x, 32);
    assert.equal(moved.magnet.fields.w, 264);
    assert.equal((await service.request({ action: "show", note: "map.md", magnet: note.id })).magnet.fields.h, 152);

    const folded = await service.request({ action: "set", note: "map.md", magnet: note.id, fields: { folded: true } });
    assert.equal(folded.magnet.fields.folded, true);
  } finally { await service.close(); }
});

test("sticky notes are validated field by field and keep their kind", async () => {
  const { service } = await vault();
  try {
    const fields = { kind: "sticky", text: "x", anchor: anchor("A saddle is a low point between two summits.") };
    await assert.rejects(service.request({ action: "add", note: "map.md", fields: { kind: "sticky", text: "x" } }), /anchor/);
    await assert.rejects(service.request({ action: "add", note: "map.md", fields: { ...fields, anchor: { landmarks: [] } } }), /anchor/);
    await assert.rejects(service.request({ action: "add", note: "map.md", fields: { ...fields, color: "purple" } }), /colour/);
    await assert.rejects(service.request({ action: "add", note: "map.md", fields: { ...fields, x: 1e9 } }), /x must be a number/);
    await assert.rejects(service.request({ action: "add", note: "map.md", fields: { ...fields, z: 3 } }), /Unknown sticky note field/);
    const added = await service.request({ action: "add", note: "map.md", magnet: "m-check", fields });
    assert.equal(added.magnet.fields.color, stickyColors[0]);
    assert.equal(added.magnet.fields.w, stickyDefaults.w);
    await assert.rejects(service.request({ action: "set", note: "map.md", magnet: "m-check", fields: { kind: "note" } }), /keeps its kind/);
    await assert.rejects(service.request({ action: "set", note: "map.md", magnet: "m-missing", fields: { text: "x" } }), /not found/);
    await assert.rejects(service.request({ action: "set", note: "map.md", magnet: "m-check", fields: {} }), /Nothing to change/);
  } finally { await service.close(); }
});

test("delete moves a note to the trash and restore brings it back, newest first", async () => {
  const { service } = await vault();
  try {
    for (const [id, text] of [["m-one", "first"], ["m-two", "second"]])
      await service.request({ action: "add", note: "map.md", magnet: id, fields: { kind: "sticky", text, anchor: anchor(`paragraph ${text}`) } });
    await service.request({ action: "delete", note: "map.md", magnet: "m-one" });
    const deleted = await service.request({ action: "delete", note: "map.md", magnet: "m-two" });
    assert.equal(deleted.changed, true);
    assert.deepEqual(deleted.trash.map(item => item.id), ["m-two", "m-one"]);
    assert.deepEqual((await service.request({ action: "list", note: "map.md" })).magnets, []);
    assert.equal((await service.request({ action: "delete", note: "map.md", magnet: "m-two" })).changed, false);
    await assert.rejects(service.request({ action: "set", note: "map.md", magnet: "m-one", fields: { text: "x" } }), /trash/);

    const restored = await service.request({ action: "restore", note: "map.md", magnet: "m-one" });
    assert.equal(restored.magnet.fields.text, "first");
    assert.deepEqual(restored.trash.map(item => item.id), ["m-two"]);
    assert.deepEqual((await service.request({ action: "list", note: "map.md" })).magnets.map(item => item.id), ["m-one"]);
    assert.equal((await service.request({ action: "restore", note: "map.md", magnet: "m-one" })).changed, false);
  } finally { await service.close(); }
});

test("merge order cannot resurrect a delete that an undo superseded", () => {
  const line = record => JSON.stringify(record);
  const set = line({ op: "set", magnetId: "m", field: "text", value: "kept", hlc: "10-0", device: "a" });
  const removed = line({ op: "delete", magnetId: "m", hlc: "11-0", device: "a" });
  const undone = line({ op: "restore", magnetId: "m", hlc: "12-0", device: "a" });
  const staleDelete = line({ op: "delete", magnetId: "m", hlc: "11-5", device: "b" });
  const kept = replayJournalText(`${[set, removed, undone, staleDelete].join("\n")}\n`);
  assert.equal(kept.invalid, 0);
  assert.deepEqual(visibleMagnets(kept.magnets).map(item => item.fields.text), ["kept"]);
  const later = replayJournalText(`${[set, removed, undone, line({ op: "delete", magnetId: "m", hlc: "13-0", device: "b" })].join("\n")}\n`);
  assert.deepEqual(visibleMagnets(later.magnets), []);
  assert.equal(later.magnets.get("m").deleted.active, true);
});

test("the indexed resolver answers exactly like the reference matcher", () => {
  const index = indexBlocks(blocks);
  const anchors = [
    anchor("Retrieval practice beats rereading."),
    anchor("Retrieval practice beats rereading", ["Afterword"]),
    anchor("Interleave related topics.", ["Memory"]),
    anchor("Retrieval practice beats rereading."),
    anchor("Space the reviews over dayz."),
    anchor("Nothing like this line exists anywhere."),
    { landmarks: [] },
  ];
  for (const candidate of anchors) assert.equal(matchIndexed(index, candidate), matchBlock(candidate, blocks));
  assert.equal(matchIndexed(index, anchors[0]), 3);
  assert.equal(matchIndexed(index, anchor("Retrieval practice beats rereading.", ["Afterword"])), 3, "the only copy still resolves from another section");
  assert.equal(matchIndexed(index, anchors[2]), 9);
  assert.equal(matchIndexed(index, anchors[4]), 5, "one changed character stays on the same paragraph");
  assert.equal(matchIndexed(index, anchors[5]), null);
  assert.equal(matchIndexed(index, anchors[6]), null);
  assert.equal(matchIndexed(index, anchors[1]), null, "a changed sentence in another section has no anchor");
  const ambiguous = indexBlocks([...blocks, { block: "Retrieval practice beats rereading.", headings: ["Memory"], line: 21 }]);
  assert.equal(matchIndexed(ambiguous, anchors[0]), null, "two identical paragraphs in one section are never guessed");
});

test("creation lands on the paragraph under the pointer, else the nearest one", () => {
  const live = [
    { block: "First", headings: [], line: 1, element: box(100, 100, 600, 40) },
    { block: "Second", headings: [], line: 3, element: box(100, 200, 600, 40) },
    { block: "Third", headings: [], line: 5, element: box(100, 400, 600, 40) },
  ];
  assert.equal(nearestBlock(live, { x: 300, y: 220 }).line, 3, "inside a paragraph");
  assert.equal(nearestBlock(live, { x: 300, y: 310 }).line, 3, "between paragraphs, closer to the one above");
  assert.equal(nearestBlock(live, { x: 300, y: 360 }).line, 5, "closer to the one below");
  assert.equal(nearestBlock(live, { x: 900, y: 150 }).line, 1, "outside the text column still pins to the nearest one");
  assert.equal(nearestBlock([], { x: 0, y: 0 }), undefined);
});

test("offsets are content-relative and snap to the 8px grid", () => {
  const block = { block: "First", headings: [], line: 1, element: box(120, 260, 600, 40) };
  assert.deepEqual(offsetIn(block, { x: 300, y: 280 }), { x: 184, y: 24 });
  assert.deepEqual(offsetIn(block, { x: 123, y: 262 }), { x: 0, y: 0 });
  assert.deepEqual(offsetIn({ block: "Loose", headings: [], line: 9 }, { x: 300, y: 280 }), { x: 0, y: 0 });
  assert.equal(snapped(233.7), 232);
  assert.equal(snapped(-17), -16);
  assert.equal(snapped(3), 0);
  const note = { id: "m", text: "", color: stickyColors[0], anchor: anchorOf(block), x: -24, y: 16, w: 232, h: 168, folded: false };
  assert.deepEqual(stickyFields(note).anchor, anchor("First", [], 1));
  assert.match(newStickyId(), /^m-[a-z0-9]+-[a-z0-9]{6}$/);
});

test("a magnet read back from another device keeps its sticky identity", () => {
  const magnet = { id: "m-foreign", kind: "sticky", fields: {
    kind: "sticky", text: "from an agent", color: "violet", anchor: anchor("Interleave related topics."),
    x: 8.4, y: -3.6, w: 40, h: 9000, folded: "yes",
  } };
  assert.deepEqual(stickyFromMagnet(magnet), {
    id: "m-foreign", text: "from an agent", color: "violet", anchor: anchor("Interleave related topics."),
    x: 8, y: -4, w: stickyDefaults.minW, h: 4000, folded: false,
  });
  assert.equal(stickyFromMagnet({ id: "m-ink", fields: { kind: "ink" } }), undefined);
  assert.equal(stickyFromMagnet({ id: "m-bare", fields: {} }), undefined, "a magnet with no kind is not a sticky note");
});
