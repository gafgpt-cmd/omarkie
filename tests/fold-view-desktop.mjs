import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "playwright/test";
import sharp from "sharp";
import { createTranslator } from "../shared/i18n.mjs";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";
import { assertFrameCadence, assertWorkBudget, readWork, stableHost, watchWork } from "./frame-cadence.mjs";

// OM-105: Fold view, level bar, keys, motion and scrub on local stops. Words keep their identity.
const corpus = fileURLToPath(new URL("./fixtures/fold/", import.meta.url));
const baselines = fileURLToPath(new URL("./fixtures/fold-view/", import.meta.url));
const notes = {
  "ward.md": await readFile(path.join(corpus, "01-adhf-ward-guide", "input.md"), "utf8"),
  "chapter.md": await readFile(path.join(corpus, "12-physiology-chapter-10k", "input.md"), "utf8"),
  "short.md": "# Short note\n\nOne line is not worth folding.\n",
};
const evidence = process.env.OMARKIE_QA_DIR ?? await mkdtemp(path.join(os.tmpdir(), "omarkie-fold-shots-"));
await mkdir(evidence, { recursive: true });
const COMMIT_BUDGET = 50;

async function launch(language) {
  const home = await mkdtemp(path.join(os.tmpdir(), `omarkie-fold-${language}-`)), folder = path.join(home, "vault");
  await mkdir(folder, { recursive: true });
  const documents = [];
  for (const [name, content] of Object.entries(notes)) {
    const file = path.join(folder, name);
    await writeFile(file, content, "utf8");
    documents.push({ id: name, path: file, name, content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), lineEnding: "\n" });
  }
  await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: "ward.md", folder, documents }), "utf8");
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
async function resize(app, page, width) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
}
const rich = page => page.locator(".document-editor:not([hidden]) .rich-document");
const fold = (page, t) => page.getByRole("region", { name: t("Fold view"), exact: true });
const slider = (page, t) => page.getByRole("slider", { name: t("Fold level"), exact: true });
async function learning(page, t) {
  await page.getByRole("button", { name: t("显示"), exact: true }).click();
  const item = page.getByRole("menuitemcheckbox", { name: t("Learning mode"), exact: true });
  if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
  else await page.keyboard.press("Escape");
  await expect(rich(page)).toHaveAttribute("contenteditable", "false");
}
async function theme(page, t, value) {
  await page.keyboard.press("ControlOrMeta+,");
  const options = page.getByRole("dialog", { name: t("偏好设置"), exact: true });
  await options.getByRole("combobox", { name: t("主题"), exact: true }).selectOption(value);
  await options.getByRole("button", { name: t("完成"), exact: true }).click();
}
async function openFold(page, t) {
  await rich(page).focus();
  await page.keyboard.press("Control+Shift+H");
  await expect(fold(page, t)).toBeVisible();
  await expect(page.locator(".document-editor:not([hidden])")).toHaveCount(0);
}
async function closeFold(page) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const article = page.locator(".fold-document");
  await article.focus();
  await expect(article).toBeFocused();
  await page.keyboard.press("Escape");
}
async function quickOpen(page, t, name) {
  await page.keyboard.press("Control+P");
  const quick = page.getByRole("dialog", { name: t("快速打开"), exact: true });
  await quick.getByRole("combobox").fill(name);
  await expect(quick.getByRole("option", { selected: true })).toContainText(name);
  await quick.getByRole("combobox").press("Enter");
  await expect(quick).toHaveCount(0);
}
async function settle(page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
}
// Watches from before the key press, so a 180 ms glide cannot finish unseen.
function watchMotion(page) {
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
const commits = page => page.evaluate(() => performance.getEntriesByName("omarkie:fold-commit").map(entry => entry.duration));
async function stop(page, key, name, value) {
  await page.keyboard.press(key);
  await expect(page.locator(".fold-view")).toHaveAttribute("data-stop", name);
  if (value) await expect(page.locator(".fold-track")).toHaveAttribute("aria-valuenow", String(value));
}

async function grade(file) {
  return sharp(file).resize({ width: 320, kernel: "mitchell" }).grayscale().raw().toBuffer({ resolveWithObject: true });
}
async function capture(page, name) {
  await page.evaluate(() => { const scroller = document.querySelector(".fold-scroller"); if (scroller) scroller.scrollTop = 0; document.querySelector(".fold-document")?.focus({ preventScroll: true }); });
  await settle(page);
  const shot = path.join(evidence, `${name}.png`);
  await page.locator(".fold-view").screenshot({ path: shot });
  const baseline = path.join(baselines, `${name}.png`);
  if (process.env.OMARKIE_UPDATE_BASELINES === "1") { await mkdir(baselines, { recursive: true }); await copyFile(shot, baseline); return; }
  const [fresh, expected] = await Promise.all([grade(shot), grade(baseline)]);
  assert.equal(fresh.info.height, expected.info.height, `${name}: baseline size differs`);
  let sum = 0, changed = 0;
  for (let index = 0; index < fresh.data.length; index++) { const delta = Math.abs(fresh.data[index] - expected.data[index]); sum += delta; if (delta > 32) changed += 1; }
  const mean = sum / fresh.data.length, fraction = changed / fresh.data.length;
  console.log(`${name}: mean ${mean.toFixed(2)}, changed ${(fraction * 100).toFixed(1)}%`);
  assert.ok(mean <= 6 && fraction <= 0.08, `${name}: drifted from baseline (mean ${mean.toFixed(2)}, changed ${(fraction * 100).toFixed(1)}%)`);
}
async function shots(app, page, t, language) {
  for (const width of [1440, 720]) {
    await resize(app, page, width);
    await capture(page, `fold-${language}-light-${width}`);
    await theme(page, t, "omarchy-dark");
    await expect(fold(page, t)).toBeVisible();
    await capture(page, `fold-${language}-dark-${width}`);
    await theme(page, t, "omarchy-light");
  }
  await resize(app, page, 1440);
}

let { app, page, errors, t } = await launch("en");
try {
  await expect(rich(page).getByRole("heading").first()).toBeVisible();
  await learning(page, t);
  const toggle = page.locator(".fold-rail").getByRole("button", { name: `${t("Fold view")}: ${t("Key")}`, exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await openFold(page, t);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const view = fold(page, t), bar = slider(page, t);
  await expect(view).toHaveAttribute("data-stop", "key");
  await expect(bar).toHaveAttribute("aria-valuenow", "3");
  await expect(bar).toHaveAttribute("aria-valuetext", /^Key, \d+% of words$/);
  await expect(page.locator(".fold-bar-note")).toHaveText(t("Local fold · model lines when you choose"));
  await expect(page.getByRole("button", { name: /Estudio/ })).toBeDisabled();
  const percents = await page.locator(".fold-stop[data-stop] small").allTextContents();
  assert.equal(percents[0], "100%");
  assert.ok(percents.map(value => parseInt(value, 10)).every((value, index, all) => index === 0 || value <= all[index - 1]), `percent per stop falls: ${percents}`);
  await settle(page);

  // Source ink: author words carry a faint underline; the fold marker is not the author's.
  const ink = await page.evaluate(() => {
    const shown = element => element.getClientRects().length > 0;
    const author = [...document.querySelectorAll(".fold-document .fold-w:not(.fold-added, .fold-atom)")].find(shown);
    const added = [...document.querySelectorAll(".fold-document .fold-added")].find(shown);
    return { author: author && getComputedStyle(author).textDecorationLine, added: added && getComputedStyle(added).textDecorationLine, marker: added?.textContent };
  });
  assert.equal(ink.author, "underline");
  assert.equal(ink.added, "none");
  assert.match(ink.marker ?? "", /…/);

  // Identity: a word seen at Key is the same node at Full, and the page never re-renders.
  const before = await page.evaluate(() => {
    const word = [...document.querySelectorAll(".fold-document .fold-w:not(.fold-added)")].find(element => element.getClientRects().length > 0);
    window.__foldWord = word;
    return { count: document.querySelectorAll(".fold-w").length, text: word.textContent };
  });
  const motion = watchMotion(page);
  await stop(page, "1", "full", 1);
  assert.ok((await motion).words > 0, "survivors glide between stops");
  const after = await page.evaluate(() => ({ count: document.querySelectorAll(".fold-w").length, same: window.__foldWord.isConnected && window.__foldWord.getClientRects().length > 0, text: window.__foldWord.textContent }));
  assert.deepEqual(after, { count: before.count, same: true, text: before.text });
  await expect(page.locator(".fold-bar-note")).toHaveCount(0);

  await stop(page, "]", "brief", 2);
  await stop(page, "[", "full", 1);
  await stop(page, "5", "topic", 5);
  await stop(page, "4", "takeaway", 4);
  await stop(page, "3", "key", 3);
  await stop(page, "6", "key", 3);
  await expect(page.locator(".fold-bar-note")).toHaveText(t("Local fold · model lines when you choose"));
  await bar.focus();
  await stop(page, "ArrowRight", "takeaway", 4);
  await stop(page, "Home", "full", 1);
  await stop(page, "End", "topic", 5);
  await stop(page, "ArrowLeft", "takeaway", 4);
  await page.locator(".fold-stop[data-stop='key']").click();
  await expect(view).toHaveAttribute("data-stop", "key");
  await settle(page);
  await page.locator(".fold-document").focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains("fold-unit"))).toBe(true);
  const wardCommits = await commits(page);
  console.log(`fold commit, fixture 1: max ${Math.max(...wardCommits).toFixed(1)} ms over ${wardCommits.length}`);
  assert.ok(Math.max(...wardCommits) <= COMMIT_BUDGET, `a stop change took ${Math.max(...wardCommits).toFixed(1)} ms`);

  await stop(page, "6", "key", 3);
  await shots(app, page, t, "en");

  // Esc gives the page back at the fold's top line; focus returns to the toggle; the stop is remembered.
  await page.locator(".fold-scroller").evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
  const topLine = await page.evaluate(() => {
    const top = document.querySelector(".fold-scroller").getBoundingClientRect().top;
    return Number([...document.querySelectorAll(".fold-unit:not(.fold-off)")].find(unit => unit.getBoundingClientRect().bottom > top).dataset.line);
  });
  await closeFold(page);
  await expect(view).toBeHidden();
  await expect(rich(page)).toBeVisible();
  await expect(toggle).toBeFocused();
  assert.ok(topLine > 1);
  await expect.poll(() => page.locator(".document-editor:not([hidden]) .rich-scroller").evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await openFold(page, t);
  await expect(view).toHaveAttribute("data-stop", "key");

  // Reduced motion: no word travels; the page only fades.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const calm = watchMotion(page);
  await stop(page, "2", "brief", 2);
  assert.deepEqual(await calm, { words: 0, page: 1 });
  await settle(page);
  await stop(page, "3", "key", 3);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await closeFold(page);
  await expect(view).toBeHidden();

  // Lifecycle: the fold closes with Learning and with focus mode, and leaving never touches another note.
  await openFold(page, t);
  for (let pass = 0; pass < 2; pass++) {
    await page.getByRole("button", { name: t("显示"), exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: t("Learning mode"), exact: true }).click();
  }
  await expect(rich(page)).toHaveAttribute("contenteditable", "false");
  await expect(view).toBeHidden();
  await expect(rich(page)).toBeVisible();
  await rich(page).focus();
  await page.keyboard.press("F8");
  await expect(page.locator(".app-shell.focus-mode")).toHaveCount(1);
  await page.keyboard.press("Control+Shift+H");
  await expect(page.locator(".app-shell.focus-mode")).toHaveCount(0);
  await expect(view).toBeVisible();
  await page.locator(".fold-scroller").evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
  await page.locator(".fold-document").focus();
  await quickOpen(page, t, "chapter.md");
  await expect(rich(page).getByRole("heading", { name: "Integrative Cardiopulmonary and Renal Physiology", exact: true })).toBeVisible();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(view).toBeHidden();
  assert.equal(await page.locator(".document-editor:not([hidden]) .rich-scroller").evaluate(element => element.scrollTop), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("fold-toggle")), false);
  await quickOpen(page, t, "ward.md");
  await expect(view).toBeHidden();
  await expect(rich(page)).toBeVisible();

  // Too short: the bar says so and stays at Full.
  await quickOpen(page, t, "short.md");
  await expect(rich(page).getByRole("heading", { name: "Short note", exact: true })).toBeVisible();
  await openFold(page, t);
  await expect(page.getByRole("status").filter({ hasText: t("Too short to fold") })).toBeVisible();
  await expect(bar).toHaveAttribute("aria-disabled", "true");
  await stop(page, "5", "full", 1);
  await closeFold(page);
  await expect(view).toBeHidden();

  // Scrub: a 10k-word chapter folds under the pointer; survivors move part way, dropped words fade.
  await quickOpen(page, t, "chapter.md");
  await expect(rich(page).getByRole("heading", { name: "Integrative Cardiopulmonary and Renal Physiology", exact: true })).toBeVisible();
  await openFold(page, t);
  await settle(page);
  await page.evaluate(() => performance.clearMeasures("omarkie:fold-commit"));
  const centre = async stop => { const box = await page.locator(`.fold-stop[data-stop='${stop}']`).boundingBox(); return [box.x + box.width / 2, box.y + box.height / 2]; };
  const [x0, y] = await centre("key"), [xm] = await centre("takeaway"), [x1] = await centre("topic");
  await watchWork(page);
  await page.evaluate(() => {
    window.__gaps = []; window.__frames = true;
    let last = performance.now();
    const frame = now => { window.__gaps.push(now - last); last = now; if (window.__frames) requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
  await page.mouse.move(x0, y);
  await page.mouse.down();
  const scrubCosts = [], cost = async () => scrubCosts.push(Number(await page.locator(".fold-document").getAttribute("data-scrub-ms")));
  for (let step = 1; step <= 20; step++) { await page.mouse.move(x0 + (xm - x0) * step / 40, y); await cost(); }
  const mid = await page.evaluate(() => ({
    moved: document.querySelectorAll(".fold-document .fold-w[style*='translate']").length,
    faded: [...document.querySelectorAll(".fold-document .fold-w")].filter(element => element.style.opacity && Number(element.style.opacity) < 1).length,
  }));
  assert.ok(mid.moved > 0 && mid.faded > 0, `mid-scrub survivors move and dropped words fade: ${JSON.stringify(mid)}`);
  for (let step = 1; step <= 30; step++) { await page.mouse.move((x0 + xm) / 2 + (x1 - (x0 + xm) / 2) * step / 30, y); await cost(); }
  await page.mouse.up();
  await expect(view).toHaveAttribute("data-stop", "topic");
  const gaps = await page.evaluate(() => { window.__frames = false; return window.__gaps.slice(1); });
  const work = await readWork(page);
  assertFrameCadence(gaps, "fold scrub");
  assertWorkBudget({ work: scrubCosts.filter(Number.isFinite), longTasks: work.longTasks, gesture: "fold scrub on 10k words", longest: stableHost() ? 50 : 500 });
  await settle(page);
  assert.equal(await page.evaluate(() => document.querySelectorAll(".fold-document .fold-w[style*='translate'], .fold-document .fold-w[style*='opacity']").length), 0);
  await stop(page, "1", "full", 1);
  await stop(page, "3", "key", 3);
  const chapterCommits = await commits(page);
  console.log(`fold commit, fixture 12: max ${Math.max(...chapterCommits).toFixed(1)} ms over ${chapterCommits.length}`);
  assert.ok(Math.max(...chapterCommits) <= COMMIT_BUDGET, `a stop change took ${Math.max(...chapterCommits).toFixed(1)} ms`);
  assert.deepEqual(errors, []);
} finally { await app.close(); }

// Spanish: labels and the same page at both widths and themes.
({ app, page, errors, t } = await launch("es"));
try {
  await learning(page, t);
  await openFold(page, t);
  await expect(slider(page, t)).toHaveAttribute("aria-valuetext", /^Clave, \d+ % de las palabras$/);
  await stop(page, "3", "key", 3);
  await expect(page.locator(".fold-bar-note")).toHaveCount(0);
  await stop(page, "6", "key", 3);
  await shots(app, page, t, "es");
  assert.deepEqual(errors, []);
} finally { await app.close(); }
console.log("PASS: fold view opens at Key, keys and slider move stops, words keep identity, motion and reduced motion, too-short state, scrub, commit under 50 ms, EN/ES baselines.");
