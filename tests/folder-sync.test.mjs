import assert from "node:assert/strict";
import { test } from "node:test";
import { detectFolderSync } from "../electron/folder-sync.mjs";

test("a vault names the desktop app that syncs its parent folder", async () => {
  const drive = ["/home/me/Google Drive/My Drive/Vault", "/home/me/Google Drive/My Drive", "/home/me/Google Drive"];
  assert.equal((await detectFolderSync(drive[0], { ancestors: drive })).app, "Google Drive");

  const syncthing = ["/home/me/Sync/Vault", "/home/me/Sync"];
  const found = await detectFolderSync(syncthing[0], {
    ancestors: syncthing,
    exists: async target => /[\\/]\.stfolder$/.test(target),
  });
  assert.equal(found.app, "Syncthing");
  assert.equal(found.source, "syncthing");

  const plain = ["/home/me/Sync/Vault", "/home/me/Sync"];
  assert.equal(await detectFolderSync(plain[0], { ancestors: plain, exists: async () => false }), null);
});
