import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JSDOM } from "jsdom";
import { references, referenceIndex, bundlePlan } from "../shared/references.mjs";
import { DocumentStore } from "../electron/store.mjs";
import { vaultSnapshot, exportBundle } from "../electron/document-workflows.mjs";
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://editor.test/" });
for (const key of ["window", "document", "DOMParser", "HTMLElement", "Node"]) globalThis[key] = dom.window[key];
const { renderMarkdown, extractHeadings, localImageSources } = await import("../src/editor/markdown.ts");
const { imageReferences } = await import("../src/editor/images.ts");
const { conversionMarkdown } = await import("../src/editor/print.ts");
const { MarkdownDocument } = await import("../src/editor/model.ts");
const { renderNode } = await import("../src/editor/richRender.ts");
const note = (relative, content) => ({ relative, content, token: relative });
const snapshot = (content, assets = [], notes = []) => ({ notes: [note("start.md", content), ...notes], assets: assets.map(relative => ({ relative })), truncated: false });

test("copied media keeps element types, HTML attributes and resource bytes", async () => {
  const original = '![[clip.mp4|320x200]]\n\n![[sound.mp3]]\n\n<video controls class="keep" src="other.webm" width="450"></video>\n\n<audio controls><source src=voice.ogg type="audio/ogg"></audio>\n\n<img src="a&amp;b.png" alt="A &amp; B" width="120">\n';
  const files = ["clip.mp4", "sound.mp3", "other.webm", "voice.ogg", "a&b.png"];
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "reference-media-"))), vault = path.join(root, "vault"), output = path.join(root, "output");
  await mkdir(vault); await mkdir(output); await writeFile(path.join(vault, "start.md"), original);
  for (const file of files) await writeFile(path.join(vault, file), Buffer.from("synthetic resource: " + file));
  const store = new DocumentStore(path.join(root, "profile")); await store.scan(vault);
  const inventory = await vaultSnapshot(store), index = referenceIndex(inventory);
  assert.deepEqual(index.broken, []); assert.deepEqual(index.unused, []);
  const plan = bundlePlan(inventory), destination = await exportBundle(store, plan, output);
  assert.deepEqual(plan.assets.map(asset => asset.source).sort(), files.sort());
  const copy = await readFile(path.join(destination, "notes/start.md"), "utf8"), article = document.createElement("article"); article.innerHTML = renderMarkdown(copy, "bundle");
  assert.equal(article.querySelectorAll("video").length, 2);
  assert.equal(article.querySelectorAll("audio").length, 2);
  assert.equal(article.querySelectorAll("source").length, 1);
  assert.equal(article.querySelectorAll("img").length, 1);
  assert.equal(article.querySelector("video").getAttribute("width"), "320");
  assert.equal(article.querySelector("video.keep").getAttribute("width"), "450");
  assert.equal(article.querySelector("source").getAttribute("type"), "audio/ogg");
  assert.equal(article.querySelector("img").getAttribute("alt"), "A & B");
  const inline = "Inline ![[clip.mp4]] and ![[sound.mp3]] after.";
  for (const [content, count] of [[original, 2], [copy, 2], [inline, 1], [bundlePlan(snapshot(inline, files)).notes[0].content, 1]]) {
    const model = new MarkdownDocument(content), rich = document.createElement("article"), leaves = new Map();
    for (const node of model.nodes) rich.append(renderNode(node, "bundle", leaves, model.environment));
    assert.equal(rich.querySelectorAll("video").length, count);
    assert.equal(rich.querySelectorAll("audio").length, count);
    assert.equal(model.toMarkdown(), content);
  }
  for (const element of article.querySelectorAll("[src]")) {
    const uri = element.getAttribute("src"), relative = decodeURIComponent(new URL(uri).pathname.split("/").slice(2).join("/"));
    const file = decodeURIComponent(relative);
    assert.equal(await readFile(path.resolve(destination, "notes", file), "utf8"), "synthetic resource: " + path.basename(file));
  }
  for (const asset of plan.assets) assert.deepEqual(await readFile(path.join(destination, asset.relative)), await readFile(path.join(vault, asset.source)));
  assert.equal(await readFile(path.join(vault, "start.md"), "utf8"), original);
});

