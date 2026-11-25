import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { GlassService } from "../electron/glass-service.mjs";
import { buildMarkdownExport } from "../shared/glass-export.mjs";
import { exportGlassNote, importGlassBundle } from "../electron/glass-export.mjs";
import { stickyFields } from "../src/glass/glass-model.ts";
import { cardFields } from "../shared/glass-cards.mjs";

const scratch = [];
after(async () => { for (const root of scratch) await rm(root, { recursive: true, force: true }); });

const text = "# Map\n\nContour lines close together mean a steep slope.\n\nA saddle is a low point between two summits.\n";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const anchor = (block, line) => ({ landmarks: [{ kind: "block", block, headings: ["Map"], line }] });

async function vault(files = { "map.md": text }) {
  const root = await mkdtemp(path.join(tmpdir(), "omarkie-export-"));
  scratch.push(root);
  const folder = path.join(root, "vault"), data = path.join(root, "app-data");
  await mkdir(path.join(folder, ".obsidian"), { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(path.join(folder, ".obsidian", "app.json"), '{"attachmentFolderPath":"assets"}\n');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await writeFile(path.join(folder, name), content);
  }
  const service = await new GlassService({ root: folder, appData: data, device: "test-device" }).open();
  return { root, folder, data, service };
}

async function checksums(root) {
  const result = new Map();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.name === ".omarkie") continue;
      if (entry.isDirectory()) await walk(file);
      else result.set(path.relative(root, file), createHash("sha256").update(await readFile(file)).digest("hex"));
    }
  }
  await walk(root);
  return result;
}

const magnets = [
  { id: "m-sticky", fields: { kind: "sticky", text: "Steep = close contours", color: "yellow", x: 0, y: 0, anchor: anchor("Contour lines close together mean a steep slope.", 3) } },
  { id: "m-bubble", fields: { kind: "comment", anchor: anchor("A saddle is a low point between two summits.", 5), thread: [{ role: "user", text: "Why a low point?" }, { role: "agent", text: "It sits between two peaks." }] } },
  { id: "m-card", fields: { kind: "card", card: "ai", title: "Saddle", question: "What is a saddle?", answer: "Low point between two summits.", anchor: anchor("A saddle is a low point between two summits.", 5) } },
  { id: "m-ink", fields: { kind: "ink", color: "#24292f", size: 4, parts: [{ points: [[0.1, 0.1, 0.5], [0.2, 0.15, 0.5]] }], anchor: anchor("Contour lines close together mean a steep slope.", 3) } },
  { id: "m-star", fields: { kind: "sticker", sticker: "star", anchor: anchor("Contour lines close together mean a steep slope.", 3) } },
  { id: "m-arrow", fields: { kind: "arrow", from: { kind: "magnet", magnet: "m-sticky" }, to: { kind: "magnet", magnet: "m-card" }, style: "straight", color: "red", head: "solid", label: "explains" } },
];

