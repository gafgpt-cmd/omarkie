import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { _electron as launch, expect } from "playwright/test";
import { decode } from "@toon-format/toon";
import sharp from "sharp";
import { setTimeout as delay } from "node:timers/promises";
import { assertFrameCadence, assertWorkBudget, readWork, watchWork } from "./frame-cadence.mjs";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";
import { GlassService } from "../electron/glass-service.mjs";

if (process.platform === "win32") process.exit(0);
const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-snap-"));
const vault = path.join(home, "vault"), doc = "snap.md", file = path.join(vault, doc);
const heading = "Pharmacology";
const first = "Beta blockers reduce heart rate by blocking beta-1 receptors in the sinoatrial node.";
const second = "Contraindicated in severe asthma and advanced heart block.";
const filler = Array.from({ length: 60 }, (_, index) => `Review point ${index + 1}: check the dose, route and timing before you move on.`);
const source = `# ${heading}\r\n\r\n${first}\r\n\r\n${second}\r\n\r\n${filler.slice(0, 20).join("\r\n\r\n")}\r\n\r\nAsthma is the red-flag contraindication.\r\n\r\n${filler.slice(20).join("\r\n\r\n")}\r\n`;
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
const photo = path.join(home, "harbour.png");
await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 120, g: 160, b: 190 } } }).png().toFile(photo);

async function axi(...args) {
  try {
    const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 60_000 });
    return decode(stdout);
  } catch (error) {
    if (typeof error.code !== "number" || !error.stdout) throw error;
    return { exit: error.code, ...decode(error.stdout) };
  }
}
const fieldsOf = state => state.magnet?.fields ?? {};
const near = (value, wanted, tolerance = 1) => Math.abs(value - wanted) <= tolerance;
const onGrid = (value, step) => { const rest = ((value % step) + step) % step; return Math.min(rest, step - rest) <= 1; };
const frameX = (locator) => locator.evaluate(node => {
  const layer = node.closest(".glass-layer");
  return node.getBoundingClientRect().left - layer.getBoundingClientRect().left;
});

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
const guides = page => page.locator(".glass-guides");
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
async function columnBox(page) {
  return page.evaluate(() => {
    const rect = document.querySelector(".rich-document").getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  });
}
async function lineBoxes(page, text) {
  return page.evaluate(text => {
    const block = [...document.querySelectorAll(".rich-document > [data-cid]")].find(node => node.textContent?.trim() === text);
    if (!block) return [];
    const range = document.createRange();
    range.selectNodeContents(block);
    return [...range.getClientRects()].filter(rect => rect.width > 8).map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
  }, text);
}
async function grab(page, locator) {
  const box = await locator.boundingBox();
  assert.ok(box, "magnet has a box");
  return { x: box.x + Math.min(24, box.width / 2), y: box.y + 7, box };
}
async function dragTo(page, locator, left, top, { alt = false } = {}) {
  const start = await grab(page, locator);
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const dx = left - start.box.x, dy = top - start.box.y;
  await page.mouse.move(start.x + dx / 2, start.y + dy / 2, { steps: 6 });
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 6 });
  return { dx, dy };
}
async function drop(page) {
  await page.mouse.up();
  await page.keyboard.up("Alt").catch(() => {});
}
const guideOf = async (page, axis) => {
  const node = page.locator(`.glass-guides [data-guide="${axis}"]`);
  if (await node.isHidden().catch(() => true)) return null;
  return { kind: await node.getAttribute("data-kind"), left: await node.evaluate(node => Number.parseFloat(node.style.left)),
    top: await node.evaluate(node => Number.parseFloat(node.style.top)), label: await node.getAttribute("data-label") };
};
const saved = page => expect(tray(page).locator("[data-glass-saved]")).toHaveText("Saved", { timeout: 15_000 });
async function openGrid(page) {
  const toggle = tray(page).locator("[data-glass-grid]");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.locator('[data-glass-palette="grid"]')).toBeVisible();
}