test("literal wiki percent names, URI escapes and HTML entities keep distinct destinations", () => {
  const source = '[[100% sure]] [[name%20literal]]\n\n[URI](name%20literal.md)\n\n<img src="a&amp;b.png">\n';
  const value = snapshot(source, ["a&b.png"], [note("100% sure.md", ""), note("name%20literal.md", ""), note("name literal.md", "")]);
  const index = referenceIndex(value), from = index.notes[0];
  assert.deepEqual(index.broken, []); assert.deepEqual(index.unused, []);
  assert.equal(index.resolve(from, "100% sure", true).candidates[0].relative, "100% sure.md");
  assert.equal(index.resolve(from, "name%20literal", true).candidates[0].relative, "name%20literal.md");
  assert.equal(index.resolve(from, "name%20literal.md", false).candidates[0].relative, "name literal.md");
  assert.equal(index.resolve(from, "bad%ZZ.md", false).state, "invalid");
  assert.equal(index.resolve(from, "../outside", true).state, "escape");
  assert.equal(index.resolve(from, "%2e%2e/outside", false).state, "escape");
  assert.equal(index.resolve(from, "file:///outside.md", true).state, "escape");
  const plan = bundlePlan(value), article = document.createElement("article"); article.innerHTML = renderMarkdown(plan.notes[0].content, "copy");
  assert.deepEqual([...article.querySelectorAll("a")].map(link => link.getAttribute("href")), ["../notes/100%25%20sure.md", "../notes/name%2520literal.md", "../notes/name%20literal.md"]);
  assert.equal(decodeURIComponent(new URL(article.querySelector("img").getAttribute("src")).pathname.split("/").at(-1)), "../assets/a%26b.png");
  assert.equal(value.notes[0].content, source);
});

test("wiki heading display, outline, rich rendering, index and copied anchors agree", () => {
  const source = '# [[Project|Overview]]\n\n# [[Project|Overview]]\n\n## [[Project]] **Bold** `Code` #topic\n\n# [[Project|   ]]\n\n# [[Project|]]\n\n# [[Project|**Overview** &amp; :smile: $x$]]\n';
  const expected = [{ text: "Overview", id: "overview" }, { text: "Overview", id: "overview-1" }, { text: "Project Bold Code #topic", id: "project-bold-code-topic" }, { text: "Project", id: "project" }, { text: "Project", id: "project-1" }, { text: "**Overview** &amp; :smile: $x$", id: "overview-amp-smile-x" }];
  const value = snapshot('[[headings#Overview]]\n[[headings#overview-1]]\n', [], [note("headings.md", source), note("Project.md", "# Project\n")]);
  assert.deepEqual(extractHeadings(source).map(({ text, id }) => ({ text, id })), expected);
  const index = referenceIndex(value);
  assert.deepEqual(index.notes[1].headings.map(({ title, id }) => ({ text: title, id })), expected);
  assert.equal(index.resolve(index.notes[0], "headings#Overview", true).line, 1);
  assert.equal(index.resolve(index.notes[0], "headings#overview-1", true).line, 3);
  const article = document.createElement("article"); article.innerHTML = renderMarkdown(source, "headings");
  assert.deepEqual([...article.querySelectorAll("h1,h2")].map(heading => ({ text: heading.textContent, id: heading.id })), expected);
  const model = new MarkdownDocument(source), leaves = new Map(), rich = document.createElement("article");
  for (const node of model.nodes) rich.append(renderNode(node, "headings", leaves, model.environment));
  assert.deepEqual([...rich.querySelectorAll("h1,h2")].map(heading => heading.id), expected.map(heading => heading.id));
  const plan = bundlePlan(value), copy = plan.notes.find(note => note.relative === "notes/headings.md");
  assert.deepEqual(extractHeadings(copy.content).map(({ text, id }) => ({ text, id })), expected);
  assert.ok(plan.notes[0].content.includes("../notes/headings.md#overview"));
  assert.ok(plan.notes[0].content.includes("../notes/headings.md#overview-1"));
  model.replaceSource(copy.content, "document-command"); assert.equal(model.undo(), true); assert.equal(model.toMarkdown(), source);
});

test("asset membership stays linear without losing ambiguity or copied selection", () => {
  let reads = 0;
  const assets = Array.from({ length: 200 }, (_, index) => ({ get relative() { reads++; return `image-${index}.png`; } }));
  const value = { notes: [note("start.md", Array.from({ length: 100 }, (_, index) => `![image](image-${index}.png)`).join("\n"))], assets, truncated: false };
  const index = referenceIndex(value);
  assert.equal(index.unused.length, 100); assert.ok(reads < 2000, `asset paths read ${reads} times`);
  reads = 0;
  const plan = bundlePlan(value); assert.equal(plan.assets.length, 100); assert.ok(reads < 2500, `copy selection read ${reads} asset paths`);
  const ambiguous = referenceIndex(snapshot("![[photo.png]]", ["a/photo.png", "b/photo.png", "unused.png"]));
  assert.deepEqual(ambiguous.unused.map(asset => asset.relative), ["unused.png"]);
  assert.throws(() => bundlePlan(snapshot("![[photo.png]]", ["a/photo.png", "b/photo.png"])));
  assert.deepEqual(referenceIndex(snapshot("")).unused, []);
});

