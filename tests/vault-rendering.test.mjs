import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://editor.test/" });
for (const key of ["window", "document", "DOMParser", "HTMLElement", "Node"]) globalThis[key] = dom.window[key];
const { renderMarkdown } = await import("../src/editor/markdown.ts");
const { MarkdownDocument } = await import("../src/editor/model.ts");
const { renderNode } = await import("../src/editor/richRender.ts");
const { imageReferences } = await import("../src/editor/images.ts");
test("wiki aliases and tags render authorized application links without source rewriting", () => {
  const source = '---\ntype: Reference\n---\n# Start\n\n[[Other note#Heading|Visible alias]] #nested/tag `[[literal]] #not-tag` \\#escaped\n';
  const holder = document.createElement("article"); holder.innerHTML = renderMarkdown(source, "fixture");
  assert.equal(holder.querySelector('a[href^="omarkie-wiki:"]').textContent, "Visible alias");
  assert.equal(decodeURIComponent(holder.querySelector('a[href^="omarkie-wiki:"]').getAttribute("href").slice(13)), "Other note#Heading");
  assert.deepEqual([...holder.querySelectorAll('a[href^="omarkie-tag:"]')].map(anchor => anchor.textContent), ["#nested/tag"]);
  const model = new MarkdownDocument(source), leaves = new Map();
  for (const node of model.nodes) holder.append(renderNode(node, "fixture", leaves, model.environment));
  assert.equal(model.toMarkdown(), source);
  assert.ok(holder.querySelector('.md-view a[href^="omarkie-wiki:"]'));
  assert.equal(renderMarkdown('[unsafe](javascript:alert(1))').includes('href="javascript:'), false);
});
test("wiki image aliases/dimensions and raw-space references share export image inventory", () => {
  const source = '![[my picture.png|300x200]]\n![[folder/another.png|Caption]]\n![raw](folder/raw space.png)\n`![[ignored.png]]`\n';
  const images = imageReferences(source);
  assert.deepEqual(images.map(image => image.url), ["my picture.png", "folder/another.png", "folder/raw space.png"]);
  assert.equal(images[0].width, "300"); assert.equal(images[0].height, "200"); assert.equal(images[1].alt, "Caption");
  for (const image of images) assert.equal(source.slice(image.from, image.to), image.source);
});
