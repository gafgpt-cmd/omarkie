import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as launch, expect } from "playwright/test";
import sharp from "sharp";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// G12: five shared glass layers in the left rail. Nothing here makes a layer per element.
const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-layers-"));
const vault = path.join(home, "vault"), doc = "practice.md", file = path.join(vault, doc);
const first = "Recall the answer before looking it up.";
const second = "Leave a day before your next review.";
const source = `# Retrieval practice\r\n\r\n${first}\r\n\r\n${second}\r\n`;
const anchor = { version: 1, landmarks: [{ kind: "block", block: first, headings: ["Retrieval practice"], line: 3 }] };
await mkdir(path.join(vault, ".omarkie", "glass"), { recursive: true });
await writeFile(path.join(vault, ".omarkie", "glass", "vault.json"), `${JSON.stringify({ version: 1, visible: true })}\n`);
await writeFile(file, source, "utf8");
const record = { id: "fixture", path: file, name: doc, content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\r\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");
const png = await sharp({ create: { width: 120, height: 80, channels: 4, background: { r: 47, g: 111, b: 185, alpha: 1 } } }).png().toBuffer();
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const evidence = process.env.OMARKIE_QA_DIR ?? path.join(home, "shots");
await mkdir(evidence, { recursive: true });
const fixtures = fileURLToPath(new URL("./fixtures/glass", import.meta.url));

async function grade(pngPath) {
  return sharp(pngPath).resize({ width: 320, kernel: "mitchell" }).grayscale().raw().toBuffer({ resolveWithObject: true });
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
async function resize(app, page, width) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
}
const richOf = page => page.locator(".document-editor:not([hidden]) .rich-document");
const railOf = page => page.getByRole("complementary", { name: "Layers", exact: true });
async function ready(page) {
  await expect(richOf(page).getByRole("heading", { name: "Retrieval practice", exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
}
async function learning(page) {
  if (process.platform === "linux") {
    await page.getByRole("button", { name: "Display", exact: true }).click();
    const item = page.getByRole("menuitemcheckbox", { name: "Learning mode", exact: true });
    if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
    else await page.keyboard.press("Escape");
  } else {
    const button = page.getByRole("button", { name: "Learning mode", exact: true });
    if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
  }
  await expect(richOf(page)).toHaveAttribute("contenteditable", "false");
}
async function theme(page, value) {
  await page.keyboard.press("ControlOrMeta+,");
  const options = page.getByRole("dialog", { name: "Preferences", exact: true });
  await options.getByRole("combobox", { name: "Theme", exact: true }).selectOption(value);
  await options.getByRole("button", { name: "Done", exact: true }).click();
}

// Five kinds make five shared layers; the layer ids are the contract agents read too.
async function seed(page) {
  const reply = await page.evaluate(async ({ anchor, base64 }) => {
    const api = window.desktop.glass;
    const ink = { kind: "ink", layer: "ink", tool: "pen", color: "#24292f", size: 4,
      parts: [{ box: { kind: "block" }, anchor, points: [[0.1, 0.1, 0.4], [0.2, 0.15, 0.8]] }] };
    const adds = [
      { magnet: "m-ink", fields: ink },
      { magnet: "m-sticky", kind: "sticky", text: "Active recall", color: "yellow", anchor, x: 360, y: 40 },
      { magnet: "m-photo", anchor, fields: { kind: "image", name: "photo.png", anchor, wrap: "right", x: 0, y: 0, w: 180, h: 120 }, image: { name: "photo.png", base64 } },
      { magnet: "m-comment", fields: { kind: "comment", text: "Why does spacing work?", element: "fixture", elementKind: "paragraph",
        line: 3, headings: ["Retrieval practice"], thread: [], anchor } },
      { magnet: "m-card", anchor, fields: { kind: "card", card: "ai", question: "Why recall first?", title: "Recall", anchor, x: 0, y: 0, folded: true } },
    ];
    const failures = [];
    for (const add of adds) {
      const result = await api({ action: "add", note: "practice.md", ...add });
      if (!result?.ok) failures.push(`${add.magnet}: ${result?.error}`);
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    return failures;
  }, { anchor, base64: png.toString("base64") });
  assert.deepEqual(reply, []);
}

const firstRun = await launchApp();
let { app, page, errors } = firstRun;
try {
  await resize(app, page, 1440);
  await page.reload();
  await ready(page);
  await learning(page);
  const rail = railOf(page);
  await expect(rail.getByText("Layers appear when you first add ink, a note, a photo, a card or a comment.")).toBeVisible();
  await seed(page);
  const rows = rail.locator("[data-glass-layer-row]");
  await page.waitForTimeout(300);
  await expect(rows).toHaveCount(5);
  for (const [id, name, count] of [["ink", "Ink", "1"], ["notes", "Notes & stickers", "1"], ["media", "Media", "1"], ["cards", "AI cards", "1"], ["comments", "Comments", "1"]]) {
    const row = rail.locator(`[data-glass-layer-row="${id}"]`);
    await expect(row).toContainText(name);
    await expect(row.locator("small")).toHaveText(count);
  }
  await expect(rail.getByRole("heading", { name: "Study sheets", exact: true })).toBeVisible();

  // Eye: the notes layer disappears, then comes back.
  const note = page.locator(".glass-note").first();
  await expect(note).toBeVisible();
  await rail.locator('[data-glass-layer-row="notes"]').getByRole("button", { name: "Hide Notes & stickers layer", exact: true }).click();
  await expect(note).toBeHidden();
  await rail.locator('[data-glass-layer-row="notes"]').getByRole("button", { name: "Show Notes & stickers layer", exact: true }).click();
  await expect(note).toBeVisible();

  // Opacity: 40% reaches the magnet without re-rendering it.
  const slider = rail.locator('[data-glass-layer-row="notes"]').getByRole("slider", { name: "Notes & stickers opacity", exact: true });
  await slider.focus();
  // One input change, not forty keystrokes: a dropped keypress under load would skew the value.
  await slider.fill("40");
  await slider.dispatchEvent("pointerup");
  await expect(slider).toHaveValue("40");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector(".glass-note")).opacity)).toBe("0.4");

  // Lock: drag and double-click are refused, focus cannot land inside the layer.
  await rail.locator('[data-glass-layer-row="notes"]').getByRole("button", { name: "Lock Notes & stickers layer", exact: true }).click();
  await expect(rail.locator('[data-glass-layer-row="notes"]').getByRole("button", { name: "Unlock Notes & stickers layer", exact: true })).toHaveAttribute("aria-pressed", "true");
  const before = await note.boundingBox();
  await page.mouse.move(before.x + 40, before.y + 20);
  await page.mouse.down();
  await page.mouse.move(before.x + 140, before.y + 80, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const after = await note.boundingBox();
  assert.ok(Math.abs(after.x - before.x) < 2 && Math.abs(after.y - before.y) < 2, "a locked layer refused the drag");
  await page.mouse.dblclick(before.x + 6, before.y + 6);
  await expect(note).not.toHaveAttribute("data-editing", "true");
  assert.equal(await page.evaluate(() => { const element = document.querySelector(".glass-note"); element.focus(); return document.activeElement === element; }), false);

  await capture(page, "layers-light-1440");
  await theme(page, "omarchy-dark");
  await capture(page, "layers-dark-1440");

  // Sheets data and toggles moved into the new panel without loss.
  const actions = page.getByRole("group", { name: "Selection actions", exact: true });
  await richOf(page).getByText(second, { exact: true }).selectText();
  await page.keyboard.press("Alt+Enter");
  await expect(actions).toBeVisible();
  await actions.getByRole("button", { name: "Note", exact: true }).click();
  await actions.getByRole("textbox", { name: "Note", exact: true }).fill("Spacing beats cramming.");
  await actions.getByRole("button", { name: "Pin note", exact: true }).click();
  const sheet = rail.locator(".study-sheet").filter({ hasText: "Notes" }).first();
  await expect(sheet).toContainText("1");
  await expect(rail.locator('[data-glass-layer-row="notes"]').locator("small")).toHaveText("2");
  await sheet.click();
  await expect(sheet).toHaveAttribute("aria-pressed", "false");
  await sheet.click();
  await expect(sheet).toHaveAttribute("aria-pressed", "true");

  await theme(page, "omarchy-light");
  await resize(app, page, 720);
  const chips = page.getByRole("group", { name: "Layers", exact: true });
  await expect(chips.locator("[data-glass-layer-row]")).toHaveCount(5);
  await expect(chips.getByRole("button", { name: "Hide Notes & stickers layer", exact: true })).toBeVisible();
  await capture(page, "layers-light-720");
  await theme(page, "omarchy-dark");
  await capture(page, "layers-dark-720");
  await theme(page, "omarchy-light");
  await chips.getByRole("button", { name: "Hide Notes & stickers layer", exact: true }).click();
  await expect(page.locator(".glass-note").first()).toBeHidden();
  assert.deepEqual(errors, []);
} finally { await app.close(); }

// Restart: layer state is in the note journal, not in memory.
let relaunch = await launchApp();
({ app, page, errors } = relaunch);
try {
  await resize(app, page, 1440);
  await page.reload();
  await ready(page);
  await learning(page);
  const rail = railOf(page);
  const notes = rail.locator('[data-glass-layer-row="notes"]');
  await expect(notes.locator("small")).toHaveText("2");
  await expect(notes.getByRole("button", { name: "Unlock Notes & stickers layer", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(notes.getByRole("slider", { name: "Notes & stickers opacity", exact: true })).toHaveValue("40");
  await expect(notes.getByRole("button", { name: "Show Notes & stickers layer", exact: true })).toBeVisible();
  await expect(page.locator(".glass-note").first()).toBeHidden();
  await notes.getByRole("button", { name: "Show Notes & stickers layer", exact: true }).click();
  await expect(page.locator(".glass-note").first()).toBeVisible();
  await notes.getByRole("button", { name: "Unlock Notes & stickers layer", exact: true }).click();

  // Budget: 500 magnets on one layer, then the eye toggle must land under 50 ms.
  const bulk = await page.evaluate(async ({ anchor }) => {
    const api = window.desktop.glass;
    for (let index = 0; index < 500; index++) {
      const result = await api({ action: "add", note: "practice.md", magnet: `m-bulk-${index}`, kind: "sticky",
        text: `Bulk ${index}`, anchor, x: 20 + (index % 20) * 30, y: 20 + Math.floor(index / 20) * 24 });
      if (!result?.ok) return result?.error ?? "bulk add failed";
    }
    return null;
  }, { anchor });
  assert.equal(bulk, null);
  await expect(rail.locator('[data-glass-layer-row="notes"]').locator("small")).toHaveText("502");
  const hide = rail.locator('[data-glass-layer-row="notes"]').getByRole("button", { name: "Hide Notes & stickers layer", exact: true });
  await expect(hide).toBeVisible();
  const budget = await page.evaluate(async () => {
    const button = document.querySelector('[data-glass-layer-row="notes"] button[aria-label="Hide Notes & stickers layer"]');
    const start = performance.now();
    button.click();
    const ms = performance.now() - start;
    const hidden = [...document.querySelectorAll(".glass-note")].every(note => getComputedStyle(note).visibility === "hidden");
    return { ms, hidden, count: document.querySelectorAll(".glass-note").length };
  });
  console.log(`layer toggle over ${budget.count} magnets: ${budget.ms.toFixed(1)} ms`);
  assert.equal(budget.hidden, true);
  assert.ok(budget.ms < 50, `layer toggle took ${budget.ms.toFixed(1)} ms`);
  await rail.locator('[data-glass-layer-row="notes"]').getByRole("button", { name: "Show Notes & stickers layer", exact: true }).click();
  assert.deepEqual(errors, []);
} finally { await app.close(); }
console.log("PASS: five auto layers, eye, lock, opacity, Sheets migration, restart persistence, and a 500-magnet toggle under 50 ms.");
