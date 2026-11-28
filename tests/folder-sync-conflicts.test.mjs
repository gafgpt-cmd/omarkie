// Two desktop vaults kept in step by a Syncthing-style folder sync. Each client edits offline;
// on reconnect nothing is lost silently, deletes stay recoverable, and both folders converge.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, stat, utimes, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DocumentStore } from "../electron/store.mjs";
import { moveExclusive } from "../electron/move-exclusive.mjs";
import { Workspace } from "../electron/workspace.mjs";
import { conflictCopy, conflictName, copiesOf } from "../shared/sync-conflicts.mjs";
import { SyncthingPair, sha, snapshot } from "./syncthing-sim.mjs";

test("conflict copy names: Syncthing and Omarkie parse, Omarkie names never collide with Syncthing cleanup", () => {
  assert.deepEqual(conflictCopy("plan.sync-conflict-20260301-101530-LAPTOPA.md"), { base: "plan.md", app: "syncthing", at: "2026-03-01T10:15:30", origin: "LAPTOPA" });
  assert.deepEqual(conflictCopy("a.b.omarkie-conflict-20260301-101530-draft.md"), { base: "a.b.md", app: "omarkie", at: "2026-03-01T10:15:30", origin: "draft" });
  assert.equal(conflictCopy("plan.md"), null);
  assert.equal(conflictCopy("plan.sync-conflict-2026.md"), null);
  const name = conflictName("plan.md", "disk", new Date(2026, 2, 1, 10, 15, 30));
  assert.equal(name, "plan.omarkie-conflict-20260301-101530-disk.md");
  assert.doesNotMatch(name, /\.sync-conflict-/);
  assert.throws(() => conflictName("plan.md", "../x"));
  const entries = [
    { path: "/v/a/plan.md", name: "plan.md" },
    { path: "/v/a/plan.sync-conflict-20260301-101530-LAPTOPA.md", name: "plan.sync-conflict-20260301-101530-LAPTOPA.md" },
    { path: "/v/a/plan.omarkie-conflict-20260302-090000-disk.md", name: "plan.omarkie-conflict-20260302-090000-disk.md" },
    { path: "/v/b/plan.sync-conflict-20260301-101530-LAPTOPA.md", name: "plan.sync-conflict-20260301-101530-LAPTOPA.md" },
    { path: "/v/a/planner.sync-conflict-20260301-101530-LAPTOPA.md", name: "planner.sync-conflict-20260301-101530-LAPTOPA.md" },
  ];
  assert.deepEqual(copiesOf("/v/a/plan.md", entries).map(entry => entry.name), ["plan.omarkie-conflict-20260302-090000-disk.md", "plan.sync-conflict-20260301-101530-LAPTOPA.md"]);
});

async function client(root, data, trashRoot) {
  const store = new DocumentStore(data), workspace = new Workspace(data);
  await store.scan(root);
  const trash = async file => { const target = path.join(trashRoot, `${Date.now()}-${path.basename(file)}`); await mkdir(trashRoot, { recursive: true }); await rename(file, target); };
  return { store, workspace, trash, open: async relative => store.open(path.join(root, relative)), token: async file => (await store.scan(root)).files.find(entry => entry.path === file).token };
}
async function texts(...roots) {
  const found = [];
  const walk = async directory => { for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await walk(file); else found.push(await readFile(file, "utf8").catch(() => "")); } };
  for (const root of roots) await walk(root);
  return found.join("\n\u0000\n");
}

