import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://editor.test/" });
for (const key of ["window", "document", "Node", "HTMLElement", "Element", "DOMParser"]) globalThis[key] = dom.window[key];
const { renderMarkdown, setMarkdownOptions } = await import("../src/editor/markdown.ts");
const { defaultPreferences } = await import("../src/preferences.ts");

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
    '<div><video controls><source src="clip.mp4"><track src="http://tracker.example/t.vtt"></video></div>',
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
  const local = renderMarkdown('<div><video controls src="clip.mp4"></video></div>', "doc");
  assert.match(local, /<video[^>]+src="omarkie-asset:\/\/local\/doc\/clip\.mp4"/);
  setMarkdownOptions({ ...defaultPreferences, remoteImages: true });
  assert.match(renderMarkdown(embeds[0], "doc"), /<video[^>]+src="https:\/\/tracker\.example\/v\.mp4"/);
  assert.match(renderMarkdown(embeds[1], "doc"), /<source[^>]+src="https:\/\/tracker\.example\/p\.mp3"/);
  assert.match(renderMarkdown(embeds[3], "doc"), /<iframe[^>]+src="https:\/\/tracker\.example\/embed"/);
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
