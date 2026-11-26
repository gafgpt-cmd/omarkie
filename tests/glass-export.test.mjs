import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
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

// A bundle is a folder from somewhere else: its manifest may point outside the vault.
test("bundle import refuses a note path outside the vault", async () => {
  const target = await vault();
  const bundle = path.join(target.root, "bundle");
  await mkdir(path.join(bundle, ".omarkie", "glass"), { recursive: true });
  await writeFile(path.join(bundle, "escape.md"), "# escaped\n");
  await writeFile(path.join(bundle, "omarkie-bundle.json"), JSON.stringify({ version: 1, note: "../escape.md", title: "escape" }));
  await assert.rejects(importGlassBundle({ root: target.folder, bundle }), /outside this vault/);
  assert.equal(await readFile(path.join(target.root, "escape.md"), "utf8").catch(() => null), null, "nothing was written above the vault");
  const store = path.join(target.root, "store-bundle");
  await mkdir(store, { recursive: true });
  await writeFile(path.join(store, "notes.md"), "# store\n");
  await writeFile(path.join(store, "omarkie-bundle.json"), JSON.stringify({ version: 1, note: ".omarkie/notes.md", title: "notes" }));
  await assert.rejects(importGlassBundle({ root: target.folder, bundle: store }), /points at the glass store/);
});

test("page pictures never follow a symlink out of the vault or the bundle", async () => {
  const outside = await mkdtemp(path.join(tmpdir(), "omarkie-export-secret-"));
  scratch.push(outside);
  await writeFile(path.join(outside, "secret.png"), png);
  const linked = "# Map\n\n![page](linked/secret.png)\n\nContour lines close together.\n";
  const first = await vault({ "map.md": linked });
  await symlink(outside, path.join(first.folder, "linked"));
  await first.service.request({ action: "add", note: "map.md", magnet: "m-sticky", fields: stickyFields({ id: "m-sticky", text: "Steep", color: "yellow", anchor: anchor("Contour lines close together.", 5), x: 0, y: 0, w: 232, h: 168, folded: false }) });
  const bundle = await exportGlassNote({ root: first.folder, note: "map.md", mode: "bundle", out: path.join(first.root, "Out") });
  assert.equal(await readFile(path.join(bundle.out, "linked", "secret.png")).catch(() => null), null, "an outside file never travels in a bundle");
  const second = await vault();
  const planted = path.join(second.root, "planted");
  await mkdir(planted, { recursive: true });
  await writeFile(path.join(planted, "notes.md"), "![page](pics/secret.png)\n");
  await symlink(outside, path.join(planted, "pics"));
  await writeFile(path.join(planted, "omarkie-bundle.json"), JSON.stringify({ version: 1, note: "notes.md", title: "notes" }));
  await importGlassBundle({ root: second.folder, bundle: planted });
  assert.equal(await readFile(path.join(second.folder, "pics", "secret.png")).catch(() => null), null, "a bundle link never copies an outside file into the vault");
});

// The export dialog can land on the note itself; a flattened page must never replace it.
test("an export never overwrites the note it copies or the glass store", async () => {
  const first = await vault();
  await first.service.request({ action: "add", note: "map.md", magnet: "m-sticky", fields: stickyFields({ id: "m-sticky", text: "Steep = close contours", color: "yellow", anchor: anchor("Contour lines close together mean a steep slope.", 3), x: 0, y: 0, w: 232, h: 168, folded: false }) });
  const note = path.join(first.folder, "map.md");
  await assert.rejects(exportGlassNote({ root: first.folder, note: "map.md", mode: "flat", out: note }), /never overwrites the note/);
  assert.equal(await readFile(note, "utf8"), text, "the note still has its own text");
  await assert.rejects(exportGlassNote({ root: first.folder, note: "map.md", mode: "flat", out: path.join(first.folder, ".omarkie", "map.md") }), /inside the glass store/);
});

