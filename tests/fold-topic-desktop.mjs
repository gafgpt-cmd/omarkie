import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "playwright/test";
import sharp from "sharp";
import { foldTopic, topicCards } from "../shared/fold-topic.mjs";
import { foldDocumentLadder } from "../shared/fold-units.mjs";
import { createTranslator } from "../shared/i18n.mjs";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// OM-113: Topic stop as cards or a map, both from one topic model; opening one lands at Key where it was clicked.
const corpus = fileURLToPath(new URL("./fixtures/fold/", import.meta.url));
const baselines = fileURLToPath(new URL("./fixtures/fold-topic/", import.meta.url));
const notes = {
  "ward.md": await readFile(path.join(corpus, "01-adhf-ward-guide", "input.md"), "utf8"),
  "chapter.md": await readFile(path.join(corpus, "12-physiology-chapter-10k", "input.md"), "utf8"),
};
const ward = foldTopic(foldDocumentLadder(notes["ward.md"]));
const evidence = process.env.OMARKIE_QA_DIR ?? await mkdtemp(path.join(os.tmpdir(), "omarkie-topic-shots-"));
await mkdir(evidence, { recursive: true });
// A landed unit's top may differ from the card's by subpixel rounding only.
const LANDING_SLACK = 3;

async function launch(language) {
  const home = await mkdtemp(path.join(os.tmpdir(), `omarkie-topic-${language}-`)), folder = path.join(home, "vault");
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
const views = (page, t) => page.getByRole("radiogroup", { name: t("How Topic shows"), exact: true });
const focused = page => page.evaluate(() => {
  const element = document.activeElement;
  return { className: element?.className ?? "", unit: element?.dataset?.unit ?? null, anchor: element?.dataset?.anchor ?? null, level: element?.getAttribute("aria-level") ?? null };
});
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
async function stop(page, key, name) {
  await page.keyboard.press(key);
  await expect(page.locator(".fold-view")).toHaveAttribute("data-stop", name);
}
async function topicView(page, t, name) {
  await views(page, t).getByRole("radio", { name: t(name === "cards" ? "Cards" : "Map"), exact: true }).click();
  await expect(page.locator(name === "cards" ? ".fold-cards" : ".fold-map")).toBeVisible();
}
// Opens the card or node and checks the Key stop lands its unit at the same height, focused.
async function landsAt(page, target, expectedUnit) {
  await target.scrollIntoViewIfNeeded();
  const top = await target.evaluate(element => element.getBoundingClientRect().top);
  await target.click();
  await expect(page.locator(".fold-view")).toHaveAttribute("data-stop", "key");
  await expect(page.locator(".fold-topic")).toHaveCount(0);
  await expect.poll(async () => (await focused(page)).unit).toBe(expectedUnit);
  const landed = await page.evaluate(() => ({ top: document.activeElement.getBoundingClientRect().top, flash: document.activeElement.classList.contains("fold-landed") }));
  assert.ok(Math.abs(landed.top - top) <= LANDING_SLACK, `landed at ${landed.top}, clicked at ${top}`);
  assert.ok(landed.flash, "the landed unit flashes");
  await settle(page);
}

async function grade(file) {
  return sharp(file).resize({ width: 320, kernel: "mitchell" }).grayscale().raw().toBuffer({ resolveWithObject: true });
}
async function capture(page, name) {
  await page.evaluate(() => {
    const topic = document.querySelector(".fold-topic");
    topic.scrollTop = 0;
    topic.querySelector("[data-anchor][tabindex='0']")?.focus({ preventScroll: true });
  });
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
    for (const view of ["cards", "map"]) {
      await topicView(page, t, view);
      await capture(page, `topic-${view}-${language}-light-${width}`);
      await theme(page, t, "omarchy-dark");
      await expect(page.locator(".fold-topic")).toBeVisible();
      await capture(page, `topic-${view}-${language}-dark-${width}`);
      await theme(page, t, "omarchy-light");
    }
  }
  await resize(app, page, 1440);
  await topicView(page, t, "cards");
}

