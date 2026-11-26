import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { GlassService } from "../electron/glass-service.mjs";
import { cutoutFieldValues, cutoutDefaults, extraPageFieldValues, regionOf, lassoOf } from "../shared/glass-clips.mjs";

const scratch = [];
after(async () => { for (const root of scratch) await rm(root, { recursive: true, force: true }); });
const anchor = (text = "A saddle is a low point between two summits.", line = 5) => ({ landmarks: [{ kind: "block", block: text, headings: ["Map"], line }] });
const source = (patch = {}) => ({ element: "paragraph-2", line: 5, path: "map.md", kind: "paragraph", ...patch });

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "omarkie-glass-clips-"));
  scratch.push(root);
  const folder = path.join(root, "vault"), data = path.join(root, "app-data");
  await mkdir(folder, { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(path.join(folder, "map.md"), "# Map\n\nContour lines close together mean a steep slope.\n\nA saddle is a low point between two summits.\n");
  const service = await new GlassService({ root: folder, appData: data, device: "test-device" }).open();
  return { folder, data, service };
}

async function markdownChecksums(folder) {
  const sums = new Map();
  for (const name of await readdir(folder)) {
    if (!name.endsWith(".md")) continue;
    sums.set(name, createHash("sha256").update(await readFile(path.join(folder, name))).digest("hex"));
  }
  return sums;
}

test("a clip stores its mini-page, folds through the journal, and saves exactly one new note", async () => {
  const { folder, data, service } = await vault();
  try {
    const added = await service.request({ action: "add", note: "map.md", magnet: "m-clip", fields: { kind: "clip", anchor: anchor(),
      text: "# Doses\n\nStart low.", x: 20, y: 12, w: 348, h: 284, folded: false, notePath: null, savedAt: "" } });
    assert.equal(added.magnet.fields.kind, "clip");
    assert.equal(added.magnet.fields.text, "# Doses\n\nStart low.");
    assert.equal(added.magnet.fields.folded, false);
    await service.request({ action: "set", note: "map.md", magnet: "m-clip", fields: { folded: true, strokes: [{ color: "#cf3b32", size: 5, points: [[10, 10], [40, 50]] }] } });
    const before = await markdownChecksums(folder);
    const saved = await service.request({ action: "clip-save", note: "map.md", magnet: "m-clip" });
    assert.equal(saved.created, true);
    assert.equal(saved.path, "Doses.md");
    const afterSave = await markdownChecksums(folder);
    const addedNames = [...afterSave.keys()].filter(name => !before.has(name));
    assert.deepEqual(addedNames, ["Doses.md"], "only the new note appears; the vault is otherwise byte-identical");
    for (const [name, hash] of before) assert.equal(afterSave.get(name), hash, `${name} is unchanged`);
    const again = await service.request({ action: "clip-save", note: "map.md", magnet: "m-clip" });
    assert.equal(again.created, false);
    assert.equal(again.path, "Doses.md");
    assert.deepEqual([...await markdownChecksums(folder)].filter(([name]) => name === "Doses.md").length, 1);
    await service.request({ action: "delete", note: "map.md", magnet: "m-clip" });
    assert.equal(await readFile(path.join(folder, "Doses.md"), "utf8"), "# Doses\n\nStart low.\n", "deleting the clip keeps the saved page");
    const reopened = await new GlassService({ root: folder, appData: data, device: "test-device" }).open();
    try {
      const listed = await reopened.request({ action: "list", note: "map.md" });
      assert.equal(listed.magnets.find(item => item.id === "m-clip"), undefined, "the clip is a tombstone after delete");
    } finally { await reopened.close(); }
  } finally { await service.close().catch(() => {}); }
});

test("a cutout stores a fractional crop, keeps image sources lossless, and refuses a tiny region", async () => {
  const { service } = await vault();
  try {
    const region = regionOf({ x: 100, y: 200, width: 400, height: 200 }, { x: 140, y: 220, width: 100, height: 50 });
    assert.deepEqual(region, { x: 10, y: 10, w: 25, h: 25 });
    const image = await service.request({ action: "add", note: "map.md", magnet: "m-crop", fields: { kind: "cutout", name: "Slope", anchor: anchor(),
      source: source(), sourceKind: "image", region, lasso: null, aspect: 2, w: 280, h: 140, x: 10, y: 10, locked: false } });
    assert.equal(image.magnet.fields.sourceKind, "image");
    assert.equal(image.magnet.fields.asset, undefined, "an image crop points at its source; no pixels are copied");
    assert.deepEqual(image.magnet.fields.region, region);
    const lasso = lassoOf([[140, 220], [240, 220], [240, 270], [140, 270]], { x: 100, y: 200, width: 400, height: 200 });
    assert.deepEqual(lasso, [[10, 10], [35, 10], [35, 35], [10, 35]]);
    assert.throws(() => cutoutFieldValues({ kind: "cutout", anchor: anchor(), source: source(),
      sourceKind: "region", region, aspect: 2, w: 280, h: 140 }, false), /needs its picture/);
    assert.throws(() => cutoutFieldValues({ kind: "cutout", anchor: anchor(), source: source(),
      sourceKind: "image", region: { x: 0, y: 0, w: 0, h: 100 }, aspect: 2 }, false), /region/);
    assert.equal(cutoutDefaults.minCropPx, 10);
  } finally { await service.close().catch(() => {}); }
});

test("an extra page keeps its paper and ink between paragraphs", async () => {
  const { folder, data, service } = await vault();
  try {
    const page = { kind: "extra-page", anchor: anchor(), paper: "grid", title: "Doses", text: "", x: -40, y: 30, w: 420, h: 340,
      strokes: [{ color: "#2f9fb5", size: 4, points: [[1, 2], [30, 40]] }] };
    const added = await service.request({ action: "add", note: "map.md", magnet: "m-page", fields: page });
    assert.equal(added.magnet.fields.paper, "grid");
    assert.throws(() => extraPageFieldValues({ ...page, paper: "marble" }, false), /paper/);
    await service.close();
    const reopened = await new GlassService({ root: folder, appData: data, device: "test-device" }).open();
    try {
      const listed = await reopened.request({ action: "list", note: "map.md" });
      const stored = listed.magnets.find(item => item.id === "m-page");
      assert.equal(stored.fields.paper, "grid");
      assert.deepEqual(stored.fields.strokes, page.strokes);
    } finally { await reopened.close(); }
  } finally { await service.close().catch(() => {}); }
});
