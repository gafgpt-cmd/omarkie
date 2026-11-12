// Run after npm run build: node scripts/benchmark-photo-previews.mjs /path/to/camera.jpg
import { _electron as electron } from "playwright";
import { mkdtemp, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const file = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !(await stat(file)).isFile()) throw Error("Pass a camera JPEG path");
const profile = await mkdtemp(path.join(os.tmpdir(), "omarkie-preview-bench-"));
const env = { ...process.env, OMARKIE_DATA_DIR: profile, OMARKIE_LANGUAGE: "zh", OMARKIE_TEST_HIDDEN: "1" }; delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL;
const app = await electron.launch({ args: [process.cwd()], env });
try {
  await app.firstWindow();
  const page = await app.firstWindow();
  const { PhotoPreviews, previewWorker } = await import("../electron/photo-previews.mjs");
  const { readFile, rename } = await import("node:fs/promises");
  const generate = async (file, width) => {
    const base64 = (await readFile(file)).toString("base64");
    const result = await page.evaluate(({ source, base64, width }) => new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" })), worker = new Worker(url);
      worker.onmessage = ({ data }) => { worker.terminate(); URL.revokeObjectURL(url); data.error ? reject(Error("preview failed")) : resolve(data.base64); };
      worker.onerror = reject;
      worker.postMessage({ base64, width });
    }), { source: `(${previewWorker.toString()})()`, base64, width });
    return Buffer.from(result, "base64");
  };
  const native = [], thumbnail = [], chromium = [];
  for (let i = 0; i < 3; i++) {
    const results = await app.evaluate(async ({ nativeImage }, file) => {
      let start = performance.now();
      const jpeg = nativeImage.createFromPath(file).resize({ width: 1200 }).toJPEG(82);
      const native = { ms: performance.now() - start, bytes: jpeg.length };
      start = performance.now();
      try { const image = await nativeImage.createThumbnailFromPath(file, { width: 1200, height: 1200 }); return { native, thumbnail: { ms: performance.now() - start, bytes: image.toJPEG(82).length } }; }
      catch (error) { return { native, thumbnail: { error: String(error) } }; }
    }, file);
    native.push(results.native); thumbnail.push(results.thumbnail);
    const start = performance.now(), bytes = await generate(file, 1200);
    chromium.push({ ms: performance.now() - start, bytes: bytes.length });
  }
  const cache = new PhotoPreviews(path.join(profile, "photo-previews"), generate, file => rename(file, file + ".trashed"));
  let start = performance.now(); const coldTarget = await cache.get(file, 1200), cold = performance.now() - start;
  await Promise.all(cache.pending.values());
  start = performance.now(); const target = await cache.get(file, 1200), warm = performance.now() - start;
  console.log(JSON.stringify({ nativeImage: native, nativeThumbnail: thumbnail, chromiumWebP: chromium, cacheColdMs: cold, coldServesOriginal: coldTarget === file, cacheWarmMs: warm, target }, null, 2));
} finally { await app.close(); }