// The page and the glass share one footnote namespace in a flattened export.
test("flat export keeps the note's own footnotes apart from the glass footnotes", () => {
  const withFootnote = "# Map\n\nContour lines close together.[^1]\n\n[^1]: the note's own footnote\n";
  const flat = buildMarkdownExport({ noteName: "map.md", noteText: withFootnote, magnets, mode: "flat" }).markdown;
  assert.equal((flat.match(/^\[\^1\]:/gm) ?? []).length, 1, "only the note defines [^1]");
  assert.match(flat, /^\[\^2\]: explains$/m, "the arrow label starts after the note's label");
  const bare = buildMarkdownExport({ noteName: "map.md", noteText: text, magnets, mode: "flat" }).markdown;
  assert.match(bare, /^\[\^1\]: explains$/m, "no note footnotes keeps numbering simple");
});

// A cheatsheet selection must not name the magnets the reader left out.
test("cheatsheet leaves out arrows that touch an excluded magnet", () => {
  const sheet = buildMarkdownExport({ noteName: "map.md", noteText: text, magnets, mode: "cheatsheet", order: ["m-sticky"] }).markdown;
  assert.match(sheet, /^## 1\. Steep = close contours/m);
  assert.doesNotMatch(sheet, /Saddle|explains/, "excluded labels never leak into the sheet");
  assert.doesNotMatch(sheet, /^## Connections$/m);
});

// EF is also the first byte of U+FF00-U+FFFF characters, not just the BOM.
test("a note that starts with a three-byte EF character keeps it", async () => {
  const fullwidth = "（注）Map\n\nContour lines close together.\n";
  const first = await vault({ "map.md": fullwidth });
  await first.service.request({ action: "add", note: "map.md", magnet: "m-sticky", fields: stickyFields({ id: "m-sticky", text: "Steep", color: "yellow", anchor: anchor("Contour lines close together.", 3), x: 0, y: 0, w: 232, h: 168, folded: false }) });
  const flat = await exportGlassNote({ root: first.folder, note: "map.md", mode: "flat", out: path.join(first.root, "out", "map.md") });
  assert.ok((await readFile(flat.out, "utf8")).startsWith("（注）Map"), "the first character survives");
});

async function outsideVault() {
  const root = await mkdtemp(path.join(tmpdir(), "omarkie-export-outside-"));
  scratch.push(root);
  const folder = path.join(root, "vault"), data = path.join(root, "app-data"), vaultId = "outside123456";
  await mkdir(path.join(folder, ".obsidian"), { recursive: true });
  await mkdir(path.join(folder, ".omarkie"), { recursive: true });
  await writeFile(path.join(folder, ".omarkie", "settings.json"), JSON.stringify({ version: 1, vaultId, mode: "outside" }));
  await writeFile(path.join(folder, "map.md"), text);
  await mkdir(path.join(data, "glass-vaults", vaultId), { recursive: true });
  await writeFile(path.join(data, "glass-vaults", vaultId, "settings.json"), JSON.stringify({ version: 1, vaultId, mode: "outside" }));
  const service = await new GlassService({ root: folder, appData: data, device: "outside-device" }).open();
  return { root, folder, data, service };
}

test("export and import follow a glass store that lives in app data", async () => {
  const first = await vault();
  await first.service.request({ action: "add", note: "map.md", magnet: "m-sticky", fields: stickyFields({ id: "m-sticky", text: "Steep = close contours", color: "yellow", anchor: anchor("Contour lines close together mean a steep slope.", 3), x: 0, y: 0, w: 232, h: 168, folded: false }) });
  const bundle = await exportGlassNote({ root: first.folder, note: "map.md", mode: "bundle", out: path.join(first.root, "Out") });
  const outside = await outsideVault();
  const imported = await importGlassBundle({ root: outside.folder, bundle: bundle.out, appData: outside.data });
  assert.equal(await readFile(path.join(outside.folder, ".omarkie", "glass", imported.journal), "utf8").catch(() => null), null, "nothing written inside the vault");
  const reopened = await new GlassService({ root: outside.folder, appData: outside.data, device: "outside-read" }).open();
  const listed = await reopened.request({ action: "list", note: "map.md" });
  assert.deepEqual(listed.magnets.map(magnet => magnet.id), ["m-sticky"], "the imported marks are visible in the outside store");
  // A read-only vault has no settings.json at all: only the app registry remembers the store.
  await rm(path.join(outside.folder, ".omarkie", "settings.json"));
  const flat = await exportGlassNote({ root: outside.folder, note: "map.md", mode: "flat", appData: outside.data, out: path.join(outside.root, "out", "map.md") });
  assert.match(await readFile(flat.out, "utf8"), /Steep = close contours/, "the registry still finds the store");
});

// Two people annotate the same note; the import must not strand either journal.
test("bundle import merges into the note's own journal and keeps undo copies reachable", async () => {
  const source = await vault();
  await source.service.request({ action: "add", note: "map.md", magnet: "m-sticky", fields: stickyFields({ id: "m-sticky", text: "from the sharing side", color: "yellow", anchor: anchor("Contour lines close together mean a steep slope.", 3), x: 0, y: 0, w: 232, h: 168, folded: false }) });
  const bundle = await exportGlassNote({ root: source.folder, note: "map.md", mode: "bundle", out: path.join(source.root, "Out") });
  const bundleGlass = path.join(bundle.out, ".omarkie", "glass");
  const bundleJournal = (await readdir(bundleGlass)).find(name => name.endsWith(".jsonl"));
  const bundleBase = path.basename(bundleJournal, ".jsonl");
  const undo = `assets/${bundleBase}/undo-merge-1.md`;
  await mkdir(path.join(bundle.out, ".omarkie", "assets", bundleBase), { recursive: true });
  await writeFile(path.join(bundle.out, ".omarkie", "assets", bundleBase, "undo-merge-1.md"), "before\n");
  await writeFile(path.join(bundleGlass, bundleJournal), `${await readFile(path.join(bundleGlass, bundleJournal), "utf8")}${JSON.stringify({ op: "merge", mergeId: "merge-1", magnetId: "m-sticky", kind: "rewrite", line: 3, baseHash: "a", afterHash: "b", undo, hlc: "1-0", device: "src" })}\n`);
  const target = await vault();
  await target.service.request({ action: "add", note: "map.md", magnet: "m-local", fields: stickyFields({ id: "m-local", text: "my own mark", color: "rose", anchor: anchor("Contour lines close together mean a steep slope.", 3), x: 0, y: 0, w: 232, h: 168, folded: false }) });
  await importGlassBundle({ root: target.folder, bundle: bundle.out });
  const reopened = await new GlassService({ root: target.folder, appData: target.data, device: "fresh" }).open();
  const listed = await reopened.request({ action: "list", note: "map.md" });
  assert.deepEqual(listed.magnets.map(magnet => magnet.id).sort(), ["m-local", "m-sticky"], "both people's marks survive");
  const journals = await readdir(path.join(target.folder, ".omarkie", "glass"));
  assert.equal(journals.length, 1, "one journal now holds the note");
  const targetBase = path.basename(journals[0], ".jsonl");
  const merge = (await readFile(path.join(target.folder, ".omarkie", "glass", journals[0]), "utf8"))
    .split("\n").filter(Boolean).map(line => JSON.parse(line)).find(record => record.op === "merge");
  assert.equal(merge.undo, `assets/${targetBase}/undo-merge-1.md`, "the undo copy moved with the journal");
  assert.ok(await readFile(path.join(target.folder, ".omarkie", merge.undo), "utf8").catch(() => null), "the undo copy is readable");
});

// Both vaults can hold a "dot.png" that is not the same picture.
test("bundle import renames a colliding picture instead of overwriting it", async () => {
  const other = Buffer.concat([png, Buffer.from([0x42])]);
  const source = await vault();
  await source.service.request({ action: "add", note: "map.md", magnet: "m-photo", fields: { anchor: anchor("A saddle is a low point between two summits.", 5), w: 260 }, image: { base64: png.toString("base64"), name: "dot.png", displayBase64: png.toString("base64") } });
  const bundle = await exportGlassNote({ root: source.folder, note: "map.md", mode: "bundle", out: path.join(source.root, "Out") });
  const target = await vault();
  await target.service.request({ action: "add", note: "map.md", magnet: "m-local-photo", fields: { anchor: anchor("A saddle is a low point between two summits.", 5), w: 260 }, image: { base64: other.toString("base64"), name: "dot.png", displayBase64: other.toString("base64") } });
  await importGlassBundle({ root: target.folder, bundle: bundle.out });
  const reopened = await new GlassService({ root: target.folder, appData: target.data, device: "fresh" }).open();
  const imported = await reopened.request({ action: "asset", note: "map.md", magnet: "m-photo", which: "original" });
  const local = await reopened.request({ action: "asset", note: "map.md", magnet: "m-local-photo", which: "original" });
  assert.equal(imported.base64, png.toString("base64"), "the shared picture arrives intact");
  assert.equal(local.base64, other.toString("base64"), "the vault's own picture is untouched");
});

// The bundle copies the note's page pictures; the import must put them back, but never over a local file.
test("bundle import restores page pictures and leaves a local one alone", async () => {
  const withImage = "# Map\n\n![page](img/page.png)\n\nContour lines close together.\n";
  const first = await vault({ "map.md": withImage });
  await mkdir(path.join(first.folder, "img"), { recursive: true });
  await writeFile(path.join(first.folder, "img", "page.png"), png);
  await first.service.request({ action: "add", note: "map.md", magnet: "m-sticky", fields: stickyFields({ id: "m-sticky", text: "Steep", color: "yellow", anchor: anchor("Contour lines close together.", 5), x: 0, y: 0, w: 232, h: 168, folded: false }) });
  const bundle = await exportGlassNote({ root: first.folder, note: "map.md", mode: "bundle", out: path.join(first.root, "Out") });
  const second = await vault({ "map.md": withImage });
  await importGlassBundle({ root: second.folder, bundle: bundle.out });
  assert.deepEqual(await readFile(path.join(second.folder, "img", "page.png")), png, "the page picture arrives with the note");
  const local = Buffer.concat([png, Buffer.from([1])]);
  await writeFile(path.join(second.folder, "img", "page.png"), local);
  await importGlassBundle({ root: second.folder, bundle: bundle.out });
  assert.deepEqual(await readFile(path.join(second.folder, "img", "page.png")), local, "the vault's own picture is not replaced");
});

test("two magnets on one paragraph keep their reading order in a flat export", () => {
  const shared = anchor("Contour lines close together mean a steep slope.", 3);
  const two = [
    { id: "m-first", fields: { kind: "sticky", text: "first mark", anchor: shared } },
    { id: "m-second", fields: { kind: "sticky", text: "second mark", anchor: shared } },
  ];
  const flat = buildMarkdownExport({ noteName: "map.md", noteText: text, magnets: two, mode: "flat" }).markdown;
  assert.ok(flat.indexOf("first mark") < flat.indexOf("second mark"), "reading order survives a shared anchor");
  assert.ok(flat.indexOf("second mark") < flat.indexOf("A saddle"), "both blocks stay above the next paragraph");
});

// Renaming a note keeps its journal title; an import must write the file the app already reads.
test("bundle import follows the journal of a renamed note", async () => {
  const source = await vault({ "atlas.md": text });
  await source.service.request({ action: "add", note: "atlas.md", magnet: "m-shared", fields: stickyFields({ id: "m-shared", text: "shared mark", color: "yellow", anchor: anchor("Contour lines close together mean a steep slope.", 3), x: 0, y: 0, w: 232, h: 168, folded: false }) });
  const bundle = await exportGlassNote({ root: source.folder, note: "atlas.md", mode: "bundle", out: path.join(source.root, "Out") });
  const target = await vault({ "map.md": text });
  await target.service.request({ action: "add", note: "map.md", magnet: "m-local", fields: stickyFields({ id: "m-local", text: "local mark", color: "rose", anchor: anchor("Contour lines close together mean a steep slope.", 3), x: 0, y: 0, w: 232, h: 168, folded: false }) });
  await rename(path.join(target.folder, "map.md"), path.join(target.folder, "atlas.md"));
  await target.service.recordMove(target.service.notesByPath.get("map.md"), "atlas.md", { title: "atlas" });
  await importGlassBundle({ root: target.folder, bundle: bundle.out, appData: target.data });
  assert.equal((await readdir(path.join(target.folder, ".omarkie", "glass"))).length, 1, "the renamed note keeps one journal");
  const reopened = await new GlassService({ root: target.folder, appData: target.data, device: "fresh" }).open();
  const listed = await reopened.request({ action: "list", note: "atlas.md" });
  assert.deepEqual(listed.magnets.map(magnet => magnet.id).sort(), ["m-local", "m-shared"], "both marks are readable");
});
