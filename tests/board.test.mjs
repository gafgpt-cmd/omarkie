import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GlassService } from "../electron/glass-service.mjs";

test("a board is one Media-layer magnet whose Excalidraw scene lives under .omarkie/assets/boards", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-board-"));
  const appData = path.join(root, "appdata"), vault = path.join(root, "vault");
  await mkdir(vault);
  await writeFile(path.join(vault, "note.md"), "# Board\n\nA paragraph.\n");
  const service = await new GlassService({ root: vault, appData }).open({ passive: false });
  try {
    const added = await service.request({ action: "board", mode: "add", note: "note.md", magnet: "board1", name: "Pathway" });
    assert.equal(added.magnet.fields.kind, "board");
    assert.equal(added.magnet.fields.layer, "media");
    assert.equal(added.magnet.fields.name, "Pathway");
    assert.equal(added.asset, ".omarkie/assets/boards/board1.excalidraw.json");
    const blank = JSON.parse(await readFile(path.join(vault, added.asset), "utf8"));
    assert.equal(blank.type, "excalidraw");
    assert.deepEqual(blank.elements, []);

    const scene = { type: "excalidraw", version: 2, source: "test", elements: [{ id: "rect", type: "rectangle", x: 1, y: 2 }],
      appState: { gridSize: 20, collaborators: new Map(), selectedElementIds: { rect: true } }, files: { ignored: { dataURL: "https://example.com/x.png" } } };
    const saved = await service.request({ action: "board", mode: "save", note: "note.md", magnet: "board1", scene });
    assert.ok(saved.bytes > 0);
    const disk = JSON.parse(await readFile(path.join(vault, saved.asset), "utf8"));
    assert.equal(disk.elements[0].id, "rect");
    assert.equal(disk.appState.gridSize, 20);
    assert.equal(disk.appState.collaborators, undefined);
    assert.deepEqual(disk.files, {}, "non-data URLs never enter the vault");

    const loaded = await service.request({ action: "board", mode: "load", note: "note.md", magnet: "board1" });
    assert.equal(loaded.scene.elements[0].id, "rect");
    assert.equal(loaded.corrupt, false);
  } finally {
    await service.close();
  }
});
