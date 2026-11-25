import assert from "node:assert/strict";

export function assertFrameCadence(gaps, gesture) {
  const sorted = gaps.sort((a, b) => a - b);
  const frames = sorted.length, p95 = sorted[Math.ceil(frames * 0.95) - 1], max = sorted.at(-1);
  const metrics = `rAF p95 ${p95?.toFixed(1)} ms, max ${max?.toFixed(1)} ms over ${frames} frames`;
  console.log(`${gesture}: ${metrics}`);
  if (process.platform === "linux" && !process.env.OMARKIE_TEST_DISPLAY) {
    console.log("Frame cadence requires an isolated display; the headless backend throttles animation frames.");
    return;
  }
  assert.ok(frames >= 60, `${gesture}: only ${frames} frames in 1.3 s`);
  // >25 ms (1.5 intervals at 60 Hz) misses a refresh. p95 allows sub-ms timestamp jitter.
  assert.ok(max <= 25 && p95 <= 17.5, `${gesture}: ${metrics}; need zero gaps above 25 ms and p95 <=17.5 ms`);
}
