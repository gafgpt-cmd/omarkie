// A sync client writes `.omarkie/glass/*.jsonl` behind the app's back and no note watcher sees it.
// Coming back to the window must catch the index up, or a magnet added on the other computer is
// never findable until the app restarts.
import assert from "node:assert/strict";
import { appendFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GlassService } from "../electron/glass-service.mjs";
import { GlassSync } from "../electron/glass-sync.mjs";

const quietWatcher = async () => ({ close() {} });

async function openVault() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-focus-"));
  const folder = path.join(root, "vault"), data = path.join(root, "app-data"), cache = path.join(root, "cache");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(folder, { recursive: true });
  await mkdir(data, { recursive: true });
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(folder, "map.md"), "# Map\n\nContour lines close together mean a steep slope.\n");
  const service = await new GlassService({ root: folder, appData: data, device: "this-device" }).open();
  const sync = new GlassSync({ service, cacheDir: cache, appData: data, watcherFactory: quietWatcher });
  await sync.start();
  await sync.whenIdle();
  return { root, folder, service, sync };
}

test("a magnet another computer synced in becomes findable when the window regains focus", async () => {
  const { folder, service, sync } = await openVault();
  try {
    const added = await service.request({ action: "add", note: "map.md", magnet: "m-local", text: "local pin" });
    await sync.whenIdle();
    const notes = await service.request({ action: "list", note: "map.md" });
    assert.equal(added.id, notes.id);
    // The other device appends its own op while this window is in the background.
    const line = JSON.stringify({ op: "set", magnetId: "m-remote", field: "text", value: "interleaving", hlc: "ffffffff-0", device: "other-device" });
    await appendFile(path.join(folder, ".omarkie", ...added.journal.split("/")), `${line}\n`);
    assert.equal((await sync.find({ query: "interleaving" })).count, 0, "the index has not seen it yet");

    await sync.focus();
    const found = await sync.find({ query: "interleaving" });
    assert.equal(found.count, 1, "focus republishes the magnets a sync client dropped in");
    assert.equal(found.results[0].kind, "magnet");
    assert.equal(found.results[0].id, "m-remote");
  } finally { await sync.close(); await service.close(); }
});