test("every flatten mapping stays Markdown-native", () => {
  const flat = buildMarkdownExport({ noteName: "map.md", noteText: text, magnets, mode: "flat" }).markdown;
  assert.match(flat, /^> \[!NOTE\]$/m, "sticky becomes a GitHub alert");
  assert.match(flat, /> Steep = close contours/, "sticky text survives");
  assert.match(flat, /^> \[!TIP\]$/m, "comment becomes its own alert");
  assert.match(flat, /^> \*\*A:\*\* It sits between two peaks\.$/m);
  assert.match(flat, /^> \[!IMPORTANT\] \*\*Saddle\*\*$/m, "card title rides the alert");
  assert.match(flat, /!\[Ink\]\(<assets\/ink-ink\.svg>\)/, "ink is a relative SVG");
  assert.match(flat, /!\[Star sticker\]\(<assets\/sticker-star\.svg>\)/, "sticker is a relative SVG");
  assert.match(flat, /^## Connections$/m);
  assert.match(flat, /- \*\*Steep = close contours\*\* → \*\*Saddle\*\*: explains\[\^1\]/);
  assert.match(flat, /^\[\^1\]: explains$/m, "arrow label is a footnote");
  assert.doesNotMatch(flat, /<\/?(?:div|span|section|figure|aside|table|details|summary|img|p|br)\b/i, "no HTML layout");
  assert.doesNotMatch(flat, /\[\[/, "no wikilinks in portable bundles");
  assert.ok(flat.indexOf("Steep = close contours") < flat.indexOf("Saddle"), "reading order follows anchors");
});

test("image width is Obsidian-only because GitHub Markdown has none", () => {
  const withImage = [...magnets, { id: "m-photo", fields: { kind: "image", name: "dot.png", w: 260, anchor: anchor("A saddle is a low point between two summits.", 5) } }];
  const assets = { folder: "assets", images: id => id === "m-photo" ? { name: "dot.png" } : null };
  const github = buildMarkdownExport({ noteName: "map.md", noteText: text, magnets: withImage, mode: "flat", assets }).markdown;
  const obsidian = buildMarkdownExport({ noteName: "map.md", noteText: text, magnets: withImage, mode: "flat", target: "obsidian", assets }).markdown;
  assert.match(github, /!\[dot\.png\]\(<assets\/dot\.png>\)/);
  assert.match(obsidian, /!\[dot\.png\|260\]\(<assets\/dot\.png>\)/);
});

test("handout and cheatsheet keep source quotes, order and no page text", () => {
  const handout = buildMarkdownExport({ noteName: "map.md", noteText: text, magnets, mode: "handout" }).markdown;
  assert.match(handout, /^# map — Glass handout$/m);
  assert.doesNotMatch(handout, /Contour lines close together mean a steep slope\.$/m);
  assert.match(handout, /^\[\^1\]: map\.md:3 — "Contour lines close together mean a steep slope\."$/m);
  const ordered = buildMarkdownExport({ noteName: "map.md", noteText: text, magnets, mode: "cheatsheet", order: ["m-card", "m-sticky"] }).markdown;
  assert.match(ordered, /^## 1\. Saddle/m, "user order wins");
  assert.match(ordered, /^## 2\. Steep = close contours/m);
  assert.match(ordered, /^\[\^1\]: map\.md:5/m);
});

test("page scope copies the note and bundle round-trips the glass", async () => {
  const first = await vault();
  await first.service.request({ action: "add", note: "map.md", magnet: "m-sticky", fields: stickyFields({ id: "m-sticky", text: "Steep = close contours", color: "yellow", anchor: anchor("Contour lines close together mean a steep slope.", 3), x: 0, y: 0, w: 232, h: 168, folded: false }) });
  await first.service.request({ action: "add", note: "map.md", magnet: "m-card", fields: { ...cardFields({ kind: "card", card: "ai", title: "Saddle", question: "What is a saddle?", answer: "Low point.", folded: false }), anchor: anchor("A saddle is a low point between two summits.", 5) } });
  await first.service.request({ action: "add", note: "map.md", magnet: "m-photo", fields: { anchor: anchor("A saddle is a low point between two summits.", 5), w: 260 }, image: { base64: png.toString("base64"), name: "dot.png", displayBase64: png.toString("base64"), wrap: "left" } });
  const before = await checksums(first.folder);
  const out = path.join(first.root, "out");
  const page = await exportGlassNote({ root: first.folder, note: "map.md", mode: "page", out: path.join(out, "copy.md") });
  assert.equal(await readFile(page.out, "utf8"), text);
  assert.deepEqual(await checksums(first.folder), before, "page export leaves the vault untouched");
  const bundle = await exportGlassNote({ root: first.folder, note: "map.md", mode: "bundle", out: path.join(out, "Map") });
  const second = await vault();
  await importGlassBundle({ root: second.folder, bundle: bundle.out });
  const listed = await second.service.request({ action: "list", note: "map.md" });
  assert.equal(listed.magnets.length, 3);
  assert.equal(listed.magnets.find(magnet => magnet.id === "m-sticky").fields.text, "Steep = close contours");
  const importedImage = await second.service.request({ action: "asset", note: "map.md", magnet: "m-photo", which: "display" });
  assert.equal(importedImage.base64, png.toString("base64"), "bundle keeps image bytes");
  assert.equal(await readFile(path.join(second.folder, "map.md"), "utf8"), text);
  assert.deepEqual(await checksums(first.folder), before, "bundle export leaves the vault untouched");
});
