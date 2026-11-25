import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { _electron as launch, expect } from "playwright/test";
import { decode } from "@toon-format/toon";
import sharp from "sharp";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// G17 smart ink: geometric gestures, the undo chip, Alt ask, peek lens, time scrub, OCR hook.
const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-smart-"));
const vault = path.join(home, "vault"), doc = "smart.md", file = path.join(vault, doc);
const heading = "Smart notes";
const paragraph = "Recall the answer before looking it up.";
const second = "Review the missed cards tomorrow.";
const source = `# ${heading}\n\n${paragraph}\n\n${second}\n`;
await mkdir(vault);
await writeFile(file, source, "utf8");
const record = { id: "fixture", path: file, name: doc, content: source, savedContent: source,
  diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");
const stub = path.join(home, "ocr-stub");
await writeFile(stub, "#!/bin/sh\nprintf 'read from ink\\n'\n", "utf8");
await chmod(stub, 0o755);
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en", OMARKIE_OCR: stub });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const evidence = process.env.OMARKIE_QA_DIR ?? path.join(home, "shots");
await mkdir(evidence, { recursive: true });
const fixtures = fileURLToPath(new URL("./fixtures/glass", import.meta.url));
const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
async function axi(...args) {
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 });
  return decode(stdout);
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
async function launchApp(overrides = {}) {
  const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env: { ...env, ...overrides } });
  const page = await app.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
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
    if (((await glassOf(page).count()) > 0) !== on) { await page.locator(".rich-document").click({ position: { x: 4, y: 4 } }); await page.keyboard.press("g"); }
    await expect(glassOf(page)).toHaveCount(on ? 1 : 0);
    return;
  }
  await flip(page, "Glass overlay", async () => ((await glassOf(page).count()) > 0) === on);
}
async function resize(app, page, width) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
}
async function rectOf(page, selector) {
  return page.evaluate(selector => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, selector);
}
async function stroke(page, points, pointerId = 7) {
  await page.evaluate(({ points, pointerId }) => {
    const surface = document.querySelector("[data-ink-surface]");
    if (!surface) throw new Error("no ink surface");
    const fire = (type, point) => surface.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId, pointerType: "pen", pressure: 0.5, isPrimary: true,
      buttons: type === "pointerup" ? 0 : 1, clientX: point[0], clientY: point[1],
    }));
    fire("pointerdown", points[0]);
    for (const point of points.slice(1, -1)) fire("pointermove", point);
    fire("pointerup", points.at(-1));
  }, { points, pointerId });
}
const ellipse = (cx, cy, rx, ry, steps = 48, gap = 0) => {
  const points = Array.from({ length: steps }, (_, index) => {
    const angle = gap + (index / steps) * (Math.PI * 2 - gap);
    return [cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry];
  });
  return gap ? points : points.concat([[cx + rx, cy]]);
};

