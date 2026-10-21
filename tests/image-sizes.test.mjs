import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { imageSizes } from "../electron/resources.mjs";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNNsAAAAASUVORK5CYII=", "base64");
const sharp = createRequire(import.meta.url)("sharp");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-sizes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { DocumentStore } = await import("../electron/store.mjs");
  const store = new DocumentStore(path.join(root, "session"));
  await mkdir(path.join(root, "docs", "images"), { recursive: true });
  const file = path.join(root, "docs", "notes.md");
  await writeFile(file, "# Images");
  const record = await store.open(file);
  await writeFile(path.join(root, "docs", "images", "one.png"), png);
  await writeFile(path.join(root, "docs", "images", "wide.jpg"), await sharp({ create: { width: 30, height: 20, channels: 3, background: "#f00" } }).jpeg().toBuffer());
  // Stored landscape, displayed portrait: EXIF orientation 6 is a quarter turn.
  await writeFile(path.join(root, "docs", "images", "portrait.jpg"), await sharp({ create: { width: 30, height: 20, channels: 3, background: "#0f0" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer());
  await writeFile(path.join(root, "docs", "images", "vector.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"></svg>');
  await writeFile(path.join(root, "docs", "images", "clip.mp4"), Buffer.alloc(64));
  await writeFile(path.join(root, "outside.png"), png);
  return { root, store, record };
}

test("sizes come from file headers, honour EXIF rotation and skip anything the asset scope rejects", async t => {
  const f = await fixture(t);
  const sizes = await imageSizes(f.store, f.record.id, [
    "images/one.png", "images/wide.jpg", "images/portrait.jpg", "images/vector.svg", "images/clip.mp4",
    "images/missing.png", "../outside.png", "https://example.com/remote.png", "images/one.png",
  ]);
  // The asset protocol's scope: local image files reachable from the document, parent folders included.
  assert.deepEqual(sizes, {
    "images/one.png": [1, 1],
    "images/wide.jpg": [30, 20],
    "images/portrait.jpg": [20, 30],
    "images/vector.svg": [64, 48],
    "../outside.png": [1, 1],
  });
});

test("the request is validated like every other document call", async t => {
  const f = await fixture(t);
  await assert.rejects(imageSizes(f.store, f.record.id, "images/one.png"), /图片路径不可用/);
  await assert.rejects(imageSizes(f.store, f.record.id, ["images/one.png", 7]), /图片路径不可用/);
  await assert.rejects(imageSizes(f.store, "no-such-document", ["images/one.png"]));
  assert.deepEqual(await imageSizes(f.store, f.record.id, []), {});
});

test("the renderer keys announced sizes the way the image rule looks them up", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://editor.test/" });
  for (const key of ["window", "document", "Node", "HTMLElement", "Element", "DOMParser", "NodeFilter"]) globalThis[key] = dom.window[key];
  const { rememberImageSizes, renderMarkdown, localImageSources } = await import("../src/editor/markdown.ts");
  const text = "![a](images/one.png)\n\n![b](<images/my photo.jpg>)\n\n<img src=\"images/vector.svg\">\n\n![r](https://example.com/x.png) ![d](data:image/png;base64,AAAA) ![f](file:///tmp/x.png)\n";
  assert.deepEqual(localImageSources(text), ["images/one.png", "images/my photo.jpg", "images/vector.svg", "file:///tmp/x.png"]);
  rememberImageSizes("doc-1", { "images/one.png": [1, 1], "images/my photo.jpg": [30, 20], "images/vector.svg": [64, 48] });
  const html = renderMarkdown(text, "doc-1");
  assert.match(html, /images%2Fone\.png" alt="a" loading="lazy" decoding="async" width="1" height="1"/);
  assert.match(html, /images%2Fmy%2520photo\.jpg" alt="b" loading="lazy" decoding="async" width="30" height="20"/);
  assert.match(html, /vector\.svg"[^>]*width="64" height="48"/);
  // Sizes for another document do not leak.
  assert.doesNotMatch(renderMarkdown("![a](images/one.png)", "doc-2"), /width=/);
});
