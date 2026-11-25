import assert from "node:assert/strict";

// CI and this host draw through a software compositor (Xvfb, headless): it drops frames for reasons
// outside the app. Smoothness is asserted on our own work; display cadence only on a real compositor,
// with OMARKIE_REAL_COMPOSITOR=1 (documented in tests/perf-desktop.mjs).
export const realCompositor = () => process.env.OMARKIE_REAL_COMPOSITOR === "1";

export function assertFrameCadence(gaps, gesture) {
  const sorted = [...gaps].sort((a, b) => a - b);
  const frames = sorted.length, p95 = sorted[Math.ceil(frames * 0.95) - 1], max = sorted.at(-1);
  const metrics = `rAF p95 ${p95?.toFixed(1)} ms, max ${max?.toFixed(1)} ms over ${frames} frames`;
  console.log(`${gesture}: ${metrics}`);
  if (!realCompositor()) {
    console.log(`${gesture}: display cadence logged only; run with OMARKIE_REAL_COMPOSITOR=1 on a real compositor to assert it.`);
    return;
  }
  if (process.platform === "linux" && !process.env.OMARKIE_TEST_DISPLAY) {
    console.log("Frame cadence requires an isolated display; the headless backend throttles animation frames.");
    return;
  }
  assert.ok(frames >= 60, `${gesture}: only ${frames} frames in 1.3 s`);
  // >25 ms (1.5 intervals at 60 Hz) misses a refresh. p95 allows sub-ms timestamp jitter.
  assert.ok(max <= 25 && p95 <= 17.5, `${gesture}: ${metrics}; need zero gaps above 25 ms and p95 <=17.5 ms`);
}

// What the page itself spends: the app stamps each drag frame's own handler work on data-*-ms, and
// long tasks name any stall that could swallow a frame.
export async function watchWork(page) {
  await page.evaluate(() => {
    window.__workEvents = [];
    window.__workLong = [];
    window.__eventObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__workEvents.push(entry.processingEnd - entry.processingStart);
    });
    window.__eventObserver.observe({ type: "event", durationThreshold: 0 });
    window.__workLongStart = performance.now();
    window.__workObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__workLong.push(entry.duration);
      window.__workLongDetail = [...(window.__workLongDetail ?? []), ...list.getEntries().map(entry => ({ duration: Math.round(entry.duration), at: Math.round(entry.startTime - (window.__workLongStart ?? 0)) }))];
    });
    window.__workObserver.observe({ entryTypes: ["longtask"] });
  });
}

export async function readWork(page) {
  return page.evaluate(() => {
    window.__eventObserver?.disconnect();
    window.__workObserver?.disconnect();
    // Live entries plus the browser's recent buffer: a long gesture can outrun the observer queue.
    const buffered = (performance.getEntriesByType("event") ?? []).map(entry => entry.processingEnd - entry.processingStart);
    return { events: [...(window.__workEvents ?? []), ...buffered], longTasks: window.__workLong ?? [], detail: window.__workLongDetail ?? [] };
  });
}

export function assertWorkBudget({ work, longTasks = [], gesture, p95 = 8, longest = 50, minimum = 8 }) {
  const sorted = [...work].sort((a, b) => a - b);
  const count = sorted.length, p = sorted[Math.max(0, Math.ceil(count * 0.95) - 1)] ?? 0, max = sorted.at(-1) ?? 0;
  const longestTask = longTasks.length ? Math.max(...longTasks) : 0;
  console.log(`${gesture}: handler p95 ${p.toFixed(1)} ms, max ${max.toFixed(1)} ms over ${count} events; longest task ${longestTask.toFixed(0)} ms`);
  assert.ok(count >= minimum, `${gesture}: only ${count} timed pointer events`);
  assert.ok(p <= p95, `${gesture}: handler p95 ${p.toFixed(1)} ms must stay under ${p95} ms`);
  assert.ok(longestTask <= longest, `${gesture}: a ${longestTask.toFixed(0)} ms long task blocks the page (budget ${longest} ms)`);
}
