import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { GlassService } from "../electron/glass-service.mjs";
import { lockDirectory, unlockDirectory } from "./readonly-dir.mjs";
import { imageLink, inkSvg, mergeDiff, mergeKindLabel, mergeLines, noteMergeSettings } from "../shared/glass-merge.mjs";
import { markdownElements } from "../shared/element-model.mjs";

const scratch = [];
after(async () => { for (const root of scratch) await rm(root, { recursive: true, force: true }); });

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

async function vault({ appJson = { attachmentFolderPath: "assets" } } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "omarkie-merge-"));
  scratch.push(root);
  const folder = path.join(root, "vault"), data = path.join(root, "app-data");
  await mkdir(path.join(folder, ".obsidian"), { recursive: true });
  await mkdir(path.join(folder, "notes"), { recursive: true });
  await mkdir(data, { recursive: true });
  if (appJson) await writeFile(path.join(folder, ".obsidian", "app.json"), JSON.stringify(appJson));
  const text = "# Title\r\n\r\nFirst paragraph.\r\n\r\nLast paragraph.\r\n";
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  await writeFile(path.join(folder, "notes", "Note.md"), bytes);
  await chmod(path.join(folder, "notes", "Note.md"), 0o640);
  const service = await new GlassService({ root: folder, appData: data, device: "test-device" }).open();
  return { root, folder, data, service, bytes, text };
}

async function sticky(service, id = "m-sticky", text = "Remember this.") {
  return service.request({ action: "add", note: "notes/Note.md", magnet: id, fields: {
    kind: "sticky", text, color: "yellow", w: 232, h: 168, folded: false, x: 0, y: 0,
    anchor: { version: 2, landmarks: [{ kind: "block", block: "First paragraph.", headings: ["Title"] }] },
  } });
}

test("each mapping and the vault's own link style", () => {
  const obsidian = noteMergeSettings({ appJson: { attachmentFolderPath: "assets" }, notePath: "notes/Note.md" });
  assert.deepEqual(obsidian, { attachmentFolder: "assets", noteDir: "notes", linkStyle: "wikilink" });
  const markdown = noteMergeSettings({ appJson: { attachmentFolderPath: "./pics", useMarkdownLinks: true }, notePath: "notes/Note.md" });
  assert.deepEqual(markdown, { attachmentFolder: "notes/pics", noteDir: "notes", linkStyle: "markdown" });
  assert.deepEqual(noteMergeSettings({ appJson: { attachmentFolderPath: "." }, notePath: "notes/Note.md" }),
    { attachmentFolder: "notes", noteDir: "notes", linkStyle: "wikilink" });
  // Not an Obsidian vault: the picture goes beside the note, because a bare Markdown link resolves there.
  assert.deepEqual(noteMergeSettings({ appJson: null, notePath: "notes/Note.md" }), { attachmentFolder: "notes", noteDir: "notes", linkStyle: "markdown" });

  assert.deepEqual(mergeLines("sticky", { text: "One\n\nTwo" }).lines, ["> [!note]", "> One", ">", "> Two"]);
  assert.throws(() => mergeLines("sticky", { text: "  " }), /Write something/);
  assert.equal(mergeLines("image", { name: "Harbour at dusk.png", w: 260 }, { settings: obsidian, assetPath: "assets/Harbour at dusk.png" }).lines[0],
    "![[assets/Harbour at dusk.png|260]]");
  assert.equal(imageLink({ path: "assets/a b.png", name: "a b.png", width: 320, linkStyle: "markdown" }), "![a b.png](<assets/a b.png>){width=320}");
  assert.match(mergeLines("ink", { parts: [{ points: [[0.1, 0.1, 0.5], [0.2, 0.2, 0.5]] }] }, { settings: obsidian, assetPath: "assets/ink-1.svg" }).lines[0],
    /^!\[\[assets\/ink-1\.svg\|640\]\]$/);
  assert.match(inkSvg({ parts: [{ points: [[0.1, 0.1, 0.5], [0.2, 0.2, 0.5]] }], tool: "pen", color: "#24292f", size: 4 }), /^<svg[^>]+viewBox=/);
  assert.throws(() => inkSvg({ parts: [] }), /no points/);
  assert.deepEqual(mergeLines("card", { mode: "embed", section: "Other note#Heading" }).lines, ["![[Other note#Heading]]"]);
  assert.deepEqual(mergeLines("card", { mode: "plain", title: "Summary", body: "One\nTwo" }).lines, ["## Summary", "", "One", "Two"]);
  assert.deepEqual(mergeLines("card", { card: "static", link: "Other note#Heading" }).lines, ["![[Other note#Heading]]"]);
  assert.deepEqual(mergeLines("card", { card: "static", link: "#Heading" }).lines, ["![[#Heading]]"]);
  assert.equal(mergeKindLabel("card", { card: "static", link: "#Heading" }), "Card → section embed");
  assert.deepEqual(mergeLines("card", { card: "ai", title: "Why?", question: "Why kerma?", answer: "Energy per mass." }).lines,
    ["## Why?", "", "**Why kerma?**", "", "Energy per mass."]);
  assert.deepEqual(mergeLines("card", { card: "menu", title: "Dose quiz", choices: [{ label: "Unit?", body: "J/kg" }] }).lines,
    ["## Dose quiz", "", "- Unit? — J/kg"]);
  assert.throws(() => mergeLines("card", { card: "static", title: "Empty" }), /needs its Markdown body/);
});

