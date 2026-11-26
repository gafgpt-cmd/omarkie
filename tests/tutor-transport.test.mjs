import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { endpoint, listenBridge, requestBridge } from "../electron/tutor-transport.mjs";

const roots = [];
after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
async function area() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-bridge-"));
  roots.push(root);
  return root;
}

// Answers the caller's requested size so the frame limit is what is under test, not the Glass store.
const broker = () => ({
  client(request, send) { send({ ok: true, blob: "x".repeat(Number(request.size ?? 0)) }); },
  stopWait() {}, bind() { return {}; }, unbind() { return 0; },
});

async function bridged(root, run) {
  const close = await listenBridge(root, broker());
  try { return await run(); }
  finally { await close(); await rm(endpoint(root).directory, { recursive: true, force: true }).catch(() => {}); }
}

test("a large Glass answer crosses the bridge instead of reading as a dead bridge", async () => {
  const root = await area();
  const state = await bridged(root, () => requestBridge(root, { size: 1_500_000 }, 10_000));
  assert.equal(state.ok, true);
  assert.equal(state.blob.length, 1_500_000);
});

test("an answer past the frame limit names the size, never the bridge", async () => {
  const root = await area();
  await assert.rejects(bridged(root, () => requestBridge(root, { size: 3_000_000 }, 10_000)), error => {
    assert.doesNotMatch(error.message, /unavailable/);
    assert.match(error.message, /larger than 2048 KB/);
    return true;
  });
});
