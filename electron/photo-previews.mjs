import { createHash } from "node:crypto";
import { mkdir, readdir, stat, readFile, writeFile, utimes, open } from "node:fs/promises";
import path from "node:path";
import { imageSize } from "image-size";

export const previewWidths = [800, 1200, 1600, 2400];
export function previewBucket(width) {
  return previewWidths.find(bucket => bucket >= width) || 2400;
}
export function previewKey(file, info, width) {
  return createHash("sha256").update(JSON.stringify([2, file, info.mtimeMs, info.size, previewBucket(width)])).digest("hex") + ".webp";
}
// Runs entirely in a Chromium worker, including decode, resize and WebP encoding.
export function previewWorker() {
  self.onmessage = async ({ data: { base64, width } }) => {
    let bitmap;
    try {
      const binary = atob(base64), bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const blob = new Blob([bytes], { type: "image/jpeg" });
      bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeQuality: "medium" });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      let encoded;
      try { encoded = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 }); if (encoded.type !== "image/webp") throw Error("WebP unavailable"); }
      catch { encoded = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 }); }
      self.postMessage({ base64: new FileReaderSync().readAsDataURL(encoded).split(",")[1] });
    } catch { self.postMessage({ error: true }); }
    finally { bitmap?.close(); }
  };
}
export async function chromiumPreview(webContents, file, width) {
  const base64 = (await readFile(file)).toString("base64");
  const result = await webContents.executeJavaScript(`new Promise((resolve,reject) => {
    const url = URL.createObjectURL(new Blob([${JSON.stringify(`(${previewWorker.toString()})()`)}], {type:'text/javascript'}));
    const worker = new Worker(url);
    const finish = () => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); };
    const timer = setTimeout(() => { finish(); reject(new Error('preview timeout')); }, 15000);
    worker.onerror = () => { finish(); reject(new Error('preview failed')); };
    worker.onmessage = ({data}) => { finish(); data.error ? reject(new Error('preview failed')) : resolve(data.base64); };
    worker.postMessage({base64:${JSON.stringify(base64)},width:${width}});
  })`);
  return Buffer.from(result, "base64");
}
export async function evictPreviews(directory, limit, trash) {
  const files = await Promise.all((await readdir(directory)).filter(name => /^[a-f0-9]{64}\.(?:webp|jpg)$/.test(name)).map(async name => {
    const file = path.join(directory, name), info = await stat(file); return { file, ...info };
  }));
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file))) {
    if (total <= limit) break;
    await trash(file.file); total -= file.size;
  }
}
export class PhotoPreviews {
  constructor(directory, generate, trash, limit = 128 * 1024 * 1024) {
    this.directory = directory; this.generate = generate; this.trash = trash; this.limit = limit;
    this.pending = new Map(); this.queue = Promise.resolve();
  }
  async get(file, requestedWidth) {
    if (!/\.jpe?g$/i.test(file) || !previewWidths.includes(requestedWidth)) return file;
    try {
      const info = await stat(file), key = previewKey(file, info, requestedWidth);
      const target = path.join(this.directory, key), fallback = target.replace(/\.webp$/, ".jpg");
      for (const cached of [target, fallback]) {
        try { if ((await stat(cached)).size > 0) { const now = new Date(); void utimes(cached, now, now).catch(() => {}); return cached; } } catch {}
      }
      if (this.pending.has(key)) return file;
      // Let the original finish loading before competing for decode and IPC resources.
      const task = new Promise(resolve => { setTimeout(resolve, 2000); }).then(() => this.queue = this.queue.then(async () => {
        await mkdir(this.directory, { recursive: true });
        const handle = await open(file, "r");
        let dimensions;
        try { const header = Buffer.alloc(Math.min(info.size, 128 * 1024)); await handle.read(header, 0, header.length, 0); dimensions = imageSize(header); } finally { await handle.close(); }
        const width = (dimensions.orientation || 1) >= 5 ? dimensions.height : dimensions.width;
        if (!width || width <= requestedWidth) return file;
        const bytes = await this.generate(file, requestedWidth);
        if (!bytes.length || bytes.length > this.limit) return file;
        // Do not cache a preview if the original changed during decoding.
        if (previewKey(file, await stat(file), requestedWidth) !== key) return file;
        const destination = bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? target : fallback;
        await writeFile(destination, bytes);
        await evictPreviews(this.directory, this.limit, this.trash);
        return destination;
      }).catch(() => file));
      this.pending.set(key, task);
      void task.finally(() => this.pending.delete(key));
      return file;
    } catch { return file; }
  }
}
