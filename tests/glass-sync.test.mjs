import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { GlassService } from "../electron/glass-service.mjs";
import { GlassSync } from "../electron/glass-sync.mjs";

const scratch = [];
after(async () => { for (const root of scratch) await rm(root, { recursive: true, force: true }); });

async function fixture(files, shared = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "omarkie-sync-"));
  scratch.push(root);
  const vault = path.join(root, "vault"), data = shared.data ?? path.join(root, "app-data"), cache = shared.cache ?? path.join(root, "cache");
  await mkdir(vault, { recursive: true });
  await mkdir(data, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(vault, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return { root, vault, data, cache };
}

const watcher = async () => ({ close() {} });

async function open(environment) {
  const service = await new GlassService({ root: environment.vault, appData: environment.data, device: "test-device" }).open();
  const sync = new GlassSync({ service, cacheDir: environment.cache, appData: environment.data, watcherFactory: watcher });
  await sync.start();
  await sync.whenIdle();
  return { service, sync };
}

async function notesLines(environment) {
  const text = await readFile(path.join(environment.vault, ".omarkie", "notes.jsonl"), "utf8");
  return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

async function contents(environment) {
  const hashes = [];
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name === ".omarkie") continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) hashes.push(createHash("sha256").update(await readFile(file)).digest("hex"));
    }
  }
  await walk(environment.vault);
  return hashes.sort();
}

function noteFiles(count, folder = "Old") {
  return Object.fromEntries(Array.from({ length: count }, (_, index) =>
    [`${folder}/Unit ${index}.md`, `# Unit ${index}\n\nUnique body ${index}.\n`]));
}

test("indexing and scan leave the vault byte-for-byte identical and add no glass folder", async () => {
  const environment = await fixture({ "notes/map.md": "# Map\n\nContour lines.\n", "assets/photo.png": "png" });
  const before = await contents(environment);
  const { service, sync } = await open(environment);
  try {
    assert.equal((await sync.map()).files, 2);
    assert.equal((await sync.find({ query: "contour" })).count, 1);
    assert.ok(!await readdir(path.join(environment.vault, ".omarkie")).catch(() => null));
  } finally { await sync.close(); await service.close(); }
  assert.deepEqual(await contents(environment), before);
});

test("a 500-note folder rename while open is one line and every magnet follows", async () => {
  const environment = await fixture(noteFiles(500));
  const { service, sync } = await open(environment);
  const baseline = await contents(environment);
  try {
    for (let index = 0; index < 500; index += 1)
      await service.request({ action: "add", note: `Old/Unit ${index}.md`, kind: "note", text: `pin ${index}` });
    await sync.whenIdle();
    await sync.publishNotes();
    await sync.publishMagnets();

    await rename(path.join(environment.vault, "Old"), path.join(environment.vault, "New"));
    const events = [];
    for (let index = 0; index < 500; index += 1)
      events.push({ type: "delete", path: `Old/Unit ${index}.md` }, { type: "create", path: `New/Unit ${index}.md` });
    await sync.handleBatch(events);
    await sync.whenIdle();

    const lines = await notesLines(environment);
    assert.equal(lines.length, 501, "500 note lines plus one folder line");
    assert.equal(lines.filter(line => line.op === "folder").length, 1);
    assert.deepEqual(lines.find(line => line.op === "folder") && { from: lines.find(line => line.op === "folder").from, to: lines.find(line => line.op === "folder").to }, { from: "Old", to: "New" });
    assert.deepEqual(sync.lost, []);
    assert.equal(service.currentNotes().filter(note => note.path.startsWith("New/")).length, 500);
    assert.equal((await service.request({ action: "list", note: "New/Unit 250.md" })).magnets[0].fields.text, "pin 250");
    assert.equal((await sync.map()).magnets, 500);
    assert.equal((await sync.find({ query: "pin 250" })).count, 1);
    assert.deepEqual(await contents(environment), baseline);
  } finally { await sync.close(); await service.close(); }
});

test("a sync-style copy-then-delete folder move waits for quiet and never flickers lost glass", async () => {
  const files = noteFiles(30);
  const environment = await fixture(files);
  const { service, sync } = await open(environment);
  try {
    for (const name of Object.keys(files)) await service.request({ action: "add", note: name, kind: "note", text: `pin ${name}` });
    await sync.whenIdle();

    await mkdir(path.join(environment.vault, "New"));
    for (const name of Object.keys(files)) {
      const base = path.basename(name);
      await writeFile(path.join(environment.vault, "New", base), files[name]);
    }
    await sync.handleBatch(Object.keys(files).map(name => ({ type: "create", path: `New/${path.basename(name)}` })));
    await sync.whenIdle();
    assert.deepEqual(sync.lost, []);
    assert.equal((await notesLines(environment)).filter(line => line.op === "folder").length, 0);
    assert.equal(service.currentNotes().every(note => note.path.startsWith("Old/")), true);

    await rm(path.join(environment.vault, "Old"), { recursive: true });
    await sync.handleBatch(Object.keys(files).map(name => ({ type: "delete", path: name })));
    await sync.whenIdle();
    const lines = await notesLines(environment);
    assert.equal(lines.filter(line => line.op === "folder").length, 1);
    assert.deepEqual(sync.lost, []);
    assert.equal(service.currentNotes().every(note => note.path.startsWith("New/")), true);
    assert.equal((await service.request({ action: "list", note: "New/Unit 7.md" })).magnets.length, 1);
  } finally { await sync.close(); await service.close(); }
});

