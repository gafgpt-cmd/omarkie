import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { GlassService } from "../electron/glass-service.mjs";
import { assetFile, displayFile, displayNeeded, displaySize, imageFields, imageTypeOf,
  orientationSize, scrapImageMagnet } from "../shared/glass-images.mjs";

const scratch = [];
after(async () => { for (const root of scratch) await rm(root, { recursive: true, force: true }); });

// One transparent pixel; enough to prove storage without shipping a photo.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function vault(files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "omarkie-images-"));
  scratch.push(root);
  const data = path.join(root, "app-data"), folder = path.join(root, "vault");
  await mkdir(path.join(folder, ".obsidian"), { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(path.join(folder, ".obsidian", "app.json"), '{"attachmentFolderPath":"assets"}\n');
  for (const [name, content] of Object.entries({ "notes/Photo note.md": "# Photo\n\nOne paragraph under the picture.\n", ...files })) {
    const file = path.join(folder, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return { root, data, folder };
}

test("asset names stay human and never collide", () => {
  assert.equal(assetFile("Sunset at Barceloneta.HEIC", "heic"), "Sunset at Barceloneta.heic");
  const weird = assetFile("../../etc/passwd.png", "png");
  assert.ok(weird.endsWith(".png") && !/[/\\]/.test(weird) && Buffer.byteLength(weird) <= 96, weird);
  assert.equal(assetFile("", "jpg"), "image.jpg");
  const taken = new Set(["photo.png", "photo-2.png"]);
  assert.equal(assetFile("photo.png", "png", taken), "photo-3.png");
  assert.throws(() => assetFile("x", "pn/g"), /Unknown image type/);
  const long = assetFile(`${"a".repeat(400)}.png`, "png");
  assert.ok(Buffer.byteLength(long) <= 96, long);
  assert.equal(displayFile("Sunset at Barceloneta.heic"), "Sunset at Barceloneta ~display.webp");
});

test("sniffed types cover what phones and browsers hand over", () => {
  assert.equal(imageTypeOf(png), "png");
  assert.equal(imageTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(imageTypeOf(Buffer.from("RIFF0000WEBPVP8 ", "ascii")), "webp");
  assert.equal(imageTypeOf(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])), "heic");
  assert.equal(imageTypeOf(Buffer.from("not an image at all", "ascii")), null);
});

test("EXIF rotation changes the aspect, not the picture", () => {
  assert.deepEqual(orientationSize({ width: 400, height: 300, orientation: 1 }), { width: 400, height: 300 });
  assert.deepEqual(orientationSize({ width: 400, height: 300, orientation: 6 }), { width: 300, height: 400 });
  assert.deepEqual(orientationSize({ width: 400, height: 300, orientation: 8 }), { width: 300, height: 400 });
  assert.equal(orientationSize({ width: 0, height: 300 }), null);
  assert.equal(orientationSize(), null);
});

test("a light copy is planned only when the original would hurt", () => {
  assert.equal(displayNeeded({ width: 800, height: 600, bytes: 200_000, type: "jpeg" }), false);
  assert.equal(displayNeeded({ width: 800, height: 600, bytes: 40 * 1024 * 1024, type: "jpeg" }), true);
  assert.equal(displayNeeded({ width: 6000, height: 4000, bytes: 900_000, type: "jpeg" }), true);
  assert.equal(displayNeeded({ width: 800, height: 600, bytes: 900_000, type: "heic" }), true);
  assert.deepEqual(displaySize({ width: 6000, height: 4000 }), { width: 1600, height: 1067 });
  assert.deepEqual(displaySize({ width: 800, height: 600 }), { width: 800, height: 600 });
});

test("image fields round-trip through one validator", () => {
  const values = imageFields({ name: "Cell", asset: "cell.png", wrap: "right", rot: 12.34, w: 240 });
  assert.deepEqual({ ...values, anchor: undefined }, { kind: "image", name: "Cell", asset: "cell.png", wrap: "right",
    rot: 12.3, w: 240, h: 240, tape: false, locked: false, x: 0, y: 0, bytes: 0, anchor: undefined });
  assert.throws(() => imageFields({ wrap: "sideways" }), /wrap must be one of/);
  assert.throws(() => imageFields({ asset: "../secret.png" }), /plain file name/);
  assert.throws(() => imageFields({ rot: 720 }), /rotation/);
  assert.throws(() => imageFields({ anchor: { landmarks: [] } }), /needs an anchor/);
  assert.deepEqual(imageFields({ w: 200 }, { partial: true }), { w: 200 });
});

test("a legacy image scrap becomes the same glass image twice", () => {
  const scrap = { id: "s1/2", body: "Cell membrane", image: { width: 900, height: 600, side: "right" },
    anchor: { block: "One paragraph under the picture.", line: 2 } };
  const first = scrapImageMagnet({ scrap, asset: "cell.png", width: 900, height: 600, blockText: scrap.anchor.block });
  const second = scrapImageMagnet({ scrap, asset: "cell.png", width: 600, height: 900, blockText: scrap.anchor.block });
  assert.equal(first.id, "m-scrap-s1-2");
  assert.equal(first.id, second.id);
  assert.equal(first.fields.name, "Cell membrane");
  assert.equal(first.fields.wrap, "right");
  assert.equal(first.fields.anchor.landmarks[0].block, scrap.anchor.block);
  assert.throws(() => scrapImageMagnet({ scrap, asset: "../x.png" }), /needs an id and an asset/);
});

test("the service stores the original, the light copy, and survives a restart", async () => {
  const environment = await vault();
  const options = { root: environment.folder, appData: environment.data, device: "test-device" };
  const service = await new GlassService(options).open();
  const added = await service.request({ action: "add", note: "notes/Photo note.md", magnet: "m-photo",
    fields: { anchor: { landmarks: [{ kind: "block", block: "One paragraph under the picture.", headings: [] }] }, w: 260 },
    image: { base64: png.toString("base64"), name: "Harbour at dusk.png", displayBase64: png.toString("base64"), wrap: "left" } });
  const fields = added.magnet.fields;
  assert.equal(fields.kind, "image");
  assert.equal(fields.name, "Harbour at dusk.png");
  assert.equal(fields.asset, "Harbour at dusk.png");
  assert.equal(fields.display, "Harbour at dusk ~display.webp");
  assert.equal(fields.aspect, 1);
  assert.equal(fields.wrap, "left");
  const directory = path.join(environment.folder, ".omarkie", "assets");
  const [folder] = await readdir(directory);
  assert.deepEqual((await readdir(path.join(directory, folder))).sort(), ["Harbour at dusk ~display.webp", "Harbour at dusk.png"]);

  const original = await service.request({ action: "asset", note: "notes/Photo note.md", magnet: "m-photo", which: "original" });
  assert.equal(original.mime, "image/png");
  assert.deepEqual(Buffer.from(original.base64, "base64"), png);
  const display = await service.request({ action: "asset", note: "notes/Photo note.md", magnet: "m-photo" });
  assert.equal(display.name, "Harbour at dusk ~display.webp");

  // Rotation and washi tape persist in the note's own journal only.
  await service.request({ action: "set", note: "notes/Photo note.md", magnet: "m-photo", fields: { rot: -12, tape: true, wrap: "behind" } });
  await assert.rejects(service.request({ action: "set", note: "notes/Photo note.md", magnet: "m-photo", fields: { wrap: "inside" } }), /wrap must be one of/);

  const reopened = await new GlassService(options).open();
  const listed = await reopened.request({ action: "list", note: "notes/Photo note.md" });
  const image = listed.magnets.find(magnet => magnet.id === "m-photo");
  assert.equal(image.fields.rot, -12);
  assert.equal(image.fields.tape, true);
  assert.equal(image.fields.wrap, "behind");
  assert.equal(await readFile(path.join(environment.folder, "notes/Photo note.md"), "utf8"), "# Photo\n\nOne paragraph under the picture.\n");
});

test("concurrent readers see a complete legacy image in a scraps-only vault", async () => {
  const hash = "c".repeat(64);
  const store = { v: 1, entry: { id: "legacy-only", type: "scrap", document: "notes/Photo note.md", deleted: false, body: "Cell membrane",
    image: { hash, width: 200, height: 100, side: "left" },
    anchor: { block: "One paragraph under the picture.", line: 2, headings: ["Photo"] } } };
  const environment = await vault({ ".omarkie/store.jsonl": `${JSON.stringify(store)}\n`, [`.omarkie/scraps/${hash}`]: png });
  await mkdir(path.join(environment.folder, "notes"), { recursive: true });
  await writeFile(path.join(environment.folder, "notes/Photo note.md"), "# Photo\n\nOne paragraph under the picture.\n");
  await mkdir(path.join(environment.folder, ".omarkie", "scraps"), { recursive: true });
  await writeFile(path.join(environment.folder, ".omarkie", "scraps", hash), png);
  const service = await new GlassService({ root: environment.folder, appData: environment.data, device: "test-device" }).open();
  const request = { action: "list", note: "notes/Photo note.md" };
  const results = await Promise.all(Array.from({ length: 4 }, () => service.request(request)));
  for (const result of results) {
    const images = result.magnets.filter(magnet => magnet.id === "m-scrap-legacy-only");
    assert.equal(images.length, 1);
    assert.equal(images[0].fields.anchor.landmarks[0].block, "One paragraph under the picture.");
  }
  const later = await service.request(request);
  assert.equal(later.imported, 0);
  assert.equal(later.magnets.length, 1);
  await service.close();
});

test("learning mode scraps migrate once and keep their blob", async () => {
  const hash = "a".repeat(64);
  const store = { v: 1, entry: { id: "legacy-1", type: "scrap", document: "notes/Photo note.md", deleted: false, body: "Cell membrane",
    image: { hash, width: 200, height: 100, name: "cell.png", side: "left" },
    anchor: { block: "One paragraph under the picture.", line: 2, headings: ["Photo"] } } };
  const environment = await vault({ ".omarkie/store.jsonl": `${JSON.stringify(store)}\n`, [`.omarkie/scraps/${hash}`]: png });
  await mkdir(path.join(environment.folder, "notes"), { recursive: true });
  await writeFile(path.join(environment.folder, "notes/Photo note.md"), "# Photo\n\nOne paragraph under the picture.\n");
  await mkdir(path.join(environment.folder, ".omarkie", "scraps"), { recursive: true });
  await writeFile(path.join(environment.folder, ".omarkie", "scraps", hash), png);
  const options = { root: environment.folder, appData: environment.data, device: "test-device" };
  const result = await new GlassService(options).open();
  await result.request({ action: "add", note: "notes/Photo note.md", text: "first glass magnet", x: 4, y: 4 });

  const first = await result.request({ action: "list", note: "notes/Photo note.md" });
  assert.equal(first.imported, 1);
  const migrated = first.magnets.find(magnet => magnet.id === "m-scrap-legacy-1");
  assert.ok(migrated, "scrap became a glass image");
  assert.equal(migrated.fields.name, "Cell membrane");
  assert.equal(migrated.fields.asset, "Cell membrane.png");
  assert.equal(migrated.fields.wrap, "left");
  assert.equal(migrated.fields.aspect, 1);
  assert.equal(migrated.fields.h, migrated.fields.w);

  const again = await new GlassService(options).open();
  const second = await again.request({ action: "list", note: "notes/Photo note.md" });
  assert.equal(second.imported, 0);
  assert.equal(second.magnets.filter(magnet => magnet.id === "m-scrap-legacy-1").length, 1);
  assert.ok((await stat(path.join(environment.folder, ".omarkie", "scraps", hash))).size > 0, "scrap blob untouched");
});
