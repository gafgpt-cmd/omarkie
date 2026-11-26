import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { _electron as launch, expect } from "playwright/test";
import { decode } from "@toon-format/toon";
import sharp from "sharp";
import { setTimeout as delay } from "node:timers/promises";
import { assertFrameCadence, assertWorkBudget, readWork, stableHost, watchWork } from "./frame-cadence.mjs";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-marks-"));
const vault = path.join(home, "vault"), doc = "pharm.md", file = path.join(vault, doc);
const heading = "Pharmacology";
const first = "Beta blockers reduce heart rate by blocking beta-1 receptors.";
const far = "Contraindicated in severe asthma and advanced heart block.";
const target = "Asthma is the red-flag contraindication.";
const filler = Array.from({ length: 80 }, (_, index) => `Review point ${index + 1}: check the dose, route and timing before you move on.`);
const source = `# ${heading}\r\n\r\n${first}\r\n\r\n${far}\r\n\r\n${filler.slice(0, 30).join("\r\n\r\n")}\r\n\r\n${target}\r\n\r\n${filler.slice(30).join("\r\n\r\n")}\r\n`;
await mkdir(vault);
await writeFile(file, source, "utf8");
const record = { id: "fixture", path: file, name: doc, content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\r\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en", OMARKIE_TEST_HIDDEN: "0" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const evidence = process.env.OMARKIE_QA_DIR ?? path.join(home, "shots");
await mkdir(evidence, { recursive: true });
const fixtures = fileURLToPath(new URL("./fixtures/glass", import.meta.url));
const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
const customFile = path.join(home, "custom.png");
const customArt = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="18" fill="#f6efdc"/><circle cx="48" cy="48" r="30" fill="#2f9e5f"/><path d="M34 49l10 10 20-22" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
await sharp(Buffer.from(customArt)).png().toFile(customFile);
async function axi(...args) {
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 });
  return decode(stdout);
}
const fieldsOf = state => state.magnet?.fields ?? {};
async function grade(png) {
  return sharp(png).resize({ width: 320, kernel: "mitchell" }).grayscale().raw().toBuffer({ resolveWithObject: true });
}
async function capture(page, name) {
  const shot = path.join(evidence, `${name}.png`);
  await page.screenshot({ path: shot });
  const baseline = path.join(fixtures, `${name}.png`);
  if (process.env.OMARKIE_UPDATE_BASELINES === "1") { await copyFile(shot, baseline); return; }
  const [fresh, expected] = await Promise.all([grade(shot), grade(baseline)]);
  assert.equal(fresh.info.width, expected.info.width, `${name}: baseline width differs`);
  assert.equal(fresh.info.height, expected.info.height, `${name}: baseline height differs`);
  const a = fresh.data, b = expected.data, size = a.length;
  let sum = 0, changed = 0;
  for (let index = 0; index < size; index++) { const delta = Math.abs(a[index] - b[index]); sum += delta; if (delta > 32) changed += 1; }
  const mean = sum / size, fraction = changed / size;
  console.log(`${name}: mean ${mean.toFixed(2)}, changed ${(fraction * 100).toFixed(1)}%`);
  assert.ok(mean <= 6 && fraction <= 0.08, `${name}: drifted from baseline (mean ${mean.toFixed(2)}, changed ${(fraction * 100).toFixed(1)}%)`);
}