test("a folder renamed while the app is closed pairs by fingerprint on the next open", async () => {
  const files = noteFiles(20);
  const environment = await fixture(files);
  const first = await open(environment);
  for (const name of Object.keys(files)) await first.service.request({ action: "add", note: name, text: "pin" });
  await first.sync.whenIdle();
  await first.sync.close();
  await first.service.close();

  await rename(path.join(environment.vault, "Old"), path.join(environment.vault, "Moved"));
  const second = await open(environment);
  try {
    const lines = await notesLines(environment);
    assert.equal(lines.filter(line => line.op === "folder").length, 1);
    assert.deepEqual(second.sync.lost, []);
    assert.equal(second.service.currentNotes().every(note => note.path.startsWith("Moved/")), true);
    assert.equal((await second.service.request({ action: "list", note: "Moved/Unit 11.md" })).magnets.length, 1);
  } finally { await second.sync.close(); await second.service.close(); }
});

test("one note moved to another folder keeps its id and its magnets", async () => {
  const environment = await fixture(noteFiles(3));
  const { service, sync } = await open(environment);
  try {
    const added = await service.request({ action: "add", note: "Old/Unit 1.md", text: "pin one" });
    await sync.whenIdle();
    await mkdir(path.join(environment.vault, "Archive"));
    await rename(path.join(environment.vault, "Old/Unit 1.md"), path.join(environment.vault, "Archive/Unit 1.md"));
    await sync.handleBatch([{ type: "delete", path: "Old/Unit 1.md" }, { type: "create", path: "Archive/Unit 1.md" }]);
    await sync.whenIdle();
    const lines = await notesLines(environment);
    const move = lines.find(line => line.op === "move");
    assert.equal(move.id, added.id);
    assert.equal(move.to, "Archive/Unit 1.md");
    assert.equal((await service.request({ action: "list", note: "Archive/Unit 1.md" })).magnets[0].fields.text, "pin one");
    assert.deepEqual(sync.lost, []);
  } finally { await sync.close(); await service.close(); }
});

test("a moved mtime alone is a hint, not a change", async () => {
  const environment = await fixture({ "map.md": "# Map\n\nContour lines.\n" });
  const { service, sync } = await open(environment);
  try {
    await service.request({ action: "add", note: "map.md", text: "pin" });
    await sync.whenIdle();
    const lines = (await notesLines(environment)).length;
    const file = path.join(environment.vault, "map.md");
    const later = new Date(Date.now() + 5_000);
    await utimes(file, later, later);
    await sync.handleBatch([{ type: "update", path: "map.md" }]);
    await sync.whenIdle();
    assert.equal((await notesLines(environment)).length, lines);
  } finally { await sync.close(); await service.close(); }
});

test("glass known from another vault is offered and brought into this one", async () => {
  const source = await fixture({ "notes/Kerma.md": "# Kerma\n\nDose units.\n" });
  const first = await open(source);
  await first.service.request({ action: "add", note: "notes/Kerma.md", kind: "note", text: "old pin" });
  await first.sync.whenIdle();
  await first.sync.close();
  await first.service.close();

  const destination = await fixture({ "copied/Kerma.md": "# Kerma\n\nDose units.\n" }, { data: source.data, cache: source.cache });
  const second = await open(destination);
  try {
    await second.sync.whenIdle();
    assert.equal(second.sync.offer?.count, 1);
    const result = await second.sync.bring({});
    await second.sync.whenIdle();
    assert.equal(result.brought.length, 1);
    assert.equal((await second.service.request({ action: "list", note: "copied/Kerma.md" })).magnets[0].fields.text, "old pin");
    assert.equal((await second.sync.find({ query: "old pin" })).count, 1);
    assert.deepEqual(second.sync.lost, []);
  } finally { await second.sync.close(); await second.service.close(); }
  const untouched = await readFile(path.join(source.vault, ".omarkie", "notes.jsonl"), "utf8");
  assert.match(untouched, /notes\/Kerma\.md/);
});
