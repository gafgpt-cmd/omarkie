import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import electron from "electron";
import sharp from "sharp";
import { _electron as launch, expect } from "playwright/test";
import { decode } from "@toon-format/toon";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

if (process.platform === "win32") process.exit(0);
const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-g15-"));
const shots = process.env.OMARKIE_GLASS_SHOTS || path.join(home, "screens");
await mkdir(shots, { recursive: true });
const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
const heading = "Trace notes";
const first = "First paragraph gives the pictures a landing place and keeps this note readable.";
const second = "Second paragraph holds the before picture and its own words.";
const third = "Third paragraph holds the after picture.";
const source = `# ${heading}\n\n${first}\n\n${second}\n\n${third}\n`;
const scene = (width, height, hue) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="hsl(${hue} 42% 82%)"/>
  <circle cx="${width * 0.7}" cy="${height * 0.28}" r="${Math.min(width, height) * 0.12}" fill="hsl(${hue + 30} 55% 60%)"/>
  <path d="M${width * 0.08} ${height * 0.72} L${width * 0.36} ${height * 0.42} L${width * 0.7} ${height * 0.76} L${width * 0.92} ${height * 0.56}"
    stroke="hsl(${hue - 30} 45% 35%)" stroke-width="${Math.max(2, width / 60)}" fill="none"/>
