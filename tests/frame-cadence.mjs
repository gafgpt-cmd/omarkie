import assert from "node:assert/strict";

// CI and this host draw through a software compositor (Xvfb, headless): it drops frames for reasons
// outside the app. Smoothness is asserted on our own work; display cadence only on a real compositor,
// with OMARKIE_REAL_COMPOSITOR=1 (documented in tests/perf-desktop.mjs).
export const realCompositor = () => process.env.OMARKIE_REAL_COMPOSITOR === "1";

// Budgets relax only against a same-run baseline, and never on a stable runner: GitHub Actions
// sets GITHUB_ACTIONS, so the unscaled numbers are what CI asserts. OMARKIE_STRICT_BUDGETS=1
// reproduces that run anywhere.
export const stableHost = () => process.env.GITHUB_ACTIONS === "true" || process.env.OMARKIE_STRICT_BUDGETS === "1";

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
// renderer main-thread tasks name any stall that could swallow a frame. Tasks are gated on thread CPU
// time (trace `tdur`): wall time on a loaded host also counts the time other processes held the core.
const traces = new WeakMap();

export async function watchWork(page) {
  await page.evaluate(() => {
    window.__workEvents = [];
    window.__eventObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__workEvents.push(entry.processingEnd - entry.processingStart);
    });
    window.__eventObserver.observe({ type: "event", durationThreshold: 0 });
  });
  const cdp = await page.context().newCDPSession(page), events = [];
  cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  // RunTask with thread time is all the gate needs; the timeline's per-call events would add their own CPU.
  await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["disabled-by-default-devtools.timeline"] } });
  traces.set(page, { cdp, events });
}

async function mainThreadTasks(page) {
  const { cdp, events } = traces.get(page);
  traces.delete(page);
  const done = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  await done;
  await cdp.detach();
  const main = new Set(events.filter(event => event.name === "thread_name" && event.args?.name === "CrRendererMain").map(event => `${event.pid}:${event.tid}`));
  const tasks = events.filter(event => event.name === "RunTask" && event.ph === "X" && main.has(`${event.pid}:${event.tid}`));
  assert.ok(tasks.length > 0 && tasks.every(task => Number.isFinite(task.tdur)), "the trace has renderer tasks with thread time");
  return tasks.map(task => ({ cpu: task.tdur / 1000, wall: task.dur / 1000 }));
}

export async function readWork(page) {
  const events = await page.evaluate(() => {
    window.__eventObserver?.disconnect();
    // Live entries plus the browser's recent buffer: a long gesture can outrun the observer queue.
    const buffered = (performance.getEntriesByType("event") ?? []).map(entry => entry.processingEnd - entry.processingStart);
    return [...(window.__workEvents ?? []), ...buffered];
  });
  return { events, longTasks: await mainThreadTasks(page) };
}

export function assertWorkBudget({ work, longTasks = [], gesture, p95 = 8, longest = 50, minimum = 8 }) {
  const sorted = [...work].sort((a, b) => a - b);
  const count = sorted.length, p = sorted[Math.max(0, Math.ceil(count * 0.95) - 1)] ?? 0, max = sorted.at(-1) ?? 0;
  const slowest = longTasks.reduce((worst, task) => task.cpu > worst.cpu ? task : worst, { cpu: 0, wall: 0 });
  console.log(`${gesture}: handler p95 ${p.toFixed(1)} ms, max ${max.toFixed(1)} ms over ${count} events; slowest task ${slowest.cpu.toFixed(0)} ms CPU (${slowest.wall.toFixed(0)} ms wall) of ${longTasks.length}`);
  assert.ok(count >= minimum, `${gesture}: only ${count} timed pointer events`);
  assert.ok(p <= p95, `${gesture}: handler p95 ${p.toFixed(1)} ms must stay under ${p95} ms`);
  assert.ok(slowest.cpu <= longest, `${gesture}: a ${slowest.cpu.toFixed(0)} ms CPU task blocks the page (budget ${longest} ms)`);
}