test("diff touches only the lines around the anchor", () => {
  const text = "# Title\r\n\r\nFirst paragraph.\r\n\r\nLast paragraph.\r\n";
  const diff = mergeDiff(text, text.indexOf("\r\n\r\nLast"), ["> [!note]", "> Body"], "\r\n");
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.added, ["> [!note]", "> Body", ""]);
  assert.ok(diff.next.includes("First paragraph.\r\n\r\n> [!note]\r\n> Body\r\n\r\nLast paragraph.\r\n"));
  assert.ok(!diff.next.replace(/\r\n/g, "").includes("\n"), "CRLF stays CRLF");
});

test("sticky merge: preview, accept, byte-exact undo, magnet leaves the glass", async () => {
  const environment = await vault();
  const { service } = environment;
  await sticky(service);
  const preview = await service.request({ action: "merge-preview", note: "notes/Note.md", magnet: "m-sticky" });
  assert.equal(preview.merge.eol, "CRLF");
  assert.equal(preview.merge.bom, true);
  assert.equal(preview.merge.kind, "sticky");
  assert.deepEqual(preview.merge.added, ["> [!note]", "> Remember this."]);
  assert.equal(sha(await readFile(path.join(environment.folder, "notes", "Note.md"))), sha(environment.bytes));
  assert.equal((await service.request({ action: "list", note: "notes/Note.md" })).magnets.length, 1);

  const accepted = await service.request({ action: "merge-accept", note: "notes/Note.md", magnet: "m-sticky",
    expectedHash: preview.merge.baseHash, approved: true });
  assert.equal(accepted.merged, true);
  if (process.platform !== "win32") assert.equal((await stat(path.join(environment.folder, "notes", "Note.md"))).mode & 0o777, 0o640);
  const bytes = await readFile(path.join(environment.folder, "notes", "Note.md"));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const written = bytes.subarray(3).toString("utf8");
  assert.equal(written, environment.text.replace("First paragraph.\r\n", "First paragraph.\r\n\r\n> [!note]\r\n> Remember this.\r\n"));
  assert.equal(written.replace(/\r\n/g, "").includes("\n"), false, "every line ending is CRLF");
  assert.equal((await service.request({ action: "list", note: "notes/Note.md" })).magnets.length, 0, "the magnet leaves the glass");

  const history = await service.request({ action: "merge-history", note: "notes/Note.md" });
  assert.equal(history.merges.length, 1);
  assert.equal(history.merges[0].id, accepted.merge.id);
  assert.equal(history.merges[0].undone, false);

  await service.close();
  const reopened = await new GlassService({ root: environment.folder, appData: environment.data, device: "test-device" }).open();
  assert.equal((await reopened.request({ action: "merge-history", note: "notes/Note.md" })).merges.length, 1);
  const undone = await reopened.request({ action: "merge-undo", note: "notes/Note.md" });
  assert.equal(undone.undone, true);
  assert.equal(undone.restoredMagnet, true);
  assert.deepEqual(await readFile(path.join(environment.folder, "notes", "Note.md")), environment.bytes, "undo restores the exact prior bytes");
  const restored = await reopened.request({ action: "list", note: "notes/Note.md" });
  assert.equal(restored.magnets.length, 1);
  assert.equal(restored.magnets[0].id, "m-sticky");
  assert.equal((await reopened.request({ action: "merge-history", note: "notes/Note.md" })).merges[0].undone, true);
  assert.equal((await reopened.request({ action: "merge-preview", note: "notes/Note.md", magnet: "m-sticky" })).merge.kind, "sticky");
});

test("an external edit between preview and accept opens the stale path and writes nothing", async () => {
  const environment = await vault();
  const { service } = environment;
  await sticky(service);
  const preview = await service.request({ action: "merge-preview", note: "notes/Note.md", magnet: "m-sticky" });
  const file = path.join(environment.folder, "notes", "Note.md");
  const changed = Buffer.concat([environment.bytes, Buffer.from("Inserted while you looked away.\r\n", "utf8")]);
  await writeFile(file, changed);
  const stale = await service.request({ action: "merge-accept", note: "notes/Note.md", magnet: "m-sticky",
    expectedHash: preview.merge.baseHash, approved: true });
  assert.equal(stale.stale, true);
  assert.equal(stale.preview.magnet, "m-sticky");
  assert.deepEqual(await readFile(file), changed, "nothing written on the stale path");
  assert.equal((await service.request({ action: "list", note: "notes/Note.md" })).magnets.length, 1, "the magnet stays on the glass");

  const retry = await service.request({ action: "merge-accept", note: "notes/Note.md", magnet: "m-sticky",
    expectedHash: stale.preview.baseHash, approved: true });
  assert.equal(retry.merged, true);
  assert.match((await readFile(file, "utf8")), /First paragraph\.\r\n\r\n> \[!note\]\r\n> Remember this\.\r\n\r\nLast paragraph\.\r\nInserted/);
});

