// npm run build && node tests/photo-previews-desktop.mjs
import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-photo-desktop-"));
const photo = path.join(root, "camera.jpg"), file = path.join(root, "note.md"), content = "# Photo\n\n![Camera](camera.jpg)\n";
await sharp({ create: { width: 6000, height: 4500, channels: 3, background: "#ab6644" } }).jpeg().withMetadata({ orientation: 6 }).toFile(photo);
const original = await readFile(photo);
await writeFile(file, content);
await writeFile(path.join(root, "session.json"), JSON.stringify({ version: 1, activeId: "photo", documents: [{ id: "photo", path: file, name: "note.md", content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), bom: false, lineEnding: "\n" }] }));
const env = { ...process.env, OMARKIE_DATA_DIR: root, OMARKIE_LANGUAGE: "zh" }; delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL;
const app = await electron.launch({ args: [process.cwd()], env });
try {
  const page = await app.firstWindow(), image = page.locator(".rich-document img").first();
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(image => image.complete && image.naturalWidth > 0 && image.currentSrc.includes("?preview="))).toBe(true);
  assert.equal(await image.evaluate(image => image.naturalWidth), 4500, "cold view serves original immediately");
  await expect.poll(async () => { try { return (await readdir(path.join(root, "photo-previews"))).some(name => name.endsWith(".webp")); } catch { return false; } }, { timeout: 15000 }).toBe(true);
  await page.reload();
  await expect.poll(() => image.evaluate(image => image.complete && image.naturalWidth > 0 && image.naturalWidth < 4500)).toBe(true);
  const result = await image.evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight, selected: image.currentSrc, original: image.src }));
  const bucket = Number(new URL(result.selected).searchParams.get("preview"));
  assert.ok(result.width <= bucket); assert.ok(result.height > result.width, "EXIF orientation survives preview generation");
  assert.ok(!result.original.includes("preview="));
  const cached = await readdir(path.join(root, "photo-previews")); assert.ok(cached.length > 0 && cached.every(name => name.endsWith(".webp")));
  for (const name of cached) assert.ok((await sharp(path.join(root, "photo-previews", name)).metadata()).width <= bucket);
  const exported = await image.evaluate(async image => {
    const result = await window.desktop.readResource(image.src);
    return result;
  });
  assert.equal(exported.ok, true); assert.deepEqual(Buffer.from(exported.value.base64, "base64"), original);
  const htmlPath = path.join(root, "export.html");
  await app.evaluate(({ dialog, BrowserWindow }, htmlPath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: htmlPath });
    BrowserWindow.getAllWindows()[0].webContents.send("app:command", { action: "html" });
  }, htmlPath);
  await expect.poll(async () => { try { return (await readFile(htmlPath, "utf8")).includes("data:image/jpeg;base64,"); } catch { return false; } }).toBe(true);
  const html = await readFile(htmlPath, "utf8");
  assert.ok(!html.includes("?preview=")); assert.ok(!/srcset=/.test(html));
  const embedded = /src="data:image\/jpeg;base64,([^"]+)"/.exec(html);
  assert.ok(embedded); assert.deepEqual(Buffer.from(embedded[1], "base64"), original);
  assert.deepEqual(await readFile(photo), original);
  console.log("PASS: cold original, warm WebP, EXIF rotation, cached preview and original export resource");
} finally { await app.close(); }