async function launchApp() {
  const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
  const page = await app.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  return { app, page, errors };
}
const richOf = page => page.locator(".document-editor:not([hidden]) .rich-document");
const glassOf = page => page.locator(".glass-layer");
const tray = page => page.locator(".glass-tray");
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
    if (((await glassOf(page).count()) > 0) !== on) await richOf(page).click({ position: { x: 4, y: 4 } }), await page.keyboard.press("g");
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
async function blockBox(page, text) {
  return page.evaluate(text => {
    const block = [...document.querySelectorAll(".rich-document > [data-cid]")].find(node => node.textContent?.trim() === text);
    if (!block) return null;
    const rect = block.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, text);
}
async function center(page, locator) {
  const box = await locator.boundingBox();
  assert.ok(box, "element has a box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function drag(page, locator, dx, dy, { alt = false } = {}) {
  const grab = await center(page, locator);
  grab.x = Math.round(grab.x); grab.y = Math.round(grab.y);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(grab.x + dx / 2, grab.y + dy / 2, { steps: 5 });
  await page.mouse.move(grab.x + dx, grab.y + dy, { steps: 5 });
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
}
async function scrollTop(page) {
  return page.evaluate(() => {
    let node = document.querySelector(".rich-document");
    while (node && node !== document.body) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) break;
      node = node.parentElement;
    }
    return node?.scrollTop ?? 0;
  });
}
async function scrollTo(page, top) {
  await page.evaluate(top => {
    let node = document.querySelector(".rich-document");
    while (node && node !== document.body) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) break;
      node = node.parentElement;
    }
    if (node) node.scrollTop = top;
  }, top);
}
async function scrollHome(page) {
  await page.evaluate(() => {
    let node = document.querySelector(".rich-document");
    while (node && node !== document.body) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) break;
      node = node.parentElement;
    }
    if (node) node.scrollTop = 0;
  });
}
async function selectArrow(page, id) {
  const path = page.locator(`[data-arrow-path="${id}"]`);
  await path.focus();
  await path.press("Enter");
  await expect(page.locator(`[data-arrow-tools="${id}"]`)).toBeVisible();
}
async function placeAt(page, text, dx = 0, dy = 0) {
  const box = await blockBox(page, text);
  assert.ok(box, `paragraph is on screen: ${text}`);
  await page.mouse.click(box.x + 40 + dx, box.y + 10 + dy);
}