test("two offline vaults reconnect through a Syncthing-style sync with no silent loss", async () => {
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "omarkie-folder-sync-")));
  const laptopRoot = path.join(scratch, "laptop", "Vault"), deskRoot = path.join(scratch, "desk", "Vault");
  await mkdir(laptopRoot, { recursive: true }); await mkdir(deskRoot, { recursive: true });
  const seed = {
    "shared.md": "# Shared\n\nStart.\n",
    "notes/plan.md": "# Plan\n\n- step one\n",
    "notes/old-name.md": "# Rename me\n\nKeeps its text.\n",
    "notes/delete-me.md": "# Short lived\n\nStill wanted on one side.\n",
    "views/tasks.base": "views:\n  - type: table\n    name: Open\n",
    "boards/map.canvas": JSON.stringify({ nodes: [{ id: "a", type: "text", text: "Map", x: 0, y: 0, width: 200, height: 60 }], edges: [] }),
    "photos/cat.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 64 }, (_, index) => index)]),
  };
  for (const [relative, content] of Object.entries(seed)) { await mkdir(path.dirname(path.join(laptopRoot, relative)), { recursive: true }); await writeFile(path.join(laptopRoot, relative), content); }
  const sync = new SyncthingPair([laptopRoot, deskRoot]);
  await sync.start();
  const laptop = await client(laptopRoot, path.join(scratch, "laptop-data"), path.join(scratch, "laptop-trash"));
  const desk = await client(deskRoot, path.join(scratch, "desk-data"), path.join(scratch, "desk-trash"));

  const laptopShared = await laptop.open("shared.md"), deskShared = await desk.open("shared.md");
  await laptop.store.save(laptopShared.id, "# Shared\n\nStart.\n\nLaptop paragraph.\n");
  await desk.store.save(deskShared.id, "# Shared\n\nStart.\n\nDesk paragraph.\n");
  const lost = new Date(Date.now() - 120_000); await utimes(path.join(laptopRoot, "shared.md"), lost, lost); // Syncthing makes the laptop lose by mtime.

  const deskPlan = await desk.open("notes/plan.md");
  const deskDraft = "# Plan\n\n- step one\n- desk draft, never saved\n";
  await laptop.store.save((await laptop.open("notes/plan.md")).id, "# Plan\n\n- step one\n- laptop step\n");

  const deskOld = await desk.open("notes/old-name.md");
  const renamed = await laptop.workspace.execute({ action: "rename", path: path.join(laptopRoot, "notes/old-name.md"), name: "new-name.md" }, laptop.store);
  assert.equal(renamed.toPath, path.join(laptopRoot, "notes/new-name.md"));

  await writeFile(path.join(deskRoot, "views/tasks.base"), "views:\n  - type: table\n    name: Open\n  - type: cards\n    name: Board\n");
  await mkdir(path.join(laptopRoot, "archive")); await rename(path.join(laptopRoot, "boards/map.canvas"), path.join(laptopRoot, "archive/map.canvas"));
  await copyFile(path.join(deskRoot, "photos/cat.png"), path.join(deskRoot, "photos/cat copy.png"));

  const deskDoomed = await desk.open("notes/delete-me.md");
  await laptop.store.scan(laptopRoot);
  await laptop.workspace.execute({ action: "trash", path: path.join(laptopRoot, "notes/delete-me.md") }, laptop.store, laptop.trash);

  // Reconnect.
  const first = await sync.sync();
  assert.deepEqual(first.conflicts.map(item => [item.relative, item.loser]), [["shared.md", "LAPTOPA"]]);

  // Syncthing kept both shared.md versions; the laptop sees the desk text and the copy beside it.
  assert.match(await readFile(path.join(laptopRoot, "shared.md"), "utf8"), /Desk paragraph/);
  const syncCopy = path.join(laptopRoot, first.conflicts[0].copy);
  assert.match(await readFile(syncCopy, "utf8"), /Laptop paragraph/);
  const sharedChange = await laptop.store.check(laptopShared.id);
  assert.match(sharedChange.content, /Desk paragraph/);
  laptop.store.acceptDisk(laptopShared.id, sharedChange.content, sharedChange.diskHash, sharedChange.bom, sharedChange.encoding);
  const scanned = (await laptop.store.scan(laptopRoot)).files;
  const [copy] = copiesOf(path.join(laptopRoot, "shared.md"), scanned);
  assert.match((await laptop.store.peek(copy.token)).content, /Laptop paragraph/);
  // The laptop decides by reading, not by clock: its own older text goes back in place.
  const used = await laptop.store.resolve(laptopShared.id, { action: "use-copy", token: copy.token }, laptop.trash, moveExclusive);
  assert.match(used.record.content, /Laptop paragraph/);
  await assert.rejects(stat(syncCopy), { code: "ENOENT" });

  // The desk followed the rename instead of reporting a missing file.
  const followed = await desk.store.check(deskOld.id);
  assert.deepEqual(followed, { moved: true, path: path.join(deskRoot, "notes/new-name.md"), name: "new-name.md" });
  assert.equal(desk.store.require(deskOld.id).path, path.join(deskRoot, "notes/new-name.md"));
  assert.equal(await desk.store.check(deskOld.id), null);

  // The desk's dirty plan draft meets the laptop's saved step: compare, keep the draft, keep the disk as a copy.
  const planChange = await desk.store.check(deskPlan.id);
  assert.match(planChange.content, /laptop step/);
  await assert.rejects(desk.store.resolve(deskPlan.id, { action: "keep-draft", text: deskDraft, diskHash: "stale" }), { code: "EXTERNAL_CHANGE" });
  const kept = await desk.store.resolve(deskPlan.id, { action: "keep-draft", text: deskDraft, diskHash: planChange.diskHash });
  assert.equal(await readFile(path.join(deskRoot, "notes/plan.md"), "utf8"), deskDraft);
  assert.match(path.basename(kept.copy), /^plan\.omarkie-conflict-\d{8}-\d{6}-disk\.md$/);
  assert.match(await readFile(kept.copy, "utf8"), /laptop step/);
  assert.equal(await desk.store.check(deskPlan.id), null);

  // The laptop trashed delete-me.md; the desk still had it open. Recoverable on both sides, restorable from the open text.
  const missing = await desk.store.check(deskDoomed.id);
  assert.equal(missing.missing, true);
  assert.match(await texts(path.join(deskRoot, ".stversions")), /Still wanted on one side/);
  assert.match(await texts(path.join(scratch, "laptop-trash")), /Still wanted on one side/);
  await desk.store.resolve(deskDoomed.id, { action: "restore", text: deskDoomed.content });
  await assert.rejects(desk.store.resolve(deskDoomed.id, { action: "restore", text: deskDoomed.content }), { code: "EXTERNAL_CHANGE" });

  const second = await sync.sync();
  assert.deepEqual(second.conflicts, []);
  const third = await sync.sync();
  assert.deepEqual(third.conflicts, []);

  // Both folders hold the same bytes: hashes converge.
  const left = await snapshot(laptopRoot), right = await snapshot(deskRoot);
  assert.deepEqual([...left].map(([relative, entry]) => [relative, entry.hash]).sort(), [...right].map(([relative, entry]) => [relative, entry.hash]).sort());
  assert.equal(left.get("notes/new-name.md").hash, sha(Buffer.from(seed["notes/old-name.md"])));
  assert.ok(!left.has("notes/old-name.md"));
  assert.match(left.get("views/tasks.base").bytes.toString(), /type: cards/);
  assert.ok(left.has("archive/map.canvas") && !left.has("boards/map.canvas"));
  assert.equal(left.get("photos/cat copy.png").hash, sha(seed["photos/cat.png"]));
  assert.equal(left.get("notes/delete-me.md").bytes.toString(), seed["notes/delete-me.md"]);
  assert.match(left.get("shared.md").bytes.toString(), /Laptop paragraph/);

  // Every version anyone wrote still exists in a vault, a version folder or a Trash.
  const everything = await texts(laptopRoot, deskRoot, path.join(laptopRoot, ".stversions"), path.join(deskRoot, ".stversions"), path.join(scratch, "laptop-trash"), path.join(scratch, "desk-trash"));
  for (const text of ["Laptop paragraph", "Desk paragraph", "laptop step", "desk draft, never saved", "type: table\n    name: Open\n", "Keeps its text", "Still wanted on one side"])
    assert.ok(everything.includes(text), `lost: ${text}`);
});

test("a moved note is not followed when two files share its bytes", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "omarkie-follow-")));
  await writeFile(path.join(root, "a.md"), "same\n");
  const store = new DocumentStore(path.join(root, ".data"));
  await store.scan(root);
  const record = await store.open(path.join(root, "a.md"));
  await mkdir(path.join(root, "x")); await mkdir(path.join(root, "y"));
  await rename(path.join(root, "a.md"), path.join(root, "x", "a.md"));
  await writeFile(path.join(root, "y", "a.md"), "same\n");
  const change = await store.check(record.id);
  assert.equal(change.missing, true);
  assert.equal(store.require(record.id).path, path.join(root, "a.md"));
});
