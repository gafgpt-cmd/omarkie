// Rows 2, 7, 8, 17, 23, 24, 31: Merge down power cut, sync- and git-conflict journals, HEIC, export and backup.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  compare, copyTree, fileHash, manifest, openService, openSync, sameGlass, scratch, sha256, sleep, spawnNode, vault,
} from "../lib.mjs";
import { journalOpId, replayJournalText } from "../../../shared/glass-core.mjs";

const mergeChild = fileURLToPath(new URL("../child-merge.mjs", import.meta.url));
const heicFixture = fileURLToPath(new URL("../../fixtures/glass/photo-heic.heic", import.meta.url));
const opLine = (magnetId, field, value, hlc, device = "chaos") => JSON.stringify({ op: "set", magnetId, field, value, hlc, device });

async function glassDir(environment) {
  return path.join(environment.folder, ".omarkie", "glass");
}

async function onlyJournal(environment) {
  const names = (await readdir(await glassDir(environment))).filter(name => / ~[a-z0-9]{6}\.jsonl$/.test(name));
  assert.equal(names.length, 1, `one journal, saw ${names.join(", ")}`);
  return path.join(await glassDir(environment), names[0]);
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=chaos", "-c", "user.email=chaos@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export const rows = [
  {
    id: 2,
    name: "power cut mid Merge down: the note is old or complete, never half written, undo survives",
    async run() {
      const environment = await vault({ "map.md": "# Map\n\nContour lines close together mean a steep slope.\n" });
      const filler = Array.from({ length: 40_000 }, (_, index) => `filler line ${index}`).join("\n");
      await writeFile(path.join(environment.folder, "map.md"), `# Map\n\nContour lines close together mean a steep slope.\n\n${filler}\n`);
      const service = await openService(environment);
      let journal, magnet;
      try {
        const added = await service.request({ action: "add", note: "map.md", kind: "sticky", text: "merged pin",
          anchor: { version: 2, landmarks: [{ kind: "block", block: "Contour lines close together mean a steep slope.", headings: ["Map"], line: 3 }] } });
        magnet = added.magnet.id;
        journal = path.join(environment.folder, ".omarkie", added.journal);
      } finally { await service.close(); }

      // Reference outcome: run the same merge with no fault on a copy of the vault.
      const reference = await vault({});
      await copyTree(environment.folder, reference.folder);
      const control = await openService(reference);
      let merged;
      try { merged = await control.request({ action: "merge-accept", note: "map.md", magnet, approved: true }); }
      finally { await control.close(); }
      const oldBytes = await readFile(path.join(environment.folder, "map.md"));
      const newBytes = await readFile(path.join(reference.folder, "map.md"));
      assert.notEqual(sha256(oldBytes), sha256(newBytes), "the merge does change the page");

      let tore = 0;
      for (let trial = 0; trial < 10; trial += 1) {
        const child = await spawnNode(mergeChild, [environment.folder, environment.data, "map.md", magnet]);
        let output = "";
        child.stdout.on("data", chunk => { output += chunk; });
        for (;;) {
          if (output.includes("ready")) break;
          if (child.exitCode !== null) throw new Error(`merger exited before ready: ${output}`);
          await sleep(2);
        }
        await sleep(2 + Math.floor(Math.random() * 40));
        child.kill("SIGKILL");
        await once(child, "exit");
        const bytes = await readFile(path.join(environment.folder, "map.md"));
        const hash = sha256(bytes);
        if (hash !== sha256(oldBytes) && hash !== sha256(newBytes)) tore += 1;
        assert.ok(hash === sha256(oldBytes) || hash === sha256(newBytes), "the page is old or complete, never torn");
        if (hash === sha256(newBytes)) {
          // Undo must still restore the old page after a restart.
          const reopened = await openService(environment);
          try {
            const history = await reopened.request({ action: "merge-history", note: "map.md" });
            const entry = history.merges.at(-1);
            assert.ok(entry, "the merge was journalled before the page was written");
            await reopened.request({ action: "merge-undo", note: "map.md", merge: entry.id });
            assert.equal(sha256(await readFile(path.join(environment.folder, "map.md"))), sha256(oldBytes));
          } finally { await reopened.close(); }
          await writeFile(path.join(environment.folder, "map.md"), oldBytes);
        }
      }
      return { trials: 10, tornNotes: tore, journal: path.basename(journal), mergeId: merged.merge?.id ?? null };
    },
  },
  {
    id: 7,
    name: "Syncthing/Drive/Dropbox conflict copies are union-merged by op id and moved, never deleted",
    async run() {
      const environment = await vault({ "map.md": "# Map\n\nContour lines.\n" });
      const service = await openService(environment);
      let journal, base;
      try {
        await service.request({ action: "add", note: "map.md", magnet: "m-one", text: "base" });
        await service.request({ action: "add", note: "map.md", magnet: "m-two", text: "second" });
        journal = await onlyJournal(environment);
        base = await readFile(journal, "utf8");
      } finally { await service.close(); }

      const now = Date.now().toString(16);
      const extra = (magnetId, value, offset) => opLine(magnetId, "text", value, `${(Number.parseInt(now, 16) + offset).toString(16)}-0`, `copy-${offset}`);
      const duplicated = base.trim().split("\n")[0];
      const copies = {
        [`${path.basename(journal)}.sync-conflict-20260101-120000-ABCDEF1.jsonl`]: `${base}${duplicated}\n${extra("m-three", "syncthing", 1)}\n`,
        [`${path.basename(journal, ".jsonl")} (1).jsonl`]: `${base}${extra("m-four", "drive", 2)}\n`,
        [`${path.basename(journal, ".jsonl")} (conflicted copy 2026-01-01).jsonl`]: `${base}${extra("m-five", "dropbox", 3)}\n`,
      };
      for (const [name, text] of Object.entries(copies)) await writeFile(path.join(await glassDir(environment), name), text);

      const reopened = await openService(environment);
      try {
        const listed = await reopened.request({ action: "list", note: "map.md" });
        const texts = listed.magnets.map(magnet => magnet.fields.text).sort();
        assert.deepEqual(texts, ["base", "drive", "dropbox", "second", "syncthing"]);
        const merged = (await readFile(journal, "utf8")).trim().split("\n");
        const ids = merged.map(line => journalOpId(JSON.parse(line)));
        assert.equal(new Set(ids).size, ids.length, "no op id appears twice");
        assert.equal(replayJournalText(merged.join("\n") + "\n").invalid, 0);
        const moved = await readdir(path.join(environment.folder, ".omarkie", "merged"));
        assert.deepEqual(moved.sort(), Object.keys(copies).sort(), "every copy was kept under merged/");
        assert.deepEqual((await readdir(await glassDir(environment))).filter(name => name.endsWith(".jsonl")),
          [path.basename(journal)], "one journal is left");
        await reopened.close();

        // A copy that lands while the app is open is absorbed on the next sync batch.
        const { service: live, sync } = await openSync(environment);
        try {
          const liveJournal = await onlyJournal(environment);
          const late = `${path.basename(liveJournal, ".jsonl")}.sync-conflict-20260101-130000-ZZZZZZ9.jsonl`;
          await writeFile(path.join(await glassDir(environment), late), `${await readFile(liveJournal, "utf8")}${extra("m-six", "late", 4)}\n`);
          await sync.handleBatch([{ type: "update", path: "map.md" }]);
          await sync.whenIdle();
          const after = await live.request({ action: "list", note: "map.md" });
          assert.ok(after.magnets.some(magnet => magnet.id === "m-six"));
          assert.ok((await readdir(path.join(environment.folder, ".omarkie", "merged"))).includes(late));
        } finally { await sync.close(); await live.close(); }
        return { copies: Object.keys(copies).length, magnets: texts.length };
      } finally { await reopened.close().catch(() => {}); }
    },
  },
  {
    id: 8,
    name: "a real git union merge leaves zero conflict markers and the app dedupes by op id",
    async run() {
      const environment = await vault({ "map.md": "# Map\n\nContour lines.\n" });
      const service = await openService(environment);
      try {
        await service.request({ action: "add", note: "map.md", magnet: "m-git", text: "base" });
      } finally { await service.close(); }
      const journal = await onlyJournal(environment);
      const repo = path.join(environment.root, "repo");
      await mkdir(repo, { recursive: true });
      git(repo, "init", "-q", "-b", "left");
      await copyTree(path.join(environment.folder, ".omarkie"), path.join(repo, ".omarkie"));
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "base");

      const time = Date.now().toString(16);
      git(repo, "checkout", "-q", "-b", "right");
      const right = path.join(repo, ".omarkie", "glass", path.basename(journal));
      await writeFile(right, `${await readFile(right, "utf8")}${opLine("m-git", "text", "right", `${time}-0`, "device-r")}\n${opLine("m-git", "color", "rose", `${time}-1`, "device-r")}\n`);
      git(repo, "commit", "-q", "-am", "right");
      git(repo, "checkout", "-q", "left");
      const left = path.join(repo, ".omarkie", "glass", path.basename(journal));
      await writeFile(left, `${await readFile(left, "utf8")}${opLine("m-git", "text", "left", `${time}-2`, "device-l")}\n`);
      git(repo, "commit", "-q", "-am", "left");
      let merged = "";
      try { merged = git(repo, "merge", "right"); } catch (error) { merged = String(error.stdout ?? ""); }
      const mergedText = await readFile(left, "utf8");
      assert.doesNotMatch(mergedText, /^(?:<<<<<<<|=======|>>>>>>>)/m, "union merge leaves no markers");
      assert.match(mergedText, /device-r/);
      assert.match(mergedText, /device-l/);

      const restored = await vault({ "map.md": "# Map\n\nContour lines.\n" });
      await copyTree(path.join(repo, ".omarkie"), path.join(restored.folder, ".omarkie"));
      const reopened = await openService(restored);
      try {
        const listed = await reopened.request({ action: "list", note: "map.md" });
        assert.equal(listed.magnets.length, 1);
        assert.equal(listed.magnets[0].fields.text, "left", "the newest clock wins");
        assert.equal(listed.magnets[0].fields.color, "rose", "the other side's field survived");
        const lines = (await readFile(path.join(restored.folder, ".omarkie", "glass", path.basename(journal)), "utf8")).trim().split("\n");
        const ids = lines.map(line => journalOpId(JSON.parse(line)));
        assert.equal(new Set(ids).size, ids.length, "union merge did not duplicate an op id");
      } finally { await reopened.close(); }
      return { markers: 0, merge: merged.split("\n")[0] };
    },
  },
  {
    id: 17,
    name: "a 24 MP HEIC photo: original hash untouched, display copy smaller, orientation applied",
    async run() {
      const environment = await vault({ "photos/big.heic": await readFile(heicFixture), "map.md": "# Photo\n\nBig picture.\n" });
      const original = path.join(environment.folder, "photos/big.heic");
      const before = await fileHash(original);
      process.env.OMARKIE_IMAGE_CONVERT = JSON.stringify(["magick"]);
      const service = await openService(environment);
      try {
        const added = await service.request({ action: "add", note: "map.md", magnet: "m-photo",
          anchor: { version: 2, landmarks: [{ kind: "block", block: "Big picture.", headings: ["Photo"], line: 3 }] },
          image: { path: original, name: "big.heic" } });
        assert.equal(await fileHash(original), before, "the original is never rewritten");
        assert.ok(added.magnet.fields.asset.endsWith(".heic"));
        if (added.magnet.fields.display) {
          const display = path.join(environment.folder, ".omarkie", "assets", path.basename(added.journal, ".jsonl"), added.magnet.fields.display);
          assert.ok((await stat(display)).size < (await stat(original)).size, "the display copy is smaller");
        }
        const ratio = added.magnet.fields.aspect;
        assert.ok(Math.abs(ratio - 4 / 3) < 0.02, `aspect ${ratio}`);
        const fetched = await service.request({ action: "asset", note: "map.md", magnet: "m-photo", which: "original" });
        assert.equal(sha256(Buffer.from(fetched.base64, "base64")), before);
        return { originalBytes: (await stat(original)).size, display: added.magnet.fields.display ?? null, aspect: ratio };
      } finally { delete process.env.OMARKIE_IMAGE_CONVERT; await service.close(); }
    },
  },
  {
    id: 23,
    name: "export: every magnet id is in the exported vault and the note hashes never move",
    async run() {
      const environment = await vault({ "map.md": "# Map\n\nContour lines.\n", "photos/p.png": "png bytes" });
      const first = await openSync(environment);
      let basis;
      try {
        await first.service.request({ action: "add", note: "map.md", magnet: "m-export-one", text: "one" });
        await first.service.request({ action: "add", note: "map.md", magnet: "m-export-two", text: "two" });
        await first.sync.whenIdle();
        basis = await manifest(environment);
      } finally { await first.sync.close(); await first.service.close(); }

      const exported = path.join(await scratch(), "export", "vault");
      await mkdir(path.dirname(exported), { recursive: true });
      await copyTree(environment.folder, exported);
      const fresh = { root: path.dirname(exported), folder: exported, data: path.join(environment.root, "fresh-data"), cache: path.join(environment.root, "fresh-cache") };
      const second = await openSync(fresh);
      try {
        const after = await manifest(fresh);
        assert.ok(sameGlass(basis, after));
        const ids = after.notes.flatMap(note => note.magnets.map(magnet => magnet.id)).sort();
        assert.deepEqual(ids, ["m-export-one", "m-export-two"]);
        const hashes = [...after.notes.map(note => note.sha256)].sort(compare);
        assert.deepEqual(hashes, basis.notes.map(note => note.sha256).sort(compare));
      } finally { await second.sync.close(); await second.service.close(); }
      return { magnets: 2, notes: basis.notes.length };
    },
  },
  {
    id: 24,
    name: "a backup archive restores the glass with the same ids, no cache outside the vault needed",
    async run() {
      const environment = await vault({ "map.md": "# Map\n\nContour lines.\n" });
      const first = await openSync(environment);
      let basis;
      try {
        await first.service.request({ action: "add", note: "map.md", magnet: "m-backup", text: "backed up" });
        await first.sync.whenIdle();
        basis = await manifest(environment);
      } finally { await first.sync.close(); await first.service.close(); }

      const restoreRoot = path.join(await scratch(), "restore");
      await mkdir(restoreRoot, { recursive: true });
      execFileSync("tar", ["-czf", path.join(restoreRoot, "vault.tgz"), "-C", environment.root, "vault"]);
      const unpacked = path.join(restoreRoot, "unpacked");
      await mkdir(unpacked, { recursive: true });
      execFileSync("tar", ["-xzf", path.join(restoreRoot, "vault.tgz"), "-C", unpacked]);
      const restored = { root: unpacked, folder: path.join(unpacked, "vault"), data: path.join(unpacked, "app-data"), cache: path.join(unpacked, "cache") };
      await mkdir(restored.data, { recursive: true });
      await mkdir(restored.cache, { recursive: true });
      const second = await openSync(restored);
      try {
        const after = await manifest(restored);
        assert.ok(sameGlass(basis, after), "the restored glass is the backed-up glass");
        assert.equal((await second.service.request({ action: "list", note: "map.md" })).magnets[0].fields.text, "backed up");
      } finally { await second.sync.close(); await second.service.close(); }
      return { restored: true, journals: basis.journals.length };
    },
  },
  {
    id: 31,
    name: "handing the vault to someone: glass restores in a clean profile and stays out of Obsidian's way",
    async run() {
      const environment = await vault({ "map.md": "# Map\n\nContour lines.\n", "assets/photo.png": "png" });
      const first = await openSync(environment);
      let basis;
      try {
        await first.service.request({ action: "add", note: "map.md", magnet: "m-hand", text: "handed over" });
        await first.sync.whenIdle();
        basis = await manifest(environment);
      } finally { await first.sync.close(); await first.service.close(); }

      const target = path.join(await scratch(), "someone-else", "vault");
      await mkdir(path.dirname(target), { recursive: true });
      await copyTree(environment.folder, target);
      const notes = (await readdir(target, { recursive: true }))
        .filter(name => String(name).endsWith(".md") && !String(name).split(path.sep)[0].startsWith(".")).sort();
      assert.deepEqual(notes, ["map.md"], "glass writes no extra Markdown outside its hidden folder");
      assert.ok((await readdir(target)).includes(".omarkie"), "hidden folder, so Obsidian ignores it");
      const clean = { root: path.dirname(target), folder: target, data: path.join(environment.root, "clean-data"), cache: path.join(environment.root, "clean-cache") };
      const second = await openSync(clean);
      try {
        assert.ok(sameGlass(basis, await manifest(clean)));
        assert.equal((await second.service.request({ action: "list", note: "map.md" })).magnets[0].fields.text, "handed over");
      } finally { await second.sync.close(); await second.service.close(); }
      return { notes: notes.length, magnets: 1 };
    },
  },
];