</svg>`;
const before = await sharp(Buffer.from(scene(440, 300, 200))).png().toBuffer();
const after = await sharp(Buffer.from(scene(440, 300, 30))).png().toBuffer();

function session(vault, doc, content) {
  const file = path.join(vault, doc);
  return { version: 1, activeId: "fixture", folder: vault, documents: [{ id: "fixture", path: file, name: doc,
    content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), lineEnding: "\n" }] };
}

async function axiIn(vault, env, ...args) {
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 60_000 });
  return decode(stdout);
}

async function boot() {
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
  delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
  const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  return { app, page, env, errors };
}

async function resize(app, page, width, height = 900) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
}

async function openGlass(page) {
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  await expect(rich.getByRole("heading", { name: heading, exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  if (process.platform === "linux") {
    await page.getByRole("button", { name: "Display", exact: true }).click();
    const item = page.getByRole("menuitemcheckbox", { name: "Learning mode", exact: true });
    if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
    await page.keyboard.press("Escape");
  }
  await expect(rich).toHaveAttribute("contenteditable", "false");
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "light"));
  await rich.click({ position: { x: 4, y: 4 } });
  if (!await page.locator(".glass-layer").count()) await page.keyboard.press("g");
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:glass-ready").length > 0);
  return rich;
}

async function blockFor(page, text) {
  return page.locator(".rich-document > [data-cid]", { hasText: text }).first();
}

async function addImage(page, bytes, name) {
  await page.locator("[data-glass-file]").setInputFiles({ name, mimeType: "image/png", buffer: bytes });
}

async function selectImage(page, id) {
  const frame = page.locator(`.glass-image[data-magnet="${id}"]`);
  const box = await frame.locator("[data-glass-image-body]").boundingBox();
  await frame.locator("[data-glass-image-body]").click({ position: { x: Math.min(120, Math.round(box.width / 2)), y: Math.round(box.height * 0.6) } });
  await expect(frame.locator("[data-glass-sheets-toggle]")).toBeVisible();
  return frame;
}

async function drawOn(page, frame, from, to) {
  const box = await frame.locator("[data-glass-image-body]").boundingBox();
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 8 });
  await page.mouse.up();
}

async function clickAt(page, frame, [x, y]) {
  const box = await frame.locator("[data-glass-image-body]").boundingBox();
  await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
}

async function reload(page, app, width, height, theme) {
  await page.evaluate(theme => localStorage.setItem("omarkie-theme", theme), theme);
  await page.reload();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  await expect(rich.getByRole("heading").first()).toBeVisible({ timeout: 30_000 });
  if (process.platform === "linux") {
    await page.getByRole("button", { name: "Display", exact: true }).click();
    const item = page.getByRole("menuitemcheckbox", { name: "Learning mode", exact: true });
    if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
    await page.keyboard.press("Escape");
  }
  await rich.click({ position: { x: 4, y: 4 } });
  if (!await page.locator(".glass-layer").count()) await page.keyboard.press("g");
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on", { timeout: 15_000 });
  await expect(page.locator(".glass-image").first()).toBeVisible({ timeout: 30_000 });
  await resize(app, page, width, height);
  await page.waitForTimeout(500);
}

const vault = path.join(home, "vault"), doc = "Trace notes.md", file = path.join(vault, doc);
await mkdir(vault, { recursive: true });
await writeFile(file, source, "utf8");
await writeFile(path.join(home, "session.json"), JSON.stringify(session(vault, doc, source)), "utf8");

const { app, page, env, errors } = await boot();
try {
  await openGlass(page);
  await resize(app, page, 1440);
  await addImage(page, before, "Before.png");
  await addImage(page, after, "After.png");
  const frames = page.locator(".glass-image");
  await expect(frames).toHaveCount(2, { timeout: 20_000 });
  const ids = await frames.evaluateAll(nodes => nodes.map(node => node.dataset.magnet));
  const frame = await selectImage(page, ids[0]);

  // Tracing sheets: three named sheets, one stroke on each, visibility and opacity persist.
  await frame.locator("[data-glass-sheets-toggle]").click();
  await expect(frame.locator("[data-glass-sheets]")).toBeVisible();
  for (let count = 0; count < 3; count += 1) await frame.locator("[data-sheet-add]").click();
  const rows = frame.locator("[data-glass-sheets] li");
  await expect(rows).toHaveCount(3);
  assert.deepEqual(await rows.locator("[data-sheet-name]").evaluateAll(nodes => nodes.map(node => node.value)), ["Muscles", "Nerves", "Vessels"]);
  const sheets = await rows.evaluateAll(nodes => nodes.map(node => node.dataset.sheet));
  for (let index = 0; index < 3; index += 1) {
    if (!await frame.locator("[data-glass-sheets]").isVisible()) await frame.locator("[data-glass-sheets-toggle]").click();
    await rows.nth(index).locator("[data-sheet-draw]").click();
    await expect(frame.locator("[data-glass-sheets]")).toBeHidden();
    await page.locator(`[data-trace-colour="${["#b42318", "#1d4ed8", "#24292f"][index]}"]`).click();
    await drawOn(page, frame, [0.18, 0.35 + index * 0.07], [0.78, 0.35 + index * 0.07]);
    await expect(frame.locator(`[data-trace-sheet="${sheets[index]}"] path`)).toHaveCount(1, { timeout: 10_000 });
  }
  if (!await frame.locator("[data-glass-sheets]").isVisible()) await frame.locator("[data-glass-sheets-toggle]").click();
  const muscles = rows.nth(0);
  await muscles.locator("[data-sheet-eye]").click();
  await expect(frame.locator(`[data-trace-sheet="${sheets[0]}"]`)).toHaveAttribute("opacity", "0");
  await muscles.locator("[data-sheet-eye]").click();
  await expect(frame.locator(`[data-trace-sheet="${sheets[0]}"]`)).toHaveAttribute("opacity", "1");
  const opacity = muscles.locator("[data-sheet-opacity]");
  await opacity.focus();
  await opacity.press("Home");
  for (let step = 0; step < 8; step += 1) { await opacity.press("ArrowRight"); await page.waitForTimeout(80); }
  await expect.poll(async () => (await axiIn(vault, env, "glass", "list", "--note", doc)).magnets
    .find(magnet => magnet.id === ids[0]).fields.sheets.find(sheet => sheet.id === sheets[0]).opacity).toBe(40);
  await page.screenshot({ path: path.join(shots, "g15-sheets-1440.png") });
  await frame.locator("[data-glass-sheets-toggle]").click();
  await page.screenshot({ path: path.join(shots, "g15-traces-1440.png") });

  // Compare: pick two pictures, drag the handle, keyboard steps, swap sides.
  await page.locator("[data-glass-compare]").click();
  await expect(page.locator("[data-compare-dialog]")).toBeVisible();
  await page.locator("[data-compare-left]").selectOption(ids[1]);
  await page.locator("[data-compare-right]").selectOption(ids[0]);
  await page.locator("[data-compare-create]").click();
  const card = page.locator("[data-compare-card]");
  await expect(card).toBeVisible({ timeout: 10_000 });
  const compareId = await card.getAttribute("data-compare-card");
  const slider = card.getByRole("slider");
  await expect(slider).toHaveAttribute("aria-valuenow", "50");
  const handle = await slider.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 70, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Number(await slider.getAttribute("aria-valuenow"))).toBeGreaterThan(50);
  const dragged = Number(await slider.getAttribute("aria-valuenow"));
  await slider.focus();
  await slider.press("ArrowLeft");
  await expect.poll(async () => Number(await slider.getAttribute("aria-valuenow"))).toBe(dragged - 1);
  const names = await card.locator(".glass-compare-head strong").textContent();
  await card.locator("[data-compare-swap]").first().click();
  await expect.poll(() => card.locator(".glass-compare-head strong").textContent()).not.toBe(names);

  if (await frame.locator("[data-glass-sheets]").isVisible()) await frame.locator("[data-glass-sheets-toggle]").click();
  // Ruler: draw a known line, set 50 mm once, then measure the same line and a right angle.
  await page.locator('[data-glass-tool="measure"]').click();
  await page.locator('[data-measure-mode="scale"]').click();
  await drawOn(page, frame, [0.15, 0.68], [0.6, 0.68]);
  await expect(page.locator("[data-scale-dialog]")).toBeVisible();
  await page.locator("[data-scale-length]").fill("50");
  await page.locator("[data-scale-unit]").selectOption("mm");
  await page.locator("[data-scale-precision]").selectOption("0");
  await page.locator("[data-scale-apply]").click();
  await expect(frame.locator("[data-scale-label]")).toHaveText("Scale: 50 mm");
  await page.locator('[data-measure-mode="line"]').click();
  await drawOn(page, frame, [0.15, 0.68], [0.6, 0.68]);
  await expect(frame.locator("[data-measure-label]").filter({ hasText: "50 mm" })).toHaveCount(1);
  await page.locator('[data-measure-mode="angle"]').click();
  await clickAt(page, frame, [0.5, 0.75]);
  await clickAt(page, frame, [0.78, 0.75]);
  await clickAt(page, frame, [0.5, 0.93]);
  await expect(frame.locator('[data-measure-label][data-measure-kind="angle"]')).toHaveText("90.0°");
  await page.waitForTimeout(300);

  // Agent parity: sheets and the divider change through the same service the CLI uses.
  await axiIn(vault, env, "glass", "tracing", "hide", "--note", doc, "--image", ids[0], "--sheet", sheets[2]);
  await expect(frame.locator(`[data-trace-sheet="${sheets[2]}"]`)).toHaveAttribute("opacity", "0");
  await axiIn(vault, env, "glass", "tracing", "show", "--note", doc, "--image", ids[0], "--sheet", sheets[2]);
  await expect(frame.locator(`[data-trace-sheet="${sheets[2]}"]`)).toHaveAttribute("opacity", "1");
  const bones = await axiIn(vault, env, "glass", "tracing", "add", "--note", doc, "--image", ids[0], "--sheet", "Bones", "--name", "Bones", "--points", "[[0.2,0.2,0.5],[0.6,0.2,0.5]]");
  assert.equal(bones.trace.fields.sheet, "Bones");
  await axiIn(vault, env, "compare", "set", "--note", doc, "--magnet", compareId, "--value", "35");
  await expect.poll(async () => Number(await slider.getAttribute("aria-valuenow"))).toBe(35);
  const cliScale = await axiIn(vault, env, "measure", "scale", "--note", doc, "--image", ids[1], "--length", "20", "--unit", "cm",
    "--line", "[[0.1,0.1],[0.6,0.1]]", "--frame", "[290,198]");
  assert.equal(cliScale.scale.unit, "cm");
  const cliLine = await axiIn(vault, env, "measure", "line", "--note", doc, "--image", ids[1], "--points", "[[0.1,0.1],[0.6,0.1]]");
  assert.equal(cliLine.measure.fields.type, "line");
  const cliAngle = await axiIn(vault, env, "measure", "angle", "--note", doc, "--image", ids[1], "--points", "[[0.5,0.7],[0.75,0.7],[0.5,0.9]]");
  assert.equal(cliAngle.measure.fields.type, "angle");

  // Restart: every mark comes back from storage.
  await reload(page, app, 1440, 900, "light");
  await expect(page.locator(".glass-image")).toHaveCount(2, { timeout: 20_000 });
  const restored = page.locator(`.glass-image[data-magnet="${ids[0]}"]`);
  await expect(restored.locator(`[data-trace-sheet="${sheets[1]}"] path`)).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator("[data-compare-card]")).toBeVisible();
  await expect(page.locator("[data-compare-card]").getByRole("slider")).toHaveAttribute("aria-valuenow", "35");
  await expect(page.locator("[data-measure-label]").filter({ hasText: "50 mm" })).toHaveCount(1);
  await expect(restored.locator('[data-measure-label][data-measure-kind="angle"]')).toHaveText("90.0°");
  await page.screenshot({ path: path.join(shots, "g15-light-1440.png") });

  for (const [theme, width, height] of [["omarchy-dark", 1440, 900], ["light", 720, 720], ["omarchy-dark", 720, 720]]) {
    await reload(page, app, width, height, theme);
    await expect(page.locator("[data-compare-card]")).toBeVisible();
    await page.screenshot({ path: path.join(shots, `g15-${theme}-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  console.log(`G15 screenshots: ${shots}`);
} finally {
  await app.close();
}