const firstRun = await launchApp();
let { app, page, errors } = firstRun;
let anchor;
try {
  await resize(app, page, 1440);
  await ready(page);
  await learning(page, true);
  await glassMenu(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");

  // Grid: toggle in the pencil case, three sizes, off, visible paper grid.
  await openGrid(page);
  const gridPalette = page.locator('[data-glass-palette="grid"]');
  await expect(gridPalette).toBeVisible();
  await gridPalette.locator('[data-grid-size="16"]').click();
  await expect(glassOf(page)).toHaveAttribute("data-grid", "16");
  await expect(page.locator(".glass-grid")).toHaveAttribute("data-glass-grid", "16");
  await gridPalette.locator('[data-grid-size="off"]').click();
  await expect(glassOf(page)).toHaveAttribute("data-grid", "off");
  await expect(page.locator(".glass-grid")).toHaveCount(0);
  await gridPalette.locator('[data-grid-size="8"]').click();
  await expect(glassOf(page)).toHaveAttribute("data-grid", "8");
  await page.keyboard.press("Escape");

  // Magnets: two notes, a sticker and a floating photo, all anchored through the agent CLI.
  const added = await axi("glass", "add", "--note", doc, "--kind", "sticky", "--near", first, "--text", "Rate check", "--x", "120", "--y", "40", "--magnet", "m-note-a");
  assert.equal(added.magnet.fields.kind, "sticky");
  anchor = added.magnet.fields.anchor;
  await axi("glass", "add", "--note", doc, "--kind", "sticky", "--near", first, "--text", "Dose", "--x", "420", "--y", "40", "--magnet", "m-note-b");
  await axi("glass", "add", "--note", doc, "--kind", "sticker", "--sticker", "star", "--near", first, "--x", "600", "--y", "200", "--magnet", "m-star");
  await axi("glass", "add", "--note", doc, "--kind", "image", "--file", photo, "--near", second, "--x", "40", "--y", "30", "--wrap", "front", "--w", "160", "--magnet", "m-photo");
  const noteA = page.locator('.glass-note[data-magnet="m-note-a"]');
  const noteB = page.locator('.glass-note[data-magnet="m-note-b"]');
  const star = page.locator('.glass-sticker[data-magnet="m-star"]');
  const photoFrame = page.locator('.glass-image[data-magnet="m-photo"]');
  await expect(noteA).toHaveCount(1, { timeout: 15_000 });
  await expect(noteB).toHaveCount(1, { timeout: 15_000 });
  await expect(star).toHaveCount(1, { timeout: 15_000 });
  await expect(photoFrame).toHaveCount(1, { timeout: 15_000 });
  await expect(photoFrame).toHaveAttribute("data-wrap", "front");

  // 1. Edge snap: paper dragged four pixels off a neighbour's edge lands exactly on it.
  const frame = () => guides(page).boundingBox();
  let b = await noteB.boundingBox();
  await dragTo(page, noteA, b.x + 4, b.y);
  await expect(guides(page)).toHaveAttribute("data-snap", "on");
  const edge = await guideOf(page, "x");
  assert.ok(edge, "an x guide is drawn");
  assert.equal(edge.kind, "edge");
  assert.ok(near(edge.left, b.x - (await frame()).x, 1), `guide sits on the neighbour's edge (${edge.left})`);
  await expect(noteA).toHaveClass(/is-lifting/);
  assert.equal(Math.round(await noteA.evaluate(node => Number.parseFloat(getComputedStyle(node).scale || "1")) * 100) / 100, 1.02, "the picked-up note lifts");
  const snapMs = Number(await guides(page).getAttribute("data-snap-ms"));
  assert.ok(snapMs >= 0 && snapMs < 2, `guides cost ${snapMs} ms`);
  await drop(page);
  await expect(noteA).toHaveClass(/is-settling/);
  await expect(noteA).not.toHaveClass(/is-settling/, { timeout: 5_000 });
  await saved(page);
  assert.ok(near((await noteA.boundingBox()).x, b.x, 1), "the dropped note sits on the edge");
  const aEdge = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", "m-note-a"));
  const bEdge = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", "m-note-b"));
  assert.ok(near(aEdge.x, bEdge.x, 1), `the journal keeps the aligned offset (${aEdge.x} vs ${bEdge.x})`);
  await expect(noteA).not.toHaveClass(/is-lifting/);

  // 2. The page text column is a guide: a sticker near the measure snaps to its edge.
  const column = await columnBox(page);
  const starBox = await star.boundingBox();
  await dragTo(page, star, column.left + 4, starBox.y);
  const columnGuide = await guideOf(page, "x");
  assert.ok(columnGuide && columnGuide.kind === "column", `column guide drawn (${JSON.stringify(columnGuide)})`);
  assert.ok(near(columnGuide.left, column.left - (await frame()).x, 1), "the column guide sits on the measure");
  await drop(page);
  await saved(page);
  assert.ok(near((await star.boundingBox()).x, column.left, 2), "sticker flush with the text column");
  assert.equal(fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", "m-star")).y, 200, "the column snap touches x only");

  // 3. Centre snap: a narrow sticker centres on a wider note.
  b = await noteB.boundingBox();
  await dragTo(page, star, b.x + b.width / 2 - 36 + 3, b.y);
  const centre = await guideOf(page, "x");
  assert.ok(centre && centre.kind === "center", `centre guide drawn (${JSON.stringify(centre)})`);
  assert.ok(near(centre.left, b.x + b.width / 2 - (await frame()).x, 2));
  await drop(page);
  await saved(page);
  assert.ok(near((await star.boundingBox()).x + 36, b.x + b.width / 2, 2), "centres line up on screen");
  assert.ok(near(fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", "m-star")).x, 500, 2), "centres line up at 120+116-36");

  // 4. Spacing hint: an eight-pixel gap beside a neighbour is named.
  const bRight = b.x + b.width;
  await dragTo(page, star, bRight + 9, b.y + 30);
  const spacing = await guideOf(page, "spacing");
  assert.ok(spacing, "a spacing hint is drawn");
  assert.equal(spacing.label, "8");
  await drop(page);
  await saved(page);

  // 5. Glue to a text line: the dropped sticker reads like it was written on that line.
  await page.keyboard.press("Escape");
  const glueText = filler[8];
  const lines = await lineBoxes(page, glueText);
  assert.ok(lines.length >= 1, `the paragraph has ${lines.length} lines`);
  const line = lines[0];
  const starNow = await star.boundingBox();
  await dragTo(page, star, starNow.x, line.y - 5);
  const lineGuide = await guideOf(page, "y");
  assert.ok(lineGuide && lineGuide.kind === "line", `line guide drawn (${JSON.stringify(lineGuide)})`);
  assert.ok(near(lineGuide.top, line.y - (await frame()).y, 1), "line guide sits on the text line");
  await drop(page);
  await saved(page);
  const glued = await star.boundingBox();
  assert.ok(near(glued.y, line.y, 1), `sticker top glued to the text line (${glued.y} vs ${line.y})`);
  const anchorBox = await blockBox(page, first);
  const gluedFields = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", "m-star"));
  assert.ok(near(gluedFields.y, line.y - anchorBox.y, 2), `line glue is stored as an anchor offset (${gluedFields.y} vs ${line.y - anchorBox.y})`);

  // 6. Alt disables every guide and keeps the hand's place.
  await page.keyboard.press("Escape");
  b = await noteB.boundingBox();
  const before = await star.boundingBox();
  const beforeFields = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", "m-star"));
  const hand = beforeFields.x + Math.round(b.x + 5 - before.x);
  await dragTo(page, star, b.x + 5, before.y, { alt: true });
  await expect(guides(page)).toHaveAttribute("data-snap", "off");
  assert.equal(await guideOf(page, "x"), null, "no guide with Alt down");
  await drop(page);
  await saved(page);
  const altFields = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", "m-star"));
  assert.ok(near(altFields.x, hand, 1), `Alt keeps the raw offset (${altFields.x} vs ${hand})`);
  assert.notEqual(altFields.x % 8, 0, "Alt skips the grid too");

  // 7. Grid off means free pixels; 16 and 8 round to their own steps.
  const desk = await columnBox(page);
  const odd = 83;
  await page.keyboard.press("Escape");
  await openGrid(page);
  await gridPalette.locator('[data-grid-size="off"]').click();
  const freeStart = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", "m-note-b"));
  const freeBox = await noteB.boundingBox();
  const freeWanted = freeStart.x + Math.round(desk.right + odd - freeBox.x);
  await dragTo(page, noteB, desk.right + odd, freeBox.y);
  await drop(page);
  await saved(page);
  const free = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", "m-note-b"));
  assert.ok(near(free.x, freeWanted, 1), `grid off keeps the hand's odd offset (${free.x} vs ${freeWanted})`);
  await gridPalette.locator('[data-grid-size="16"]').click();
  await expect(glassOf(page)).toHaveAttribute("data-grid", "16");
  await dragTo(page, noteB, (await noteB.boundingBox()).x + 3, (await noteB.boundingBox()).y);
  await drop(page);
  await saved(page);
  const wide = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", "m-note-b"));
  assert.ok(onGrid(await frameX(noteB), 16), `grid 16 puts the note on a paper line (${await frameX(noteB)})`);
  await gridPalette.locator('[data-grid-size="8"]').click();
  await page.keyboard.press("Escape");
  await expect(glassOf(page)).toHaveAttribute("data-grid", "8");

  // 8. Every magnet kind lifts and shows guides while picked up; the photo snaps too.
  b = await noteA.boundingBox();
  await dragTo(page, noteB, b.x + 4, b.y);
  await expect(noteB).toHaveClass(/is-lifting/);
  assert.equal(await guideOf(page, "x").then(guide => guide?.kind), "edge");
  await drop(page);
  b = await noteB.boundingBox();
  await dragTo(page, star, b.x + 4, b.y + 160);
  await expect(star).toHaveClass(/is-lifting/);
  assert.equal(await guideOf(page, "x").then(guide => guide?.kind), "edge");
  await drop(page);
  b = await noteB.boundingBox();
  const photoBox = await photoFrame.boundingBox();
  await dragTo(page, photoFrame.locator("[data-glass-image-body]"), b.x + 4, photoBox.y);
  await expect(photoFrame).toHaveClass(/is-lifting/);
  assert.equal(await guideOf(page, "x").then(guide => guide?.kind), "edge");
  await drop(page);
  await saved(page);
  await expect(photoFrame).not.toHaveClass(/is-lifting/);

  // 9. Reduced motion: the lift is a shadow only, and the drop never eases.
  await page.emulateMedia({ reducedMotion: "reduce" });
  b = await noteB.boundingBox();
  const calm = await photoFrame.boundingBox();
  await dragTo(page, photoFrame.locator("[data-glass-image-body]"), b.x + 4, calm.y + 260);
  await expect(photoFrame).toHaveClass(/is-lifting/);
  assert.equal(await photoFrame.evaluate(node => getComputedStyle(node).scale), "1", "reduced motion keeps the photo flat");
  await drop(page);
  assert.equal(await photoFrame.evaluate(node => node.classList.contains("is-settling")), false, "no settle ease under reduced motion");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // 10. Screenshots: light and dark, wide and narrow. The paper grid is visible.
  await page.locator('[data-glass-tool="select"]').click();
  await axi("glass", "move", "--note", doc, "--magnet", "m-note-a", "--x", "60", "--y", "40");
  await axi("glass", "move", "--note", doc, "--magnet", "m-note-b", "--x", "380", "--y", "40");
  await axi("glass", "move", "--note", doc, "--magnet", "m-star", "--x", "520", "--y", "220");
  await axi("glass", "move", "--note", doc, "--magnet", "m-photo", "--x", "40", "--y", "40");
  await page.keyboard.press("Escape");
  await page.mouse.move(8, 8);
  await saved(page);
  await capture(page, "snap-light-1440");
  await resize(app, page, 720);
  await capture(page, "snap-light-720");
  await resize(app, page, 1440);
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "omarchy-dark"));
  await page.reload();
  await ready(page);
  await learning(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
  await expect(glassOf(page)).toHaveAttribute("data-grid", "8");
  await expect(page.locator(".glass-note, .glass-sticker, .glass-image")).toHaveCount(4);
  await capture(page, "snap-dark-1440");
  await resize(app, page, 720);
  await capture(page, "snap-dark-720");
  await resize(app, page, 1440);

  // 11. Agent parity: the CLI snaps with the same rules and reports its guides.
  await axi("glass", "move", "--note", doc, "--magnet", "m-note-a", "--x", "100", "--y", "100");
  await axi("glass", "move", "--note", doc, "--magnet", "m-note-b", "--x", "800", "--y", "100");
  const snappedEdge = await axi("glass", "move", "--note", doc, "--magnet", "m-star", "--x", "328", "--y", "600", "--snap");
  assert.equal(fieldsOf(snappedEdge).x, 332, `CLI edge snap (${fieldsOf(snappedEdge).x})`);
  assert.equal(snappedEdge.snap.guides[0].kind, "edge");
  assert.ok(fieldsOf(snappedEdge).x !== 328, "the sticker moved off the hand's spot");
  const snappedGrid = await axi("glass", "move", "--note", doc, "--magnet", "m-star", "--x", "659", "--y", "199", "--snap", "--grid", "16");
  assert.deepEqual([fieldsOf(snappedGrid).x, fieldsOf(snappedGrid).y], [656, 196], "CLI rounds x to 16 and snaps y to the neighbour bottom");
  const snappedGrid8 = await axi("glass", "move", "--note", doc, "--magnet", "m-star", "--x", "203", "--y", "417", "--snap");
  assert.deepEqual([fieldsOf(snappedGrid8).x, fieldsOf(snappedGrid8).y], [200, 416], "CLI defaults to the 8 px grid");
  const badGrid = await axi("glass", "move", "--note", doc, "--magnet", "m-star", "--x", "1", "--y", "1", "--snap", "--grid", "7");
  assert.equal(badGrid.exit, 2, "an unknown grid size is refused");
  assert.match(badGrid.error, /--grid must be 0, 8, 16, 24\./);

  // 12. Restart: the grid choice and every snapped offset come back.
  const starFields = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", "m-star"));
  const aFields = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", "m-note-a"));
  assert.deepEqual(errors, []);
  await app.close();
  ({ app, page, errors } = await launchApp());
  await resize(app, page, 1440);
  await ready(page);
  await learning(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
  await expect(glassOf(page)).toHaveAttribute("data-grid", "8");
  await expect(page.locator(".glass-note, .glass-sticker, .glass-image")).toHaveCount(4);
  assert.equal(fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", "m-star")).x, starFields.x);
  assert.equal(fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", "m-note-a")).x, aFields.x);
  assert.deepEqual(errors, []);
  await app.close();

  // 13. Budget: 200 magnets, guides under 2 ms per move, drag still at 60 fps.
  const seed = await new GlassService({ root: vault, appData: home, device: "desktop-test" }).open();
  for (let index = 0; index < 200; index++)
    await seed.request({ action: "add", note: doc, magnet: `m-perf-${index}`,
      fields: { kind: "sticker", sticker: "star", anchor, x: 20 + (index % 20) * 68, y: 20 + Math.floor(index / 20) * 58, w: 72, h: 72, rotate: 0, layer: "notes" } });
  await seed.close();
  ({ app, page, errors } = await launchApp());
  await resize(app, page, 1440);
  await ready(page);
  await learning(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
  const perfStar = page.locator('.glass-sticker[data-magnet="m-perf-150"]');
  await expect(perfStar).toHaveCount(1, { timeout: 30_000 });
  assert.ok(await page.locator(".glass-sticker").count() >= 201, "every magnet is on the glass");
  await page.evaluate(() => {
    window.__snapGaps = [];
    const sample = now => {
      if (window.__snapPrevious !== undefined) window.__snapGaps.push(now - window.__snapPrevious);
      window.__snapPrevious = now;
      window.__snapFrame = requestAnimationFrame(sample);
    };
    window.__snapFrame = requestAnimationFrame(sample);
  });
  const start = await grab(page, perfStar);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 0; step < 6; step++) {
    await page.mouse.move(start.x + 20 + step * 4, start.y + 30 + step * 3);
    await delay(16);
  }
  // The drag itself is the interaction: watch long tasks and per-move work from here.
  await watchWork(page);
  const costs = [], dragCosts = [];
  while (costs.length < 40) {
    await page.mouse.move(start.x + 20 + (costs.length % 14) * 6, start.y + 30 + (costs.length % 9) * 4);
    costs.push(Number(await guides(page).getAttribute("data-snap-ms")));
    dragCosts.push(Number(await glassOf(page).getAttribute("data-drag-ms")));
    await delay(8);
  }
  const gaps = await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    cancelAnimationFrame(window.__snapFrame);
    return window.__snapGaps;
  });
  const work = await readWork(page);
  await page.mouse.up();
  const sorted = costs.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  console.log(`guide math over 200 magnets: p95 ${p95?.toFixed(3)} ms, max ${sorted.at(-1)?.toFixed(3)} ms over ${sorted.length} moves`);
  // The strict 2 ms budget for the guide math is proven in glass-snap.test.mjs. This end-to-end
  // sample runs on shared hosts, so it only guards against a pathological slowdown.
  assert.ok(sorted.length >= 20 && p95 <= 50, `guides stay responsive on the app path (p95 ${p95}, max ${sorted.at(-1)})`);
  assertWorkBudget({ work: dragCosts.filter(Number.isFinite), longTasks: work.longTasks, gesture: "Dragging with 200 magnets" });
  assertFrameCadence(gaps, "Dragging with 200 magnets");
  assert.deepEqual(errors, []);
} finally {
  await app.close().catch(() => {});
}

console.log(`glass snap desktop: ok (${evidence})`);