const firstRun = await launchApp();
let { app, page, errors } = firstRun;
try {
  await resize(app, page, 1440);
  await ready(page);
  await learning(page, true);
  await glassMenu(page, true);
  await expect(trayOf(page)).toBeVisible();
  await trayOf(page).getByRole("button", { name: "Pen", exact: true }).click();
  await expect(page.locator("[data-ink-surface]")).toHaveAttribute("data-ink-tool", "pen");
  const paragraphRect = await rectOf(page, ".rich-document p[data-cid]");
  assert.ok(paragraphRect);

  // Underline -> highlight, with the one-click undo chip.
  const underline = Array.from({ length: 16 }, (_, index) => [paragraphRect.x + 24 + index * 20, paragraphRect.y + paragraphRect.height * 0.72]);
  await stroke(page, underline, 11);
  await expect(page.locator('.glass-ink path[data-ink-tool="highlighter"]')).toHaveCount(1);
  const highlightChip = page.locator('[data-glass-gesture="highlight"]');
  await expect(highlightChip).toBeVisible();
  await highlightChip.locator("[data-gesture-undo]").click();
  await expect(page.locator('.glass-ink path[data-ink-tool="pen"]')).toHaveCount(1);
  await expect(page.locator('[data-glass-chip], [data-glass-gesture="highlight"]')).toHaveCount(0);
  // Again, left applied for the screenshot.
  await stroke(page, underline, 12);
  await expect(page.locator('.glass-ink path[data-ink-tool="highlighter"]')).toHaveCount(1);
  await expect(page.locator('[data-glass-gesture="highlight"]')).toBeVisible();

  // Circle around the first words -> bubble on that range.
  const circle = ellipse(paragraphRect.x + 80, paragraphRect.y + paragraphRect.height / 2, 80, 24, 48);
  await stroke(page, circle, 13);
  await expect(page.locator('[data-bubble-panel]')).toBeVisible();
  await expect(page.locator('[data-glass-gesture="bubble"]')).toBeVisible();
  const quote = await page.locator(".glass-bubble .bubble-quote").textContent();
  assert.ok(quote && quote.toLowerCase().includes("recall"), `bubble quote was ${quote}`);

  // Arrow from the paragraph to the heading -> connector.
  const headingRect = await rectOf(page, ".rich-document h1[data-cid]");
  assert.ok(headingRect);
  const start = [paragraphRect.x + 40, paragraphRect.y + paragraphRect.height * 0.4];
  const end = [headingRect.x + 60, headingRect.y + headingRect.height * 0.6];
  const diagonal = Array.from({ length: 16 }, (_, index) => [start[0] + (end[0] - start[0]) * index / 15, start[1] + (end[1] - start[1]) * index / 15]);
  const dx = end[0] - start[0], dy = end[1] - start[1], length = Math.hypot(dx, dy);
  const back = [-dx / length * 12, -dy / length * 12], side = [-dy / length * 10, dx / length * 10];
  const barbLeft = [end[0] + back[0] + side[0], end[1] + back[1] + side[1]];
  const barbRight = [end[0] + back[0] - side[0], end[1] + back[1] - side[1]];
  await stroke(page, [...diagonal, barbLeft, end, barbRight, end, barbLeft, end, barbRight, end], 14);
  await expect(page.locator("[data-arrow]")).toHaveCount(1);
  await expect(page.locator('[data-glass-gesture="connector"]')).toBeVisible();

  // Gestures off: a fresh underline stays pen ink and no chip appears.
  await page.locator("[data-glass-gesture] [data-gesture-dismiss]").click();
  await trayOf(page).locator("[data-glass-magic]").click();
  await expect(trayOf(page).locator("[data-glass-magic]")).toHaveAttribute("aria-pressed", "false");
  const before = await page.locator(".glass-ink path").count();
  await stroke(page, underline.map(([x, y]) => [x, y + 34]), 15);
  await expect(page.locator(".glass-ink path")).toHaveCount(before + 1);
  await expect(page.locator("[data-glass-gesture]")).toHaveCount(0);
  await trayOf(page).locator("[data-glass-magic]").click();
  await trayOf(page).getByRole("button", { name: "Select", exact: true }).click();

  // Alt+? asks about the spot without any "?" recogniser.
  const box = { x: paragraphRect.x + 20, y: paragraphRect.y + 10 };
  await page.mouse.move(box.x, box.y);
  await page.keyboard.down("Alt");
  await page.keyboard.press("?");
  await page.keyboard.up("Alt");
  await expect(page.locator("[data-bubble-panel]:visible")).toHaveCount(1);

  // Alt hold: the glass is cut by a clear circle; release restores it.
  await page.mouse.move(paragraphRect.x + 120, paragraphRect.y + 40);
  await page.keyboard.down("Alt");
  await expect(glassOf(page)).toHaveAttribute("data-glass-lens", "on");
  await expect(page.locator("[data-glass-lens-ring]")).toHaveCount(1);
  assert.ok((await glassOf(page).evaluate(node => node.style.clipPath)).includes("evenodd"));
  await page.keyboard.up("Alt");
  await expect(glassOf(page)).not.toHaveAttribute("data-glass-lens", "on");

  // OCR hook: the button exists only with OMARKIE_OCR and reads a stroke into a sticky.
  await trayOf(page).locator("[data-glass-ocr]").click();
  const inkBox = await page.locator('.glass-ink path[data-ink-tool="highlighter"]').first().boundingBox();
  assert.ok(inkBox);
  await page.mouse.click(inkBox.x + inkBox.width / 2, inkBox.y + Math.min(4, inkBox.height / 2));
  await expect(page.locator(".glass-note textarea")).toHaveValue("read from ink");
  const noteCard = page.locator(".glass-note").last();
  const grip = await noteCard.locator(".glass-note-head").boundingBox();
  assert.ok(grip);
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 150, { steps: 6 });
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 300, { steps: 6 });
  await page.mouse.up();

  // Screenshots: light/dark at 1440 and 720.
  for (const width of [1440, 720]) {
    await resize(app, page, width);
    for (const theme of ["light", "omarchy-dark"]) {
      await page.evaluate(theme => localStorage.setItem("omarkie-theme", theme), theme);
      await page.reload();
      await ready(page);
      await expect(glassOf(page)).toBeVisible();
      await capture(page, `smart-${theme === "light" ? "light" : "dark"}-${width}`);
    }
  }
  assert.deepEqual(errors, []);
  await app.close();

  // Restart: glass survives, and the agent parity commands answer from the journal.
  ({ app, page, errors } = await launchApp());
  await resize(app, page, 1440);
  await ready(page);
  await glassMenu(page, true);
  await expect(page.locator(".glass-note textarea")).toHaveValue("read from ink");
  await expect(page.locator("[data-arrow]")).toHaveCount(1);
  const timeline = await axi("glass", "timeline", "--note", doc);
  assert.ok(timeline.points.length > 0);
  const scrubbed = await axi("glass", "scrub", "--note", doc, "--at", String(timeline.points[0].at));
  assert.ok(Array.isArray(scrubbed.magnets));
  const asked = await axi("glass", "ask", "--note", doc, "--near", paragraph, "--text", "Why?");
  assert.equal(asked.bubble.pending, true);
  const read = await axi("glass", "ocr", "--note", doc, "--region", (await axi("glass", "ink", "list", "--note", doc)).ink[0].id);
  assert.equal(read.text, "read from ink");
  assert.deepEqual(errors, []);
  assert.equal(await readFile(file, "utf8"), source, "smart ink never writes the page");

  // Time scrub: replay the journal on desktop, read-only, then return to now.
  await page.locator("[data-glass-scrub-open]").click();
  await expect(page.locator('[data-glass-scrub][role="dialog"]')).toBeVisible();
  await expect(page.locator("[data-ink-surface]")).toHaveCount(0);
  const range = page.locator("[data-glass-scrub-range]");
  const max = Number(await range.getAttribute("max"));
  assert.ok(max > 0);
  await range.focus();
  await page.keyboard.press("Home");
  await expect(range).toHaveValue("0");
  await page.keyboard.press("End");
  await expect(range).toHaveValue(String(max));
  await page.locator("[data-glass-scrub-now]").click();
  await expect(page.locator("[data-glass-scrub]")).toHaveCount(0);
  await expect(page.locator("[data-arrow]")).toHaveCount(1);
  await app.close();

  // Without OMARKIE_OCR the button is absent; nothing is bundled.
  ({ app, page, errors } = await launchApp({ OMARKIE_OCR: "" }));
  await resize(app, page, 1440);
  await ready(page);
  await glassMenu(page, true);
  await expect(page.locator("[data-glass-ocr]")).toHaveCount(0);
  assert.deepEqual(errors, []);
} finally {
  await app.close().catch(() => {});
}
console.log("glass-smart-desktop: ok");
