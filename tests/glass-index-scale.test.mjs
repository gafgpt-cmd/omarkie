import assert from "node:assert/strict";
import { test } from "node:test";
import { runGlassIndexScale } from "./glass-index-fixture.mjs";

test("50,000 notes index while the main thread keeps processing timers", { timeout: 300_000 }, async () => {
  const { ticks } = await runGlassIndexScale();
  assert.ok(ticks > 0, "the heartbeat ran while indexing");
});
