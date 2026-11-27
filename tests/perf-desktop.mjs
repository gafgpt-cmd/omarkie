import { _electron as electron } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, stat, realpath, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import budgets from "./perf-budgets.json" with { type: "json" };
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";
import { runGlassIndexScale } from "./glass-index-fixture.mjs";

// Display cadence is only asserted on a real compositor: OMARKIE_REAL_COMPOSITOR=1 ./scripts perf run.
// CI and Xvfb draw in software, so the desktop suites assert handler work and long tasks instead
// (tests/frame-cadence.mjs).
const runs = Number(process.env.OMARKIE_PERF_RUNS ?? 3);
assert.ok(Number.isSafeInteger(runs) && runs > 0, "OMARKIE_PERF_RUNS must be a positive integer");
// OMARKIE_PERF_HEADLESS=1 runs on headless Ozone for stage tracing; the report records that display.
const headless = process.env.OMARKIE_PERF_HEADLESS === "1" && !process.env.OMARKIE_TEST_DISPLAY;
assert.ok(process.platform !== "linux" || process.env.OMARKIE_TEST_DISPLAY || headless, "Linux performance checks require an isolated X display via OMARKIE_TEST_DISPLAY; see README.");
const scratch = path.resolve("test-results");
await mkdir(scratch, { recursive: true });
const fixtures = await realpath(await mkdtemp(path.join(scratch, "perf-fixtures-"))), qa = process.env.OMARKIE_QA_DIR || path.join(scratch, "perf");
const big = path.join(fixtures, "big.md"), photos = path.join(fixtures, "photos.md");
const editor = ".document-editor:not([hidden]) .rich-document";
const finalParagraph = "End of the performance fixture.";
await mkdir(fixtures, { recursive: true }); await mkdir(qa, { recursive: true });

async function launch(file, directory) {
  directory ??= await mkdtemp(path.join(fixtures, "profile-"));
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: path.join(directory, "data"), OMARKIE_LANGUAGE: "en", OMARKIE_TRACE_STARTUP: "1", OMARKIE_TEST_HIDDEN: "0" });
  delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL;
  const args = process.env.OMARKIE_EXECUTABLE ? (process.env.OMARKIE_APP ? [process.env.OMARKIE_APP] : []) : [process.cwd()];
  args.push(...headlessArguments);
  if (file) args.push(file);
  const started = performance.now(), epoch = Date.now();
  const application = await electron.launch({ ...(process.env.OMARKIE_EXECUTABLE ? { executablePath: process.env.OMARKIE_EXECUTABLE } : {}), args, env, timeout: 60000 });
  return { application, started, epoch, directory };
}

async function prepare() {
  const words = "writing calmly makes space for useful details while simple moments become lasting notes through careful thought and steady daily practice".split(" ");
  const paragraph = Array.from({ length: 90 }, (_, i) => words[i % words.length]).join(" ");
  await writeFile(big, "# Big note\n\n" + Array.from({ length: 400 }, (_, i) => `## Section ${i}\n\n${Array(6).fill(paragraph).join("\n\n")}\n\n`).join("") + finalParagraph + "\n", "utf8");
  const { application } = await launch();
  let bytes;
  try {
    const encoded = await application.evaluate(async ({ BrowserWindow }) => {
      const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
      try {
        await window.loadURL("about:blank");
        return await window.webContents.executeJavaScript(`(async () => {
          const canvas = new OffscreenCanvas(6000, 4000), context = canvas.getContext("2d");
          const pixels = context.createImageData(canvas.width, canvas.height);
          let seed = 123456789;
          for (let i = 0; i < pixels.data.length; i += 4) {
            seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
            pixels.data[i] = seed & 255; pixels.data[i + 1] = (seed >>> 8) & 255;
            pixels.data[i + 2] = (seed >>> 16) & 255; pixels.data[i + 3] = 255;
          }
          context.putImageData(pixels, 0, 0);
          const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
          return await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.readAsDataURL(blob); });
        })()`);
      } finally { window.destroy(); }
    });
    bytes = Buffer.from(encoded, "base64");
  } finally { await application.close(); }
  assert.ok(bytes.length >= 3_000_000 && bytes.length <= 20 * 1024 * 1024, `Unexpected JPEG size: ${bytes.length}`);
  for (let i = 0; i < 18; i++) await writeFile(path.join(fixtures, `photo-${i}.jpg`), bytes);
  const cached = { width: 6000, height: 4000, bytes: bytes.length };
  await writeFile(photos, "# Photos\n\n" + Array.from({ length: 18 }, (_, i) => `![Photo ${i}](photo-${i}.jpg)\n\n`).join(""), "utf8");
  return { ...cached, bigBytes: (await stat(big)).size, directory: fixtures };
}

