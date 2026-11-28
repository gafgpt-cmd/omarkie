// npm run build && node tests/photo-previews-desktop.mjs
import { _electron as electron, expect } from "playwright/test";
import { fullSize, headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-photo-desktop-"));
const photo = path.join(root, "camera.jpg"), file = path.join(root, "note.md");
const content = `# Photo

![Camera](camera.jpg)

![Standalone](small.jpg)

![[small.jpg]]

<img src="small.jpg" alt="Standalone HTML">

Text ![Inline](small.jpg) text

Text <img src="small.jpg" alt="Inline HTML"> text

![Sized Markdown](small.jpg){width=240}

![[small.jpg|220]]

<img src="small.jpg" alt="Sized HTML" width="200">

<img src="small.jpg" alt="Styled HTML" style="width: 180px">
`;
await sharp({ create: { width: 6000, height: 4500, channels: 3, background: "#ab6644" } }).jpeg().withMetadata({ orientation: 6 }).toFile(photo);
await sharp({ create: { width: 96, height: 48, channels: 3, background: "#886644" } }).jpeg().toFile(path.join(root, "small.jpg"));
const original = await readFile(photo);
await writeFile(file, content);
await writeFile(path.join(root, "session.json"), JSON.stringify({ version: 1, activeId: "photo", documents: [{ id: "photo", path: file, name: "note.md", content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), bom: false, lineEnding: "\n" }] }));
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: root, OMARKIE_LANGUAGE: "en" }); delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL;
const app = await electron.launch({ args: [process.cwd(), ...headlessArguments], env });
try {
  const page = await app.firstWindow(), image = page.locator(".rich-document img").first();
  await fullSize(app, page);
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(image => image.complete && image.naturalWidth > 0 && image.currentSrc.includes("?preview="))).toBe(true);
  // srcset w-descriptors make naturalWidth layout-dependent; decode to read the served pixel size.
  const pixels = () => image.evaluate(async image => { const bitmap = await createImageBitmap(image); try { return [bitmap.width, bitmap.height]; } finally { bitmap.close(); } });
  assert.equal((await pixels())[0], 4500, "cold view serves original immediately");
  await expect.poll(async () => { try { return (await readdir(path.join(root, "photo-previews"))).some(name => name.endsWith(".webp")); } catch { return false; } }, { timeout: 15000 }).toBe(true);
  await page.reload();
  await expect.poll(async () => await image.evaluate(image => image.complete && image.naturalWidth > 0) && (await pixels())[0] < 4500).toBe(true);
  const [width, height] = await pixels();
  const result = { width, height, ...await image.evaluate(image => ({ selected: image.currentSrc, original: image.src })) };
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
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  const figure = alt => rich.getByRole("img", { name: alt, exact: true });
  const display = locator => locator.evaluate(img => {
    const { width, height } = img.getBoundingClientRect();
    return [Math.round(width), Math.round(height)];
  });
  const column = await image.evaluate(img => img.closest(".md-inline").getBoundingClientRect().width);
  await expect.poll(() => display(image)).toEqual([Math.round(column), Math.round(column * 4 / 3)]);
  for (const [locator, width] of [
    [figure("Standalone"), 192],
    [figure("small.jpg").first(), 192],
    [figure("Standalone HTML"), 192],
    [figure("Inline"), 96],
    [figure("Inline HTML"), 96],
    [figure("Sized Markdown"), 240],
    [figure("small.jpg").last(), 220],
    [figure("Sized HTML"), 200],
    [figure("Styled HTML"), 180],
  ]) {
    await locator.scrollIntoViewIfNeeded();
    await expect.poll(() => locator.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect.poll(() => display(locator)).toEqual([width, width / 2]);
  }
  async function setScale(from, to) {
    await page.keyboard.press("ControlOrMeta+,");
    const preferences = page.getByRole("dialog", { name: "Preferences", exact: true });
    const scale = preferences.getByRole("combobox", { name: "Standalone image scale limit" });
    await expect(scale.getByRole("option")).toHaveCount(3);
    await expect(scale).toHaveValue(from); await scale.selectOption(to);
    await preferences.getByRole("button", { name: "Done", exact: true }).click();
  }
  await setScale("2", "1.5");
  await expect.poll(() => display(figure("Standalone"))).toEqual([144, 72]);
  await expect.poll(() => display(figure("Sized Markdown"))).toEqual([240, 120]);
  await setScale("1.5", "1");
  await expect.poll(() => display(figure("Standalone"))).toEqual([96, 48]);
  await page.reload();
  await expect.poll(() => display(figure("Standalone"))).toEqual([96, 48]);
  await page.locator(".source-toggle").click();
  const source = page.locator(".document-editor:not([hidden]) .source-surface:not([hidden]) .cm-content");
  await expect(source).toBeVisible();
  assert.equal((await source.locator(".cm-line").allTextContents()).join("\n"), content);
  assert.equal(await readFile(file, "utf8"), content);
  await page.locator(".source-toggle").click();
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

  const small = await readFile(path.join(root, "small.jpg"));
  for (const name of ["held", "cancelled", "ready"]) await writeFile(path.join(root, `${name}.jpg`), small);
  const readyBytes = await app.evaluate(async ({ session }, encoded) => {
    const require = process.getBuiltinModule("module").createRequire(process.cwd() + "/package.json");
    const assert = require("node:assert/strict");
    const { DocumentStore } = require("./electron/store.mjs");
    const { Readable } = require("node:stream");
    const files = require("node:fs/promises"), { syncBuiltinESMExports } = require("node:module");
    const asset = DocumentStore.prototype.asset, readFile = files.readFile, fromWeb = Readable.fromWeb;
    const lookup = Promise.withResolvers(), missingStarted = Promise.withResolvers();
    const heldStarted = Promise.withResolvers();
    const opened = [];
    DocumentStore.prototype.asset = async function (...args) {
      if (args[1] === "missing.jpg") { missingStarted.resolve(); await lookup.promise; }
      return asset.apply(this, args);
    };
    // Cold JPEG bodies are read in one call once their turn comes; observe and hold those reads.
    files.readFile = function (file, ...args) {
      const name = typeof file === "string" ? file.split(/[\\/]/).pop() : "";
      if (["held.jpg", "cancelled.jpg", "ready.jpg"].includes(name)) opened.push(name);
      if (name === "held.jpg") return new Promise(resolve => heldStarted.resolve(resolve));
      return readFile.call(this, file, ...args);
    };
    syncBuiltinESMExports();
    const request = (name, signal = AbortSignal.timeout(10_000)) => session.defaultSession.fetch(`omarkie-asset://local/photo/${name}.jpg?preview=800`, { signal });
    const cancel = new AbortController();
    try {
      const missing = request("missing");
      await Promise.race([missingStarted.promise, missing.then(() => assert.fail("missing lookup did not block"))]);
      const first = await request("held");
      const firstBody = first.arrayBuffer();
      const held = await Promise.race([heldStarted.promise, firstBody.then(() => assert.fail("held body finished early"))]);
      const disconnected = Promise.withResolvers();
      Readable.fromWeb = function (...args) {
        const stream = fromWeb.apply(this, args);
        stream.once("close", disconnected.resolve);
        Readable.fromWeb = fromWeb;
        return stream;
      };
      const abandoned = await request("cancelled", AbortSignal.any([cancel.signal, AbortSignal.timeout(10_000)]));
      const surviving = await request("ready");
      assert.deepEqual(opened, ["held.jpg"], "waiting responses do not open files");
      const cancelledBody = assert.rejects(abandoned.arrayBuffer(), { name: "AbortError" });
      cancel.abort();
      await cancelledBody;
      // Client rejection precedes Electron's asynchronous protocol disconnect.
      await Promise.race([disconnected.promise, new Promise((_, reject) => {
        AbortSignal.timeout(10_000).addEventListener("abort", () => reject(new Error("Cancelled client did not disconnect the protocol stream")));
      })]);
      held(Buffer.from(encoded, "base64"));
      assert.equal(Buffer.from(await firstBody).toString("base64"), encoded);
      const bytes = Buffer.from(await surviving.arrayBuffer()).toString("base64");
      assert.deepEqual(opened, ["held.jpg", "ready.jpg"], "cancelled waiter never opens its file");
      assert.equal(bytes, encoded, "ready JPEG arrives while missing lookup is held");
      lookup.resolve();
      assert.equal((await missing).status, 404);
      return bytes;
    } finally {
      cancel.abort();
      lookup.resolve();
      files.readFile = readFile; syncBuiltinESMExports();
      Readable.fromWeb = fromWeb;
      DocumentStore.prototype.asset = asset;
    }
  }, small.toString("base64"));
  const { info } = await sharp(Buffer.from(readyBytes, "base64")).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [96, 48], "ready JPEG decodes");
  console.log("PASS: cold queue, warm WebP, EXIF, reading width and scale limits, explicit and inline sizes, source and export");
} finally { await app.close(); }
