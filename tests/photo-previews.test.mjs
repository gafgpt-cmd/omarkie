import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, stat, rename, utimes } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { PhotoPreviews, previewKey, previewBucket, evictPreviews } from "../electron/photo-previews.mjs";

test("preview buckets and keys bound widths and invalidate changed originals", () => {
  assert.deepEqual([0, 800, 801, 1201, 1601, 9000].map(previewBucket), [800, 800, 1200, 1600, 2400, 2400]);
  const info = { mtimeMs: 123, size: 456 }, key = previewKey("/a.jpg", info, 801);
  assert.equal(key, previewKey("/a.jpg", info, 1200));
  for (const other of [previewKey("/b.jpg", info, 1200), previewKey("/a.jpg", { ...info, size: 457 }, 1200), previewKey("/a.jpg", { ...info, mtimeMs: 124 }, 1200), previewKey("/a.jpg", info, 1600)]) assert.notEqual(key, other);
});

test("cache coalesces work, survives restart, invalidates changes, preserves originals and falls back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-preview-")), file = path.join(root, "photo.jpg"), directory = path.join(root, "cache");
  await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "red" } }).jpeg().toFile(file);
  const original = await readFile(file); let calls = 0;
  const generate = async (file, width) => { calls++; return sharp(file).resize({ width }).webp().toBuffer(); };
  const trash = file => rename(file, file + ".trashed");
  const cache = new PhotoPreviews(directory, generate, trash);
  const [first, duplicate] = await Promise.all([cache.get(file, 800), cache.get(file, 800)]);
  assert.equal(first, file); assert.equal(duplicate, file);
  await Promise.all(cache.pending.values());
  const cached = await cache.get(file, 800); assert.equal(calls, 1);
  assert.equal((await sharp(cached).metadata()).width, 800);
  assert.equal(await new PhotoPreviews(directory, generate, trash).get(file, 800), cached); assert.equal(calls, 1);
  assert.deepEqual(await readFile(file), original);
  const info = await stat(file); await utimes(file, new Date(), new Date(info.mtimeMs + 2000));
  assert.notEqual(await cache.get(file, 800), cached); await Promise.all(cache.pending.values()); assert.equal(calls, 2);
  assert.equal(await cache.get(file, 17), file);
  assert.equal(await cache.get(file + ".gif", 800), file + ".gif");
  const failed = new PhotoPreviews(path.join(root, "failed"), async () => { throw Error("decode"); }, trash);
  assert.equal(await failed.get(file, 800), file); await Promise.all(failed.pending.values());
  const tiny = path.join(root, "tiny.jpg"); await sharp(original).resize(100).toFile(tiny);
  assert.equal(await cache.get(tiny, 800), tiny); await Promise.all(cache.pending.values()); assert.equal(calls, 2);
});

test("eviction removes least recently used previews and ignores unrelated files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-preview-lru-"));
  const names = ["a", "b", "c"].map(letter => letter.repeat(64) + (letter === "b" ? ".jpg" : ".webp"));
  for (const [index, name] of names.entries()) { const file = path.join(root, name); await writeFile(file, Buffer.alloc(10)); await utimes(file, new Date(), new Date(1000 * (index + 1))); }
  await writeFile(path.join(root, "keep"), "unrelated");
  const removed = [];
  await evictPreviews(root, 20, async file => { removed.push(path.basename(file)); await rename(file, file + ".trashed"); });
  assert.deepEqual(removed, [names[0]]);
  assert.ok((await readdir(root)).includes("keep"));
});

test("renderer selects previews while HTML and portable export retain original bytes", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://editor.test/" });
  for (const key of ["window", "document", "Node", "HTMLElement", "Element", "DOMParser", "NodeFilter", "FileReader"]) globalThis[key] = dom.window[key];
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Electron/43.0.0" }, configurable: true });
  const { renderMarkdown } = await import("../src/editor/markdown.ts");
  const { MarkdownDocument } = await import("../src/editor/model.ts");
  const { renderNode } = await import("../src/editor/richRender.ts");
  const model = new MarkdownDocument("![camera](camera.jpg)");
  const rendered = renderNode(model.nodes[0], "photo", new Map());
  assert.match(rendered.querySelector("img").srcset, /preview=800/);
  const { exportHtml, portableHtml } = await import("../src/editor/print.ts");
  const content = document.createElement("article");
  content.innerHTML = renderMarkdown("![camera](camera.jpg)\n\n<img src=\"portrait.jpeg\">\n\n![animated](clip.gif)", "photo");
  const images = [...content.querySelectorAll("img")];
  for (const image of images.slice(0, 2)) {
    assert.equal(image.getAttribute("sizes"), "auto");
    assert.equal(image.src.includes("preview="), false);
    assert.match(image.srcset, /\?preview=800 800w.*\?preview=2400 2400w/);
  }
  assert.equal(images[2].hasAttribute("srcset"), false);
  const html = exportHtml(content);
  assert.equal(html.includes("preview="), false); assert.ok(html.includes(images[0].src));
  const requested = [];
  window.desktop = { readResource: async address => { requested.push(address); return { ok: true, value: { mime: "image/jpeg", base64: "b3JpZ2luYWw=" } }; } };
  const portable = await portableHtml(content, "Photo");
  assert.deepEqual(requested, images.map(image => image.src));
  assert.ok(portable.includes("data:image/jpeg;base64,b3JpZ2luYWw="));
  assert.equal(portable.includes("preview="), false);
  assert.ok(images[0].srcset, "export does not mutate editor images");
});
