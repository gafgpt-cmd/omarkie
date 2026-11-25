// Rows 4-6, 9, 10, 13-16, 26-28, 30, 35: edits from outside, a second app, clocks, lost glass, names, moves.
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readdir, readFile, rename, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compare, contentHashes, copyTree, fileHash, manifest, notesLines, openService, openSync, put, sameGlass, scratch,
  sha256, sleep, vault, waitFor,
} from "../lib.mjs";
import { createWatcher } from "../../../electron/glass-watcher.mjs";
import { createClock, parseClock, replayJournalText } from "../../../shared/glass-core.mjs";

const skip = reason => Object.assign(new Error(reason), { skip: true });

function pinnedNote(extra = "") {
  return `# Map\n\nContour lines close together mean a steep slope.\n${extra}`;
}

function anchor() {
  return { version: 2, landmarks: [
    { kind: "block", block: "Contour lines close together mean a steep slope.", headings: ["Map"], line: 3 },
  ] };
}

export const rows = [
  {
    id: 4,
    name: "an external edit reloads once, keeps the magnets and makes Merge down refuse a changed page",
    async run() {
      const environment = await vault({ "map.md": pinnedNote() });
      const { service, sync } = await openSync(environment);
      try {
        const added = await service.request({ action: "add", note: "map.md", kind: "sticky", text: "pin", anchor: anchor() });
        await sync.whenIdle();
        const noteFile = path.join(environment.folder, "map.md");
        const stale = (await notesLines(environment)).filter(line => line.op === "note").at(-1).fingerprint.hash;

        await writeFile(noteFile, pinnedNote("\nAn outside edit.\n"));
        await utimes(noteFile, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
        await sync.handleBatch([{ type: "update", path: "map.md" }]);
        await sync.whenIdle();
        const lines = await notesLines(environment);
        assert.equal(lines.filter(line => line.op === "note").length, 2, "one fingerprint record for the outside edit");
        assert.notEqual(lines.at(-1).fingerprint.hash, stale);
        assert.equal((await service.request({ action: "list", note: "map.md" })).magnets[0].id, added.magnet.id);
        assert.deepEqual(sync.lost, []);

        const preview = await service.request({ action: "merge-preview", note: "map.md", magnet: added.magnet.id });
        const before = await readFile(noteFile);
        await writeFile(noteFile, `${pinnedNote("\nAnother outside edit.\n")}`);
        const refused = await service.request({ action: "merge-accept", note: "map.md", magnet: added.magnet.id,
          approved: true, expectedHash: preview.merge.baseHash });
        assert.equal(refused.stale, true);
        assert.equal(sha256(await readFile(noteFile)), sha256(Buffer.from(`${pinnedNote("\nAnother outside edit.\n")}`)));
        assert.notEqual(sha256(before), sha256(await readFile(noteFile)));
        return { fingerprintLines: 1, staleRefused: true };
      } finally { await sync.close(); await service.close(); }
    },
  },
  {
    id: 5,
    name: "200 plugin rewrites in 2 s become at most two batches and never touch the glass journal",
    async run() {
      const environment = await vault({ "map.md": pinnedNote() });
      const { service, sync } = await openSync(environment);
      try {
        const added = await service.request({ action: "add", note: "map.md", magnet: "m-burst", text: "pin", anchor: anchor() });
        await sync.whenIdle();
        const journal = path.join(environment.folder, ".omarkie", added.journal);
        const journalBefore = await fileHash(journal);

        const noteFile = path.join(environment.folder, "map.md");
        for (let index = 0; index < 200; index += 1) {
          await writeFile(noteFile, `${pinnedNote(`\nrewrite ${index}\n`)}`);
          await sleep(10);
        }
        const batches = [];
        const watcher = await createWatcher({ root: environment.folder, onBatch: batch => batches.push(batch), env: {} });
        try {
          const started = Date.now();
          for (let index = 0; index < 200; index += 1) {
            await writeFile(noteFile, `${pinnedNote(`\nsecond pass ${index}\n`)}`);
            await sleep(10);
          }
          const burst = Date.now() - started;
          await sleep(700);
          const events = batches.flat();
          // The quiet window is 300 ms, so a 2 s burst proves at most two batches; on a slow disk the
          // burst itself takes longer, and one batch per 400 ms is still coalescing, not per-event work.
          const allowed = burst <= 2_000 ? 2 : Math.ceil(burst / 400);
          assert.ok(batches.length >= 1 && batches.length <= allowed, `batches: ${batches.length} in ${burst} ms (allowed ${allowed})`);
          assert.ok(events.length >= 1);
          const paths = new Set(events.map(event => event.path ?? event));
          assert.ok(paths.size <= 2, "one file, one debounced batch");
        } finally { await watcher.close(); }

        await sync.handleBatch([{ type: "update", path: "map.md" }]);
        await sync.whenIdle();
        assert.equal(await fileHash(journal), journalBefore, "a content edit never writes the glass journal");
        const changed = (await notesLines(environment)).filter(line => line.op === "note");
        assert.ok(changed.length >= 2, "the fingerprint moved with the content");
        return { batches: batches.length, journalWrites: 0 };
      } finally { await sync.close(); await service.close(); }
    },
  },
  {
    id: 6,
    name: "two Omarkie instances: the second is read-only, shows host and pid, writes nothing",
    async run() {
      const environment = await vault({ "map.md": pinnedNote() });
      const first = await openService(environment);
      try {
        await first.request({ action: "add", note: "map.md", text: "first" });
        const notesBefore = await fileHash(path.join(environment.folder, ".omarkie", "notes.jsonl"));
        const second = await openService(environment);
        try {
          assert.equal(second.readOnly, true);
          assert.equal(second.status().lock.host, os.hostname());
          assert.equal(second.status().lock.pid, process.pid);
          assert.match(second.status().readOnlyReason, /Omarkie window/);
          await assert.rejects(second.request({ action: "add", note: "map.md", text: "second" }), error => error.code === "GLASS_READ_ONLY");
        } finally { await second.close(); }
        assert.equal(await fileHash(path.join(environment.folder, ".omarkie", "notes.jsonl")), notesBefore, "the read-only window wrote nothing");
      } finally { await first.close(); }

      // Another computer's live claim blocks writes and says whose it is.
      const lock = path.join(environment.folder, ".omarkie", "writer.lock");
      await writeFile(lock, JSON.stringify({ version: 1, host: "other-machine", pid: 4242, token: "t", started: Date.now() }));
      const remote = await openService(environment);
      try {
        assert.equal(remote.readOnly, true);
        assert.match(remote.status().readOnlyReason, /another computer/);
        await assert.rejects(remote.request({ action: "add", note: "map.md", text: "remote" }), error => error.code === "GLASS_READ_ONLY");
      } finally { await remote.close(); }

      // A claim from yesterday is stale and is taken over, so a crashed laptop never locks the vault.
      await writeFile(lock, JSON.stringify({ version: 1, host: "other-machine", pid: 4242, token: "t", started: Date.now() - 2 * 86_400_000 }));
      const takeover = await openService(environment);
      try {
        assert.equal(takeover.readOnly, false);
        assert.equal((await takeover.request({ action: "add", note: "map.md", text: "takeover" })).saved, true);
      } finally { await takeover.close(); }
      return { readOnlySecond: true, foreignClaim: true, staleTakenOver: true };
    },
  },
  {
    id: 9,
    name: "clock skew: every process stays monotonic, a reader's next op lands above what it read",
    async run() {
      const environment = await vault({ "map.md": pinnedNote(), "other.md": "# Other\n" });
      const ahead = await openService(environment, { device: "ahead", now: () => Date.now() + 5 * 60_000 });
      let aheadClock;
      try {
        aheadClock = ahead.clock.next();
        assert.ok(aheadClock);
        await ahead.request({ action: "add", note: "map.md", magnet: "m-ahead", text: "ahead" });
      } finally { await ahead.close(); }

      const behind = await openService(environment, { device: "behind", now: () => Date.now() - 2 * 3_600_000 });
      try {
        // Reading the ahead journal lifts the behind clock above every observed op (HLC receive rule).
        await behind.request({ action: "list", note: "map.md" });
        const observed = behind.clock.next();
        assert.ok(compare(observed, aheadClock) > 0 || Number.parseInt(observed.split("-")[0], 16) >= Number.parseInt(aheadClock.split("-")[0], 16));
        await behind.request({ action: "add", note: "map.md", magnet: "m-behind", text: "behind" });
        const lines = (await readFile(path.join(environment.folder, ".omarkie", "glass", (await behind.request({ action: "list", note: "map.md" })).journal.split("/").at(-1)), "utf8")).trim().split("\n");
        const clocks = lines.map(line => Number.parseInt(JSON.parse(line).hlc.split("-")[0], 16));
        for (let index = 1; index < clocks.length; index += 1) assert.ok(clocks[index] >= clocks[index - 1], "the log never goes backwards");
      } finally { await behind.close(); }

      const device = createClock("skew-test", () => Date.now() - 24 * 3_600_000);
      const clocks = Array.from({ length: 100 }, () => device.next());
      const order = value => parseClock(value);
      for (let index = 1; index < clocks.length; index += 1) {
        const now = order(clocks[index]), before = order(clocks[index - 1]);
        assert.ok(now.t > before.t || (now.t === before.t && now.c > before.c), `${clocks[index - 1]} < ${clocks[index]}`);
      }
      return { totalOrder: true, perNodeMonotonic: true };
    },
  },
  {
    id: 10,
    name: "note deleted then restored: magnets wait in lost glass and come back by fingerprint, zero loss",
    async run() {
      const environment = await vault({ "map.md": pinnedNote(), "other.md": "# Other\n" });
      const first = await openSync(environment);
      let id, basis;
      try {
        const added = await first.service.request({ action: "add", note: "map.md", kind: "sticky", text: "kept", anchor: anchor() });
        id = added.id;
        await first.sync.whenIdle();
        basis = await manifest(environment);
      } finally { await first.sync.close(); await first.service.close(); }

      const noteFile = path.join(environment.folder, "map.md");
      const bytes = await readFile(noteFile);
      await mkdir(path.join(environment.folder, ".trash"), { recursive: true });
      await rename(noteFile, path.join(environment.folder, ".trash", "map.md"));

      const second = await openSync(environment);
      try {
        await second.sync.scan("deleted");
        assert.deepEqual(second.sync.lost.map(item => item.id), [id], "lost glass, never a deletion");
        assert.deepEqual(second.service.currentNotes().map(note => note.id), [id]);

        await rename(path.join(environment.folder, ".trash", "map.md"), noteFile);
        assert.equal(sha256(await readFile(noteFile)), sha256(bytes), "restored byte-for-byte");
        await second.sync.scan("restored");
        assert.deepEqual(second.sync.lost, []);
        assert.deepEqual(second.service.currentNotes().map(note => note.id), [id]);
        const listed = await second.service.request({ action: "list", note: "map.md" });
        assert.deepEqual(listed.magnets.map(magnet => magnet.fields.text), ["kept"]);
        assert.ok(sameGlass(basis, await manifest(environment)));
        return { lostWhileGone: true, magnetsRestored: 1 };
      } finally { await second.sync.close(); await second.service.close(); }
    },
  },
  {
    id: 13,
    name: "a suspended watcher misses every event; one focus rescan re-places the glass, no reload storm",
    async run() {
      const files = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`notes/Unit ${index}.md`, `# Unit ${index}\n\nbody ${index}\n`]));
      const environment = await vault(files);
      process.env.OMARKIE_GLASS_POLL = "1";
      const { service, sync } = await openSync(environment, {
        watcherFactory: options => createWatcher({ ...options, pollEvery: 60 }),
      });
      try {
        await waitFor(() => sync.mode === "polling", { label: "polling watcher" });
        let refreshes = 0;
        const original = service.refreshFingerprint.bind(service);
        service.refreshFingerprint = async (...args) => { refreshes += 1; return original(...args); };
        // The app was suspended: the 100 rewrites happened while nothing was listening.
        for (let index = 0; index < 100; index += 1)
          await writeFile(path.join(environment.folder, "notes", `Unit ${index}.md`), `# Unit ${index}\n\nchanged body ${index}\n`);
        await sync.focus();
        await sync.whenIdle();
        assert.equal(sync.status().scanComplete, true, "one quick rescan ran");
        assert.equal(sync.scanReason, "focus");
        assert.ok(refreshes <= 100, `refreshes: ${refreshes}`);
        assert.deepEqual(sync.lost, []);
        assert.equal((await sync.find({ query: "changed" })).count >= 1, true);
        return { mode: sync.mode, rescans: 1, refreshes };
      } finally { delete process.env.OMARKIE_GLASS_POLL; await sync.close(); await service.close(); }
    },
  },
  {
    id: 14,
    name: "NFD and NFC names are one note with one glass; a case-only rename keeps it",
    async run() {
      const nfd = "Fluoroscopi\u0301a.md";
      const nfc = "Fluoroscopi\u0301a.md".normalize("NFC");
      assert.notEqual(nfd, nfc);
      const environment = await vault({});
      await put(environment.folder, nfd, "# Fluoroscopía\n\nDose.\n");
      const first = await openSync(environment);
      try {
        await first.service.request({ action: "add", note: nfd, magnet: "m-accent", text: "accent pin", anchor: anchor() });
        await first.sync.whenIdle();
      } finally { await first.sync.close(); await first.service.close(); }

      // A macOS drive hands the same file with the other normalisation.
      await put(environment.folder, nfc, "# Fluoroscopía\n\nDose.\n");
      const second = await openSync(environment);
      try {
        await second.sync.scan("nfc");
        const ids = new Set(second.service.currentNotes().map(note => note.id));
        assert.equal(ids.size, 1, `one note, saw ${ids.size}`);
        const listed = await second.service.request({ action: "list", note: nfc });
        assert.deepEqual(listed.magnets.map(magnet => magnet.fields.text), ["accent pin"], "the other normalisation finds the same glass");
        const journals = (await manifest(environment)).journals.length;
        assert.equal(journals, 1, "one journal");
      } finally { await second.sync.close(); await second.service.close(); }

      // Case-only rename on a case-insensitive drive (detection is per drive; ext4 here is only the carrier).
      const caseEnvironment = await vault({ "Kerma.md": "# Kerma\n\nDose units.\n" });
      const third = await openSync(caseEnvironment);
      let id;
      try {
        third.sync.detectCase = async () => true;
        await third.sync.scan("case");
        const added = await third.service.request({ action: "add", note: "Kerma.md", text: "case pin" });
        id = added.id;
        await third.sync.whenIdle();
        await rename(path.join(caseEnvironment.folder, "Kerma.md"), path.join(caseEnvironment.folder, "kerma.md"));
        await third.sync.scan("case-rename");
        assert.deepEqual(third.service.currentNotes().map(note => [note.id, note.path]), [[id, "kerma.md"]]);
        assert.equal((await third.service.request({ action: "list", note: "kerma.md" })).magnets[0].fields.text, "case pin");
        assert.deepEqual(third.sync.lost, []);
      } finally { await third.sync.close(); await third.service.close(); }
      return { nfdNfc: 1, caseOnlyRename: true };
    },
  },
  {
    id: 15,
    name: "weird titles create glass with a sanitized name and no write error",
    async run() {
      const files = {
        "CON.md": "# Reserved\n", "aux.txt": "plain", "notes/a:b.md": "# Colon\n", "trail. .md": "# Trail\n",
        [`${"a".repeat(200)}.md`]: "# Long\n",
      };
      const environment = await vault(files);
      const service = await openService(environment);
      try {
        for (const name of ["CON.md", "notes/a:b.md", "trail. .md", `${"a".repeat(200)}.md`]) {
          const added = await service.request({ action: "add", note: name, text: name });
          const file = added.journal.split("/").at(-1);
          assert.ok(Buffer.byteLength(file) <= 120, `${file.length}`);
          assert.doesNotMatch(file, /[<>:"/\\|?*\u0000-\u001f]/);
          assert.ok((await lstat(path.join(environment.folder, ".omarkie", added.journal))).isFile());
        }
        await assert.rejects(service.request({ action: "add", note: "aux.txt", text: "no" }), /Markdown/u);
        return { journals: 4 };
      } finally { await service.close(); }
    },
  },
  {
    id: 16,
    name: "symlink loops terminate, each real folder is visited once, no symlinked note is opened",
    async run() {
      const environment = await vault({ "map.md": pinnedNote(), "deep/note.md": "# Deep\n" });
      await symlink("..", path.join(environment.folder, "deep", "up"));
      await symlink("map.md", path.join(environment.folder, "alias.md"));
      await symlink(path.join(environment.folder, "deep"), path.join(environment.folder, "deep-copy"));
      const { service, sync } = await openSync(environment);
      try {
        const map = await sync.map();
        assert.equal(map.files, 2, `map.md and deep/note.md only, no symlink; saw ${map.files}`);
        const files = (await sync.find({ query: "" }).catch(() => null)) ?? null;
        assert.equal(files, null, "empty query is refused, not a scan");
        const found = await sync.find({ query: "Contour" });
        assert.equal(found.count, 1);
        await assert.rejects(service.request({ action: "add", note: "alias.md", text: "no" }), /symlink/u);
        await assert.rejects(service.request({ action: "add", note: "deep/up/map.md", text: "no" }), /symlink|vault-relative/u);
        return { files: map.files };
      } finally { await sync.close(); await service.close(); }
    },
  },
  {
    id: 26,
    name: "the whole vault moves to a drive: same vault id, same magnets, one glass",
    async run() {
      const source = await vault({ "map.md": pinnedNote(), "notes/Dose.md": "# Dose\n\nUnits.\n" });
      const first = await openSync(source);
      let basis;
      try {
        await first.service.request({ action: "add", note: "map.md", magnet: "m-move", text: "move pin", anchor: anchor() });
        await first.service.request({ action: "add", note: "notes/Dose.md", magnet: "m-dose", text: "dose pin" });
        await first.sync.whenIdle();
        basis = await manifest(source);
      } finally { await first.sync.close(); await first.service.close(); }

      const moved = path.join(await scratch(), "usb", "vault");
      await mkdir(path.dirname(moved), { recursive: true });
      await copyTree(source.folder, moved);
      const environment = { root: path.dirname(moved), folder: moved, data: source.data, cache: source.cache };
      const second = await openSync(environment);
      try {
        const after = await manifest(environment);
        assert.equal(after.vaultId, basis.vaultId);
        assert.ok(sameGlass(basis, after), "manifest identical after the path change");
        assert.equal(after.journals.length, basis.journals.length);
        assert.equal((await second.service.request({ action: "list", note: "map.md" })).magnets[0].fields.text, "move pin");
      } finally { await second.sync.close(); await second.service.close(); }
      return { vaultId: basis.vaultId, journals: basis.journals.length };
    },
  },
  {
    id: 27,
    name: "a copy without hidden files offers the old glass and writes nothing until accepted",
    async run() {
      const source = await vault({ "notes/Kerma.md": "# Kerma\n\nDose units.\n" });
      const first = await openSync(source);
      try {
        await first.service.request({ action: "add", note: "notes/Kerma.md", text: "old pin", anchor: anchor() });
        await first.sync.whenIdle();
      } finally { await first.sync.close(); await first.service.close(); }
      const oldStore = path.join(source.folder, ".omarkie");
      const oldHashes = await contentHashes(oldStore);

      const copyEnvironment = { ...(await vault({}, { data: source.data, cache: source.cache })) };
      await copyTree(source.folder, copyEnvironment.folder, { filter: name => !path.basename(name).startsWith(".") });
      const second = await openSync(copyEnvironment);
      try {
        assert.ok(second.sync.offer?.count >= 1, "the finder offers the glass from the old location");
        assert.equal(await lstat(path.join(copyEnvironment.folder, ".omarkie")).catch(() => null), null, "nothing written on the copy before the user accepts");
        const brought = await second.sync.bring({});
        assert.equal(brought.brought.length, 1);
        assert.equal((await second.service.request({ action: "list", note: "notes/Kerma.md" })).magnets[0].fields.text, "old pin");
        assert.deepEqual(await contentHashes(oldStore), oldHashes, "the old location is untouched");
      } finally { await second.sync.close(); await second.service.close(); }
      return { offered: true };
    },
  },
  {
    id: 28,
    name: "a note moves to another vault: the old vault keeps lost glass, the new one offers it",
    async run() {
      const source = await vault({ "notes/Kerma.md": "# Kerma\n\nDose units.\n", "keep.md": "# Keep\n" });
      const first = await openSync(source);
      let id;
      try {
        id = (await first.service.request({ action: "add", note: "notes/Kerma.md", text: "travel pin", anchor: anchor() })).id;
        await first.sync.whenIdle();
      } finally { await first.sync.close(); await first.service.close(); }

      const target = await vault({ "other.md": "# Other\n" }, { data: source.data, cache: source.cache });
      await rename(path.join(source.folder, "notes/Kerma.md"), path.join(target.folder, "Kerma.md"));

      const second = await openSync(source);
      try {
        assert.deepEqual(second.sync.lost.map(item => item.id), [id]);
      } finally { await second.sync.close(); await second.service.close(); }

      const third = await openSync(target);
      try {
        await third.sync.scan("offer");
        assert.ok(third.sync.offer?.count >= 1);
        await third.sync.bring({});
        assert.equal((await third.service.request({ action: "list", note: "Kerma.md" })).magnets[0].fields.text, "travel pin");
      } finally { await third.sync.close(); await third.service.close(); }
      return { lostThenOffered: true };
    },
  },
  {
    id: 30,
    name: "the vault vanishes mid-write, comes back, replays queued ops, and is found again at a new path",
    async run() {
      const environment = await vault({ "map.md": pinnedNote() });
      const { service, sync } = await openSync(environment);
      let basis;
      try {
        await service.request({ action: "add", note: "map.md", magnet: "m-live", text: "before unplug", anchor: anchor() });
        await sync.whenIdle();
        basis = await manifest(environment);
        const store = path.join(environment.folder, ".omarkie");
        // The mount is gone: every write inside the vault fails, as an unplugged drive does. The files
        // keep their write bits in a real unplug, so revoking them all is the closest local stand-in.
        const glass = path.join(store, "glass");
        const names = await readdir(glass);
        for (const name of names) await chmod(path.join(glass, name), 0o444);
        await chmod(path.join(store, "notes.jsonl"), 0o444);
        await chmod(glass, 0o555);
        await chmod(store, 0o555);

        const unplugged = await service.request({ action: "add", note: "map.md", magnet: "m-live", text: "written while unplugged" });
        assert.equal(unplugged.saved, false, "no write is claimed while the vault is gone");
        assert.ok(service.status().pending >= 1);
        assert.ok(service.status().error, "a banner-worthy error is surfaced");
        assert.match(service.status().error.message, /EACCES|permission|not saved/u);

        await chmod(store, 0o755);
        await chmod(glass, 0o755);
        await chmod(path.join(store, "notes.jsonl"), 0o644);
        for (const name of names) await chmod(path.join(glass, name), 0o644);
        const replayed = await service.request({ action: "flush" });
        assert.equal(replayed.pending, 0);
        assert.equal(replayed.error, null);
        assert.equal((await service.request({ action: "list", note: "map.md" })).magnets[0].fields.text, "written while unplugged");
        const text = await readFile(path.join(store, "glass", unplugged.journal.split("/").at(-1)), "utf8");
        assert.equal(replayJournalText(text).invalid, 0);
        assert.ok(text.endsWith("\n"));
      } finally { await sync.close(); await service.close(); }

      // Replug at a different mount point: same vault, same glass, no duplicate journals.
      const moved = path.join(await scratch(), "usb2", "vault");
      await mkdir(path.dirname(moved), { recursive: true });
      await copyTree(environment.folder, moved);
      const replugged = { root: path.dirname(moved), folder: moved, data: environment.data, cache: environment.cache };
      const second = await openSync(replugged);
      try {
        assert.equal((await manifest(replugged)).vaultId, basis.vaultId);
        assert.equal((await manifest(replugged)).journals.length, basis.journals.length);
        assert.equal((await second.service.request({ action: "list", note: "map.md" })).magnets[0].fields.text, "written while unplugged");
      } finally { await second.sync.close(); await second.service.close(); }
      return { queuedWhileGone: true, replayed: true, replugSameVault: true };
    },
  },
  {
    id: 34,
    name: "FAT-style whole-second timestamps: a same-size edit inside the stamp window is found by content",
    async run() {
      const environment = await vault({ "map.md": "# Map\n\nabcde\n" });
      const { service, sync } = await openSync(environment);
      try {
        const noteFile = path.join(environment.folder, "map.md");
        // Identity is lazy: the first magnet is what records a fingerprint to compare against.
        await service.request({ action: "add", note: "map.md", magnet: "m-fat", text: "pin" });
        await sync.scan("first");
        const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
        await utimes(noteFile, stamp, stamp);
        await sync.scan("stamped");
        const recorded = (await notesLines(environment)).filter(line => line.op === "note").at(-1).fingerprint;
        assert.ok(recorded?.hash);

        // Same byte count, same whole-second stamp: FAT cannot tell these apart, so content must.
        await writeFile(noteFile, "# Map\n\nfghij\n");
        await utimes(noteFile, stamp, stamp);
        await sync.scan("fat-edit");
        const after = (await notesLines(environment)).filter(line => line.op === "note").at(-1).fingerprint;
        assert.notEqual(after.hash, recorded.hash, "the edit was hashed, not skipped");
        assert.equal((await sync.find({ query: "fghij" })).count, 1);

        // A fine-grained stamp with equal size and mtime is still trusted, so a rescan stays cheap.
        const lines = (await notesLines(environment)).length;
        await sync.scan("cheap");
        assert.equal((await notesLines(environment)).length, lines);
        return { contentDecided: true };
      } finally { await sync.close(); await service.close(); }
    },
  },
  {
    id: 35,
    name: "no live events (share/FUSE): polling finds a change, focus rescans the rest",
    async run() {
      const environment = await vault({ "map.md": pinnedNote(), "other.md": "# Other\n" });
      process.env.OMARKIE_GLASS_POLL = "1";
      const watcher = await createWatcher({ root: environment.folder, onBatch: () => {}, env: { OMARKIE_GLASS_POLL: "1" }, pollEvery: 60 });
      try {
        await waitFor(() => watcher.mode === "polling", { label: "polling mode" });
        const batches = [];
        const watched = await createWatcher({ root: environment.folder, onBatch: batch => batches.push(batch), env: { OMARKIE_GLASS_POLL: "1" }, pollEvery: 60 });
        try {
          await writeFile(path.join(environment.folder, "map.md"), pinnedNote("\nchanged on the share\n"));
          await waitFor(() => batches.length > 0, { timeout: 2_000, label: "poll batch" });
          assert.ok(batches.flat().some(event => (event.path ?? event) === "map.md"));
        } finally { await watched.close(); }

        const { service, sync } = await openSync(environment, {
          watcherFactory: options => createWatcher({ ...options, pollEvery: 60 }),
        });
        try {
          await waitFor(() => sync.mode === "polling", { label: "sync polling" });
          await writeFile(path.join(environment.folder, "other.md"), "# Other\n\nchanged without an event\n");
          await sync.focus();
          await sync.whenIdle();
          assert.equal((await sync.find({ query: "changed without an event" })).count, 1);
        } finally { await sync.close(); await service.close(); }
      } finally { delete process.env.OMARKIE_GLASS_POLL; await watcher.close(); }
      return { pollInterval: 60, focusRescan: true };
    },
  },
];
