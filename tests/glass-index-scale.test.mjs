import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GlassService } from "../electron/glass-service.mjs";
import { GlassSync } from "../electron/glass-sync.mjs";

// The 50,000-note vault: indexing runs in a worker and in async reads, so the main thread keeps ticking.
test("50,000 notes index without stalling the main thread", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omarkie-scale-"));
  const vault = path.join(root, "vault"), data = path.join(root, "app-data"), cache = path.join(root, "cache");
  const service = new GlassService({ root: vault, appData: data, device: "scale-device" });
  let sync;
  try {
    await mkdir(vault, { recursive: true });
    for (let chunk = 0; chunk < 50_000; chunk += 500)
      await Promise.all(Array.from({ length: 500 }, (_, index) => {
        const number = chunk + index;
        return writeFile(path.join(vault, `Note ${number}.md`), `# Note ${number}\n\nUnique body ${number}.\n`);
      }));

    await service.open();
    sync = new GlassSync({ service, cacheDir: cache, appData: data, watcherFactory: async () => ({ close() {} }) });
    let gap = 0, last = performance.now(), ticks = 0;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      gap = Math.max(gap, now - last);
      last = now;
      ticks += 1;
    }, 25);
    const started = Date.now();
    await sync.start();
    await sync.whenIdle();
    clearInterval(heartbeat);
    const elapsed = Date.now() - started;

    const map = await sync.map();
    assert.equal(map.files, 50_000);
    assert.equal(map.kinds.note, 50_000);
    assert.equal(sync.status().scanComplete, true);
    assert.ok(ticks > 10, `heartbeat ticked ${ticks} times`);
    assert.ok(gap < 400, `main thread stalled ${gap.toFixed(0)} ms while indexing ${elapsed} ms`);
    assert.equal((await sync.find({ query: "unique body 49999" })).count, 1);
  } finally {
    await sync?.close().catch(() => {});
    await service.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
