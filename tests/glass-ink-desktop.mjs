import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { _electron as launch, expect } from "playwright/test";
import { decode } from "@toon-format/toon";
import sharp from "sharp";
import { assertFrameCadence, assertWorkBudget, readWork, watchWork } from "./frame-cadence.mjs";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// G7: the pencil. Pen, highlighter and eraser over a real page, split per element box,
// pressure and palm rejection, undo per stroke, persistence, and a 2,000-stroke budget.
const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-ink-"));
const vault = path.join(home, "vault"), doc = "study.md", file = path.join(vault, doc);
const heading = "Ink study";
const paragraph = "Recall the answer before looking it up.";
const items = ["Alpha item", "Beta item", "Gamma item"];
const source = [
  `# ${heading}`, "", paragraph, "",
  ...items.map(item => `- ${item}`), "",
  "| Drug | Dose |", "| --- | --- |", "| A | 1 mg |", "| B | 2 mg |", "",
  "```js", "const answer = 42;", "```", "",
].join("\n");
await mkdir(vault);
await writeFile(file, source, "utf8");
const record = { id: "fixture", path: file, name: doc, content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const evidence = process.env.OMARKIE_QA_DIR ?? path.join(home, "shots");
await mkdir(evidence, { recursive: true });
const fixtures = fileURLToPath(new URL("./fixtures/glass", import.meta.url));
const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
async function axi(...args) {
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 });
  return decode(stdout);
}
const fieldsOf = state => state.magnet?.fields ?? {};
// Placements appear before their journal write lands; wait for the stored stroke.
async function strokeOf(id) {
  let fields = {}, last;
  await expect.poll(async () => { last = await axi("glass", "show", "--note", doc, "--magnet", id); fields = fieldsOf(last); return fields.parts?.length ?? 0; }, { timeout: 10_000 }).toBeGreaterThan(0);
  if (!fields.parts) console.log("strokeOf shape:", JSON.stringify(last).slice(0, 400));
  return fields;
}

async function grade(png) {
  return sharp(png).resize({ width: 320, kernel: "mitchell" }).grayscale().raw().toBuffer({ resolveWithObject: true });
}
async function capture(page, name) {
  const fresh = path.join(evidence, `${name}.png`);
  await page.screenshot({ path: fresh });
  const baseline = path.join(fixtures, `${name}.png`);
  if (process.env.OMARKIE_UPDATE_BASELINES === "1") { await copyFile(fresh, baseline); return; }
  const [now, expected] = await Promise.all([grade(fresh), grade(baseline)]);
  assert.equal(now.info.width, expected.info.width, `${name}: baseline width differs`);
  assert.equal(now.info.height, expected.info.height, `${name}: baseline height differs`);
  const a = now.data, b = expected.data;
  let sum = 0, changed = 0;
  for (let index = 0; index < a.length; index++) { const delta = Math.abs(a[index] - b[index]); sum += delta; if (delta > 32) changed += 1; }
  const mean = sum / a.length, fraction = changed / a.length;
  console.log(`${name}: mean ${mean.toFixed(2)}, changed ${(fraction * 100).toFixed(1)}%`);
  assert.ok(mean <= 7 && fraction <= 0.1, `${name}: drifted from baseline (mean ${mean.toFixed(2)}, changed ${(fraction * 100).toFixed(1)}%)`);
}

async function launchApp() {
  const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
  const page = await app.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) console.log("PAGE:", message.text()); });
  return { app, page, errors };
}

