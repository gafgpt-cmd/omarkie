import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseOmarchyColors, readOmarchyTheme } from "../electron/omarchy.mjs";
import { omarchyTheme, toggledTheme } from "../src/omarchyTheme.ts";

test("Omarchy colors parse only flat hex values", () => {
  const palette = parseOmarchyColors('mode = "light"\naccent = "#205EA6"\nbackground = "#fffcf0"\nforeground = "#100f0f"\nred = "red;}body{x"\nblue = "#12345"\n# cyan = "#000000"\n');
  assert.deepEqual(palette, { mode: "light", colors: { accent: "#205ea6", background: "#fffcf0", foreground: "#100f0f" } });
  assert.equal(parseOmarchyColors('accent = "#7aa2f7"\n'), null);
});

test("Omarchy theme reads the current palette and tolerates a missing install", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-omarchy-"));
  try {
    assert.equal(await readOmarchyTheme(root), null);
    await mkdir(path.join(root, "theme"));
    await writeFile(path.join(root, "theme", "colors.toml"), 'accent = "#7aa2f7"\nbackground = "#1a1b26"\nforeground = "#a9b1d6"\n', "utf8");
    const theme = await readOmarchyTheme(root);
    assert.equal(theme.mode, "dark");
    assert.equal(theme.colors.accent, "#7aa2f7");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Omarchy theme follows palette mode and toggles within the family", () => {
  const light = omarchyTheme({ mode: "light", font: "Iosevka", colors: { background: "#ffffff", foreground: "#000000", accent: "#6e6e6e" } });
  assert.equal(light.dark, false);
  assert.match(light.css, /color-scheme:light/);
  assert.match(light.css, /--chrome-font:"Iosevka"/);
  assert.match(light.css, /--paper:#ffffff/);
  const noOrange = omarchyTheme({ mode: "light", font: null, colors: { background: "#ffffff", foreground: "#000000", accent: "#6e6e6e", yellow: "#4a4a4a" } });
  assert.match(noOrange.css, /\.hljs-literal\{color:#4a4a4a\}/);
  assert.equal(toggledTheme("omarchy"), "omarchy-light");
  assert.equal(toggledTheme("omarchy", false), "omarchy-dark");
  assert.equal(toggledTheme("omarchy-light"), "omarchy-dark");
  assert.equal(toggledTheme("omarchy-rose-pine"), "omarchy-rose-pine-dawn");
  assert.equal(toggledTheme("omarchy-rose-pine-dawn"), "omarchy-rose-pine");
  assert.equal(toggledTheme("light"), "dark");
});
