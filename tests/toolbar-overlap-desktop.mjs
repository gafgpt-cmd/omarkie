import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as launch, expect } from "playwright/test";
import { fullSize, headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// The title bar holds the menus, the document title and the right-hand buttons on one row.
// Nothing may overlap: narrow windows drop the button words and squeeze the title, never stack.
if (process.platform !== "linux") {
  console.log("SKIP: the in-window menu bar only exists on Linux");
  process.exit(0);
}

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-toolbar-"));
const vault = path.join(home, "vault"), doc = "toolbar.md";
const text = "# Toolbar\n\nAlpha paragraph about retrieval practice and spacing.\n";
await mkdir(vault, { recursive: true });
await writeFile(path.join(vault, doc), text, "utf8");
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: "fixture", folder: vault,
  documents: [{ id: "fixture", path: path.join(vault, doc), name: doc, content: text, savedContent: text, diskHash: "0".repeat(64), lineEnding: "\n" }] }), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const evidence = process.env.OMARKIE_EVIDENCE;

const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env, timeout: 30_000 });
const page = await app.firstWindow();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.reload();
  await expect(page.locator(".document-editor:not([hidden]) .rich-document")).toBeVisible({ timeout: 20_000 });
  await fullSize(app, page);
  const minimum = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize()[0]);

  // Boxes of every title-bar control, and whether any two of them share space.
  const measure = () => page.evaluate(() => {
    const box = node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width }; };
    const menus = [...document.querySelectorAll(".menu-bar-item > button")].map(box);
    const right = [...document.querySelectorAll(".study-toolbar .reading-layers-toggle")].map(box);
    const title = box(document.querySelector(".document-title"));
    const overlaps = [];
    const all = [...menus.map((rect, index) => ({ name: `menu-${index}`, rect })), ...right.map((rect, index) => ({ name: `button-${index}`, rect })), { name: "title", rect: title }];
    for (let a = 0; a < all.length; a += 1) for (let b = a + 1; b < all.length; b += 1) {
      const one = all[a].rect, two = all[b].rect;
      if (one.width < 1 || two.width < 1) continue;
      const horizontal = Math.min(one.right, two.right) - Math.max(one.left, two.left);
      const vertical = Math.min(one.bottom, two.bottom) - Math.max(one.top, two.top);
      if (horizontal > 0.5 && vertical > 0.5) overlaps.push(`${all[a].name}/${all[b].name}`);
    }
    const names = [...document.querySelectorAll(".toolbar button")].map(node => ({ text: node.textContent.trim(), label: node.getAttribute("aria-label") ?? "", title: node.getAttribute("title") ?? "", shown: node.getBoundingClientRect().width > 0 }));
    return { menus, right, title, overlaps, width: innerWidth, names,
      labels: [...document.querySelectorAll(".toolbar-label")].map(node => getComputedStyle(node).display),
      titleShown: getComputedStyle(document.querySelector(".document-title")).display !== "none" };
  });

  for (const width of [760, 720, minimum]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size, 900), width);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(Math.min(width, minimum) - 2);
    const state = await measure();
    assert.deepEqual(state.overlaps, [], `${width}px: title-bar controls overlap (${state.overlaps.join(", ")})`);
    assert.ok(state.menus.length >= 5, `${width}px: the menus are still there (${state.menus.length})`);
    assert.ok(state.right.length >= 1, `${width}px: the right-hand buttons are still there (${state.right.length})`);
    assert.ok(state.right.every(rect => rect.width >= 20 && rect.right <= state.width + 1), `${width}px: buttons stay inside the window`);
    // A lone glyph is worse than nothing: under 760 px the title is hidden, at 760 it shows a word.
    if (width < 760) assert.equal(state.titleShown, false, `${width}px: the title is hidden, never clipped to one letter`);
    else assert.ok(state.titleShown && state.title.width >= 50, `${width}px: the title shows at least a word (${state.title.width.toFixed(0)} px)`);
    if (width <= 900) assert.ok(state.labels.every(display => display === "none"), `${width}px: button words are dropped, not squeezed`);
    // Icon-only must still be named: a hidden label never takes the accessible name with it.
    for (const button of state.names.filter(item => item.shown)) {
      const name = button.label || button.text;
      assert.ok(name.length > 1, `${width}px: every title-bar button keeps an accessible name (got ${JSON.stringify(button)})`);
      if (!button.text) assert.ok(button.title.length > 1, `${width}px: an icon-only button keeps a tooltip (${JSON.stringify(button)})`);
    }
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      for (const theme of ["light", "dark"]) {
        await page.evaluate(name => localStorage.setItem("omarkie-theme", name === "dark" ? "omarchy-dark" : "omarchy-light"), theme);
        await page.reload();
        await expect(page.locator(".document-editor:not([hidden]) .rich-document")).toBeVisible({ timeout: 20_000 });
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size, 900), width);
        await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(Math.min(width, minimum) - 2);
        const themed = await measure();
        assert.deepEqual(themed.overlaps, [], `${width}px ${theme}: title-bar controls overlap`);
        await page.screenshot({ path: path.join(evidence, `toolbar-${width}-${theme}.png`) });
      }
    }
  }
  // A render loop keeps mutating the shell while the app is idle; a settled one goes quiet.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(720, 900));
  await page.waitForTimeout(800);
  const mutations = await page.evaluate(() => new Promise(resolve => {
    let count = 0;
    const observer = new MutationObserver(records => { count += records.length; });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    setTimeout(() => { observer.disconnect(); resolve(count); }, 1000);
  }));
  assert.ok(mutations < 40, `the shell settles when idle; ${mutations} DOM mutations in a quiet second`);
  assert.deepEqual(errors, []);
  console.log(`PASS: menus, title and buttons never overlap at 760, 720 and the ${minimum} px minimum, light and dark; idle shell settles (${mutations} mutations/s)`);
} finally { await app.close(); }
