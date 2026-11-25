import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as launch, expect } from "playwright/test";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-g19-"));
const vault = path.join(home, "vault"), doc = "textbook.md", file = path.join(vault, doc);
const pages = 1_000, perPage = 10;
const paragraphs = Array.from({ length: pages * perPage }, (_, index) => {
  const section = Math.floor(index / perPage) + 1;
  return { line: index * 2 + 1, heading: `Chapter ${section}`, text: `Page ${section} paragraph ${index + 1}. Retrieval practice, spaced review and interleaved recall keep the useful detail available.` };
});
const note = paragraphs.map((paragraph, index) => `${index % perPage === 0 ? `# ${paragraph.heading}\n\n` : ""}${paragraph.text}\n`).join("\n");
await mkdir(vault);
await writeFile(file, note, "utf8");
const session = { version: 1, activeId: "fixture", folder: vault, documents: [{ id: "fixture", path: file, name: doc,
  content: note, savedContent: note, diskHash: "0".repeat(64), lineEnding: "\n" }] };
await writeFile(path.join(home, "session.json"), JSON.stringify(session), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const evidence = process.env.OMARKIE_EVIDENCE;

async function open() {
  const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
  const page = await app.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("omarkie-glass-test", "1");
    localStorage.setItem("omarkie-theme", "light");
  });
  await page.reload();
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  await expect(rich.getByRole("heading", { name: "Chapter 1", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0, undefined, { timeout: 60_000 });
  // Glass draws on the reading surface: turn on Learning mode, then the persisted glass state.
  await page.getByRole("button", { name: "Display", exact: true }).click();
  const learning = page.getByRole("menuitemcheckbox", { name: "Learning mode", exact: true });
  if ((await learning.getAttribute("aria-checked")) !== "true") await learning.click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.desktop.glassState({ action: "write", visible: true }));
  await page.reload();
  await expect(rich.getByRole("heading", { name: "Chapter 1", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0, undefined, { timeout: 60_000 });
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "light"));
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on", { timeout: 20_000 });
  return { app, page, rich, errors };
}

async function metrics(page) {
  return page.evaluate(() => {
    const at = name => performance.getEntriesByName(name)[0]?.startTime ?? 0;
    const measures = performance.getEntriesByType("measure").filter(entry => entry.name === "omarkie:glass-measure");
    const long = performance.getEntriesByType("measure").filter(entry => entry.name === "omarkie:glass-longtask").map(entry => entry.duration);
    const sorted = measures.map(entry => entry.duration).sort((left, right) => left - right);
    return {
      openMs: Math.max(0, at("omarkie:glass-mounted") - at("omarkie:first-document-painted")),
      handlerMs: sorted[0] ?? 0,
      handlerP95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? sorted.at(-1) ?? 0,
      handlers: sorted.length,
      longTasks: long.length,
      longTaskMaxMs: Math.max(0, ...long),
      mounted: Number(document.querySelector(".glass-layer")?.getAttribute("data-mounted") ?? 0),
      phases: Object.fromEntries(["blocks", "indexed", "anchored", "placed", "measure:end"].map(name => [name, Math.round(at(`omarkie:glass-${name}`))])),
    };
  });
}

async function seed(page, count, from = 0) {
  const replies = await page.evaluate(async ({ start, total, paragraphs }) => {
    const out = [];
    for (let index = start; index < start + total; index += 1) {
      const paragraph = paragraphs[Math.round(((index - start) / Math.max(1, total - 1)) * (paragraphs.length - 1))] ?? paragraphs.at(-1);
      out.push(await window.desktop.glass({ note: "textbook.md", action: "add", magnet: `g19-${index}`,
        fields: { kind: "sticky", text: `Magnet ${index + 1}`, color: "yellow", x: 12 + (index % 5) * 20, y: 20 + (index % 7) * 24,
          w: 180, h: 120, anchor: { version: 2, landmarks: [
            { kind: "block", block: paragraph.text, headings: [paragraph.heading], line: paragraph.line },
          ] } } }));
    }
    return out;
  }, { start: from, total: count, paragraphs });
  const failed = replies.find(reply => !reply?.ok);
  assert.ok(!failed, `seeding a magnet failed: ${JSON.stringify(failed)}`);
}

async function scrollAndCollect(page, steps) {
  await page.evaluate(() => { window.__glassDurations = []; });
  for (let step = 0; step < steps; step += 1) {
    const before = await page.evaluate(() => Number(document.querySelector(".glass-layer")?.dataset.glassMeasures ?? 0));
    await page.evaluate(delta => { const surface = document.querySelector(".rich-document")?.parentElement; if (surface) surface.scrollTop += delta; }, 420);
    await page.waitForFunction(count => Number(document.querySelector(".glass-layer")?.dataset.glassMeasures ?? 0) > count, before);
  }
  return page.evaluate(() => window.__glassDurations ?? []);
}

function p95(values, pick = value => value) {
  const sorted = values.map(pick).sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length * 0.95)] ?? 0;
}

