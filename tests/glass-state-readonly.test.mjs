// Glass switches live with the glass store. A read-only vault keeps that store in app data, so the
// toggles must be saved there instead of throwing on `<vault>/.omarkie` and reverting in the UI.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GlassService } from "../electron/glass-service.mjs";
import { readGlass, readGlassSettings, readShared, writeGlass, writeShared } from "../electron/glass-state.mjs";

async function vault() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-state-"));
  const folder = path.join(root, "vault"), appData = path.join(root, "app-data");
  await mkdir(folder, { recursive: true });
  await mkdir(appData, { recursive: true });
  await writeFile(path.join(folder, "note.md"), "# Note\n\nText.\n");
  return { folder, appData };
}

test("a read-only vault keeps its glass switches in app data", async () => {
  const { folder, appData } = await vault();
  // The app resolves a read-only vault to the app data store before any toggle is pressed.
  await chmod(folder, 0o500);
  let service;
  try {
    service = await new GlassService({ root: folder, appData, device: "state-device" }).open();
    await service.initialize();
    assert.equal(service.mode, "outside", "the read-only vault runs on the app data store");

    await writeGlass(folder, true, { appData });
    await writeShared(folder, true, { appData });
    assert.equal(await readGlass(folder, { appData }), true);
    assert.equal(await readShared(folder, { appData }), true);
    assert.deepEqual(await readGlassSettings(folder, { appData }),
      { version: 1, visible: true, neverOnline: false, shared: true });

    const settings = JSON.parse(await readFile(path.join(appData, "glass-vaults", service.vaultId, "settings.json"), "utf8"));
    assert.equal(settings.mode, "outside");
    const saved = JSON.parse(await readFile(path.join(appData, "glass-vaults", service.vaultId, "glass", "vault.json"), "utf8"));
    assert.equal(saved.visible, true, "the switch is stored beside the store, not in the read-only vault");
  } finally {
    await chmod(folder, 0o700);
    await service?.close().catch(() => {});
  }
});

test("a writable vault keeps its switches inside the vault, as before", async () => {
  const { folder, appData } = await vault();
  await writeShared(folder, true, { appData });
  assert.equal(await readShared(folder, { appData }), true);
  const saved = JSON.parse(await readFile(path.join(folder, ".omarkie", "glass", "vault.json"), "utf8"));
  assert.equal(saved.shared, true);
});

test("a toggle that cannot be saved anywhere names the refusal instead of a bare EACCES", async () => {
  const { folder } = await vault();
  await chmod(folder, 0o500);
  try {
    await assert.rejects(writeShared(folder, true), error => error.code === "GLASS_STATE_READ_ONLY");
    assert.equal(await readShared(folder), false);
  } finally { await chmod(folder, 0o700); }
});
