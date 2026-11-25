// FUSE rows 2, 3, 11, 12 and 36: syscall-level faults a real drive produces, no root needed at run time.
// Needs /dev/fuse, fusermount3 and gcc with the fuse3 headers; the group skips with the exact reason otherwise.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  manifest, openService, openSync, scratch, sha256, vault, waitFor,
} from "../lib.mjs";
import { replayJournalText } from "../../../shared/glass-core.mjs";

const source = fileURLToPath(new URL("../fuse/faultfs.c", import.meta.url));
const skip = reason => Object.assign(new Error(reason), { skip: true });

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(`${command} failed: ${error.message}`), { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function available() {
  try {
    execFileSync("pkg-config", ["--exists", "fuse3"]);
    await stat("/dev/fuse");
    execFileSync("which", ["fusermount3"]);
  } catch { throw skip("fuse3 headers, /dev/fuse or fusermount3 are missing on this machine"); }
}

async function build() {
  const folder = await scratch("omarkie-chaos-fuse-");
  const binary = path.join(folder, "faultfs");
  const flags = execFileSync("pkg-config", ["--cflags", "--libs", "fuse3"], { encoding: "utf8" }).trim().split(/\s+/);
  execFileSync("gcc", ["-O2", "-o", binary, source, ...flags]);
  return { folder, binary };
}

async function mounted(point) {
  const text = await readFile("/proc/mounts", "utf8");
  return text.split("\n").some(line => line.split(" ")[1] === point);
}

async function mount(binary, folder, sourcePath, mode = "passthrough", options = {}) {
  const point = options.point ?? path.join(folder, `mnt-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(point, { recursive: true });
  const child = execFile(binary, [sourcePath, point, ...(options.readOnly ? ["-o", "ro"] : [])], {
    env: { ...process.env, FAULTFS_MODE: mode, FAULTFS_BUDGET: String(options.budget ?? -1), FAULTFS_DELAY_MS: String(options.delay ?? 0) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let mountLog = "";
  child.stderr?.on("data", chunk => { mountLog += chunk; });
  await waitFor(() => mounted(point), { timeout: 5_000, label: `mount ${mode}` });
  // /proc/mounts appears before the FUSE daemon answers; a stat has to succeed first.
  await waitFor(async () => { try { await readdir(point); await stat(point); return true; } catch { return false; } }, { timeout: 5_000, label: "mount answers" });
  return {
    point, child, log: () => mountLog,
    async unmount() {
      await run("fusermount3", ["-u", point]).catch(() => run("fusermount3", ["-uz", point]));
      await waitFor(async () => !(await mounted(point)), { timeout: 5_000, label: "unmount" }).catch(() => {});
      await waitFor(() => child.exitCode !== null, { timeout: 5_000, label: "mount process exit" }).catch(() => {});
    },
  };
}

function environmentFor(folder, point) {
  return { root: folder, folder: point, data: path.join(folder, "app-data"), cache: path.join(folder, "cache") };
}

const stickyAnchor = { version: 2, landmarks: [{ kind: "block", block: "Contour lines close together mean a steep slope.", headings: ["Map"], line: 3 }] };
const noteText = "# Map\n\nContour lines close together mean a steep slope.\n";

export const rows = [
  {
    id: 2,
    name: "FUSE rename() -> EIO during Merge down: the page is untouched, an automatic undo is journalled",
    async run() {
      await available();
      const { folder, binary } = await build();
      const sourceFolder = path.join(folder, "vault");
      await vault({ "map.md": noteText }, { root: folder, folder: sourceFolder, data: path.join(folder, "source-data"), cache: path.join(folder, "source-cache") });
      const oldHash = sha256(await readFile(path.join(sourceFolder, "map.md")));

      const faulty = await mount(binary, folder, sourceFolder, "rename-eio");
      const environment = environmentFor(folder, faulty.point);
      let journal, magnet;
      try {
        const service = await openService(environment);
        try {
          const added = await service.request({ action: "add", note: "map.md", kind: "sticky", text: "merge me", anchor: stickyAnchor });
          magnet = added.magnet.id;
          journal = path.join(faulty.point, ".omarkie", added.journal);
          await assert.rejects(service.request({ action: "merge-accept", note: "map.md", magnet, approved: true }));
          assert.equal(sha256(await readFile(path.join(faulty.point, "map.md"))), oldHash, "the page never half-writes");
          const files = await readdir(faulty.point);
          assert.deepEqual(files.filter(name => name.endsWith(".tmp")), [], "the temp file is cleaned up");
          const lines = (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
          const merge = lines.find(line => line.op === "merge");
          assert.ok(merge, "the merge was journalled");
          assert.ok(lines.some(line => line.op === "merge-undo" && line.automatic === true), "an automatic undo followed the failure");
        } finally { await service.close().catch(() => {}); }
      } finally { await faulty.unmount(); }

      // The drive behaves again: the same merge now lands and its undo restores the old page.
      const healthy = await mount(binary, folder, sourceFolder);
      const second = environmentFor(folder, healthy.point);
      try {
        const service = await openService(second);
        try {
          const merged = await service.request({ action: "merge-accept", note: "map.md", magnet, approved: true });
          assert.equal(merged.merged, true);
          assert.notEqual(sha256(await readFile(path.join(healthy.point, "map.md"))), oldHash);
          await service.request({ action: "merge-undo", note: "map.md", merge: merged.merge.id });
          assert.equal(sha256(await readFile(path.join(healthy.point, "map.md"))), oldHash);
        } finally { await service.close(); }
      } finally { await healthy.unmount(); }
      return { renameEio: true, undoAfterRestart: true };
    },
  },
  {
    id: 3,
    name: "FUSE byte-budget disk full: no torn line committed, the op replays when space returns",
    async run() {
      await available();
      const { folder, binary } = await build();
      const sourceFolder = path.join(folder, "vault");
      await vault({ "map.md": noteText }, { root: folder, folder: sourceFolder, data: path.join(folder, "source-data"), cache: path.join(folder, "source-cache") });
      const point = path.join(folder, "mnt-stick");
      const first = await mount(binary, folder, sourceFolder, "enospc", { budget: 1_200, point });
      const environment = environmentFor(folder, point);
      let pending = 0, journalText = "";
      const service = await openService(environment);
      try {
        {
          await service.request({ action: "add", note: "map.md", magnet: "m-fill", kind: "sticky", text: "fills the disk", anchor: stickyAnchor });
          let failed = null;
          for (let index = 0; index < 20 && !failed; index += 1) {
            const result = await service.request({ action: "add", note: "map.md", magnet: `m-full-${index}`, text: `op ${index}`, x: index });
            if (!result.saved) failed = result;
          }
          assert.ok(failed, "the budget eventually runs out");
          assert.match(service.status().error.code, /ENOSPC|SHORT_WRITE/u);
          pending = service.status().pending;
          assert.ok(pending >= 1);
          const journal = path.join(first.point, ".omarkie", "glass", (await readdir(path.join(first.point, ".omarkie", "glass")))[0]);
          journalText = await readFile(journal, "utf8");
          assert.equal(replayJournalText(journalText).invalid, 0, "no torn line was committed");
          assert.ok(journalText === "" || journalText.endsWith("\n"), "the file ends on a line boundary");
        }
        // Same session, same stick: the space comes back and the queued op lands.
        await first.unmount();
        const second = await mount(binary, folder, sourceFolder, "passthrough", { point });
        try {
          const flushed = await service.request({ action: "flush" });
          assert.equal(flushed.pending, 0);
          assert.equal(flushed.error, null);
          const listed = await service.request({ action: "list", note: "map.md" });
          assert.ok(listed.magnets.length >= 2, `magnets ${listed.magnets.length}`);
          const journal = path.join(point, ".omarkie", "glass", (await readdir(path.join(point, ".omarkie", "glass")))[0]);
          const text = await readFile(journal, "utf8");
          assert.equal(replayJournalText(text).invalid, 0);
          assert.ok(text.endsWith("\n"));
        } finally { await second.unmount().catch(() => {}); }
      } finally { await service.close().catch(() => {}); }
      return { queued: pending, replayed: true };
    },
  },
  {
    id: 11,
    name: "the vault unmounts mid-write: writes queue, the banner shows, a remount replays them",
    async run() {
      await available();
      const { folder, binary } = await build();
      const sourceFolder = path.join(folder, "vault");
      await vault({ "map.md": noteText }, { root: folder, folder: sourceFolder, data: path.join(folder, "source-data"), cache: path.join(folder, "source-cache") });
      const point = path.join(folder, "mnt-stick");
      const first = await mount(binary, folder, sourceFolder, "passthrough", { point });
      const environment = environmentFor(folder, point);
      let basis, queued;
      const service = await openService(environment);
      try {
        await service.request({ action: "add", note: "map.md", magnet: "m-live", kind: "sticky", text: "before", anchor: stickyAnchor });
        basis = await manifest(environment);
        await first.unmount();
        const unplugged = await service.request({ action: "add", note: "map.md", magnet: "m-live", text: "while offline" });
        assert.equal(unplugged.saved, false);
        queued = service.status().pending;
        assert.ok(queued >= 1);
        assert.ok(service.status().error, "the banner state is set");

        const back = await mount(binary, folder, sourceFolder, "passthrough", { point });
        try {
          const flushed = await service.request({ action: "flush" });
          assert.equal(flushed.pending, 0);
          assert.equal(flushed.error, null);
          assert.equal((await service.request({ action: "list", note: "map.md" })).magnets[0].fields.text, "while offline");
        } finally { await back.unmount(); }
      } finally { await service.close().catch(() => {}); }

      // Replugged somewhere else: a fresh instance recognises the same vault and glass series.
      const second = await mount(binary, folder, sourceFolder);
      const again = environmentFor(folder, second.point);
      try {
        const fresh = await openService(again);
        try {
          const after = await manifest(again);
          assert.equal(after.vaultId, basis.vaultId, "the same vault, recognised at another mount");
          assert.deepEqual(after.journals, basis.journals, "no duplicate glass");
        } finally { await fresh.close(); }
      } finally { await second.unmount(); }
      return { queued, remountedElsewhere: true };
    },
  },
  {
    id: 12,
    name: "a read-only mount switches to outside mode with zero attempted writes inside",
    async run() {
      await available();
      const { folder, binary } = await build();
      const sourceFolder = path.join(folder, "vault");
      await vault({ "map.md": noteText }, { root: folder, folder: sourceFolder, data: path.join(folder, "source-data"), cache: path.join(folder, "source-cache") });
      const ro = await mount(binary, folder, sourceFolder, "passthrough", { readOnly: true });
      const environment = environmentFor(folder, ro.point);
      try {
        const service = await openService(environment);
        try {
          const added = await service.request({ action: "add", note: "map.md", text: "outside please" });
          assert.equal(added.saved, true);
          assert.equal(service.mode, "outside");
          assert.equal(await stat(path.join(ro.point, ".omarkie")).catch(() => null), null, "nothing written inside the read-only vault");
          assert.ok(service.storeDir.startsWith(path.join(environment.data, "glass-vaults")));
        } finally { await service.close(); }
      } catch (error) { error.message += `\nfaultfs log: ${ro.log()}\nmounts: ${(await readFile("/proc/mounts", "utf8")).split("\n").filter(line => line.includes(ro.point)).join("|")}`; throw error; }
      finally { await ro.unmount(); }
      return { mode: "outside", writesInside: 0 };
    },
  },
  {
    id: 36,
    name: "a slow stick (5 ms/op): saves stay correct, the index stays on the host disk, actions stay fast",
    async run() {
      await available();
      const { folder, binary } = await build();
      const sourceFolder = path.join(folder, "vault");
      await vault({ "map.md": noteText }, { root: folder, folder: sourceFolder, data: path.join(folder, "source-data"), cache: path.join(folder, "source-cache") });
      const slow = await mount(binary, folder, sourceFolder, "passthrough", { delay: 5 });
      const environment = environmentFor(folder, slow.point);
      try {
        const { service, sync } = await openSync(environment);
        try {
          const samples = [];
          for (let index = 0; index < 40; index += 1) {
            const started = process.hrtime.bigint();
            const result = await service.request({ action: "add", note: "map.md", magnet: `m-slow-${index}`, text: `slow ${index}` });
            samples.push(Number(process.hrtime.bigint() - started) / 1e6);
            assert.equal(result.saved, true);
          }
          assert.ok(sync.indexFile.startsWith(environment.cache), `index on the host: ${sync.indexFile}`);
          assert.ok(!sync.indexFile.startsWith(slow.point), "the index is never on the stick");
          samples.sort((left, right) => left - right);
          const p95 = samples[Math.floor(samples.length * 0.95)];
          assert.ok(p95 < 500, `p95 ${p95.toFixed(1)} ms with a 5 ms/op stick`);
          const listings = await service.request({ action: "list", note: "map.md" });
          assert.equal(listings.magnets.length, 40);
          return { p95Ms: Math.round(p95 * 10) / 10, indexOutside: true };
        } finally { await sync.close(); await service.close(); }
      } finally { await slow.unmount(); }
    },
  },
];