const firstRun = await launchApp();
let { app, page, errors } = firstRun;
try {
  await resize(app, page, 1440);
  await ready(page);
  await learning(page, true);
  await glassMenu(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");

  // Sticker sheet: every built-in kind lands on the page.
  const pencil = tray(page);
  await pencil.getByRole("button", { name: "Sticker", exact: true }).click();
  const palette = page.locator('[data-glass-palette="sticker"]');
  await expect(palette).toBeVisible();
  const builtIn = await palette.locator("[data-sticker]").evaluateAll(nodes => nodes.map(node => node.dataset.sticker));
  assert.deepEqual(builtIn.sort(), ["bulb", "check", "cool", "cross", "fire", "heart", "number-1", "number-2", "number-3", "number-4",
    "number-5", "number-6", "number-7", "number-8", "number-9", "question", "smile", "star", "think", "thumbs-up", "warning"].sort());
  const sheet = await blockBox(page, first);
  const redFlag = await blockBox(page, far);
  assert.ok(sheet && redFlag);
  for (const [index, id] of builtIn.entries()) {
    await palette.locator(`[data-sticker="${id}"]`).click();
    if (id === "warning") await page.mouse.click(redFlag.x + 40, redFlag.y + 8);
    else await page.mouse.click(sheet.x + 60 + (index % 6) * 90, sheet.y + 8 + Math.floor(index / 6) * 110);
    await expect(page.locator(`.glass-sticker[data-sticker="${id}"]`)).toHaveCount(1);
  }
  await page.keyboard.press("Escape");
  // Delete each through the sticker and the keyboard, keeping the star and the red warning.
  for (const id of builtIn) {
    if (id === "star" || id === "warning") continue;
    await page.locator(`.glass-sticker[data-sticker="${id}"]`).click();
    await page.keyboard.press("Delete");
    await expect(page.locator(`.glass-sticker[data-sticker="${id}"]`)).toHaveCount(0);
  }
  const star = page.locator('.glass-sticker[data-sticker="star"]'), warning = page.locator('.glass-sticker[data-sticker="warning"]');
  await expect(star).toHaveCount(1);
  await expect(warning).toHaveCount(1);
  const starId = await star.getAttribute("data-magnet");
  const warningId = await warning.getAttribute("data-magnet");
  await expect.poll(async () => (await axi("glass", "list", "--note", doc)).magnets.map(item => item.fields.sticker).sort(),
    { timeout: 20_000 }).toEqual(["star", "warning"]);
  let listed = await axi("glass", "list", "--note", doc);
  assert.deepEqual(listed.magnets.map(item => item.fields.sticker).sort(), ["star", "warning"]);
  assert.ok(listed.magnets.every(item => item.fields.kind === "sticker" && item.fields.layer === "notes"));

  // Custom image sticker.
  await page.locator("[data-sticker-file]").setInputFiles(customFile);
  await expect(palette).toContainText("Custom sticker ready");
  await placeAt(page, far, 120, 12);
  const custom = page.locator('.glass-sticker[data-sticker="custom"]');
  await expect(custom).toHaveCount(1);
  await expect(custom.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  const customId = await custom.getAttribute("data-magnet");

  // Move, stretch and turn the star; every change reaches the journal.
  await pencil.getByRole("button", { name: "Select", exact: true }).click();
  await star.click();
  await expect(star).toHaveAttribute("data-selected", "true");
  const before = await star.boundingBox();
  const original = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", starId));
  await drag(page, star.locator(".glass-sticker-paper"), 48, 32, { alt: true });
  await expect.poll(async () => {
    const box = await star.boundingBox();
    if (!box) return false;
    return Math.abs(box.x - before.x - 48) <= 1 && Math.abs(box.y - before.y - 32) <= 1;
  }).toBe(true);
  const moved = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", starId));
  assert.ok(Math.abs(moved.x - original.x - 48) <= 1, `journal x follows the hand (${moved.x - original.x})`);
  assert.ok(Math.abs(moved.y - original.y - 32) <= 1, `journal y follows the hand (${moved.y - original.y})`);
  await star.click();
  const sized = await star.boundingBox();
  await drag(page, star.locator(".glass-sticker-grip"), 40, 16);
  await expect.poll(async () => Math.round((await star.boundingBox()).width - sized.width)).toBeGreaterThan(24);
  const scaled = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", starId));
  assert.equal(scaled.w, scaled.h, "sticker stays square");
  assert.ok(scaled.w > 72);
  await star.click();
  const turn = star.locator("[data-sticker-rotate]");
  const hub = await center(page, turn);
  const paper = await star.boundingBox();
  await page.mouse.move(hub.x, hub.y);
  await page.mouse.down();
  await page.mouse.move(paper.x + paper.width + 30, paper.y + paper.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", starId)).rotate).not.toBe(0);
  const turned = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", starId));
  assert.ok(Math.abs(turned.rotate) > 20 && Math.abs(turned.rotate) <= 180);

  // Arrows: element→element, magnet→element, element→magnet.
  await pencil.getByRole("button", { name: "Arrow", exact: true }).click();
  const arrowPalette = page.locator('[data-glass-palette="arrow"]');
  await expect(arrowPalette).toBeVisible();
  const draw = async (fromText, toText) => {
    const from = await blockBox(page, fromText), to = await blockBox(page, toText);
    assert.ok(from && to);
    await page.mouse.move(from.x + 30, from.y + 8);
    await page.mouse.down();
    await page.mouse.move(to.x + 30, to.y + 8, { steps: 12 });
    await page.mouse.up();
  };
  await draw(first, far);
  await expect(page.locator(".glass-arrow")).toHaveCount(1);
  const elementArrow = await page.locator(".glass-arrow").getAttribute("data-arrow");
  await page.keyboard.press("Escape");
  const startSticker = await center(page, star);
  const farBox = await blockBox(page, far);
  await page.mouse.move(startSticker.x, startSticker.y);
  await page.mouse.down();
  await page.mouse.move(farBox.x + 260, farBox.y + 10, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".glass-arrow")).toHaveCount(2);
  await page.keyboard.press("Escape");
  const magnetArrow = (await page.locator(".glass-arrow").evaluateAll(nodes => nodes.map(node => node.dataset.arrow)))
    .find(id => id !== elementArrow);
  const firstBox = await blockBox(page, first), warningCenter = await center(page, warning);
  await page.mouse.move(firstBox.x + 40, firstBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(warningCenter.x, warningCenter.y, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".glass-arrow")).toHaveCount(3);
  await page.keyboard.press("Escape");
  const thirdArrow = (await page.locator(".glass-arrow").evaluateAll(nodes => nodes.map(node => node.dataset.arrow)))
    .find(id => id !== elementArrow && id !== magnetArrow);
  await page.mouse.move(warningCenter.x, warningCenter.y);
  await page.mouse.down();
  await page.mouse.move((await center(page, star)).x, (await center(page, star)).y, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".glass-arrow")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(pencil.locator("[data-glass-saved]")).toHaveText("Saved", { timeout: 15_000 });
  listed = await axi("glass", "list", "--note", doc);
  const arrows = listed.magnets.filter(item => item.fields.kind === "arrow");
  assert.equal(arrows.length, 4);
  const stickerArrow = arrows.find(item => item.fields.from?.kind === "magnet" && item.fields.to?.kind === "magnet");
  assert.ok(stickerArrow, `the sticker-to-sticker arrow is in the journal (${JSON.stringify(arrows.map(item => [item.id, item.fields.from, item.fields.to]))})`);
  const elementPair = arrows.find(item => item.id === elementArrow);
  assert.deepEqual([elementPair.fields.from.kind, elementPair.fields.to.kind], ["element", "element"]);
  const mixed = arrows.find(item => item.id === magnetArrow);
  assert.deepEqual([mixed.fields.from.kind, mixed.fields.to.kind], ["magnet", "element"]);
  const reverse = arrows.find(item => item.id === thirdArrow);
  assert.deepEqual([reverse.fields.from.kind, reverse.fields.to.kind], ["element", "magnet"]);

  // Style, colour, head and label live on the selected arrow.
  await pencil.getByRole("button", { name: "Select", exact: true }).click();
  await selectArrow(page, thirdArrow);
  const tools = page.locator(`[data-arrow-tools="${thirdArrow}"]`);
  await tools.locator('[data-arrow-style="curved"]').click();
  await tools.locator('[data-arrow-colour="red"]').click();
  await tools.locator('[data-arrow-head-shape="open"]').click();
  await tools.locator("[data-arrow-label]").fill("dose → mechanism");
  await tools.locator("[data-arrow-label]").press("Enter");
  await expect(page.locator(`[data-arrow-label-text="${thirdArrow}"]`)).toHaveText("dose → mechanism");
  await expect.poll(async () => {
    const fields = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", thirdArrow));
    return [fields.style, fields.color, fields.head, fields.label];
  }).toEqual(["curved", "red", "open", "dose → mechanism"]);
  await page.keyboard.press("Escape");
  await expect(page.locator(`[data-arrow-tools="${thirdArrow}"]`)).toHaveCount(0);

  // A far end scrolls into view while the arrow is being drawn, then becomes a jump chip.
  await pencil.getByRole("button", { name: "Arrow", exact: true }).click();
  await expect(page.locator("[data-glass-arrow-surface]")).toBeVisible();
  const top = await blockBox(page, first);
  await page.mouse.move(top.x + 20, top.y + 8);
  await page.mouse.down();
  await page.mouse.move(720, 880, { steps: 8 });
  await expect.poll(() => scrollTop(page), { timeout: 8_000 }).toBeGreaterThan(400);
  await expect.poll(async () => {
    const box = await blockBox(page, target);
    return box && box.y > 10 && box.y < 820 ? 1 : 0;
  }, { timeout: 10_000 }).toBe(1);
  await page.mouse.move(720, 400);
  const targetTop = (await blockBox(page, target)).y + await scrollTop(page);
  await scrollTo(page, Math.max(0, targetTop - 300));
  await page.waitForTimeout(150);
  const farTarget = await blockBox(page, target);
  assert.ok(farTarget, "the far paragraph scrolled into view");
  await page.mouse.move(farTarget.x + 20, farTarget.y + 8, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".glass-arrow")).toHaveCount(5);
  await page.keyboard.press("Escape");
  await scrollHome(page);
  const jump = page.locator("[data-arrow-jump]").first();
  await expect(jump).toBeVisible();
  await expect(jump).toHaveAttribute("data-direction", "down");
  await jump.click();
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(0);

  // Edit text above the arrows: their ends still land on their paragraphs.
  const arrowEnds = () => page.evaluate(() => [...document.querySelectorAll(".glass-arrow")].map(node => {
    const path = node.querySelector("[data-arrow-path]")?.getAttribute("d") ?? "";
    const box = node.ownerSVGElement?.getBoundingClientRect();
    return { id: node.getAttribute("data-arrow"), path, top: box?.top };
  }));
  await scrollHome(page);
  const endsBefore = await arrowEnds();
  await learning(page, false);
  await sourceMode(page, true);
  const surface = page.locator(".document-editor:not([hidden]) .cm-content");
  await expect(surface).toBeVisible();
  await surface.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("Inserted above every arrow.\n\n");
  await expect.poll(() => page.evaluate(() => document.querySelector(".cm-content")?.textContent?.startsWith("Inserted above"))).toBe(true);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toMatch(/Inserted above/);
  await sourceMode(page, false);
  await learning(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
  await expect.poll(() => page.locator(".glass-arrow").count()).toBe(5);
  await expect.poll(async () => {
    const now = await arrowEnds();
    return now.map(item => item.path).join("|") !== endsBefore.map(item => item.path).join("|");
  }).toBe(true);
  const paragraphs = await axi("glass", "list", "--note", doc);
  assert.equal(paragraphs.magnets.filter(item => item.fields.kind === "arrow").length, 5, "arrows survive the edit");

  // Delete one arrow, undo from the trash.
  await pencil.getByRole("button", { name: "Select", exact: true }).click();
  await selectArrow(page, thirdArrow);
  await page.locator(`[data-arrow-tools="${thirdArrow}"] [data-arrow-delete]`).click();
  await expect(page.locator(".glass-arrow")).toHaveCount(4);
  await pencil.locator("[data-glass-trash]").click();
  await page.locator(`.glass-trash [data-glass-restore="${thirdArrow}"]`).click();
  await expect(page.locator(".glass-arrow")).toHaveCount(5);

  // Sample actual display refreshes during a native 1.3 s pointer drag, not the drop commit.
  await pencil.getByRole("button", { name: "Select", exact: true }).click();
  await selectArrow(page, thirdArrow);
  const handle = page.locator('[data-arrow-handle="to"]');
  await expect(handle).toBeVisible();
  const hand = await center(page, handle);
  await page.mouse.move(hand.x, hand.y);
  await page.mouse.down();
  const arrowPath = page.locator(`[data-arrow-path="${thirdArrow}"]`);
  const beforeDrag = await arrowPath.getAttribute("d");
  await watchWork(page);
  await page.evaluate(() => {
    window.__marksGaps = [];
    const sample = now => {
      if (window.__marksPrevious !== undefined) window.__marksGaps.push(now - window.__marksPrevious);
      window.__marksPrevious = now;
      window.__marksFrame = requestAnimationFrame(sample);
    };
    window.__marksFrame = requestAnimationFrame(sample);
  });
  const dragStart = performance.now(), arrowCosts = [];
  for (let step = 0; performance.now() - dragStart < 1300; step++) {
    await page.mouse.move(hand.x + 40 + (step % 10) * 4, hand.y + 40);
    arrowCosts.push(Number(await page.evaluate(() => document.documentElement.dataset.glassArrowMs)));

    await delay(8);
  }
  const gaps = await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    cancelAnimationFrame(window.__marksFrame);
    return window.__marksGaps;
  });
  assert.notEqual(await arrowPath.getAttribute("d"), beforeDrag, "the arrow follows its dragged end");
  const work = await readWork(page);
  await page.mouse.up();
  assertWorkBudget({ work: arrowCosts.filter(Number.isFinite), longTasks: work.longTasks, gesture: "Dragging an arrow end", longest: stableHost() ? 50 : 500 });
  assertFrameCadence(gaps, "Dragging an arrow end");

  // Screenshots, light and dark, wide and narrow.
  await page.keyboard.press("Escape");
  await page.mouse.move(900, 300);
  await scrollHome(page);
  await expect(pencil.locator("[data-glass-saved]")).toHaveText("Saved", { timeout: 15_000 });
  await capture(page, "marks-light-1440");
  await resize(app, page, 720);
  await capture(page, "marks-light-720");
  await resize(app, page, 1440);
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "omarchy-dark"));
  await page.reload();
  await ready(page);
  await learning(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
  await expect(page.locator(".glass-sticker")).toHaveCount(3);
  await expect(page.locator(".glass-arrow")).toHaveCount(5);
  await capture(page, "marks-dark-1440");
  await resize(app, page, 720);
  await capture(page, "marks-dark-720");
  await resize(app, page, 1440);

  // Agent parity: CLI adds a sticker and an arrow; list and delete both.
  const added = await axi("glass", "add", "--note", doc, "--kind", "sticker", "--sticker", "heart", "--near", "Review point 3: check the dose, route and timing before you move on.", "--magnet", "m-agent-heart");
  assert.equal(added.magnet.fields.sticker, "heart");
  await expect(page.locator('.glass-sticker[data-magnet="m-agent-heart"]')).toHaveCount(1, { timeout: 15_000 });
  const elements = await axi("element", "list", "--note", doc);
  const element = elements.elements.find(item => item.kind === "paragraph" && item.text === "Review point 3: check the dose, route and timing before you move on.");
  assert.ok(element, "element list names the paragraph");
  const arrow = await axi("glass", "add", "--note", doc, "--kind", "arrow", "--from", `element:${element.id}`, "--to", "magnet:m-agent-heart",
    "--style", "curved", "--color", "blue", "--head", "solid", "--label", "agent arrow", "--magnet", "m-agent-arrow");
  assert.equal(arrow.magnet.fields.kind, "arrow");
  await expect(page.locator('.glass-arrow[data-arrow="m-agent-arrow"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('[data-arrow-label-text="m-agent-arrow"]')).toHaveText("agent arrow");
  const quoted = await axi("glass", "add", "--note", doc, "--kind", "arrow", "--from", `quote:${first}`, "--to", "magnet:m-agent-heart",
    "--magnet", "m-agent-quoted", "--label", "quoted link");
  assert.equal(quoted.magnet.fields.from.kind, "element");
  await expect(page.locator('.glass-arrow[data-arrow="m-agent-quoted"]')).toHaveCount(1, { timeout: 15_000 });
  await axi("glass", "delete", "--note", doc, "--magnet", "m-agent-quoted");
  await axi("glass", "delete", "--note", doc, "--magnet", "m-agent-arrow");
  await expect(page.locator('.glass-arrow[data-arrow="m-agent-arrow"]')).toHaveCount(0);
  listed = await axi("glass", "list", "--note", doc);
  assert.ok(listed.magnets.some(item => item.id === "m-agent-heart"));
  assert.ok(!listed.magnets.some(item => item.id === "m-agent-arrow"));

  // Restart: stickers and arrows come back in the same spots.
  const beforeRestart = await page.locator(".glass-sticker, .glass-arrow").count();
  const starPlace = await star.boundingBox();
  const firstBefore = await blockBox(page, first);
  assert.deepEqual(errors, []);
  await app.close();
  ({ app, page, errors } = await launchApp());
  await resize(app, page, 1440);
  await ready(page);
  await learning(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
  await expect(page.locator(".glass-sticker, .glass-arrow")).toHaveCount(beforeRestart);
  const starAfter = await page.locator(`.glass-sticker[data-magnet="${starId}"]`).boundingBox();
  const firstAfter = await blockBox(page, first);
  const beforeOffset = { x: starPlace.x - firstBefore.x, y: starPlace.y - firstBefore.y };
  const afterOffset = { x: starAfter.x - firstAfter.x, y: starAfter.y - firstAfter.y };
  assert.ok(Math.abs(afterOffset.x - beforeOffset.x) <= 2 && Math.abs(afterOffset.y - beforeOffset.y) <= 2,
    `sticker survives restart anchored to its paragraph (${JSON.stringify({ beforeOffset, afterOffset })})`);
  await expect(page.locator(`.glass-sticker[data-magnet="${starId}"]`).locator("svg, img")).toHaveCount(1);
  assert.deepEqual(errors, []);
} finally {
  await app.close().catch(() => {});
}
