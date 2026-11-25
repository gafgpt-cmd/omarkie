import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { GlassService } from "../electron/glass-service.mjs";
import { createClock, glassFileName, replayJournalText, sanitizeTitle } from "../shared/glass-core.mjs";

const scratch = [];
after(async () => { for (const root of scratch) await rm(root, { recursive: true, force: true }); });
async function vault(files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "omarkie-glass-"));
  scratch.push(root);
  const data = path.join(root, "app-data");
  const folder = path.join(root, "vault");
  await mkdir(path.join(folder, ".obsidian"), { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(path.join(folder, ".obsidian", "app.json"), '{"attachmentFolderPath":"assets"}\n');
  const defaults = { "map.md": "# Map\n\nContour lines close together mean a steep slope.\n" };
  for (const [name, content] of Object.entries({ ...defaults, ...files })) {
    const file = path.join(folder, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return { root, data, folder };
}

async function open(environment, options = {}) {
  return new GlassService({ root: environment.folder, appData: environment.data, device: "test-device", ...options }).open();
}

async function checksums(root) {
  const result = new Map();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.name === ".omarkie") continue;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) result.set(path.relative(root, file), createHash("sha256").update(await readFile(file)).digest("hex"));
    }
  }
  await walk(root);
  return result;
}

test("guest layout, magnet round-trip, one journal per note, and a clean vault", async () => {
  const environment = await vault({ "notes/Basic note.md": "# Basic\n\nA paragraph.\n", "assets/photo.png": "png" });
  const before = await checksums(environment.folder);
  const service = await open(environment);
  try {
    const status = await service.request({ action: "status" });
    assert.equal(status.initialized, false);
    assert.equal(status.mode, null);
    await assert.rejects(stat(path.join(environment.folder, ".omarkie")), error => error.code === "ENOENT");

    const added = await service.request({ action: "add", note: "notes/Basic note.md", kind: "note", text: "peek", x: 12, y: 3.5 });
    assert.equal(service.mode, "inside");
    assert.equal(service.readOnly, false);
    assert.ok(await stat(path.join(environment.folder, ".omarkie", "README.md")));
    assert.equal((await readFile(path.join(environment.folder, ".omarkie", ".gitattributes"), "utf8")).trim(), "*.jsonl merge=union");
    const settings = JSON.parse(await readFile(path.join(environment.folder, ".omarkie", "settings.json"), "utf8"));
    assert.equal(settings.vaultId, service.vaultId);
    assert.equal(settings.mode, "inside");
    assert.equal(added.note, "notes/Basic note.md");
    assert.match(added.journal, /^glass\/Basic note ~[a-z0-9]{6}\.jsonl$/);
    assert.equal(added.magnet.fields.text, "peek");
    assert.equal(added.magnet.fields.kind, "note");

    const second = await service.request({ action: "add", note: "notes/Basic note.md", text: "second" });
    assert.equal(second.id, added.id);
    assert.equal((await readdir(path.join(environment.folder, ".omarkie", "glass"))).length, 1);
    assert.ok(await stat(path.join(environment.folder, ".omarkie", "assets", added.journal.split("/").at(-1).replace(/\.jsonl$/, ""))));

    const list = await service.request({ action: "list", note: "notes/Basic note.md" });
    assert.deepEqual(list.magnets.map(item => item.fields.text).sort(), ["peek", "second"]);
    const show = await service.request({ action: "show", note: "notes/Basic note.md", magnet: added.magnet.id });
    assert.equal(show.magnet.fields.y, 3.5);
    assert.equal(show.deleted, false);

    const notes = (await readFile(path.join(environment.folder, ".omarkie", "notes.jsonl"), "utf8")).trim().split("\n");
    assert.equal(notes.length, 1);
    const record = JSON.parse(notes[0]);
    assert.equal(record.id, added.id);
    assert.equal(record.path, "notes/Basic note.md");
    assert.equal(record.fingerprint.shape.headings[0], "Basic");
    assert.equal(record.fingerprint.shape.firstLines[0], "# Basic");
  } finally { await service.close(); }
  assert.deepEqual(await checksums(environment.folder), before);

  const reopened = await open(environment);
  try {
    const list = await reopened.request({ action: "list", note: "notes/Basic note.md" });
    assert.equal(list.magnets.length, 2);
  } finally { await reopened.close(); }

  await rm(path.join(environment.folder, ".omarkie"), { recursive: true, force: true });
  assert.deepEqual(await checksums(environment.folder), before);
});

