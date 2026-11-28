import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { canvasRequest } from "../electron/canvas-store.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
async function vault() {
  const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-canvas-"));
  const root = path.join(home, "vault");
  await mkdir(path.join(root, "Boards"), { recursive: true });
  await mkdir(path.join(root, ".obsidian"));
  await writeFile(path.join(root, "Boards", "Map.canvas"), '{"nodes":[],"edges":[]}');
  await writeFile(path.join(root, ".obsidian", "Hidden.canvas"), "{}");
  await writeFile(path.join(root, "Plexus.md"), "# Plexus\n\nSynthetic.\n");
  await writeFile(path.join(home, "Outside.canvas"), "{}");
  await writeFile(path.join(home, "Outside.md"), "# Outside\n");
  return { home, root };
}

test("boards list, read and save atomically against a base revision", async () => {
  const { root } = await vault();
  assert.deepEqual((await canvasRequest(root, { action: "list" })).files.map(file => file.file), ["Boards/Map.canvas"]);
  const board = await canvasRequest(root, { action: "read", file: "Boards/Map.canvas" });
  assert.equal(board.hash, hash('{"nodes":[],"edges":[]}'));
  const next = '{\n\t"nodes": [],\n\t"edges": [],\n\t"x": 1\n}';
  const saved = await canvasRequest(root, { action: "save", file: board.file, text: next, base: board.hash });
  assert.equal(saved.hash, hash(next));
  assert.equal(await readFile(path.join(root, "Boards", "Map.canvas"), "utf8"), next);
  await assert.rejects(canvasRequest(root, { action: "save", file: board.file, text: next, base: board.hash }), { code: "EXTERNAL_CHANGE" }, "stale base");
  await assert.rejects(canvasRequest(root, { action: "save", file: board.file, text: "[1]", base: saved.hash }), { code: "CANVAS_INVALID" });
  await assert.rejects(canvasRequest(root, { action: "save", file: "Boards/New.canvas", text: "{}", base: saved.hash }), { code: "EXTERNAL_CHANGE" }, "missing file is not the base");
  await assert.rejects(canvasRequest(root, { action: "save", file: "Boards/Map.canvas", text: "{}", base: null }), { code: "EXTERNAL_CHANGE" }, "a new board never overwrites one on disk");
});

test("an external edit while the board is dirty is refused, not overwritten", async () => {
  const { root } = await vault();
  const board = await canvasRequest(root, { action: "read", file: "Boards/Map.canvas" });
  await writeFile(path.join(root, "Boards", "Map.canvas"), '{"nodes":[],"edges":[],"other":"app"}');
  await assert.rejects(canvasRequest(root, { action: "save", file: board.file, text: '{"nodes":[]}', base: board.hash }), { code: "EXTERNAL_CHANGE" });
  assert.match(await readFile(path.join(root, "Boards", "Map.canvas"), "utf8"), /"other":"app"/);
});

test("paths stay inside the vault: no traversal, absolute, hidden, symlinked or non-board files", async () => {
  const { home, root } = await vault();
  await symlink(path.join(home, "Outside.canvas"), path.join(root, "Link.canvas"));
  await symlink(home, path.join(root, "Escape"));
  for (const file of ["../Outside.canvas", path.join(home, "Outside.canvas"), ".obsidian/Hidden.canvas", "Link.canvas", "Escape/Outside.canvas", "Plexus.md", "Boards//Map.canvas", "", 7])
    await assert.rejects(canvasRequest(root, { action: "read", file }), undefined, String(file));
  await assert.rejects(canvasRequest(root, { action: "save", file: "Escape/New.canvas", text: "{}", base: null }));
  await assert.rejects(canvasRequest(root, { action: "note", file: "../Outside.md" }));
  await assert.rejects(canvasRequest(root, { action: "note", file: "Boards/Map.canvas" }));
  await assert.rejects(canvasRequest(null, { action: "list" }), { code: "NO_FOLDER" });
  await assert.rejects(canvasRequest(root, { action: "wipe" }));
  assert.ok(!(await canvasRequest(root, { action: "list" })).files.some(file => file.file.includes("Link")));
});

test("new boards get unique names; notes for file cards read or report missing", async () => {
  const { root } = await vault();
  const first = await canvasRequest(root, { action: "create", folder: "Boards", name: "Map" });
  assert.equal(first.file, "Boards/Map 2.canvas");
  assert.deepEqual(JSON.parse(first.text), { nodes: [], edges: [] });
  const unnamed = await canvasRequest(root, { action: "create", name: "../../x:y" });
  assert.equal(unnamed.file, "x y.canvas");
  assert.equal((await canvasRequest(root, { action: "create" })).file, "Untitled board.canvas");
  assert.equal((await canvasRequest(root, { action: "note", file: "Plexus.md" })).text, "# Plexus\n\nSynthetic.\n");
  assert.deepEqual(await canvasRequest(root, { action: "note", file: "Gone.md" }), { file: "Gone.md", missing: true });
});