// Main-process stages (electron/main.mjs startupMark) and renderer marks, in ms after launch was requested.
async function stages(application, page, epoch) {
  const main = await application.evaluate(() => ({ origin: performance.timeOrigin, marks: globalThis.omarkieStartupTrace || [] }));
  const renderer = await page.evaluate(() => ({ origin: performance.timeOrigin, marks: performance.getEntriesByType("mark").filter(mark => mark.name.startsWith("omarkie:")).map(mark => ({ name: mark.name.slice(8), startTime: mark.startTime })) }));
  const at = value => Number((value - epoch).toFixed(1)), launch = { "process-start": at(main.origin) };
  for (const mark of main.marks) if (mark.request === undefined) launch[mark.name] ??= at(mark.at);
  for (const mark of renderer.marks) launch[`renderer:${mark.name}`] ??= at(renderer.origin + mark.startTime);
  return { launch, photoMarks: main.marks.filter(mark => mark.request !== undefined), rendererOrigin: renderer.origin };
}

// Cold first photo split into auth (asset grant + preview lookup), queue, file read and decode-to-visible.
function photoStages(marks, visible) {
  const requests = Map.groupBy(marks, mark => mark.request);
  for (const [request, list] of requests) {
    const find = name => list.find(mark => mark.name === name)?.at;
    const requested = find("photo-request"), authorized = find("photo-authorized"), turn = find("photo-turn"), read = find("photo-read") ?? turn;
    if (requested === undefined || authorized === undefined || turn === undefined || read > visible) continue;
    const detail = list.find(mark => mark.name === "photo-authorized");
    const round = value => Number(value.toFixed(1));
    return { request, preview: detail.preview, cached: detail.cached, auth: round(authorized - requested), queue: round(turn - authorized), read: round(read - turn), decodeVisible: round(visible - read) };
  }
  return null;
}

async function previewCount(directory) {
  return (await readdir(path.join(directory, "data", "photo-previews")).catch(() => [])).filter(name => /\.(?:webp|jpg)$/.test(name)).length;
}

async function measure(kind, file, title, directory) {
  const { application, started, epoch, directory: profile } = await launch(file, directory);
  try {
    const page = await application.firstWindow({ timeout: 60000 });
    const ready = await page.waitForFunction(({ editor, title, photo }) => {
      const heading = document.querySelector(`${editor} h1`);
      if (!heading || (title && !heading.textContent?.includes(title))) return false;
      const attached = performance.now();
      if (!photo) return { attached };
      return new Promise(resolve => {
        let revealed = false;
        const check = () => {
          const image = [...document.querySelectorAll(`${editor} img`)].find(image => {
            const rect = image.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0 && rect.left < innerWidth && rect.right > 0;
          });
          if (!image && !revealed) { const first = document.querySelector(`${editor} img`); if (first) { first.scrollIntoView({ block: "center" }); revealed = true; } }
          if (image?.complete && image.naturalWidth > 0) resolve({ attached, firstPhoto: performance.now() - attached, width: image.naturalWidth, height: image.naturalHeight, source: image.currentSrc.includes("?preview=") ? "preview" : "original" });
          else requestAnimationFrame(check);
        };
        check();
      });
    }, { editor, title, photo: kind === "photos" || kind === "warm-photos" }, { polling: "raf", timeout: 60000 });
    const elapsed = performance.now() - started, result = await ready.jsonValue(); await ready.dispose();
    const trace = await stages(application, page, epoch);
    trace.launch.heading = Number((trace.rendererOrigin + result.attached - epoch).toFixed(1));
    if (kind === "warm-photos") return { firstPhotoWarm: result.firstPhoto, warmSource: result.source };
    if (kind === "photos") {
      const loadedAfter3s = await page.evaluate(async ({ editor, attached }) => {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, attached + 3000 - performance.now())));
        return [...document.querySelectorAll(`${editor} img`)].filter(image => image.complete && image.naturalWidth > 0).length;
      }, { editor, attached: result.attached });
      // Keep the window open until the preview cache holds the first photo, so the warm launch has something to reuse.
      const deadline = Date.now() + 15000;
      while (!(await previewCount(profile)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      const visible = trace.rendererOrigin + result.attached + result.firstPhoto;
      return { firstPhoto: result.firstPhoto, naturalSize: { width: result.width, height: result.height }, loadedAfter3s, photoStages: photoStages(trace.photoMarks, visible), profile };
    }
    if (kind === "big") {
      await page.locator(editor).focus();
      const scrolling = performance.now();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
      await page.waitForFunction(({ editor, finalParagraph }) => {
        const paragraph = [...document.querySelectorAll(`${editor} p`)].find(element => element.textContent === finalParagraph);
        if (!paragraph) return false;
        const bounds = paragraph.getBoundingClientRect(), viewport = paragraph.closest(".rich-scroller").getBoundingClientRect();
        return bounds.top < viewport.bottom && bounds.bottom > viewport.top;
      }, { editor, finalParagraph }, { polling: "raf", timeout: 3000 });
      return { bigNote: elapsed, bigNoteScroll: performance.now() - scrolling };
    }
    return { launch: elapsed, launchStages: trace.launch };
  } finally { await application.close(); }
}

