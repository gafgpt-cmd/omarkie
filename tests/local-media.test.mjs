import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("", { url: "https://editor.test/" });
globalThis.window = window;
globalThis.document = window.document;
const { editableHtml, renderMarkdown } = await import("../src/editor/markdown.ts");
const blob = "blob:https://editor.test/42d375d8-5688-4d1d-a492-bf92277a8639";
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNNsAAAAASUVORK5CYII=";
const audio = "data:audio/wav;base64,UklGRg==";
const parse = html => {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
};

test("document renders preserve local media sources without allowing blob navigation", () => {
  const source = `<div><img alt="blob" src="${blob}"><img alt="data" src="${pixel}"><img alt="vault" src="photo.png"><video src="${blob}"></video><audio src="${audio}"><source src="${blob}"></audio><a href="${blob}">link</a><a href="${pixel}">data link</a><iframe src="${blob}"></iframe></div>`;
  for (const html of [renderMarkdown(source, "note"), editableHtml(source, "note", () => "", () => "")]) {
    const content = parse(html);
    for (const [selector, url] of [
      ['img[alt="blob"]', blob], ['img[alt="data"]', pixel], ['img[alt="vault"]', "omarkie-asset://local/note/photo.png"],
      ["video", blob], ["audio", audio], ["source", blob],
    ]) assert.equal(content.querySelector(selector)?.getAttribute("src"), url, selector);
    assert.equal(content.querySelectorAll("a[href], iframe[src]").length, 0);
  }
  const inline = parse(renderMarkdown(`Inline <img src="${blob}"> and ![Markdown](${blob})`, "note"));
  assert.deepEqual([...inline.querySelectorAll("img")].map(image => image.getAttribute("src")), [blob, blob]);
});