const richOf = page => page.locator(".document-editor:not([hidden]) .rich-document");
const glassOf = page => page.locator(".glass-layer");
const trayOf = page => page.locator(".glass-tray");
async function ready(page) {
  await expect(richOf(page).getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
}
async function flip(page, label, settled) {
  const item = page.getByRole("menuitemcheckbox", { name: label, exact: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await settled()) return;
    if (!(await item.isVisible().catch(() => false))) await page.getByRole("button", { name: "Display", exact: true }).click();
    await item.click();
    await page.waitForTimeout(150);
  }
  throw new Error(`The ${label} switch would not settle`);
}
async function learning(page, on) {
  if (process.platform !== "linux") {
    const button = page.getByRole("button", { name: "Learning mode" });
    if ((await button.getAttribute("aria-pressed")) !== String(on)) await button.click();
    await expect(richOf(page)).toHaveAttribute("contenteditable", String(!on));
    return;
  }
  await flip(page, "Learning mode", async () => (await richOf(page).getAttribute("contenteditable")) === String(!on));
}
async function glassMenu(page, on) {
  if (process.platform !== "linux") {
    if (((await glassOf(page).count()) > 0) !== on) await page.locator(".rich-document").click({ position: { x: 4, y: 4 } }), await page.keyboard.press("g");
    await expect(glassOf(page)).toHaveCount(on ? 1 : 0);
    return;
  }
  await flip(page, "Glass overlay", async () => ((await glassOf(page).count()) > 0) === on);
}
async function sourceMode(page, on) {
  if (process.platform !== "linux") return;
  await flip(page, "Source Code Mode", async () => (await page.locator(".document-editor:not([hidden]) .cm-content").isVisible().catch(() => false)) === on);
}
async function resize(app, page, width) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
}
async function boxes(page, selector) {
  return page.evaluate(selector => [...document.querySelectorAll(selector)].map(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, text: node.textContent?.trim() };
  }), selector);
}

// Synthetic pointers, pressure and all: the canvas only ever sees PointerEvents.
async function stroke(page, points, { pointerType = "pen", pressure = 0.5, pointerId = 7 } = {}) {
  await page.evaluate(({ points, pointerType, pressure, pointerId }) => {
    const surface = document.querySelector("[data-ink-surface]");
    if (!surface) throw new Error("no ink surface");
    const fire = (type, point, extra = {}) => surface.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId, pointerType, pressure, isPrimary: true,
      buttons: type === "pointerup" ? 0 : 1, clientX: point[0], clientY: point[1], ...extra,
    }));
    fire("pointerdown", points[0]);
    for (const point of points.slice(1, -1)) fire("pointermove", point);
    fire("pointerup", points.at(-1));
  }, { points, pointerType, pressure, pointerId });
}
async function palm(page, points, pointerId = 9) {
  await stroke(page, points, { pointerType: "touch", pressure: 0.7, pointerId });
}
async function pick(page, name) {
  await trayOf(page).getByRole("button", { name, exact: true }).click();
}
const inkPaths = page => page.locator(".glass-ink path");
// Ink belongs to the box it was drawn on: no stretching to a different element.
async function inside(page, id, selector, slack = 10) {
  return page.evaluate(({ id, selector, slack }) => {
    const box = document.querySelector(selector)?.getBoundingClientRect();
    if (!box) return false;
    return [...document.querySelectorAll(`.glass-ink path[data-ink="${id}"]`)].every(path => {
      const rect = path.getBoundingClientRect();
      return rect.left >= box.left - slack && rect.right <= box.right + slack
        && rect.top >= box.top - slack && rect.bottom <= box.bottom + slack;
    });
  }, { id, selector, slack });
}
const inkIds = async page => page.evaluate(() => [...new Set([...document.querySelectorAll(".glass-ink path")].map(node => node.dataset.ink))]);
async function rectOf(page, selector) {
  return page.evaluate(selector => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, selector);
}