async function capture(page, name) {
  if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, `glass-g19-${name}.png`) }); }
}

let baseline;
{
  const { app, page, errors } = await open();
  try {
    await expect.poll(() => page.locator("[data-magnet]").count()).toBe(0);
    baseline = await metrics(page);
    const baselineScroll = await scrollAndCollect(page, 12);
    baseline = { ...baseline, scrollP95Ms: p95(baselineScroll, value => value.total), magnetP95Ms: p95(baselineScroll, value => value.magnet) };
    await seed(page, 200);
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
}

let cold;
{
  const { app, page, errors } = await open();
  try {
    await expect.poll(() => page.locator("[data-magnet]").count()).toBeGreaterThan(0);
    cold = await metrics(page);
    const report = { baseline, cold, delta: cold.openMs - baseline.openMs };
    if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, "scale.json"), JSON.stringify(report, null, 2), "utf8"); }
    console.log("G19 scale", JSON.stringify(report));
    // Separate launches include the editor's own layout and GC; the magnet phase isolates the 200 magnets.
    const magnetWork = run => run.phases.placed - run.phases.indexed;
    assert.ok(magnetWork(cold) - magnetWork(baseline) < 100, `200 magnets added ${(magnetWork(cold) - magnetWork(baseline)).toFixed(1)} ms of magnet work at cold open`);
    assert.ok(cold.mounted <= 301, `only the viewport window is mounted (${cold.mounted})`);

    const scrolled = await metrics(page);
    const coldScroll = await scrollAndCollect(page, 12);
    scrolled.scrollP95Ms = p95(coldScroll, value => value.total);
    scrolled.magnetP95Ms = p95(coldScroll, value => value.magnet);
    console.log("G19 scroll", JSON.stringify(scrolled));
    assert.ok(scrolled.magnetP95Ms - baseline.magnetP95Ms < 100, `200 magnets added ${(scrolled.magnetP95Ms - baseline.magnetP95Ms).toFixed(2)} ms of magnet work while scrolling`);
    await page.evaluate(() => { const surface = document.querySelector(".rich-document")?.parentElement; if (surface) surface.scrollTop = 0; });
    await page.waitForTimeout(120);
    await capture(page, "light-1440");

    await expect.poll(() => page.locator("[data-magnet]").count()).toBeGreaterThan(0);
    const lefts = () => page.evaluate(() => [...document.querySelectorAll("[data-magnet]")].map(node => node.style.left).sort().join(","));
    const beforeRtl = await lefts();
    await page.evaluate(() => document.documentElement.dir = "rtl");
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector(".rich-document")).direction)).toBe("rtl");
    await expect.poll(lefts, { timeout: 15_000 }).not.toBe(beforeRtl);
    await capture(page, "rtl-1440");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(720, 900));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(720);
    await capture(page, "rtl-720");
    await page.evaluate(() => document.documentElement.dir = "ltr");
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await capture(page, "light-720");

    const keyboard = await page.evaluate(() => {
      const visible = [...document.querySelectorAll("[data-magnet], .glass-timeline")];
      return {
        visible: visible.length,
        unlabelled: visible.filter(node => !node.getAttribute("aria-label") || node.tabIndex < 0).length,
      };
    });
    assert.equal(keyboard.unlabelled, 0, "every mounted magnet is labelled and tabbable");
    const toggle = page.locator("[data-glass-offscreen-toggle]");
    await toggle.focus();
    await page.keyboard.press("Enter");
    const offscreen = await page.evaluate(() => document.querySelectorAll("[data-glass-offscreen]").length);
    assert.ok(offscreen > 0, "culled magnets stay reachable from one keyboard control");
    await toggle.focus();
    await page.keyboard.press("Enter");

    await page.emulateMedia({ forcedColors: "active" });
    const cues = await page.evaluate(() => [...document.querySelectorAll("[data-magnet]")].every(node => {
      const style = getComputedStyle(node), mark = node.querySelector(".glass-note-mark");
      return style.borderStyle !== "none" && !!mark && getComputedStyle(mark).display !== "none";
    }));
    assert.ok(cues, "forced colours keep a border plus a per-colour shape cue");
    await page.emulateMedia({ forcedColors: "none" });

    await page.evaluate(() => window.desktop.glassState({ action: "write", visible: false }));
    await expect(page.locator(".glass-layer")).toHaveCount(0);
    await seed(page, 1_800, 200);
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
}

{
  const { app, page, errors } = await open();
  try {
    await expect.poll(() => page.locator("[data-magnet]").count()).toBeGreaterThan(0);
    const dense = await metrics(page);
    const stored = await page.evaluate(async () => (await window.desktop.glass({ note: "textbook.md", action: "list" })).value?.magnets?.length ?? 0);
    console.log("G19 dense", JSON.stringify({ ...dense, stored }));
    assert.equal(stored, 2000);
    assert.ok(dense.mounted <= 301, `2,000 magnets mount ${dense.mounted} nodes, not all of them`);
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
}

console.log("PASS: 1,000-page note, 200 and 2,000 magnets, keyboard stops, RTL");
