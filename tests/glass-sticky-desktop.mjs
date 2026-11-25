import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { _electron as launch, expect } from "playwright/test";
import { decode } from "@toon-format/toon";
import sharp from "sharp";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-sticky-"));
const vault = path.join(home, "vault"), doc = "practice.md", file = path.join(vault, doc);
const heading = "Retrieval practice", first = "Recall the answer before looking it up.", second = "Leave a day before your next review.";
const source = `# ${heading}\r\n\r\n${first}\r\n\r\n${second}\r\n`;
await mkdir(vault);
await writeFile(file, source, "utf8");
const record = { id: "fixture", path: file, name: doc, content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\r\n" };
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

// Coarse, machine-tolerant baseline: the note is present, roughly in place, same paper colours.
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
const noteOf = (page, id) => page.locator(`.glass-note[data-magnet="${id}"]`);
async function ready(page) {
  await expect(richOf(page).getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
}
// Menu checkboxes can report a stale aria-checked right after opening, so flip and verify instead of trusting it.
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
async function blockBox(page, text) {
  return page.evaluate(text => {
    const block = [...document.querySelectorAll(".rich-document > [data-cid]")].find(node => node.textContent?.trim() === text);
    if (!block) return null;
    const rect = block.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, text);
}
async function magnetId(page, index = 0) {
  return page.locator(".glass-note").nth(index).getAttribute("data-magnet");
}
async function center(page, locator) {
  const box = await locator.boundingBox();
  assert.ok(box, "element has a box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function drag(page, locator, dx, dy, { lift = false } = {}) {
  const grab = await center(page, locator);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + dx / 2, grab.y + dy / 2, { steps: 5 });
  if (lift) await expect(page.locator(".glass-note.is-lifting")).toHaveCount(1);
  await page.mouse.move(grab.x + dx, grab.y + dy, { steps: 5 });
  await page.mouse.up();
}

const firstRun = await launchApp();
let { app, page, errors } = firstRun;
let notes = page.locator(".glass-note");
let caseTray = page.locator(".glass-tray");
try {
  await resize(app, page, 1440);
  await ready(page);
  await learning(page, true);
  await expect(richOf(page)).toHaveAttribute("contenteditable", "false");
  await glassMenu(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
  await expect(caseTray).toBeVisible();

  // Plain baseline for the open budget: the glass with no magnets on screen.
  // "g" is the hand's own toggle; the Display menu costs seconds under headless ozone and would hide the mount.
  const toggleBudget = async () => {
    if ((await glassOf(page).count()) > 0) {
      await richOf(page).click({ position: { x: 4, y: 4 } });
      await page.keyboard.press("g");
      await expect(glassOf(page)).toHaveCount(0);
    }
    await richOf(page).click({ position: { x: 4, y: 4 } });
    await page.evaluate(() => { window.__glassToggleAt = performance.now(); });
    await page.keyboard.press("g");
    await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName("omarkie:glass-ready").some(mark => mark.startTime > window.__glassToggleAt)), { timeout: 20_000 }).toBe(true);
    return page.evaluate(() => Math.min(...performance.getEntriesByName("omarkie:glass-ready").filter(mark => mark.startTime > window.__glassToggleAt).map(mark => mark.startTime)) - window.__glassToggleAt);
  };
  const plain = [];
  for (let run = 0; run < 3; run++) plain.push(await toggleBudget());
  const plainBest = Math.min(...plain);

  // Pencil case: every tool answers; later-slice tools say so and never pretend to work.
  const coming = { ink: "Ink", highlighter: "Highlighter", sticker: "Sticker", arrow: "Arrow", card: "Card", scissors: "Scissors" };
  for (const [id, label] of Object.entries(coming)) {
    const tool = caseTray.locator(`[data-glass-coming="${id}"]`);
    await expect(tool).toHaveAttribute("aria-disabled", "true");
    assert.match(await tool.getAttribute("title"), /coming soon/i);
    await tool.click({ force: true });
    await expect(page.locator(".glass-notice")).toHaveText(`${label} is coming soon.`);
  }
  await expect(caseTray.locator('[data-glass-tool="select"]')).toHaveAttribute("aria-pressed", "true");
  await caseTray.locator('[data-glass-tool="sticky"]').click();
  await expect(caseTray.locator('[data-glass-tool="sticky"]')).toHaveAttribute("aria-pressed", "true");

  // Create by clicking the glass, then type straight into the note.
  const secondBox = await blockBox(page, second);
  assert.ok(secondBox, "the anchored paragraph is on screen");
  await page.mouse.click(secondBox.x + 60, secondBox.y + 8);
  await expect(notes).toHaveCount(1);
  const firstNote = notes.first();
  const firstId = await firstNote.getAttribute("data-magnet");
  assert.match(firstId, /^m-/);
  await expect(firstNote.locator(".glass-note-text")).toBeFocused();
  await page.keyboard.type("Peel me");
  await expect.poll(async () => (await axi("glass", "list", "--note", doc)).magnets[0]?.fields.text, { timeout: 15_000 }).toBe("Peel me");
  const journal = await axi("glass", "list", "--note", doc);
  assert.equal(journal.magnets.length, 1);
  assert.equal(journal.magnets[0].fields.kind, "sticky");
  assert.equal(journal.magnets[0].fields.anchor.landmarks[0].block, second);
  assert.equal(await readFile(file, "utf8"), source, "glass never writes the page");

  // N makes the next note at the middle of the page without touching the pencil case.
  await caseTray.locator('[data-glass-tool="select"]').click();
  await page.keyboard.press("n");
  await expect(notes).toHaveCount(2);
  const secondId = await magnetId(page, 1);
  await page.keyboard.type("Keyboard note");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await axi("glass", "list", "--note", doc)).magnets.length).toBe(2);
  // Park the second note clear of the first, so both papers stay readable on the glass.
  await drag(page, noteOf(page, secondId).locator(".glass-note-head"), 40, 240);

  // Colour, fold to a dot, unfold back.
  const paper = noteOf(page, firstId);
  await paper.locator('button[aria-label="rose note"]').click();
  await expect(paper).toHaveAttribute("data-colour", "rose");
  await expect.poll(async () => fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", firstId)).color).toBe("rose");
  await paper.getByRole("button", { name: "Fold note", exact: true }).click();
  await expect(paper).toHaveAttribute("data-folded", "true");
  const folded = await paper.boundingBox();
  assert.ok(folded && folded.width <= 50 && folded.height <= 50, `folded note is a dot (${JSON.stringify(folded)})`);
  await expect.poll(async () => fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", firstId)).folded).toBe(true);
  await paper.getByRole("button", { name: "Unfold note", exact: true }).click();
  await expect(paper).not.toHaveAttribute("data-folded", "true");

  // Peel: the paper lifts while it is dragged and lands where it was dropped.
  const start = await paper.boundingBox();
  await drag(page, paper.locator(".glass-note-head"), 80, 40, { lift: true });
  await expect(paper).not.toHaveClass(/is-lifting/);
  await expect.poll(async () => {
    const box = await paper.boundingBox();
    return box ? [Math.round(box.x - start.x), Math.round(box.y - start.y)] : null;
  }).toEqual([80, 40]);
  const moved = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", firstId));
  assert.equal(moved.x, journal.magnets[0].fields.x + 80);
  assert.equal(moved.y, journal.magnets[0].fields.y + 40);

  // Stretch: the right grip resizes the paper and the journal keeps the size.
  const before = await paper.boundingBox();
  await drag(page, paper.locator(".glass-note-grip-right"), 64, 0);
  await expect.poll(async () => Math.round((await paper.boundingBox()).width - before.width)).toBe(64);
  assert.equal(fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", firstId)).w, before.width + 64);

  // Delete goes to the glass trash; undo brings it back.
  await paper.getByRole("button", { name: "Move note to trash", exact: true }).click();
  await expect(notes).toHaveCount(1);
  await expect(caseTray.locator("[data-glass-trash-count]")).toHaveText("1");
  await caseTray.locator("[data-glass-trash]").click();
  const trashPanel = page.locator(".glass-trash");
  await expect(trashPanel).toBeVisible();
  await trashPanel.locator(`[data-glass-restore="${firstId}"]`).click();
  await expect(notes).toHaveCount(2);
  await expect(caseTray.locator("[data-glass-trash-count]")).toHaveText("0");

  // Keyboard: Enter edits, Delete trashes, undo restores.
  const keyboardNote = noteOf(page, secondId);
  await keyboardNote.locator(".glass-note-head").click();
  await expect(keyboardNote).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Enter");
  await expect(keyboardNote.locator(".glass-note-text")).toBeFocused();
  await page.keyboard.press("Escape");
  await keyboardNote.locator(".glass-note-head").click();
  await page.keyboard.press("Delete");
  await expect(notes).toHaveCount(1);
  await caseTray.locator("[data-glass-trash]").click();
  await page.locator(`.glass-trash [data-glass-restore="${secondId}"]`).click();
  await expect(notes).toHaveCount(2);

  // Screenshots: light and dark, wide and narrow, one note folded to its dot.
  await keyboardNote.getByRole("button", { name: "Fold note", exact: true }).click();
  await expect(keyboardNote).toHaveAttribute("data-folded", "true");
  await paper.locator(".glass-note-head").click();
  await page.keyboard.press("Escape");
  await expect(caseTray.locator("[data-glass-saved]")).toHaveText("Saved", { timeout: 15_000 });
  await page.mouse.move(700, 320);
  await capture(page, "sticky-light-1440");
  await resize(app, page, 720);
  await capture(page, "sticky-light-720");
  await resize(app, page, 1440);
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "omarchy-dark"));
  await page.reload();
  await ready(page);
  await learning(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
  notes = page.locator(".glass-note");
  caseTray = page.locator(".glass-tray");
  await expect(notes).toHaveCount(2);
  await expect(noteOf(page, firstId)).toHaveAttribute("data-colour", "rose");
  await capture(page, "sticky-dark-1440");
  await resize(app, page, 720);
  await capture(page, "sticky-dark-720");
  await resize(app, page, 1440);

  // Agent parity: the CLI creates, moves, edits, trashes and restores; the open glass follows.
  const added = await axi("glass", "add", "--note", doc, "--kind", "sticky", "--near", "Leave a day", "--text", "Agent note", "--color", "blue", "--magnet", "m-agent");
  assert.equal(added.magnet.fields.kind, "sticky");
  const agentNote = noteOf(page, "m-agent");
  await expect(agentNote).toHaveCount(1, { timeout: 15_000 });
  await expect(agentNote).toHaveAttribute("data-colour", "blue");
  await expect(agentNote.locator(".glass-note-text")).toHaveValue("Agent note");
  await expect(notes).toHaveCount(3);
  await axi("glass", "move", "--note", doc, "--magnet", "m-agent", "--x", "144", "--y", "72", "--w", "264", "--h", "176");
  await expect.poll(async () => {
    const fields = fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", "m-agent"));
    return [fields.x, fields.y, fields.w, fields.h];
  }).toEqual([144, 72, 264, 176]);
  await axi("glass", "edit", "--note", doc, "--magnet", "m-agent", "--text", "Edited by agent", "--color", "green", "--folded");
  await expect(agentNote).toHaveAttribute("data-colour", "green");
  await expect(agentNote).toHaveAttribute("data-folded", "true");
  await axi("glass", "edit", "--note", doc, "--magnet", "m-agent", "--unfold");
  await expect(agentNote).not.toHaveAttribute("data-folded", "true");
  await expect(agentNote.locator(".glass-note-text")).toHaveValue("Edited by agent");
  await axi("glass", "delete", "--note", doc, "--magnet", "m-agent");
  await expect(agentNote).toHaveCount(0);
  await expect(caseTray.locator("[data-glass-trash-count]")).toHaveText("1");
  await axi("glass", "restore", "--note", doc, "--magnet", "m-agent");
  await expect(agentNote).toHaveCount(1);
  const listed = await axi("glass", "list", "--note", doc);
  assert.deepEqual(listed.magnets.map(item => item.id).sort(), [firstId, secondId, "m-agent"].sort());

  // The note follows its paragraph when the page reflows above it.
  const pinned = () => page.evaluate(([id, text]) => {
    const note = document.querySelector(`.glass-note[data-magnet="${id}"]`);
    const block = [...document.querySelectorAll(".rich-document > [data-cid]")].find(node => node.textContent?.trim() === text);
    return note && block ? note.getBoundingClientRect().top - block.getBoundingClientRect().top : null;
  }, [firstId, second]);
  const pinnedBefore = await pinned();
  await learning(page, false);
  await sourceMode(page, true);
  const surface = page.locator(".document-editor:not([hidden]) .cm-content");
  await expect(surface).toBeVisible();
  await surface.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("Glass guard text.\n\n");
  await expect.poll(() => page.evaluate(() => document.querySelector(".cm-content")?.textContent?.startsWith("Glass guard text."))).toBe(true);
  await sourceMode(page, false);
  await learning(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
  await expect.poll(() => pinned()).not.toBeNull();
  const pinnedAfter = await pinned();
  assert.ok(Math.abs(pinnedAfter - pinnedBefore) <= 2, `the sticky note followed its paragraph (${pinnedBefore} → ${pinnedAfter})`);
  assert.equal(fieldsOf(await axi("glass", "show", "--note", doc, "--magnet", firstId)).anchor.landmarks[0].block, second);
  assert.match(await readFile(file, "utf8"), /Glass guard text\./);

  // Restart: everything is still there, in the same place.
  const placeBefore = await noteOf(page, firstId).boundingBox();
  const countBefore = (await axi("glass", "list", "--note", doc)).magnets.length;
  assert.deepEqual(errors, []);
  await app.close();
  ({ app, page, errors } = await launchApp());
  await resize(app, page, 1440);
  await ready(page);
  await learning(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
  await expect(page.locator(".glass-note")).toHaveCount(countBefore);
  const placeAfter = await noteOf(page, firstId).boundingBox();
  assert.ok(placeBefore && placeAfter && Math.abs(placeAfter.y - placeBefore.y) <= 2, `note survives restart at its spot (${placeBefore?.y} → ${placeAfter?.y})`);
  await expect(noteOf(page, firstId)).toHaveAttribute("data-colour", "rose");
  await expect(noteOf(page, firstId).locator(".glass-note-text")).toHaveValue("Peel me");

  // Budgets: 200 magnets must not cost more than 100 ms over plain reading.
  await glassMenu(page, false);
  await expect(glassOf(page)).toHaveCount(0);
  const bulk = await page.evaluate(async ([text, heading]) => {
    for (let index = 0; index < 200; index++) {
      const result = await window.desktop.glass({ action: "add", note: "practice.md", magnet: `m-bulk-${index}`,
        fields: { kind: "sticky", text: `bulk ${index}`, color: "yellow", folded: index % 5 === 0,
          anchor: { landmarks: [{ kind: "block", block: text, headings: [heading] }] },
          x: 600 + (index % 6) * 40, y: 8 + Math.floor(index / 6) * 24, w: 232, h: 168 } });
      if ((result?.value ?? result)?.magnet?.id !== `m-bulk-${index}`) return { index, result };
    }
    return { index: 200 };
  }, [first, heading]);
  assert.equal(bulk.index, 200, `bulk magnets written: ${JSON.stringify(bulk).slice(0, 400)}`);
  const many = [];
  for (let run = 0; run < 3; run++) many.push(await toggleBudget());
  const manyBest = Math.min(...many);
  assert.ok(manyBest - plainBest < 100, `200 magnets opened in ${manyBest.toFixed(1)}ms vs ${plainBest.toFixed(1)}ms plain; budget is 100ms`);
  await expect(page.locator(".glass-note")).toHaveCount(203, { timeout: 30_000 });
  await expect(page.locator('.glass-note[data-magnet="m-bulk-199"]')).toHaveCount(1);

  // Drag stays smooth with 200 magnets on the glass. Headless ozone throttles rAF and pointer delivery to
  // one frame a second, so time the work a real 60 Hz frame would have to fit: place the dragged paper and
  // re-lay out the whole glass, 200 magnets included.
  const dragAdded = await page.evaluate(async ([text, heading]) => {
    const result = await window.desktop.glass({ action: "add", note: "practice.md", magnet: "m-drag",
      fields: { kind: "sticky", text: "drag me", color: "yellow", anchor: { landmarks: [{ kind: "block", block: text, headings: [heading] }] }, x: 8, y: 8, w: 232, h: 168 } });
    return (result?.value ?? result)?.magnet?.id ?? null;
  }, [first, heading]);
  assert.equal(dragAdded, "m-drag");
  const sample = noteOf(page, "m-drag");
  await expect(sample).toHaveCount(1, { timeout: 20_000 });
  await drag(page, sample.locator(".glass-note-head"), 60, 30);
  const perMove = await page.evaluate(([id, width]) => {
    const note = document.querySelector(`.glass-note[data-magnet="${id}"]`);
    const layer = document.querySelector(".glass-layer");
    layer.getBoundingClientRect();
    const start = performance.now();
    for (let step = 0; step < 40; step++) {
      note.style.left = `${width + step}px`;
      note.style.top = `${80 + step}px`;
      layer.getBoundingClientRect();
    }
    return (performance.now() - start) / 40;
  }, ["m-drag", 120]);
  assert.ok(perMove <= 8, `a drag frame costs ${perMove.toFixed(2)}ms with 200 magnets; a 60 Hz frame has 16.7ms`);

  // A deleted paragraph leaves its magnets in the orphan tray, not lost.
  await learning(page, false);
  await expect(richOf(page)).toHaveAttribute("contenteditable", "true");
  const paragraph = richOf(page).locator("[data-cid]").filter({ hasText: second }).first();
  await expect(paragraph).toBeVisible();
  await paragraph.click({ position: { x: 4, y: 6 } });
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("Delete");
  await expect.poll(async () => blockBox(page, second)).toBeNull();
  await learning(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
  await expect(page.locator(".glass-orphans")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(`[data-glass-orphan="${firstId}"]`)).toContainText("Peel me");
  await expect(page.locator('[data-glass-orphan="m-agent"]')).toContainText("Edited by agent");
  await expect(noteOf(page, firstId)).toHaveCount(0);

  assert.deepEqual(errors, []);
  console.log(`budget: plain ${plainBest.toFixed(1)}ms, 200 magnets ${manyBest.toFixed(1)}ms, drag frame ${perMove.toFixed(2)}ms`);
  console.log("PASS: sticky notes create, type, move, resize, recolour, fold, peel, delete, undo, follow their paragraph, survive restart, and stay fast with 200 magnets");
} finally { await app.close(); }
const remaining = await readFile(file, "utf8");
assert.match(remaining, /Glass guard text\./);
await rm(home, { recursive: true, force: true });