test("a killed append leaves a half line that the next open ignores and repairs", async () => {
  const environment = await vault();
  const service = await open(environment);
  const added = await service.request({ action: "add", note: "map.md", text: "before crash" });
  const journal = path.join(environment.folder, ".omarkie", added.journal);
  await service.close();

  const script = `
    const fs = require("node:fs");
    fs.appendFileSync(process.argv[1], '{"op":"set","magnetId":"m-crash","field":"text","value":"half","hlc":"ffff-0","device":"crash"}'.slice(0, 40));
    process.kill(process.pid, "SIGKILL");
  `;
  const child = spawn(process.execPath, ["-e", script, journal], { stdio: "ignore" });
  const [, signal] = await once(child, "exit");
  assert.equal(signal, "SIGKILL");
  assert.ok(!(await readFile(journal, "utf8")).endsWith("\n"));

  const reopened = await open(environment);
  try {
    const list = await reopened.request({ action: "list", note: "map.md" });
    assert.deepEqual(list.magnets.map(item => item.fields.text), ["before crash"]);
    assert.equal(list.incompleteTail, 0);
    assert.ok((await readFile(journal, "utf8")).endsWith("\n"));
    const next = await reopened.request({ action: "add", note: "map.md", text: "after crash" });
    assert.ok(next.saved);
    const after = await reopened.request({ action: "list", note: "map.md" });
    assert.deepEqual(after.magnets.map(item => item.fields.text).sort(), ["after crash", "before crash"]);
  } finally { await reopened.close(); }
});