test("HTML resources accept standard quoting and entities without matching data-src or malformed tags", () => {
  const source = '<img src="a&amp;b.png">\n<video src=clip.mp4></video>\n<audio><source src=\'sound&#46;mp3\'></audio>\n<img data-src="absent.png">\n<img src="unclosed.png>\n';
  assert.deepEqual(references(source).references.map(ref => ref.target), ["a&b.png", "clip.mp4", "sound.mp3"]);
  const unsafe = referenceIndex(snapshot('<video src="..&#47;outside.mp4"></video>\n<img src="bad%ZZ.png">'));
  assert.deepEqual(unsafe.edges.map(edge => edge.state), ["escape", "invalid"]);
  const article = document.createElement("article");
  article.innerHTML = renderMarkdown('Inline <video src="clip.mp4" onerror="alert(1)"></video> <audio src="https://external.test/sound.mp3"></audio>', "fixture");
  assert.equal(article.querySelector("video").hasAttribute("onerror"), false);
  assert.equal(article.querySelectorAll("audio").length, 0);
  assert.deepEqual(references("").references, []);
  assert.throws(() => bundlePlan(snapshot("[[missing]]")));
  assert.throws(() => bundlePlan({ ...snapshot(""), truncated: true }));
});

test("literal wiki image names agree across sizing, rendering, host reads and export", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "reference-percent-images-"))), file = path.join(root, "note.md");
  const source = '![[100% sure.png]]\n![[name%20literal.png]]\n<img src="a&amp;b.png">\n';
  await writeFile(file, source);
  for (const name of ["100% sure.png", "name%20literal.png", "a&b.png"]) await writeFile(path.join(root, name), "synthetic image: " + name);
  const store = new DocumentStore(path.join(root, "profile")), record = await store.open(file);
  const article = document.createElement("article"); article.innerHTML = renderMarkdown(source, record.id);
  const images = imageReferences(source);
  assert.deepEqual(images.map(image => image.url), ["100%25 sure.png", "name%2520literal.png", "a&b.png"]);
  assert.deepEqual(localImageSources(source), images.map(image => image.url));
  for (const image of article.querySelectorAll("img")) {
    const url = decodeURIComponent(new URL(image.getAttribute("src")).pathname.split("/").slice(2).join("/"));
    const asset = await store.asset(record.id, url);
    assert.equal(await readFile(asset, "utf8"), "synthetic image: " + path.basename(asset));
  }
  const previous = window.desktop;
  window.desktop = { readResource: async uri => {
    const url = decodeURIComponent(new URL(uri).pathname.split("/").slice(2).join("/"));
    const bytes = await readFile(await store.asset(record.id, url));
    return { ok: true, value: { mime: "image/png", base64: bytes.toString("base64") } };
  } };
  try {
    const converted = await conversionMarkdown(source, article);
    for (const name of ["100% sure.png", "name%20literal.png", "a&b.png"]) assert.ok(converted.includes(Buffer.from("synthetic image: " + name).toString("base64")));
  } finally { window.desktop = previous; }
  assert.equal(await readFile(file, "utf8"), source);
});

test("supported inventory bounds select referenced assets without timing budgets", () => {
  const value = { notes: Array.from({ length: 1000 }, (_, noteIndex) => note(`note-${noteIndex}.md`, Array.from({ length: 50 }, (_, index) => `![image](image-${noteIndex * 50 + index}.png)`).join("\n"))), assets: Array.from({ length: 50000 }, (_, index) => ({ relative: `image-${index}.png` })), truncated: false };
  const index = referenceIndex(value);
  assert.equal(index.edges.length, 50000); assert.equal(index.unused.length, 0); assert.equal(index.broken.length, 0);
  const plan = bundlePlan(value); assert.equal(plan.assets.length, 50000); assert.equal(plan.notes.length, 1000);
});

test("encoded hash note and image references survive real copied output", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "reference-hashes-"))), vault = path.join(root, "vault"), output = path.join(root, "output");
  await mkdir(vault); await mkdir(output);
  const source = "[Note](note%231.md#heading)\n![Figure](figure%231.png)\n";
  for (const [name, content] of [["start.md", source], ["note#1.md", "# Heading\n"], ["figure#1.png", "synthetic image"]]) await writeFile(path.join(vault, name), content);
  const store = new DocumentStore(path.join(root, "profile")); await store.scan(vault);
  const inventory = await vaultSnapshot(store), index = referenceIndex(inventory); assert.deepEqual(index.broken, []); assert.deepEqual(index.unused, []);
  const destination = await exportBundle(store, bundlePlan(inventory), output), copied = await readFile(path.join(destination, "notes/start.md"), "utf8");
  assert.ok(copied.includes("../notes/note%231.md#heading")); assert.ok(copied.includes("../assets/figure%231.png"));
  assert.equal(await readFile(path.join(destination, "assets/figure#1.png"), "utf8"), "synthetic image");
  assert.equal(await readFile(path.join(vault, "start.md"), "utf8"), source);
});
