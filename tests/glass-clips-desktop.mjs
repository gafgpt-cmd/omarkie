import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { _electron as launch, expect } from "playwright/test";
import { decode } from "@toon-format/toon";
import sharp from "sharp";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-clips-live-"));
const vault = path.join(home, "vault"), doc = "map.md", file = path.join(vault, doc);
const heading = "Reading a contour map";
const first = "Closely spaced contour lines indicate a steep slope.";
const second = "A saddle is a low point between two summits.";
const third = "Contour lines never cross each other on a map.";
const filler = Array.from({ length: 70 }, (_, index) => `Map point ${index + 1}: read the interval, the index contour and the slope.`);
const source = `# ${heading}\r\n\r\n${first}\r\n\r\n${second}\r\n\r\n${filler.slice(0, 25).join("\r\n\r\n")}\r\n\r\n${third}\r\n\r\n${filler.slice(25).join("\r\n\r\n")}\r\n`;
await mkdir(vault);
await writeFile(file, source, "utf8");
const hash = createHash("sha256").update(source).digest("hex");
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: "fixture", folder: vault,
  documents: [{ id: "fixture", path: file, name: doc, content: source, savedContent: source, diskHash: hash, lineEnding: "\r\n" }] }), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en", OMARKIE_TEST_HIDDEN: "0" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const evidence = process.env.OMARKIE_QA_DIR ?? path.join(home, "shots");