const firstRun = await launchApp();
let { app, page, errors } = firstRun;
try {
  await resize(app, page, 1440);
  await ready(page);
  await learning(page, true);
  await glassMenu(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
  const tray = trayOf(page);
  await expect(tray).toBeVisible();

  await pick(page, "Pen");
  await expect(tray.locator('[data-glass-tool="ink"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-ink-surface]")).toHaveAttribute("data-ink-tool", "pen");
  const palette = page.locator("[data-ink-palette]");
  await expect(palette).toBeVisible();
  for (const width of [2, 4, 8]) await expect(palette.locator(`[data-ink-width="${width}"]`)).toBeVisible();
  await palette.locator('[data-ink-width="4"]').click();
  await expect(palette.locator('[data-ink-width="4"]')).toHaveAttribute("aria-pressed", "true");
  const penColour = palette.locator("[data-ink-colour]");
  await expect(penColour).toHaveCount(3);
  await pick(page, "Highlighter");
  await expect(page.locator("[data-ink-palette] [data-ink-colour]")).toHaveCount(3);
  await expect(page.locator("[data-ink-palette] [data-ink-width]")).toHaveCount(0);
  await pick(page, "Eraser");
  await expect(palette.locator('[data-ink-eraser="bite"]')).toHaveAttribute("aria-pressed", "true");
  await expect(palette.locator('[data-ink-eraser="stroke"]')).toBeVisible();
  await expect(page.locator(".glass-ink-eraser")).toBeAttached();

  // A pen stroke over the paragraph: one anchored part, saved to the journal.
  await pick(page, "Pen");
  await palette.locator('[data-ink-width="4"]').click();
  const paragraphRect = await rectOf(page, ".rich-document p[data-cid]");
  assert.ok(paragraphRect);
  const penLine = Array.from({ length: 12 }, (_, index) => [paragraphRect.x + 20 + index * 18, paragraphRect.y + 12 + Math.sin(index / 2) * 5]);
  await stroke(page, penLine, { pressure: 0.6 });
  await expect(inkPaths(page)).toHaveCount(1);
  const penId = (await inkIds(page))[0];
  assert.match(penId, /^m-/);
  await expect.poll(async () => (await axi("glass", "list", "--note", doc)).magnets.find(magnet => magnet.id === penId)?.fields.kind).toBe("ink");
  const stored = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", penId));
  assert.equal(stored.tool, "pen");
  assert.equal(stored.layer, "ink");
  assert.equal(stored.parts.length, 1);
  assert.equal(stored.parts[0].box.kind, "block");
  assert.equal(stored.parts[0].anchor.landmarks.find(landmark => landmark.kind === "quote").value.exact, paragraph);
  assert.equal(stored.parts[0].points.length, penLine.length);
  assert.ok(await inside(page, penId, ".rich-document p[data-cid]", 14), "the paragraph stroke stays inside its paragraph");
  assert.equal(await readFile(file, "utf8"), source, "ink never writes the page");

  // Pressure widens the nib.
  await palette.locator('[data-ink-width="8"]').click();
  await stroke(page, Array.from({ length: 14 }, (_, index) => [paragraphRect.x + 20 + index * 16, paragraphRect.y + 60]), { pressure: 0.1, pointerId: 11 });
  await stroke(page, Array.from({ length: 14 }, (_, index) => [paragraphRect.x + 20 + index * 16, paragraphRect.y + 110]), { pressure: 1, pointerId: 12 });
  await expect(inkPaths(page)).toHaveCount(3);
  const soft = await page.evaluate(() => document.querySelectorAll(".glass-ink path")[1].getBBox().height);
  const hard = await page.evaluate(() => document.querySelectorAll(".glass-ink path")[2].getBBox().height);
  assert.ok(hard > soft, `pressure widens the stroke (${soft} → ${hard})`);

  // A stylus is present: fingers and palms leave no marks, mid-stroke or after.
  const before = await inkPaths(page).count();
  await palm(page, Array.from({ length: 8 }, (_, index) => [paragraphRect.x + 30 + index * 16, paragraphRect.y + 150]));
  await expect(inkPaths(page)).toHaveCount(before);
  await page.evaluate(({ paragraphRect }) => {
    const surface = document.querySelector("[data-ink-surface]");
    const fire = (type, x, y, pointerId, pointerType, pressure) => surface.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId, pointerType, pressure, isPrimary: true, buttons: 1, clientX: x, clientY: y,
    }));
    fire("pointerdown", paragraphRect.x + 40, paragraphRect.y + 190, 21, "pen", 0.7);
    fire("pointermove", paragraphRect.x + 90, paragraphRect.y + 195, 21, "pen", 0.7);
    fire("pointerdown", paragraphRect.x + 300, paragraphRect.y + 260, 22, "touch", 0.8);
    fire("pointermove", paragraphRect.x + 360, paragraphRect.y + 270, 22, "touch", 0.8);
    fire("pointerup", paragraphRect.x + 360, paragraphRect.y + 270, 22, "touch", 0.8);
    fire("pointermove", paragraphRect.x + 150, paragraphRect.y + 200, 21, "pen", 0.7);
    fire("pointerup", paragraphRect.x + 150, paragraphRect.y + 200, 21, "pen", 0.7);
  }, { paragraphRect });
  await expect(inkPaths(page)).toHaveCount(before + 1);

  // Highlighter: chisel, translucent, multiplied under the text.
  await pick(page, "Highlighter");
  await stroke(page, Array.from({ length: 10 }, (_, index) => [paragraphRect.x + 14 + index * 22, paragraphRect.y + 16]), { pressure: 0.9, pointerId: 23 });
  await expect.poll(async () => (await inkIds(page)).length).toBe(before + 2);
  const highlightId = await page.evaluate(() => [...document.querySelectorAll('.glass-ink path[data-ink-tool="highlighter"]')].at(-1)?.dataset.ink);
  assert.ok(highlightId);
  const highlighter = page.locator(`.glass-ink path[data-ink="${highlightId}"]`).first();
  await expect(highlighter).toHaveAttribute("data-ink-tool", "highlighter");
  const style = await highlighter.evaluate(node => { const rect = node.getBoundingClientRect(); return { blend: getComputedStyle(node).mixBlendMode, opacity: node.getAttribute("fill-opacity"), height: rect.height }; });
  assert.equal(style.blend, "multiply");
  assert.equal(style.opacity, "0.42");
  assert.ok(style.height >= 8, `the chisel band has body (${style.height}px)`);

  // Ink across a table row and across two list items: one stroke, one part per cell/item.
  const cellBoxes = await boxes(page, ".rich-document table td, .rich-document table th");
  assert.ok(cellBoxes.length >= 4);
  const row = cellBoxes.filter(box => Math.abs(box.y - cellBoxes[0].y) < 2);
  const tableCellA = row[0], tableCellB = row[1];
  await pick(page, "Pen");
  await palette.locator('[data-ink-width="4"]').click();
  const knownIds = await inkIds(page);
  await stroke(page, [
    [tableCellA.x + tableCellA.width * 0.6, tableCellA.y + tableCellA.height * 0.5],
    [tableCellA.x + tableCellA.width * 0.9, tableCellA.y + tableCellA.height * 0.55],
    [tableCellB.x + tableCellB.width * 0.1, tableCellB.y + tableCellB.height * 0.5],
    [tableCellB.x + tableCellB.width * 0.6, tableCellB.y + tableCellB.height * 0.45],
  ], { pointerId: 31 });
  const newId = async known => expect.poll(async () => (await inkIds(page)).find(id => !known.includes(id)), { timeout: 10_000 }).toBeTruthy().then(async () => (await inkIds(page)).find(id => !known.includes(id)));
  const tablePart = await newId(knownIds);
  assert.ok(tablePart, "the table stroke split into cell parts");
  const cellParts = await page.locator(`.glass-ink path[data-ink="${tablePart}"]`).count();
  assert.ok(cellParts >= 2, `two cells, two parts (${cellParts})`);
  const tableStored = await strokeOf(tablePart);
  assert.ok(tableStored.parts.filter(part => part.box.kind === "cell").length >= 2);
  assert.ok(await inside(page, tablePart, ".rich-document table", 12), "the table stroke stays inside the table");

  const itemBoxes = await boxes(page, ".rich-document li");
  assert.ok(itemBoxes.length >= 3);
  const itemKnown = await inkIds(page);
  await stroke(page, [
    [itemBoxes[0].x + 24, itemBoxes[0].y + itemBoxes[0].height / 2],
    [itemBoxes[0].x + 80, itemBoxes[0].y + itemBoxes[0].height / 2 + 2],
    [itemBoxes[1].x + 24, itemBoxes[1].y + itemBoxes[1].height / 2],
    [itemBoxes[1].x + 96, itemBoxes[1].y + itemBoxes[1].height / 2 + 3],
  ], { pointerId: 32 });
  const itemStrokeId = await newId(itemKnown);
  assert.ok(itemStrokeId, "the list stroke split into item parts");
  const itemStored = await strokeOf(itemStrokeId);
  assert.ok(itemStored.parts.filter(part => part.box.kind === "item").length >= 2);
  assert.ok(itemStored.parts.some(part => part.box.text === items[1]));
  assert.ok(await inside(page, itemStrokeId, ".rich-document ul, .rich-document ol", 12), "the list stroke stays inside its list");

  // Eraser bite: part of one stroke goes, the rest stays, one undo restores the whole stroke.
  const biteLine = Array.from({ length: 30 }, (_, index) => [paragraphRect.x + 30 + index * 8, tableCellA.y + 120 + (index % 2)]);
  await stroke(page, biteLine, { pointerId: 33 });
  const biteId = await page.evaluate(() => [...document.querySelectorAll(".glass-ink path")].at(-1)?.dataset.ink);
  assert.ok(biteId);
  const bitePartsBefore = (await strokeOf(biteId)).parts.length;
  assert.equal(bitePartsBefore, 1);
  await pick(page, "Eraser");
  await expect(palette.locator('[data-ink-eraser="bite"]')).toHaveAttribute("aria-pressed", "true");
  await stroke(page, [[paragraphRect.x + 145, tableCellA.y + 112], [paragraphRect.x + 145, tableCellA.y + 128]], { pointerId: 34 });
  await expect.poll(async () => fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", biteId)).parts?.length).toBe(2);
  await expect(page.locator(`.glass-ink path[data-ink="${biteId}"]`)).toHaveCount(2);
  await tray.locator("[data-ink-undo]").click();
  await expect.poll(async () => fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", biteId)).parts.length).toBe(1);

  // Whole-stroke eraser, undo and redo per stroke.
  await palette.locator('[data-ink-eraser="stroke"]').click();
  await expect(palette.locator('[data-ink-eraser="stroke"]')).toHaveAttribute("aria-pressed", "true");
  await stroke(page, [[paragraphRect.x + 30, tableCellA.y + 120], [paragraphRect.x + 40, tableCellA.y + 120]], { pointerId: 35 });
  await expect(page.locator(`.glass-ink path[data-ink="${biteId}"]`)).toHaveCount(0);
  assert.equal((await axi("glass", "show", "--note", doc, "--magnet", biteId)).deleted, true);
  await tray.locator("[data-ink-undo]").click();
  await expect(page.locator(`.glass-ink path[data-ink="${biteId}"]`)).toHaveCount(1);
  await tray.locator("[data-ink-redo]").click();
  await expect(page.locator(`.glass-ink path[data-ink="${biteId}"]`)).toHaveCount(0);
  await tray.locator("[data-ink-undo]").click();
  await expect(page.locator(`.glass-ink path[data-ink="${biteId}"]`)).toHaveCount(1);
  await expect(page.locator(`.glass-ink path[data-ink="${biteId}"]`)).toHaveCount(1);
  await expect(tray.locator("[data-ink-undo]")).toBeEnabled();
  await expect(tray.locator("[data-ink-redo]")).toBeEnabled();

  // Page edits above: every part keeps its place inside its own cell and its own item.
  const anchors = () => page.evaluate(() => {
    const near = [...document.querySelectorAll(".rich-document td, .rich-document th, .rich-document li")];
    return [...document.querySelectorAll('.glass-ink path[data-ink-box="cell"], .glass-ink path[data-ink-box="item"]')].map(node => {
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const box = near.find(candidate => {
        const r = candidate.getBoundingClientRect();
        return x >= r.left - 48 && x <= r.right + 48 && y >= r.top - 48 && y <= r.bottom + 48;
      });
      if (!box) return null;
      const r = box.getBoundingClientRect();
      return [node.dataset.inkBox, box.textContent?.trim(), Math.round(rect.left - r.left), Math.round(rect.top - r.top)];
    });
  });
  await pick(page, "Pen");
  const beforeEdit = await anchors();
  assert.ok(beforeEdit.length >= 2 && beforeEdit.every(Boolean));
  await glassMenu(page, false);
  await learning(page, false);
  await sourceMode(page, true);
  const surfaceArea = page.locator(".document-editor:not([hidden]) .cm-content");
  await expect(surfaceArea).toBeVisible();
  await surfaceArea.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Inserted above the ink.");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toMatch(/Inserted above the ink\./);
  await sourceMode(page, false);
  await learning(page, true);
  await glassMenu(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
  await expect.poll(async () => (await page.locator('.glass-ink path[data-ink-box="cell"]').count()) >= 2).toBe(true);
  await page.waitForTimeout(150);
  const afterEdit = await anchors();
  assert.deepEqual(afterEdit, beforeEdit, `cell and list strokes follow their boxes (${JSON.stringify(beforeEdit)} → ${JSON.stringify(afterEdit)})`);

  // The page scrolls under fixed ink: paths stay glued to their element.
  const pinned = async () => page.evaluate(() => {
    const path = document.querySelector('.glass-ink path[data-ink-box="cell"]');
    const cell = document.querySelector(".rich-document table td:nth-child(2)");
    return path && cell ? path.getBoundingClientRect().top - cell.getBoundingClientRect().top : null;
  });
  const scrollerTop = await pinned();
  assert.ok(scrollerTop !== null);
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(120);
  assert.ok(Math.abs((await pinned()) - scrollerTop) <= 1, "ink scrolls with the page");
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(120);

  // Screenshots: light then dark, 1440 and 720.
  await pick(page, "Pen");
  await page.waitForTimeout(200);
  await capture(page, "ink-light-1440");
  await resize(app, page, 720);
  await capture(page, "ink-light-720");
  await resize(app, page, 1440);
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "omarchy-dark"));
  await page.reload();
  await ready(page);
  await learning(page, true);
  await glassMenu(page, true);
  await expect.poll(async () => (await inkPaths(page)).count()).toBeGreaterThan(3);
  const darkInk = await page.evaluate(() => {
    const fill = getComputedStyle(document.querySelector('.glass-ink path[data-ink-tool="pen"]')).fill;
    const rgb = fill.match(/\d+/g).map(Number);
    return { fill, luminance: rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 };
  });
  assert.ok(darkInk.luminance > 180, `dark paper gets light ink (${darkInk.fill})`);
  await pick(page, "Pen");
  await capture(page, "ink-dark-1440");
  await resize(app, page, 720);
  await capture(page, "ink-dark-720");
  await resize(app, page, 1440);

  // Restart: every stroke is still there, each part still on its box.
  const strokesBefore = await page.evaluate(() => new Set([...document.querySelectorAll(".glass-ink path")].map(node => node.dataset.ink)).size);
  assert.deepEqual(errors, []);
  await app.close();
  ({ app, page, errors } = await launchApp());
  await resize(app, page, 1440);
  await ready(page);
  await learning(page, true);
  await glassMenu(page, true);
  await expect.poll(async () => new Set(await inkIds(page)).size).toBe(strokesBefore);
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "light"));
  await page.reload();
  await ready(page);
  await learning(page, true);
  await glassMenu(page, true);
  await expect.poll(async () => new Set(await inkIds(page)).size).toBe(strokesBefore);

  // Agent parity: ink reads back as SVG paths with its element, and deletes as a stroke.
  const listed = await axi("glass", "ink", "list", "--note", doc);
  assert.equal(listed.count, strokesBefore);
  const listedStroke = listed.ink.find(stroke => stroke.id === itemStrokeId);
  assert.ok(listedStroke, "the list stroke is listed");
  assert.equal(listedStroke.tool, "pen");
  assert.ok(listedStroke.parts.length >= 2);
  assert.ok(listedStroke.parts.every(part => part.path.startsWith("M ") && part.path.endsWith("Z")));
  assert.ok(listedStroke.parts.some(part => part.element && ["list", "list-item"].includes(part.element.kind)));
  assert.ok(listedStroke.parts.some(part => part.element?.id && part.element.line > 0));
  const removed = await axi("glass", "ink", "delete", "--note", doc, "--magnet", itemStrokeId);
  assert.equal(removed.deleted, true);
  await expect(page.locator(`.glass-ink path[data-ink="${itemStrokeId}"]`)).toHaveCount(0);
  assert.equal((await axi("glass", "show", "--note", doc, "--magnet", itemStrokeId)).deleted, true);

  // Budget: 2,000 strokes on the note; drawing still holds a frame. Seed them through the
  // journal (the same lines the app writes) so the test spends its time rendering, not writing.
  const journalDir = path.join(vault, ".omarkie", "glass");
  const [journalName] = (await readdir(journalDir)).filter(name => name.endsWith(".jsonl"));
  const journalPath = path.join(journalDir, journalName);
  const lastLine = (await readFile(journalPath, "utf8")).trim().split("\n").at(-1);
  const { hlc, device } = JSON.parse(lastLine);
  let [timeHex, counter] = hlc.split("-");
  let clock = parseInt(timeHex, 16), count = Number(counter);
  const anchor = stored.parts[0].anchor;
  const bulk = [];
  for (let index = 0; index < 2000; index++) {
    const x = 0.05 + (index % 40) * 0.02, y = 0.1 + Math.floor(index / 40) * 0.004;
    const fields = { kind: "ink", layer: "ink", tool: "pen", color: "#24292f", size: 4,
      parts: [{ box: { kind: "block" }, anchor, points: [[x, y, 0.5], [x + 0.01, y + 0.005, 0.5]] }] };
    for (const [field, value] of Object.entries(fields)) {
      bulk.push(JSON.stringify({ op: "set", magnetId: `m-inkbulk-${index}`, field, value, hlc: `${(++clock).toString(16)}-${(count = 0)}`, device }));
    }
  }
  await appendFile(journalPath, `${bulk.join("\n")}\n`);
  await glassMenu(page, false);
  await glassMenu(page, true);
  await expect.poll(() => page.evaluate(() =>
    [...document.querySelectorAll(".glass-ink path, .glass-ink [data-ink-batch]")].reduce((count, node) => count + Number(node.dataset.inkBatch ?? 1), 0)),
    { timeout: 60_000 }).toBeGreaterThan(2000);
  const bitmap = page.locator(".glass-ink-bitmap").first();
  await expect(bitmap).toBeVisible();
  assert.ok(await bitmap.evaluate(canvas => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) return true;
    return false;
  }), "dense committed strokes are present in the bitmap");
  await pick(page, "Pen");
  await expect(page.locator("[data-ink-live]")).toBeAttached();
  const grab = await page.evaluate(() => {
    const rect = document.querySelector(".rich-document p[data-cid]").getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  });
  await page.evaluate(() => {
    window.__inkPaints = []; window.__inkCommits = []; window.__inkUp = null; window.__inkChains = [];
    let at = 0;
    window.addEventListener("pointermove", () => { at = performance.now(); }, true);
    window.addEventListener("pointermove", () => window.__inkChains.push(performance.now() - at));
    window.addEventListener("pointerup", () => { window.__inkUp = performance.now(); }, true);
    new MutationObserver(() => window.__inkPaints.push(performance.now()))
      .observe(document.querySelector("[data-ink-live]"), { attributes: true, attributeFilter: ["d"] });
    new MutationObserver(() => window.__inkCommits.push(performance.now()))
      .observe(document.querySelector(".glass-ink"), { attributes: true, attributeFilter: ["data-glass-ink"] });
  });
  await watchWork(page);
  const cadence = await page.evaluate(async grab => {
    const surface = document.querySelector("[data-ink-surface]");
    const gaps = [];
    let then = await new Promise(resolve => requestAnimationFrame(resolve));
    let frame = requestAnimationFrame(function sample(now) {
      gaps.push(now - then);
      then = now;
      frame = requestAnimationFrame(sample);
    });
    const fire = (type, x, y) => surface.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 31, pointerType: "pen", pressure: 0.6, isPrimary: true,
      buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y }));
    fire("pointerdown", grab.x, grab.y);
    const start = performance.now();
    let step = 0;
    while (performance.now() - start < 1300) {
      fire("pointermove", grab.x + 12 + (step * 7) % 240, grab.y + (step * 3) % 16);
      await new Promise(resolve => setTimeout(resolve, 8));
      step += 1;
    }
    await new Promise(resolve => requestAnimationFrame(resolve));
    cancelAnimationFrame(frame);
    // The lift writes the stroke once; the smoothness budget covers the drawing, not that one commit.
    window.__inkLift = { x: grab.x + 12 + (step * 7) % 240, y: grab.y + (step * 3) % 16 };
    return gaps;
  }, grab);
  const inkWork = await readWork(page);
  await page.evaluate(() => {
    const surface = document.querySelector("[data-ink-surface]"), lift = window.__inkLift;
    surface.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 31,
      pointerType: "pen", pressure: 0.6, isPrimary: true, buttons: 0, clientX: lift.x, clientY: lift.y }));
  });
  await page.waitForFunction(() => window.__inkCommits.length > 0, { timeout: 30_000 });
  const timing = await page.evaluate(() => {
    const sorted = [...window.__inkChains].sort((a, b) => a - b);
    return { paints: window.__inkPaints.length, events: sorted.length,
      p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)],
      commit: window.__inkCommits[0] - window.__inkUp };
  });
  console.log(`budget: ${timing.events} pointer moves, ink handler p50 ${timing.p50?.toFixed(1)}ms p95 ${timing.p95?.toFixed(1)}ms, ${timing.paints} live paints, commit ${timing.commit?.toFixed(0)}ms`);
  assert.ok(timing.events > 20, "the drag reaches the ink surface");
  await expect(page.locator(".glass-ink")).toHaveAttribute("data-glass-ink", /./);
  const inkChains = await page.evaluate(() => [...window.__inkChains]);
  assertWorkBudget({ work: inkChains, longTasks: inkWork.longTasks, gesture: "Drawing over 2,000 strokes" });
  assert.ok(timing.paints > 0, "the live stroke repaints while drawing");
  assert.ok(timing.commit <= 1500, `committing the 2,001st stroke does not lock the app (${timing.commit?.toFixed(0)}ms)`);
  assertFrameCadence(cadence, "Drawing over 2,000 strokes");
  assert.ok(await page.evaluate(() => document.querySelector(".glass-ink").getAttribute("data-glass-ink") !== null));

  assert.deepEqual(errors, []);
  const checksum = createHash("sha256").update(await readFile(file, "utf8")).digest("hex");
  assert.ok(checksum);
  console.log(`PASS: ${strokesBefore} strokes, cell and item splitting, pressure, palm rejection, bite and whole eraser, undo/redo, reflow, restart, agent CLI, 2,000-stroke budget`);
} finally { await app.close(); }
await rm(home, { recursive: true, force: true });
