import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://editor.test/" });
for (const key of ["window", "document", "Node", "HTMLElement", "Element", "DOMParser"]) globalThis[key] = dom.window[key];
const { renderMarkdown, setMarkdownOptions } = await import("../src/editor/markdown.ts");
const { defaultPreferences } = await import("../src/preferences.ts");

test("offline HTML drops CSS image sources but preserves explicit sizing", () => {
  const source = `<div><style>.picture { background: url(https://tracker.example/style) }</style><img src="local.png" style='width: 180px; max-width: calc(100% - 2rem); background-image: image-set("https://tracker.example/set" 1x); cursor: u\\72l(https://tracker.example/cursor), auto'></div>`;
  const parsed = document.createElement("template");
  setMarkdownOptions(defaultPreferences);
  parsed.innerHTML = renderMarkdown(source, "doc");
  const image = parsed.content.querySelector("img");
  assert.equal(image.style.width, "180px");
  assert.equal(image.style.maxWidth, "calc(100% - 2rem)");
  assert.equal(image.getAttribute("style").trim(), "width: 180px; max-width: calc(100% - 2rem)");
  assert.equal(parsed.content.querySelector("style"), null);
  assert.doesNotMatch(parsed.innerHTML, /tracker\.example/);
  parsed.innerHTML = renderMarkdown(`<div><img src="local.png" style='--figure-width: 180px; width: var(--figure-width, 160px); --unsafe: image-set("https://tracker.example/hidden" 1x)'></div>`, "doc");
  const sized = parsed.content.querySelector("img");
  assert.equal(sized.style.getPropertyValue("--figure-width"), "180px");
  assert.equal(sized.style.width, "var(--figure-width, 160px)");
  assert.doesNotMatch(parsed.innerHTML, /tracker\.example/);
});

test("offline HTML classifies URLs after browser whitespace normalization", () => {
  setMarkdownOptions(defaultPreferences);
  const fixture = '<div><img src="h&#9;ttp://tracker.example/a"><img src="a&#9;b.png" srcset="local.png 1x, ht&#13;tp://tracker.example/b 2x"><video src="a&#9;b.mp4" poster="h&#10;ttp://tracker.example/c"></video><input type="image" src="&#1;http://tracker.example/d"><svg><image href="h&#9;ttp://tracker.example/e"/></svg></div>';
  const parsed = document.createElement("template");
  parsed.innerHTML = renderMarkdown(fixture, "doc");
  assert.equal(parsed.content.querySelectorAll("img").length, 1);
  assert.equal(parsed.content.querySelector("img").getAttribute("src"), "omarkie-asset://local/doc/a%09b.png");
  assert.equal(parsed.content.querySelector("img").getAttribute("srcset"), "omarkie-asset://local/doc/local.png 1x");
  assert.equal(parsed.content.querySelector("video").getAttribute("src"), "omarkie-asset://local/doc/a%09b.mp4");
  assert.equal(parsed.content.querySelector("video").hasAttribute("poster"), false);
  for (const image of parsed.content.querySelectorAll("input, svg image")) assert.equal(image.getAttribute("src") ?? image.getAttribute("href"), null);
});

test("remote images stay blocked unless the user enables them", () => {
  const source = "![pixel](https://tracker.example/p.gif)";
  assert.equal(defaultPreferences.remoteImages, false);
  setMarkdownOptions(defaultPreferences);
  assert.doesNotMatch(renderMarkdown(source), /<img/);
  setMarkdownOptions({ ...defaultPreferences, remoteImages: true });
  assert.match(renderMarkdown(source), /<img[^>]+src="https:\/\/tracker\.example\/p\.gif"/);
  setMarkdownOptions(defaultPreferences);
});

test("remote video, audio, source and iframe embeds stay blocked unless the user enables remote images", () => {
  const embeds = [
    '<div><video src="https://tracker.example/v.mp4" controls></video></div>',
    '<div><audio controls><source src="https://tracker.example/p.mp3"></audio></div>',
    '<div><iframe src="https://tracker.example/embed"></iframe></div>',
  ];
  const remote = /(?:src|srcset|poster)="\s*https?:/i;
  setMarkdownOptions(defaultPreferences);
  for (const embed of embeds) {
    const html = renderMarkdown(embed, "doc");
    assert.doesNotMatch(html, remote, embed);
    assert.doesNotMatch(html, /<(?:video|audio|iframe|source|track)\b/i, embed);
    assert.match(html, /class="remote-image"[^>]*>[^<]*tracker\.example/, embed);
  }
  const mixed = document.createElement("template");
  mixed.innerHTML = renderMarkdown('<div><video src="https://tracker.example/first.mp4" poster="local.png"><source src="https://tracker.example/second.mp4"><source src="clip.mp4"><track src="https://tracker.example/captions.vtt"></video><picture><source srcset="data:image/png;base64,AA== 1x, https://tracker.example/p.png 2x"><img src="https://tracker.example/fallback.png"></picture></div>', "doc");
  assert.equal(mixed.content.querySelector("video source").getAttribute("src"), "omarkie-asset://local/doc/clip.mp4");
  assert.equal(mixed.content.querySelector("video").getAttribute("poster"), "omarkie-asset://local/doc/local.png");
  assert.equal(mixed.content.querySelector("picture source").getAttribute("srcset"), "data:image/png;base64,AA== 1x");
  assert.ok(mixed.content.querySelector("picture img:not([src])"));
  assert.doesNotMatch(mixed.innerHTML, /tracker\.example/);
  const local = renderMarkdown('<div><video controls src="clip.mp4"></video></div>', "doc");
  assert.match(local, /<video[^>]+src="omarkie-asset:\/\/local\/doc\/clip\.mp4"/);
  setMarkdownOptions({ ...defaultPreferences, remoteImages: true });
  assert.match(renderMarkdown(embeds[0], "doc"), /<video[^>]+src="https:\/\/tracker\.example\/v\.mp4"/);
  assert.match(renderMarkdown(embeds[1], "doc"), /<source[^>]+src="https:\/\/tracker\.example\/p\.mp3"/);
  assert.match(renderMarkdown(embeds[2], "doc"), /<iframe[^>]+src="https:\/\/tracker\.example\/embed"/);
  setMarkdownOptions(defaultPreferences);
});

test("table backgrounds, image inputs and SVG images stay blocked unless the user enables remote images", () => {
  const embeds = [
    '<table background="https://tracker.example/t.gif"><tr><td background="http://tracker.example/c.gif">cell</td></tr></table>',
    '<div><input type="image" src="https://tracker.example/i.gif"></div>',
    '<div><svg><image href="https://tracker.example/s.svg"></image><image xlink:href="https://tracker.example/x.svg"></image></svg></div>',
  ];
  setMarkdownOptions(defaultPreferences);
  for (const embed of embeds) assert.doesNotMatch(renderMarkdown(embed, "doc"), /tracker\.example/, embed);
  setMarkdownOptions({ ...defaultPreferences, remoteImages: true });
  for (const embed of embeds) assert.match(renderMarkdown(embed, "doc"), /tracker\.example/, embed);
  setMarkdownOptions(defaultPreferences);
});
