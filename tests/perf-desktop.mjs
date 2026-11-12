import { _electron as electron } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import budgets from "./perf-budgets.json" with { type: "json" };

const runs = Number(process.env.OMARKIE_PERF_RUNS ?? 3);
assert.ok(Number.isSafeInteger(runs) && runs > 0, "OMARKIE_PERF_RUNS must be a positive integer");
const fixtures = path.join(os.tmpdir(), "omarkie-perf-fixtures-v1"), qa = process.env.OMARKIE_QA_DIR || "/tmp/omarkie-perf-qa";
const big = path.join(fixtures, "big.md"), photos = path.join(fixtures, "photos.md");
const editor = ".document-editor:not([hidden]) .rich-document";
await mkdir(fixtures, { recursive: true }); await mkdir(qa, { recursive: true });

async function launch(file) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omarkie-perf-"));
  const env = { ...process.env, OMARKIE_DATA_DIR: path.join(directory, "data"), OMARKIE_LANGUAGE: "en", XDG_STATE_HOME: path.join(directory, "state") };
  await mkdir(env.XDG_STATE_HOME, { recursive: true });
  delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL;
  const args = process.env.OMARKIE_EXECUTABLE ? (process.env.OMARKIE_APP ? [process.env.OMARKIE_APP] : []) : [process.cwd()];
  if (file) args.push(file);
  const started = performance.now();
  const application = await electron.launch({ ...(process.env.OMARKIE_EXECUTABLE ? { executablePath: process.env.OMARKIE_EXECUTABLE } : {}), args, env, timeout: 60000 });
  return { application, started };
}

async function prepare() {
  const words = "writing calmly makes space for useful details while simple moments become lasting notes through careful thought and steady daily practice".split(" ");
  const paragraph = Array.from({ length: 90 }, (_, i) => words[i % words.length]).join(" ");
  await writeFile(big, "# Big note\n\n" + Array.from({ length: 400 }, (_, i) => `## Section ${i}\n\n${Array(6).fill(paragraph).join("\n\n")}\n\n`).join(""), "utf8");
  let cached;
  try { cached = JSON.parse(await readFile(path.join(fixtures, "ready.json"), "utf8")); } catch {}
  if (!cached || !(await Promise.all(Array.from({ length: 18 }, (_, i) => stat(path.join(fixtures, `photo-${i}.jpg`)).then(info => info.size === cached.bytes).catch(() => false)))).every(Boolean)) {
    const { application } = await launch();
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
      const bytes = Buffer.from(encoded, "base64");
      assert.ok(bytes.length >= 3_000_000 && bytes.length <= 20 * 1024 * 1024, `Unexpected JPEG size: ${bytes.length}`);
      for (let i = 0; i < 18; i++) await writeFile(path.join(fixtures, `photo-${i}.jpg`), bytes);
      cached = { width: 6000, height: 4000, bytes: bytes.length };
      await writeFile(path.join(fixtures, "ready.json"), JSON.stringify(cached), "utf8");
    } finally { await application.close(); }
  }
  await writeFile(photos, "# Photos\n\n" + Array.from({ length: 18 }, (_, i) => `![Photo ${i}](photo-${i}.jpg)\n\n`).join(""), "utf8");
  return { ...cached, bigBytes: (await stat(big)).size, directory: fixtures };
}

async function measure(kind, file, title) {
  const { application, started } = await launch(file);
  try {
    const page = await application.firstWindow({ timeout: 60000 });
    // Observe attachment and image readiness together, without locator actionability waits.
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
          if (image?.complete && image.naturalWidth > 0) resolve({ attached, firstPhoto: performance.now() - attached, width: image.naturalWidth, height: image.naturalHeight });
          else requestAnimationFrame(check);
        };
        check();
      });
    }, { editor, title, photo: kind === "photos" }, { polling: "raf", timeout: 60000 });
    const elapsed = performance.now() - started, result = await ready.jsonValue(); await ready.dispose();
    if (kind === "photos") {
      const loadedAfter3s = await page.evaluate(async ({ editor, attached }) => {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, attached + 3000 - performance.now())));
        return [...document.querySelectorAll(`${editor} img`)].filter(image => image.complete && image.naturalWidth > 0).length;
      }, { editor, attached: result.attached });
      return { firstPhoto: result.firstPhoto, decoded: { width: result.width, height: result.height }, loadedAfter3s };
    }
    if (kind === "big") {
      await page.locator(editor).focus();
      const scrolling = performance.now();
      await page.keyboard.press("Control+End");
      await page.waitForFunction(editor => [...document.querySelectorAll(`${editor} h2`)].some(heading => heading.textContent?.includes("Section 399")), editor, { timeout: 60000 });
      return { bigNote: elapsed, bigNoteScroll: performance.now() - scrolling };
    }
    return { launch: elapsed };
  } finally { await application.close(); }
}

const results = { runs, executable: process.env.OMARKIE_EXECUTABLE || "development", samples: [], metrics: {} };
try {
  results.fixtures = await prepare();
  for (let i = 0; i < runs; i++) {
    console.log(`Performance run ${i + 1}/${runs}`);
    results.samples.push({ ...await measure("launch"), ...await measure("big", big, "Big note"), ...await measure("photos", photos, "Photos") });
  }
  for (const [metric, budget] of Object.entries(budgets)) {
    const values = results.samples.map(sample => sample[metric]).sort((a, b) => a - b), middle = Math.floor(values.length / 2);
    const value = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    results.metrics[metric] = { value, budget, pass: value <= budget };
  }
  console.table(Object.entries(results.metrics).map(([metric, { value, budget, pass }]) => ({ metric, "value (ms)": Number(value.toFixed(1)), "budget (ms)": budget, result: pass ? "PASS" : "FAIL" })));
  console.table(results.samples.map(({ decoded, loadedAfter3s }, run) => ({ run: run + 1, decoded: `${decoded.width}x${decoded.height}`, loadedAfter3s })));
  if (Object.values(results.metrics).some(metric => !metric.pass) && process.env.OMARKIE_PERF_REPORT_ONLY !== "1") process.exitCode = 1;
} catch (error) {
  results.error = String(error); process.exitCode = 1; console.error(error);
} finally {
  await writeFile(path.join(qa, "perf-results.json"), JSON.stringify(results, null, 2) + "\n", "utf8");
}