let { app, page, errors, t } = await launch("en");
try {
  await learning(page, t);
  await openFold(page, t);
  await expect(fold(page, t)).toHaveAttribute("data-stop", "key");

  // Topic shows cards over the page; focus lands on the card of the section being read.
  await stop(page, "5", "topic");
  const cards = page.locator(".fold-card");
  const expected = topicCards(ward);
  await expect(views(page, t).getByRole("radio", { name: t("Cards"), exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".fold-topic-title")).toHaveText(ward.title.markdown);
  await expect(page.locator(".fold-card-title")).toHaveText(expected.map(card => card.section.heading));
  await expect(page.locator(".fold-scroller")).toHaveAttribute("aria-hidden", "true");
  await expect.poll(async () => (await focused(page)).anchor).toBe(expected[0].section.anchor);
  await expect(cards.first()).toHaveAttribute("data-current", "true");
  // The folded page under Topic takes no Tab stop either way.
  await page.keyboard.press("Tab");
  await expect(fold(page, t).getByRole("slider", { name: t("Fold level"), exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(async () => (await focused(page)).anchor).toBe(expected[0].section.anchor);
  const table = ward.sections.flatMap(section => section.items).find(item => item.kind === "raw" && item.raw.class === "table");
  await expect(page.locator(".fold-topic-raw[data-raw='table']")).toHaveText(`▦ ${t("Table")} · ${t("{{count}} rows", { count: table.raw.rows })}`);
  const anchors = expected.map(card => card.section.anchor);

  // Arrows walk cards in reading order and by row; Home and End reach the ends.
  await page.keyboard.press("ArrowRight");
  assert.equal((await focused(page)).anchor, anchors[1]);
  await page.keyboard.press("ArrowLeft");
  assert.equal((await focused(page)).anchor, anchors[0]);
  await page.keyboard.press("End");
  assert.equal((await focused(page)).anchor, anchors.at(-1));
  await page.keyboard.press("Home");
  const perRow = await cards.evaluateAll(elements => elements.filter(element => Math.abs(element.getBoundingClientRect().top - elements[0].getBoundingClientRect().top) < 2).length);
  assert.ok(perRow > 1 && perRow < anchors.length, `cards wrap into rows: ${perRow} per row`);
  await page.keyboard.press("ArrowDown");
  assert.equal((await focused(page)).anchor, anchors[perRow]);
  await page.keyboard.press("ArrowUp");
  assert.equal((await focused(page)).anchor, anchors[0]);

  // Enter opens the card's section at Key, focused and flashed.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(fold(page, t)).toHaveAttribute("data-stop", "key");
  await expect.poll(async () => (await focused(page)).unit).toBe(anchors[1]);
  await settle(page);

  // Map: the same sections and lines as a tree; the toggle is a radio group and is remembered.
  await stop(page, "5", "topic");
  await page.keyboard.press("Shift+Tab");
  await expect(views(page, t).getByRole("radio", { name: t("Cards"), exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const map = page.getByRole("tree", { name: t("Topic map"), exact: true });
  await expect(map).toBeVisible();
  await expect(views(page, t).getByRole("radio", { name: t("Map"), exact: true })).toBeFocused();
  assert.equal(await page.evaluate(() => localStorage.getItem("omarkie-fold-topic-view")), "map");
  const items = ward.sections.flatMap(section => section.items);
  await expect(map.getByRole("treeitem")).toHaveCount(1 + ward.sections.length + items.length);
  await expect(page.locator(".fold-map-node[data-kind='section']")).toHaveText(ward.sections.map(section => section.heading));
  assert.deepEqual(await page.locator(".fold-map-node:is([data-kind='line'],[data-kind='raw'])").evaluateAll(nodes => nodes.map(node => node.dataset.anchor)), items.map(item => item.unitId));
  await expect(page.locator(".fold-map-links path")).toHaveCount(ward.sections.length + items.length);
  const overlaps = await page.locator(".fold-map-node").evaluateAll(nodes => {
    const boxes = nodes.map(node => node.getBoundingClientRect());
    return boxes.filter((a, i) => boxes.some((b, j) => j > i && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)).length;
  });
  assert.equal(overlaps, 0, "map nodes never overlap");

  // Tree keys: Tab enters at the current section; Right goes to a child, Left back to its parent, Down walks on.
  await page.keyboard.press("Tab");
  const section = await focused(page);
  assert.equal(section.level, "2");
  await page.keyboard.press("ArrowRight");
  const child = await focused(page);
  assert.equal(child.level, "3");
  await page.keyboard.press("ArrowLeft");
  assert.equal((await focused(page)).anchor, section.anchor);
  await page.keyboard.press("ArrowDown");
  assert.equal((await focused(page)).anchor, child.anchor);
  await page.keyboard.press("Enter");
  await expect(fold(page, t)).toHaveAttribute("data-stop", "key");
  await expect.poll(async () => (await focused(page)).unit).toBe(child.anchor);
  await settle(page);

  // Reopening Topic keeps the map; Ctrl+wheel over it scrubs the page back to a fuller stop.
  await stop(page, "5", "topic");
  await expect(map).toBeVisible();
  const box = await page.locator(".fold-topic").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect(fold(page, t)).toHaveAttribute("data-stop", "takeaway");
  await expect(page.locator(".fold-topic")).toHaveCount(0);
  await settle(page);

  // Esc from a card leaves the fold.
  await stop(page, "5", "topic");
  await topicView(page, t, "cards");
  await cards.first().focus();
  await page.keyboard.press("Escape");
  await expect(fold(page, t)).toBeHidden();
  await openFold(page, t);
  await stop(page, "5", "topic");
  await shots(app, page, t, "en");

  // A long note: a card and a map node deep in the page land at Key exactly where they were clicked.
  await page.keyboard.press("Escape");
  await quickOpen(page, t, "chapter.md");
  await openFold(page, t);
  await stop(page, "5", "topic");
  const chapter = topicCards(foldTopic(foldDocumentLadder(notes["chapter.md"])));
  const deep = chapter[Math.floor(chapter.length / 2)].section;
  await landsAt(page, page.locator(`.fold-card[data-anchor="${deep.anchor}"]`), deep.anchor);
  await stop(page, "5", "topic");
  await topicView(page, t, "map");
  const leaf = chapter[Math.floor(chapter.length / 3)].section.items[0];
  await landsAt(page, page.locator(`.fold-map-node[data-anchor="${leaf.unitId}"]`), leaf.unitId);
  assert.deepEqual(errors, []);
} finally { await app.close(); }

// Spanish: labels and the same views at both widths and themes.
({ app, page, errors, t } = await launch("es"));
try {
  await learning(page, t);
  await openFold(page, t);
  await stop(page, "5", "topic");
  await expect(views(page, t).getByRole("radio")).toHaveText(["Tarjetas", "Mapa"]);
  await expect(page.locator(".fold-topic-hint")).toHaveText("Abre cualquier línea en Clave con un clic o Intro");
  await shots(app, page, t, "es");
  assert.deepEqual(errors, []);
} finally { await app.close(); }
console.log("PASS: Topic cards and map from one model, arrow and tree keys, view toggle remembered, card and node open Key anchored, Ctrl+wheel and Esc, EN/ES baselines.");