await mkdir(evidence, { recursive: true });
const fixtures = fileURLToPath(new URL("./fixtures/glass", import.meta.url));
const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
async function axi(...args) {
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 });
  return decode(stdout);
}
const richOf = page => page.locator(".document-editor:not([hidden]) .rich-document");
const glassOf = page => page.locator(".glass-layer");
async function ready(page) {
  await expect(richOf(page).getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
}
async function flip(page, label, settled) {
  const item = page.getByRole("menuitemcheckbox", { name: label, exact: true });
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await settled()) return;
    if (!(await item.isVisible().catch(() => false))) await page.getByRole("button", { name: "Display", exact: true }).click();
    await page.waitForTimeout(120);
    await item.click().catch(() => {});
    await page.waitForTimeout(250);
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
async function glassOn(page) {
  if (process.platform === "linux") await flip(page, "Glass overlay", async () => (await glassOf(page).count()) > 0);
  else {
    if ((await glassOf(page).count()) === 0) { await richOf(page).click({ position: { x: 4, y: 4 } }); await page.keyboard.press("g"); }
    await expect(glassOf(page)).toHaveCount(1);
  }
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
async function scrollTo(page, text) {
  await page.evaluate(text => {
    const block = [...document.querySelectorAll(".rich-document > [data-cid]")].find(node => node.textContent?.trim() === text);
    block?.scrollIntoView({ block: "center" });
  }, text);
  await page.waitForTimeout(250);
}
async function grade(png) {
  return sharp(png).resize({ width: 320, kernel: "mitchell" }).grayscale().raw().toBuffer({ resolveWithObject: true });
}
async function shot(page, name) {
  const file = path.join(evidence, `${name}.png`);
  await page.screenshot({ path: file });
  const baseline = path.join(fixtures, `${name}.png`);
  if (process.env.OMARKIE_UPDATE_BASELINES === "1") { await copyFile(file, baseline); return; }
  const baselineExists = await readFile(baseline).then(() => true).catch(() => false);
  if (!baselineExists) { await copyFile(file, baseline); return; }
  const [fresh, expected] = await Promise.all([grade(file), grade(baseline)]);
  assert.equal(fresh.info.width, expected.info.width, `${name}: baseline width differs`);
  assert.equal(fresh.info.height, expected.info.height, `${name}: baseline height differs`);
  const a = fresh.data, b = expected.data, size = a.length;
  let sum = 0, changed = 0;
  for (let index = 0; index < size; index++) { const delta = Math.abs(a[index] - b[index]); sum += delta; if (delta > 32) changed += 1; }
  const mean = sum / size, fraction = changed / size;
  console.log(`${name}: mean ${mean.toFixed(2)}, changed ${(fraction * 100).toFixed(1)}%`);
  assert.ok(mean <= 6 && fraction <= 0.08, `${name}: drifted from baseline`);
}
async function launchApp() {
  const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
  const page = await app.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await ready(page);
  await learning(page, true);
  await glassOn(page);
  return { app, page, errors };
}
async function markdown(folder) {
  const sums = new Map();
  for (const name of await readdir(folder)) if (name.endsWith(".md")) sums.set(name, createHash("sha256").update(await readFile(path.join(folder, name))).digest("hex"));
  return sums;
}

let app = await launchApp();
let { page, errors } = app;
try {
  await resize(app.app, page, 1440);
  const firstBox = await blockBox(page, first);
  assert.ok(firstBox, "paragraph is on the page");

  // Paper clip: create on a paragraph, type, fold and unfold, save one new note.
  await page.locator('[data-glass-tool="clip"]').click();
  await page.mouse.click(firstBox.x + 40, firstBox.y + 10);
  const clip = page.locator(".glass-clip:not([data-folded])").first();
  await expect(clip).toBeVisible();
  await clip.locator("[data-sheet-text]").fill("# Slope\n\nSteep where contours are close.");
  await expect(clip.locator("[data-clip-title]")).toContainText("Slope");
  await clip.locator("[data-clip-fold]").click();
  await expect(page.locator(".glass-clip[data-folded]").first()).toBeVisible();
  await page.locator(".glass-clip[data-folded] [data-clip-pill]").first().click();
  await expect(clip).toBeVisible();
  const beforeSave = await markdown(vault);
  await clip.locator("[data-clip-save]").click();
  await expect(clip.locator("[data-sheet-saved]")).toContainText("Slope.md");
  const afterSave = await markdown(vault);
  assert.deepEqual([...afterSave.keys()].filter(name => !beforeSave.has(name)), ["Slope.md"]);
  for (const [name, sum] of beforeSave) assert.equal(afterSave.get(name), sum, `${name} unchanged by Save as note`);
  assert.equal(await readFile(path.join(vault, "Slope.md"), "utf8"), "# Slope\n\nSteep where contours are close.\n");

  // Scissors rectangle and freehand lasso over page regions.
  await clip.locator("[data-clip-fold]").click();

  // Extra page: pick the grid paper, write, draw ink.
  await page.locator('[data-glass-tool="extra-page"]').click();
  await page.locator('[data-page-paper="grid"]').click();
  const pageText = "Map point 1: read the interval, the index contour and the slope.";
  const pageBox = await blockBox(page, pageText);
  assert.ok(pageBox);
  await page.mouse.click(pageBox.x + 40, pageBox.y + 12);
  const sheet = page.locator(".glass-extra-page").first();
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute("data-paper", "grid");
  await sheet.locator("[data-sheet-text]").fill("Extra: interval 10 m.");
  await sheet.locator("[data-sheet-ink-toggle]").click();
  const inkBox = await sheet.locator(".glass-sheet-ink").boundingBox();
  assert.ok(inkBox);
  await page.mouse.move(inkBox.x + 20, inkBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(inkBox.x + 100, inkBox.y + 70, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => sheet.locator("[data-sheet-stroke]").count()).toBeGreaterThan(0);

  const secondBox = await blockBox(page, second);
  await page.locator('[data-glass-tool="cutout"]').click();
  await page.mouse.move(secondBox.x - 8, secondBox.y - 6);
  await page.mouse.down();
  await page.mouse.move(secondBox.x + 260, secondBox.y + 90, { steps: 10 });
  await page.mouse.up();
  const cutout = page.locator(".glass-cutout").first();
  await expect(cutout).toBeVisible({ timeout: 15_000 });
  await expect(cutout.locator("img")).toBeVisible();
  assert.ok((await page.locator(".glass-cutout").count()) >= 1);
  await page.locator('[data-glass-tool="cutout"]').click();
  await page.locator('[data-cutout-mode="lasso"]').click();
  const lassoText = "Map point 2: read the interval, the index contour and the slope.";
  const lassoBox = await blockBox(page, lassoText);
  assert.ok(lassoBox);
  await page.mouse.move(lassoBox.x + 10, lassoBox.y + 8);
  await page.mouse.down();
  for (const [x, y] of [[100, 10], [220, 12], [280, 60], [160, 76], [50, 70], [8, 40], [10, 8]])
    await page.mouse.move(lassoBox.x + x, lassoBox.y + y, { steps: 2 });
  await page.mouse.up();
  await expect.poll(() => page.locator(".glass-cutout").count()).toBe(2);

  // A cutout jumps to its source and offers the way back.
  await page.locator(".glass-cutout").first().click();
  await expect(page.locator("[data-glass-back]")).toBeVisible();
  await page.locator("[data-glass-back-skip]").click();

  // Agent parity: add a clip, an extra page and a lossless image cutout; save the clip.
  const sourceJson = JSON.stringify({ element: "paragraph-1", line: 3, path: doc, kind: "paragraph" });
  await axi("glass", "add", "--note", doc, "--kind", "clip", "--text", "Agent clip body.", "--near", first, "--magnet", "m-agent-clip");
  await axi("glass", "add", "--note", doc, "--kind", "extra-page", "--text", "Agent extra.", "--paper", "dotted", "--near", second, "--magnet", "m-agent-page");
  const region = JSON.stringify({ x: 10, y: 10, w: 30, h: 30 });
  await axi("glass", "add", "--note", doc, "--kind", "cutout", "--name", "Agent crop", "--source-kind", "image",
    "--region", region, "--source", sourceJson, "--w", "240", "--h", "160", "--aspect", "1.5", "--anchor", JSON.stringify({ landmarks: [{ kind: "block", block: first, headings: [heading], line: 3 }] }), "--magnet", "m-agent-cutout");
  const saved = await axi("glass", "clip-save", "--note", doc, "--magnet", "m-agent-clip");
  assert.equal(saved.created, true);
  const listed = await axi("glass", "list", "--note", doc);
  const kinds = new Map(listed.magnets.map(magnet => [magnet.id, magnet.fields?.kind]));
  assert.equal(kinds.get("m-agent-clip"), "clip");
  assert.equal(kinds.get("m-agent-page"), "extra-page");
  assert.equal(kinds.get("m-agent-cutout"), "cutout");
  await expect(page.locator('.glass-clip[data-magnet="m-agent-clip"]')).toHaveCount(1);
  await expect(page.locator('.glass-extra-page[data-magnet="m-agent-page"]')).toHaveCount(1);
  await axi("glass", "delete", "--note", doc, "--magnet", "m-agent-cutout");
  await axi("glass", "delete", "--note", doc, "--magnet", "m-agent-page");

  // Lay the paper objects out in two lanes so each one is legible in the screenshots.
  const state = await axi("glass", "list", "--note", doc);
  const clipId = state.magnets.find(magnet => magnet.fields?.kind === "clip" && magnet.fields.text.startsWith("# Slope"))?.id;
  const slopeClip = state.magnets.find(magnet => magnet.fields?.kind === "clip" && magnet.fields.text.startsWith("# Slope"))?.id;
  const agentClip = state.magnets.find(magnet => magnet.id === "m-agent-clip")?.id;
  const localPage = state.magnets.find(magnet => magnet.fields?.kind === "extra-page" && magnet.fields.paper === "grid")?.id;
  const cuts = state.magnets.filter(magnet => magnet.fields?.kind === "cutout").map(magnet => magnet.id);
  for (const [magnet, x, y, w, h] of [[slopeClip, 0, 330], [agentClip, 0, 10], [localPage, 0, 330, 420, 200],
    [cuts[0], 360, 10], [cuts[1], 360, 110]])
    if (magnet) await axi("glass", "move", "--note", doc, "--magnet", magnet, "--x", String(x), "--y", String(y),
      ...(w ? ["--w", String(w), "--h", String(h)] : []));
  await expect.poll(() => page.locator(".glass-cutout").count()).toBe(2);
  await expect.poll(() => page.locator(".glass-cutout img").count()).toBe(2);

  // Light and dark at 1440 and 720.
  await page.evaluate(() => localStorage.removeItem("omarkie-theme"));
  await page.reload();
  await ready(page);
  await learning(page, true);
  await glassOn(page);
  await resize(app.app, page, 1440);
  await expect(page.locator(".glass-cutout img")).toHaveCount(2);
  await expect(page.locator(".glass-cutout-missing")).toHaveCount(0);
  await shot(page, "g13-light-1440");
  await resize(app.app, page, 720);
  await expect(page.locator(".glass-clip[data-folded]")).toBeVisible();
  await expect(page.locator(".glass-extra-page[data-paper=grid]")).toBeVisible();
  await shot(page, "g13-light-720");
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "omarchy-dark"));
  await page.reload();
  await ready(page);
  await learning(page, true);
  await glassOn(page);
  await resize(app.app, page, 1440);
  await expect(page.locator(".glass-cutout img")).toHaveCount(2);
  await expect(page.locator(".glass-cutout-missing")).toHaveCount(0);
  await shot(page, "g13-dark-1440");
  await resize(app.app, page, 720);
  await expect(page.locator(".glass-clip[data-folded]")).toBeVisible();
  await expect(page.locator(".glass-extra-page[data-paper=grid]")).toBeVisible();
  await shot(page, "g13-dark-720");
  assert.deepEqual(errors, []);

  // Restart: clips, cutouts and extra pages come back from the journal.
  await app.app.close();
  app = await launchApp();
  page = app.page; errors = app.errors;
  await learning(page, true);
  await glassOn(page);
  await resize(app.app, page, 1440);
  await expect(page.locator('.glass-clip[data-magnet="m-agent-clip"]')).toBeVisible();
  await expect(page.locator(".glass-cutout").first()).toBeVisible();
  await expect(page.locator(".glass-cutout img")).toHaveCount(2);
  await expect(page.locator('.glass-extra-page[data-paper="grid"]')).toBeVisible();
  await expect(page.locator("[data-sheet-stroke]").first()).toBeVisible();

  // Layers: the new paper joins the shared notes/media shelves.
  const layerList = await axi("glass", "layers", "list", "--note", doc);
  const layers = Object.fromEntries(layerList.layers.map(layer => [layer.id, layer]));
  assert.ok(layers.notes.count >= 3, "clips and extra pages count on the notes layer");
  assert.ok(layers.media.count >= 2, "cutouts count on the media layer");
  await axi("glass", "layers", "hide", "--note", doc, "notes");
  await expect(page.locator('[data-glass-layer="notes"]').first()).toHaveCSS("visibility", "hidden");
  await axi("glass", "layers", "show", "--note", doc, "notes");
  await expect(page.locator('[data-glass-layer="notes"]').first()).toHaveCSS("visibility", "visible");
  await axi("glass", "layers", "lock", "--note", doc, "notes");
  await expect(page.locator('[data-glass-layer="notes"]').first()).toHaveAttribute("inert", "");
  await axi("glass", "layers", "unlock", "--note", doc, "notes");
  await expect(page.locator('[data-glass-layer="notes"]').first()).not.toHaveAttribute("inert", "");
  await axi("glass", "layers", "hide", "--note", doc, "media");
  await expect(page.locator('[data-glass-layer="media"].glass-cutout').first()).toHaveCSS("visibility", "hidden");
  await axi("glass", "layers", "show", "--note", doc, "media");
  await expect(page.locator('[data-glass-layer="media"].glass-cutout').first()).toHaveCSS("visibility", "visible");
  await axi("glass", "layers", "lock", "--note", doc, "media");
  await expect(page.locator('[data-glass-layer="media"].glass-cutout').first()).toHaveAttribute("inert", "");
  await axi("glass", "layers", "unlock", "--note", doc, "media");
  assert.deepEqual(errors, []);
  console.log("PASS: clip create/fold/unfold/edit/save one note; rectangle + lasso cutout with jump; extra page ink; agent parity; layers; restart persistence; 4 screenshots");
} finally {
  await app.app.close().catch(() => {});
}
