// A folder-sync app copies `.omarkie/writer.lock` from the other computer, and that lock names a
// process writing a different disk. Honouring it makes this device silently read-only; only a
// mount two computers can open at once (polling is required there) makes a foreign lock live.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GlassService } from "../electron/glass-service.mjs";

async function vault() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-lock-"));
  const folder = path.join(root, "vault"), appData = path.join(root, "app-data");
  await mkdir(folder, { recursive: true });
  await mkdir(appData, { recursive: true });
  await writeFile(path.join(folder, "note.md"), "# Note\n\nText.\n");
  return { folder, appData };
}

const foreignLock = host => JSON.stringify({ version: 1, host, pid: 1, token: "foreign-token", started: Date.now() });

async function plant(folder, host) {
  await mkdir(path.join(folder, ".omarkie"), { recursive: true });
  await writeFile(path.join(folder, ".omarkie", "writer.lock"), foreignLock(host));
}

test("a lock a folder-sync app copied from another machine does not make this device read-only", async () => {
  const { folder, appData } = await vault();
  await plant(folder, "laptop-a");
  const service = await new GlassService({ root: folder, appData, device: "dev-b", host: "laptop-b" }).open();
  try {
    await service.initialize();
    assert.equal(service.readOnly, false, "a local disk has one writer at a time, whatever the copied lock says");
    const added = await service.request({ action: "add", note: "note.md", magnet: "m-b", text: "from b" });
    assert.equal(added.saved, true);
    assert.equal(JSON.parse(await readFile(path.join(folder, ".omarkie", "writer.lock"), "utf8")).host, "laptop-b", "this machine now owns it");
  } finally { await service.close(); }
});

test("on a shared mount the other computer's claim is still honoured", async () => {
  const { folder, appData } = await vault();
  await plant(folder, "laptop-a");
  const previous = process.env.OMARKIE_GLASS_POLL;
  process.env.OMARKIE_GLASS_POLL = "1"; // the network/FUSE mount the lock really guards
  const service = await new GlassService({ root: folder, appData, device: "dev-b", host: "laptop-b" }).open();
  try {
    await service.initialize();
    assert.equal(service.readOnly, true);
    assert.equal(service.readOnlyReason, "another computer owns this vault");
    await assert.rejects(service.request({ action: "add", note: "note.md", magnet: "m-b", text: "from b" }), { code: "GLASS_READ_ONLY" });
  } finally {
    if (previous === undefined) delete process.env.OMARKIE_GLASS_POLL; else process.env.OMARKIE_GLASS_POLL = previous;
    await service.close();
  }
});
