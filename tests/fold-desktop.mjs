import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "playwright/test";
import sharp from "sharp";
import { createTranslator } from "../shared/i18n.mjs";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// Shared driver for the Fold view desktop tests: a vault of `notes`, the first one active.
export async function launch(language, notes) {
  const home = await mkdtemp(path.join(os.tmpdir(), `omarkie-fold-${language}-`)), folder = path.join(home, "vault");
  await mkdir(folder, { recursive: true });
  const documents = [];
  for (const [name, content] of Object.entries(notes)) {
    const file = path.join(folder, name);
    await writeFile(file, content, "utf8");
    documents.push({ id: name, path: file, name, content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), lineEnding: "\n" });
  }
  await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: documents[0].id, folder, documents }), "utf8");
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: language });
  delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [process.cwd(), ...headlessArguments], env });
  const page = await app.firstWindow(), errors = [], t = createTranslator(language);
  page.on("pageerror", error => errors.push(error.message));
  await resize(app, page, 1440);
  await page.reload();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  return { app, page, errors, t };
}
export async function resize(app, page, width) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
}
export const rich = page => page.locator(".document-editor:not([hidden]) .rich-document");
export const fold = (page, t) => page.getByRole("region", { name: t("Fold view"), exact: true });
export const slider = (page, t) => page.getByRole("slider", { name: t("Fold level"), exact: true });
export async function learning(page, t) {
  await page.getByRole("button", { name: t("显示"), exact: true }).click();
  const item = page.getByRole("menuitemcheckbox", { name: t("Learning mode"), exact: true });
  if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
  else await page.keyboard.press("Escape");
  await expect(rich(page)).toHaveAttribute("contenteditable", "false");
}
export async function theme(page, t, value) {
  await page.keyboard.press("ControlOrMeta+,");
  const options = page.getByRole("dialog", { name: t("偏好设置"), exact: true });
  await options.getByRole("combobox", { name: t("主题"), exact: true }).selectOption(value);
  await options.getByRole("button", { name: t("完成"), exact: true }).click();
}
export async function openFold(page, t) {
  await rich(page).focus();
  await page.keyboard.press("Control+Shift+H");
  await expect(fold(page, t)).toBeVisible();
  await expect(page.locator(".document-editor:not([hidden])")).toHaveCount(0);
}
export async function closeFold(page) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const article = page.locator(".fold-document");
  await article.focus();
  await expect(article).toBeFocused();
  await page.keyboard.press("Escape");
}
export async function settle(page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
}
// Watches from before the key press, so a 180 ms glide cannot finish unseen.
export function watchMotion(page) {
  return page.evaluate(() => new Promise(resolve => {
    let words = 0, page = 0, ticks = 0;
    const tick = () => {
      for (const animation of document.getAnimations()) {
        const target = animation.effect?.target;
        if (target?.classList?.contains("fold-w")) words += 1;
        else if (target?.classList?.contains("fold-document")) page += 1;
      }
      if (words || page || ++ticks > 40) resolve({ words, page }); else setTimeout(tick, 10);
    };
    tick();
  }));
}
export async function stop(page, key, name, value) {
  await page.keyboard.press(key);
  await expect(page.locator(".fold-view")).toHaveAttribute("data-stop", name);
  if (value) await expect(page.locator(".fold-track")).toHaveAttribute("aria-valuenow", String(value));
}

async function grade(file) {
  return sharp(file).resize({ width: 320, kernel: "mitchell" }).grayscale().raw().toBuffer({ resolveWithObject: true });
}
// Screenshot of the fold into `evidence`, graded against `baselines` (OMARKIE_UPDATE_BASELINES=1 rewrites them).
// `reset` scrolls to the top and focuses the page first; `baseline: false` only keeps the evidence.
export function shooter(evidence, baselines) {
  return async function capture(page, name, { reset = true, baseline = true } = {}) {
    if (reset) await page.evaluate(() => { const scroller = document.querySelector(".fold-scroller"); if (scroller) scroller.scrollTop = 0; document.querySelector(".fold-document")?.focus({ preventScroll: true }); });
    await settle(page);
    const shot = path.join(evidence, `${name}.png`);
    await page.locator(".fold-view").screenshot({ path: shot });
    if (!baseline) return;
    const expected = path.join(baselines, `${name}.png`);
    if (process.env.OMARKIE_UPDATE_BASELINES === "1") { await mkdir(baselines, { recursive: true }); await copyFile(shot, expected); return; }
    const [fresh, old] = await Promise.all([grade(shot), grade(expected)]);
    assert.equal(fresh.info.height, old.info.height, `${name}: baseline size differs`);
    let sum = 0, changed = 0;
    for (let index = 0; index < fresh.data.length; index++) { const delta = Math.abs(fresh.data[index] - old.data[index]); sum += delta; if (delta > 32) changed += 1; }
    const mean = sum / fresh.data.length, fraction = changed / fresh.data.length;
    console.log(`${name}: mean ${mean.toFixed(2)}, changed ${(fraction * 100).toFixed(1)}%`);
    assert.ok(mean <= 6 && fraction <= 0.08, `${name}: drifted from baseline (mean ${mean.toFixed(2)}, changed ${(fraction * 100).toFixed(1)}%)`);
  };
}
