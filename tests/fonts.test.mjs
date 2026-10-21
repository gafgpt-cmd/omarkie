import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultFonts, fontChoices, fontCss, fontIds } from "../src/fonts.ts";
import { toggledTheme } from "../src/omarchyTheme.ts";
import { toyporaThemes } from "../src/toyporaTheme.ts";
import { watchOmarchyTheme } from "../electron/omarchy.mjs";

test("font catalog covers the classic reading fonts and Omarchy defaults", () => {
  const names = fontChoices(null).map(font => font.name);
  for (const name of ["Literata", "Inter", "Open Sans", "PT Serif", "Merriweather", "Lato", "Vollkorn", "Helvetica Neue", "Lucida Console", "JetBrainsMono Nerd Font", "Liberation Sans", "Liberation Serif"]) assert.ok(names.includes(name), name);
  for (const font of fontChoices(null)) assert.match(font.stack, /"Noto Color Emoji"/);
  assert.deepEqual(fontIds.slice(0, 1), ["theme"]);
});

test("theme defaults only style the interface through the theme's --chrome-font", () => {
  const css = fontCss(defaultFonts, "Iosevka");
  assert.match(css, /^:root:not\(#_\) :is\(\.toolbar,\.menu-bar,.*\)\{font-family:var\(--chrome-font,"Open Sans"/);
  assert.doesNotMatch(css, /--document-font|Iosevka/);
  assert.match(fontCss({ ...defaultFonts, interfaceFont: "inter" }, null), /:root:not\(#_\)\{--chrome-font:Inter,/);
});

test("chosen fonts override text, headings and code, and follow the live Omarchy font", () => {
  const css = fontCss({ documentFont: "merriweather", headingFont: "lato", codeFont: "omarchy" }, "Iosevka Term");
  assert.match(css, /--document-font:Merriweather,/);
  assert.match(css, /:is\(h1,h2,h3,h4,h5,h6\)\{font-family:Lato,/);
  assert.match(css, /\.source-mode \.cm-scroller\{font-family:"Iosevka Term","JetBrainsMono Nerd Font"/);
  assert.match(fontCss({ ...defaultFonts, codeFont: "omarchy" }, null), /font-family:"JetBrainsMono Nerd Font"/);
  assert.doesNotMatch(fontCss({ ...defaultFonts, documentFont: "</style><script>" }, null), /script|--document-font/);
});

test("Toypora keeps the classic reading set and toggles light/night", () => {
  const [light, night] = toyporaThemes;
  assert.equal(light.name, "Toypora");
  assert.match(light.css, /--paper:#ffffff;.*--ink:#333333;.*--accent:#4183c4/);
  assert.match(light.css, /--document-font:"Open Sans"/);
  assert.equal(night.dark, true);
  assert.equal(toggledTheme("toypora"), "toypora-night");
  assert.equal(toggledTheme("toypora-night"), "toypora");
});

test("watcher reports Omarchy font changes from fonts.conf", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkdown-fonts-"));
  const fonts = path.join(root, "fontconfig"); await mkdir(fonts);
  let stop = () => {};
  try {
    const changed = new Promise(resolve => { stop = watchOmarchyTheme(resolve, path.join(root, "missing"), fonts); });
    await writeFile(path.join(fonts, "fonts.conf"), "<fontconfig/>", "utf8");
    await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error("no change event")), 3000))]);
  } finally { stop(); await rm(root, { recursive: true, force: true }); }
});

test("cross themes: Omarchy colours with classic fonts, classic colours with the live Omarchy font", async () => {
  const { toyporaOmarchyTheme } = await import("../src/omarchyTheme.ts");
  const { omarchyFontsTheme } = await import("../src/toyporaTheme.ts");
  const omarchy = toyporaOmarchyTheme({ mode: "dark", font: "Iosevka", colors: { background: "#101010", foreground: "#eeeeee", accent: "#ff8800" } });
  assert.equal(omarchy.id, "omarchy-toypora");
  assert.match(omarchy.css, /--paper:#101010;.*--accent:#ff8800/);
  assert.match(omarchy.css, /--document-font:"Open Sans"/);
  assert.doesNotMatch(omarchy.css, /Iosevka|border-radius:0/);
  const classic = omarchyFontsTheme("Iosevka");
  assert.equal(classic.id, "toypora-omarchy");
  assert.match(classic.css, /--paper:#ffffff;.*--accent:#4183c4/);
  assert.match(classic.css, /--document-font:"Liberation Sans"/);
  assert.match(classic.css, /--chrome-font:"Iosevka","JetBrainsMono Nerd Font"/);
  assert.equal(toggledTheme("omarchy-toypora", true), "omarchy-light");
  assert.equal(toggledTheme("toypora-omarchy"), "toypora-night");
});

test("Toyzetlr pairs Literata text with Inter headings and chrome, light and night", async () => {
  const { toyzetlrThemes } = await import("../src/toyzetlrTheme.ts");
  const [light, night] = toyzetlrThemes;
  assert.equal(light.name, "Toyzetlr");
  assert.match(light.css, /--document-font:Literata,.*--chrome-font:Inter,/);
  assert.match(light.css, /h6\)\{font-family:Inter,/);
  assert.match(light.css, /max-width:760px/);
  assert.equal(night.dark, true);
  assert.equal(toggledTheme("toyzetlr"), "toyzetlr-night");
});

test("a custom text font leaves code blocks and their inline editors to the code font", () => {
  const css = fontCss({ ...defaultFonts, documentFont: "merriweather" }, null);
  const textRule = css.split("}").find(rule => rule.includes("font-family:Merriweather"));
  assert.match(textRule, /:is\(\.rich-document,\.print-document\)\{font-family:Merriweather/);
  assert.doesNotMatch(textRule, /cm-scroller|cm-content|code|pre/);
});