test("a picture lands in the vault attachment folder and undo keeps the page exact", async () => {
  const environment = await vault();
  const { service } = environment;
  await service.request({ action: "add", note: "notes/Note.md", magnet: "m-photo", fields: {
    anchor: { version: 2, landmarks: [{ kind: "block", block: "Last paragraph.", headings: ["Title"] }] }, w: 260,
  }, image: { base64: png.toString("base64"), name: "Harbour at dusk.png", displayBase64: png.toString("base64") } });
  const preview = await service.request({ action: "merge-preview", note: "notes/Note.md", magnet: "m-photo" });
  assert.equal(preview.merge.added[0], "![[assets/Harbour at dusk.png|260]]");
  assert.equal(preview.merge.attachment, "assets/Harbour at dusk.png");
  const accepted = await service.request({ action: "merge-accept", note: "notes/Note.md", magnet: "m-photo",
    expectedHash: preview.merge.baseHash, approved: true });
  assert.equal(accepted.merged, true);
  assert.deepEqual(await readFile(path.join(environment.folder, "assets", "Harbour at dusk.png")), png);
  assert.match((await readFile(path.join(environment.folder, "notes", "Note.md"), "utf8")), /!\[\[assets\/Harbour at dusk\.png\|260\]\]/);
  await service.request({ action: "merge-undo", note: "notes/Note.md" });
  assert.deepEqual(await readFile(path.join(environment.folder, "notes", "Note.md")), environment.bytes);
});

test("lift up copies a paragraph or picture with its source and leaves the page byte-identical", async () => {
  const environment = await vault();
  const { service } = environment;
  const before = await readFile(path.join(environment.folder, "notes", "Note.md"));
  const paragraph = markdownElements(environment.text).find(element => element.kind === "paragraph" && element.text === "First paragraph.");
  const lifted = await service.request({ action: "lift-up", note: "notes/Note.md", element: paragraph.id });
  assert.equal(lifted.magnet.fields.kind, "sticky");
  assert.equal(lifted.magnet.fields.text, "First paragraph.");
  assert.equal(lifted.magnet.fields.source.line, 3);
  assert.equal(lifted.magnet.fields.source.path, "notes/Note.md");
  assert.equal(lifted.magnet.fields.source.kind, "paragraph");
  assert.deepEqual(await readFile(path.join(environment.folder, "notes", "Note.md")), before);

  await mkdir(path.join(environment.folder, "assets"), { recursive: true });
  await writeFile(path.join(environment.folder, "assets", "pic.png"), png);
  const picture = "# Picture\n\n![a dot](assets/pic.png)\n";
  await writeFile(path.join(environment.folder, "notes", "Picture.md"), picture);
  const image = markdownElements(picture).find(element => element.kind === "image");
  const pair = await service.request({ action: "lift-up", note: "notes/Picture.md", element: image.id });
  assert.equal(pair.magnet.fields.kind, "image");
  assert.equal(pair.magnet.fields.source.kind, "image");
  assert.equal(pair.magnet.fields.source.path, "notes/Picture.md");
  assert.equal(await readFile(path.join(environment.folder, "notes", "Picture.md"), "utf8"), picture);
});

test("a write that cannot land leaves the old bytes and no partial note", async () => {
  if (process.getuid?.() === 0) return;
  const environment = await vault();
  const { service } = environment;
  await sticky(service);
  const preview = await service.request({ action: "merge-preview", note: "notes/Note.md", magnet: "m-sticky" });
  const directory = path.join(environment.folder, "notes");
  await lockDirectory(directory, 0o500);
  try {
    await assert.rejects(service.request({ action: "merge-accept", note: "notes/Note.md", magnet: "m-sticky",
      expectedHash: preview.merge.baseHash, approved: true }));
    assert.deepEqual(await readFile(path.join(directory, "Note.md")), environment.bytes);
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith(".tmp")), [], "no partial temp file survives");
    assert.equal((await service.request({ action: "list", note: "notes/Note.md" })).magnets.length, 1);
  } finally { await unlockDirectory(directory, 0o700); }
  const accepted = await service.request({ action: "merge-accept", note: "notes/Note.md", magnet: "m-sticky",
    expectedHash: preview.merge.baseHash, approved: true });
  assert.equal(accepted.merged, true);
});