test("ENOSPC keeps ops in memory, reports status, and saves after space returns", async () => {
  const environment = await vault();
  const service = await open(environment);
  const full = async (handle, line) => {
    await handle.writeFile(line.slice(0, 12));
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  };
  service.faults.write = full;
  try {
    const added = await service.request({ action: "add", note: "map.md", text: "unsaved" });
    assert.equal(added.saved, false);
    assert.equal(service.status().error.code, "ENOSPC");
    assert.ok(service.status().pending >= 1);
    assert.deepEqual((await service.request({ action: "list", note: "map.md" })).magnets.map(item => item.fields.text), ["unsaved"]);
    const journal = path.join(environment.folder, ".omarkie", added.journal);
    const partial = await readFile(journal, "utf8");
    assert.equal(partial, "");
    const pendingBefore = service.status().pending;
    await service.request({ action: "flush" });
    assert.equal(service.status().pending, pendingBefore);

    service.faults.write = null;
    const flushed = await service.request({ action: "flush" });
    assert.equal(flushed.pending, 0);
    assert.equal(flushed.error, null);
    const lines = (await readFile(journal, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  } finally { await service.close(); }

  const reopened = await open(environment);
  try {
    assert.deepEqual((await reopened.request({ action: "list", note: "map.md" })).magnets.map(item => item.fields.text), ["unsaved"]);
  } finally { await reopened.close(); }
});

test("a short write is failure: the line is never torn, the op stays queued, retry saves it", async () => {
  const environment = await vault();
  const service = await open(environment);
  let journal;
  try {
    const first = await service.request({ action: "add", note: "map.md", magnet: "m-short", text: "first" });
    journal = path.join(environment.folder, ".omarkie", first.journal);
    const before = await readFile(journal, "utf8");
    assert.match(JSON.parse(before.trim()).opId, /^[0-9a-f]{16}$/);
    service.faults.write = async (handle, line) => {
      const bytes = Buffer.from(line, "utf8");
      const { bytesWritten } = await handle.write(bytes, 0, Math.max(1, bytes.length - 9), null);
      return bytesWritten;
    };
    const second = await service.request({ action: "set", note: "map.md", magnet: "m-short", fields: { text: "second" } });
    assert.equal(second.saved, false);
    assert.equal(service.status().error.code, "SHORT_WRITE");
    assert.match(service.status().error.message, /not saved/);
    assert.ok(service.status().pending >= 1);
    assert.equal(await readFile(journal, "utf8"), before, "rolled back to the last complete line");
    assert.equal((await service.request({ action: "list", note: "map.md" })).magnets[0].fields.text, "second");

    service.faults.write = null;
    const flushed = await service.request({ action: "flush" });
    assert.equal(flushed.pending, 0);
    assert.equal(flushed.error, null);
    const lines = (await readFile(journal, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) assert.equal(JSON.parse(line).opId.length, 16);
    assert.equal(JSON.parse(lines[1]).value, "second");
    assert.ok((await readFile(journal, "utf8")).endsWith("\n"));
  } finally { await service.close(); }

  const reopened = await open(environment);
  try {
    assert.equal((await reopened.request({ action: "show", note: "map.md", magnet: "m-short" })).magnet.fields.text, "second");
  } finally { await reopened.close(); }
});

test("only one writer; a second instance is read-only until the first closes", async () => {
  const environment = await vault();
  const first = await open(environment);
  try {
    await first.request({ action: "add", note: "map.md", text: "first" });
    const second = await open(environment);
    try {
      assert.equal(second.readOnly, true);
      assert.match(second.status().readOnlyReason, /another/);
      assert.equal((await second.request({ action: "list", note: "map.md" })).magnets.length, 1);
      await assert.rejects(second.request({ action: "add", note: "map.md", text: "second" }), error => error.code === "GLASS_READ_ONLY");
    } finally { await second.close(); }
    assert.equal(await readFile(path.join(environment.folder, ".omarkie", "writer.lock"), "utf8").then(text => JSON.parse(text).pid), process.pid);
  } finally { await first.close(); }
  const third = await open(environment);
  try {
    assert.equal(third.readOnly, false);
    assert.ok((await third.request({ action: "add", note: "map.md", text: "third" })).saved);
  } finally { await third.close(); }
});

test("union merge keeps every line and resolves fields by hybrid clock", async () => {
  const environment = await vault();
  const service = await open(environment);
  const added = await service.request({ action: "add", note: "map.md", magnet: "m-merge", text: "base", kind: "note" });
  await service.close();
  const journal = path.join(environment.folder, ".omarkie", added.journal);
  const base = await readFile(journal, "utf8");
  const baseTime = Number.parseInt(JSON.parse(base.trim().split("\n")[0]).hlc.split("-")[0], 16);
  const at = (offset, device, value) => `${JSON.stringify({ op: "set", magnetId: "m-merge", field: "text", value, hlc: `${(baseTime + offset).toString(16)}-0`, device })}\n`;
  const merged = base + at(1, "device-a", "alpha") + at(2, "device-b", "beta") + at(1, "device-a", "alpha");
  await writeFile(journal, merged);
  const reopened = await open(environment);
  try {
    const shown = await reopened.request({ action: "show", note: "map.md", magnet: "m-merge" });
    assert.equal(shown.magnet.fields.text, "beta");
    const text = await readFile(journal, "utf8");
    assert.ok(text.includes('"op":"set"') && text.includes("alpha") && text.includes("beta"));
  } finally { await reopened.close(); }

  await writeFile(journal, merged + `${JSON.stringify({ op: "delete", magnetId: "m-merge", hlc: `${(baseTime + 3).toString(16)}-0`, device: "device-b" })}\n`);
  const tombstoned = await open(environment);
  try {
    assert.deepEqual((await tombstoned.request({ action: "list", note: "map.md" })).magnets, []);
    assert.equal((await tombstoned.request({ action: "show", note: "map.md", magnet: "m-merge" })).deleted, true);
  } finally { await tombstoned.close(); }

  await writeFile(journal, merged + `${JSON.stringify({ op: "future-op", magnetId: "x", value: 1, hlc: `${(baseTime + 4).toString(16)}-0`, device: "device-c" })}\n`);
  const keeping = await open(environment);
  try {
    const list = await keeping.request({ action: "list", note: "map.md" });
    assert.equal(list.unknownOps, 1);
    await keeping.request({ action: "add", note: "map.md", text: "kept" });
    assert.ok((await readFile(journal, "utf8")).includes('"op":"future-op"'));
    assert.equal(list.magnets[0].fields.text, "beta");
  } finally { await keeping.close(); }
});

test("names are NFC, Windows-safe and at most 120 bytes", async () => {
  assert.equal(sanitizeTitle("CON"), "_CON");
  assert.equal(sanitizeTitle("CON .txt"), "_CON .txt");
  assert.equal(sanitizeTitle("lpt1.notes"), "_lpt1.notes");
  assert.equal(sanitizeTitle("Kerma: dosis"), "Kerma- dosis");
  assert.equal(sanitizeTitle("a<b>c|d?e*f"), "a-b-c-d-e-f");
  assert.equal(sanitizeTitle("Cafe\u0301"), "Café");
  assert.equal(sanitizeTitle("  . hidden . "), "hidden");
  assert.equal(sanitizeTitle("🧠 brain"), "🧠 brain");
  const long = glassFileName("x".repeat(300), "abcdef");
  assert.ok(Buffer.byteLength(long) <= 120, `${Buffer.byteLength(long)} bytes`);
  assert.match(long, /^x+ ~abcdef\.jsonl$/);
  assert.ok(Buffer.byteLength(glassFileName("🧠".repeat(200), "abcdef")) <= 120);
  assert.throws(() => glassFileName("x", "../bad"), /Invalid glass note id/);

  const environment = await vault({ "notes/CON.md": "# Reserved\n", "notes/a:b.md": "# Colon\n", [`notes/${"long ".repeat(40)}.md`]: "# Long\n" });
  const service = await open(environment);
  try {
    for (const note of ["notes/CON.md", "notes/a:b.md", `notes/${"long ".repeat(40)}.md`]) {
      const added = await service.request({ action: "add", note, text: note });
      const name = added.journal.split("/").at(-1);
      assert.ok(Buffer.byteLength(name) <= 120);
      assert.doesNotMatch(name, /[<>:"/\\|?*]/);
      assert.ok(added.journal.startsWith("glass/"));
    }
  } finally { await service.close(); }
});

test("a read-only vault switches to outside mode and stays byte-for-byte", async () => {
  const environment = await vault({ "notes/Protected.md": "# Protected\n\nRead only.\n" });
  const before = await checksums(environment.folder);
  await chmod(environment.folder, 0o555);
  const service = await open(environment);
  try {
    assert.equal(service.mode, null);
    assert.ok((await service.request({ action: "add", note: "notes/Protected.md", text: "outside" })).saved);
    assert.equal(service.mode, "outside");
    assert.ok(service.storeDir.startsWith(path.join(environment.data, "glass-vaults")));
    await assert.rejects(stat(path.join(environment.folder, ".omarkie")), error => error.code === "ENOENT");
    const settings = JSON.parse(await readFile(path.join(service.storeDir, "settings.json"), "utf8"));
    assert.equal(settings.mode, "outside");
    const mirror = await open(environment);
    try {
      assert.equal(mirror.mode, "outside");
      assert.equal(mirror.vaultId, service.vaultId);
      assert.equal((await mirror.request({ action: "list", note: "notes/Protected.md" })).magnets.length, 1);
    } finally { await mirror.close(); }
  } finally {
    await service.close();
    await chmod(environment.folder, 0o755);
  }
  const writableAgain = await open(environment);
  try {
    assert.equal(writableAgain.mode, "outside");
    assert.equal((await writableAgain.request({ action: "list", note: "notes/Protected.md" })).magnets.length, 1);
  } finally { await writableAgain.close(); }
  assert.deepEqual(await checksums(environment.folder), before);
});

test("a changed note updates its fingerprint under the same id", async () => {
  const environment = await vault();
  const service = await open(environment);
  let id;
  try {
    const first = await service.request({ action: "add", note: "map.md", text: "one" });
    id = first.id;
    await writeFile(path.join(environment.folder, "map.md"), "# Map\n\nChanged text.\n");
    await service.request({ action: "add", note: "map.md", text: "two" });
    const lines = (await readFile(path.join(environment.folder, ".omarkie", "notes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map(line => line.id), [id, id]);
    assert.notEqual(lines[0].fingerprint.hash, lines[1].fingerprint.hash);
  } finally { await service.close(); }
  const reopened = await open(environment);
  try {
    assert.equal((await reopened.request({ action: "list", note: "map.md" })).id, id);
  } finally { await reopened.close(); }
});

test("hybrid clock orders across clamps, devices and replay", () => {
  const clock = createClock("device-a", () => 1_000);
  const first = clock.next(), second = clock.next();
  assert.equal(first, "3e8-0");
  assert.equal(second, "3e8-1");
  const replayed = replayJournalText(`${JSON.stringify({ op: "set", magnetId: "m", field: "x", value: 1, hlc: first, device: "device-a" })}
${JSON.stringify({ op: "set", magnetId: "m", field: "x", value: 2, hlc: second, device: "device-a" })}
${JSON.stringify({ op: "set", magnetId: "m", field: "x", value: 3, hlc: second, device: "device-z" })}
`);
  assert.equal(replayed.magnets.get("m").fields.get("x").value, 3);
  const observed = createClock("device-c", () => 800);
  observed.observe("7d0-4");
  assert.equal(observed.next(), "7d0-5");
  const clamped = createClock("device-d", () => 100);
  assert.equal(clamped.next(), "64-0");
  assert.equal(clamped.next(), "64-1");
});

test("landmark anchors round-trip as an additive versioned field", async () => {
  const environment = await vault();
  const service = await open(environment);
  try {
    const anchor = { version: 2, landmarks: [
      { kind: "fingerprint", value: { tag: "paragraph", hash: "9f9920e6a9eb837c" } },
      { kind: "quote", value: { exact: "Contour lines close together mean a steep slope.", prefix: "# Map\n\n", suffix: "\n" } },
      { kind: "heading", value: { path: ["Map"] } },
      { kind: "neighbours", value: { before: "abc" } },
      { kind: "position", value: { line: 3, char: 7, word: 2, percent: 0.1 } },
      { kind: "spot", value: { x: 0.5, y: 0.5, px: 0, py: 0 } },
    ] };
    const added = await service.request({ action: "add", note: "map.md", magnet: "m-anchor", kind: "debug", anchor });
    assert.deepEqual(added.magnet.fields.anchor, anchor);
    const journal = await readFile(path.join(environment.folder, ".omarkie", added.journal), "utf8");
    assert.match(journal, /"field":"anchor"/);
    const listed = await service.request({ action: "list", note: "map.md" });
    assert.deepEqual(listed.magnets[0].fields.anchor, anchor);
    const legacy = { version: 1, landmarks: [{ kind: "block", block: "Contour lines close together mean a steep slope.", headings: ["Map"], line: 3 }] };
    const old = await service.request({ action: "add", note: "map.md", magnet: "m-legacy", anchor: legacy });
    assert.deepEqual(old.magnet.fields.anchor, legacy);
    await assert.rejects(service.request({ action: "add", note: "map.md", magnet: "m-bad", anchor: { version: 2, landmarks: [{ kind: "quote" }] } }), /Invalid Glass anchor/u);
    await assert.rejects(service.request({ action: "add", note: "map.md", magnet: "m-bad", anchor: { version: 9, landmarks: [] } }), /Invalid Glass anchor/u);
  } finally { await service.close(); }
});