async function environment() {
  const { application } = await launch();
  try {
    const page = await application.firstWindow({ timeout: 60000 });
    const runtime = await application.evaluate(({ app }) => ({ electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, packaged: app.isPackaged }));
    const view = await page.evaluate(() => ({ devicePixelRatio, screen: `${screen.width}x${screen.height}`, viewport: `${innerWidth}x${innerHeight}` }));
    const cpus = os.cpus();
    return { ...runtime, ...view, display: process.platform === "linux" ? headless ? "headless" : "x11" : process.platform, platform: `${process.platform} ${os.release()} ${process.arch}`, cpu: cpus[0]?.model?.trim() || "unknown", cores: cpus.length, memoryGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)), loadAverage: os.loadavg().map(value => Number(value.toFixed(2))) };
  } finally { await application.close(); }
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  return { median, p95, min: sorted[0], max: sorted.at(-1) };
}

const results = { runs, executable: process.env.OMARKIE_EXECUTABLE || "development", samples: [], metrics: {}, unbudgeted: {} };
try {
  results.environment = await environment();
  results.fixtures = await prepare();
  for (let i = 0; i < runs; i++) {
    console.log(`Performance run ${i + 1}/${runs}`);
    const cold = await measure("photos", photos, "Photos");
    const { profile, ...photo } = cold;
    results.samples.push({
      ...await measure("launch"),
      ...await measure("big", big, "Big note"),
      ...photo,
      ...await measure("warm-photos", photos, "Photos", profile),
      glassIndexMainThreadGap: (await runGlassIndexScale()).gap,
    });
  }
  for (const [metric, budget] of Object.entries(budgets)) {
    const values = results.samples.map(sample => sample[metric]), summary = summarize(values);
    results.metrics[metric] = { value: summary.median, budget, pass: summary.median <= budget, samples: values, ...summary };
  }
  // Warm photo reuses the cold run's profile and preview cache; reported, not budgeted.
  results.unbudgeted.firstPhotoWarm = { samples: results.samples.map(sample => sample.firstPhotoWarm), ...summarize(results.samples.map(sample => sample.firstPhotoWarm)) };
  console.table(results.environment);
  console.table(Object.entries({ ...results.metrics, ...results.unbudgeted }).map(([metric, { median, p95, min, max, budget, pass }]) => ({ metric, "median (ms)": Number(median.toFixed(1)), "p95 (ms)": Number(p95.toFixed(1)), "min–max (ms)": `${min.toFixed(0)}–${max.toFixed(0)}`, "budget (ms)": budget ?? "-", result: budget === undefined ? "report" : pass ? "PASS" : "FAIL" })));
  console.table(results.samples.map(({ naturalSize, loadedAfter3s, warmSource, photoStages }, run) => ({ run: run + 1, naturalSize: `${naturalSize.width}x${naturalSize.height}`, loadedAfter3s, warmSource, ...photoStages })));
  console.table(results.samples.map(sample => sample.launchStages));
  if (Object.values(results.metrics).some(metric => !metric.pass)) process.exitCode = 1;
} catch (error) {
  results.error = String(error); process.exitCode = 1; console.error(error);
} finally {
  await writeFile(path.join(qa, "perf-results.json"), JSON.stringify(results, null, 2) + "\n", "utf8");
}
