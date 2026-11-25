import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { _electron as launch, expect } from "playwright/test";
import { decode } from "@toon-format/toon";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-merge-"));
const vault = path.join(home, "vault"), doc = "practice.md", file = path.join(vault, doc);
const heading = "Retrieval practice", first = "Recall the answer before looking it up.", second = "Leave a day before your next review.";
const source = `# ${heading}\r\n\r\n${first}\r\n\r\n${second}\r\n\r\n![A dot](assets/pic.png)\r\n`;
await mkdir(path.join(vault, ".obsidian"), { recursive: true });
await mkdir(path.join(vault, "assets"), { recursive: true });
await writeFile(path.join(vault, ".obsidian", "app.json"), JSON.stringify({ attachmentFolderPath: "assets" }));
await writeFile(path.join(vault, "assets", "pic.png"), png);
await writeFile(file, source, "utf8");
const record = { id: "fixture", path: file, name: doc, content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\r\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const evidence = process.env.OMARKIE_QA_DIR ?? path.join(home, "shots");
await mkdir(evidence, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(evidence, `${name}.png`) });
const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
async function axi(...args) {
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 });
  return decode(stdout);
}
const bytes = () => readFile(file);
const text = () => readFile(file, "utf8");
const richOf = page => page.locator(".document-editor:not([hidden]) .rich-document");
const glassOf = page => page.locator(".glass-layer");
const trayOf = page => page.locator(".glass-tray");
async function rectOf(page, selector) {
  return page.evaluate(selector => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, selector);
}
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
async function ready(page) {
  await page.reload();
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
    if (((await glassOf(page).count()) > 0) !== on) { await richOf(page).click({ position: { x: 4, y: 4 } }); await page.keyboard.press("g"); }
    await expect(glassOf(page)).toHaveCount(on ? 1 : 0);
    return;
  }
  await flip(page, "Glass overlay", async () => ((await glassOf(page).count()) > 0) === on);
}
async function resize(app, page, width) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
}

const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
try {
  const page = await app.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await resize(app, page, 1440);
  await ready(page);
  await learning(page, true);
  await glassMenu(page, true);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
  const original = await bytes();

  // Lift a paragraph from the page: a linked sticky note appears, the page does not change.
  const paragraph = richOf(page).locator("p[data-cid]", { hasText: first }).first();
  await paragraph.click({ position: { x: 24, y: 8 } });
  const pill = page.locator(".element-halo-pill");
  await expect(pill.getByRole("button", { name: "Lift to glass", exact: true })).toBeVisible();
  await pill.getByRole("button", { name: "Lift to glass", exact: true }).click();
  const lifted = page.locator('.glass-note[data-magnet]').filter({ hasText: first });
  await expect(lifted).toBeVisible();
  await expect(lifted.locator("[data-glass-jump]")).toBeVisible();
  assert.deepEqual(await bytes(), original, "lift up never writes the page");
  await axi("glass", "delete", "--note", doc, "--magnet", await lifted.getAttribute("data-magnet"));
  await expect(lifted).toHaveCount(0);

  // A sticky note is added from the CLI, exactly as an agent would leave it.
  await axi("glass", "add", "--note", doc, "--kind", "sticky", "--text", "Review tomorrow.", "--near", first, "--magnet", "m-sticky");
  const sticky = page.locator('.glass-note[data-magnet="m-sticky"]');
  await expect(sticky).toBeVisible();
  const agentPreview = await axi("glass", "merge-down", "m-sticky", "--note", doc, "--preview");
  assert.equal(agentPreview.merge.magnet, "m-sticky");
  assert.deepEqual(agentPreview.merge.added, ["> [!note]", "> Review tomorrow."]);
  const agentAccept = await axi("glass", "merge-down", "m-sticky", "--note", doc, "--accept");
  assert.equal(agentAccept.needsUser, true);
  assert.deepEqual(await bytes(), original, "an agent's --accept only asks; it never writes");

  // Preview shows the exact callout; Cancel leaves the note untouched.
  await page.locator('[data-glass-merge="m-sticky"]').click();
  const dialog = page.locator("[data-glass-merge-dialog]");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Sticky note → callout");
  await expect(dialog).toContainText("> [!note]");
  await shot(page, "light-1440-preview");
  await resize(app, page, 720);
  await shot(page, "light-720-preview");
  await resize(app, page, 1440);
  await dialog.locator(".glass-merge-actions [data-glass-merge-cancel]").click();
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(await bytes(), original, "Cancel leaves the page byte-identical");
  await expect(sticky).toBeVisible();

  // Accept writes the callout, the magnet leaves the glass, and the toast can undo byte-exactly.
  await page.locator('[data-glass-merge="m-sticky"]').click();
  await page.locator("[data-glass-merge-dialog] .glass-merge-accept").click();
  await expect.poll(text).toContain("> [!note]\r\n> Review tomorrow.");
  await expect(sticky).toHaveCount(0);
  const merged = await bytes();
  assert.notDeepEqual(merged, original);
  await expect(page.locator("[data-glass-merge-done]")).toBeVisible();
  await shot(page, "light-1440-merged");
  await page.locator("[data-glass-merge-done] [data-glass-merge-undo]").click();
  await expect.poll(bytes).toEqual(original);
  await expect(sticky).toBeVisible();

  // A change on disk between preview and Accept opens the stale path and writes nothing yet.
  await axi("glass", "list", "--note", doc);
  await page.locator('[data-glass-merge="m-sticky"]').click();
  await expect(dialog).toBeVisible();
  const changed = Buffer.from(`${source}Inserted while you looked away.\r\n`, "utf8");
  await writeFile(file, changed);
  await page.locator("[data-glass-merge-dialog] .glass-merge-accept").click();
  await expect(page.locator("[data-glass-merge-stale]")).toBeVisible();
  assert.deepEqual(await bytes(), changed, "stale never writes silently");
  await shot(page, "light-1440-stale");
  await page.getByRole("button", { name: "Merge into the updated note", exact: true }).click();
  await expect.poll(text).toContain("> [!note]\r\n> Review tomorrow.");
  await expect.poll(text).toContain("Inserted while you looked away.");
  await expect(dialog).toHaveCount(0);
  await page.locator("[data-glass-merge-done] [data-glass-merge-undo]").click();
  await expect.poll(bytes).toEqual(changed);

  // Lift and merge a picture: vault link style and attachment folder come from .obsidian/app.json.
  const imageState = await axi("glass", "lift-up", "--note", doc, "--element", (await axi("element", "list", "--note", doc, "--kind", "image")).elements[0].id);
  const imageId = imageState.magnet.fields.kind === "image" ? imageState.magnet.id : (await axi("glass", "list", "--note", doc)).magnets.find(magnet => magnet.fields.kind === "image").id;
  const image = page.locator(`.glass-image[data-magnet="${imageId}"]`);
  await expect(image).toBeVisible();
  await image.click();
  await page.locator(`[data-glass-merge="${imageId}"]`).click();
  await expect(dialog).toContainText("Picture → Markdown image");
  await expect(dialog).toContainText("assets/");
  await shot(page, "light-1440-picture-preview");
  const beforePicture = await bytes();
  await page.locator("[data-glass-merge-dialog] .glass-merge-accept").click();
  await expect.poll(text).toMatch(/!\[\[assets\/pic-[0-9]+\.png\|320\]\]/);
  await expect(image).toHaveCount(0);
  await axi("glass", "merge-undo", "--note", doc);
  await expect.poll(bytes).toEqual(beforePicture);
  await expect(page.locator("[data-glass-merge-done]")).toHaveCount(0);

  // Ink merges as an SVG asset plus a vault image link.
  await axi("glass", "delete", "--note", doc, "--magnet", "m-sticky");
  await expect(sticky).toHaveCount(0);
  const tray = trayOf(page);
  await tray.getByRole("button", { name: "Pen", exact: true }).click();
  const paragraphRect = await rectOf(page, ".rich-document p[data-cid]");
  assert.ok(paragraphRect);
  await stroke(page, Array.from({ length: 12 }, (_, index) => [paragraphRect.x + 20 + index * 16, paragraphRect.y + 12 + Math.sin(index / 2) * 5]));
  await expect(page.locator(".glass-ink path")).not.toHaveCount(0);
  await expect(page.locator("[data-glass-merge-ink]")).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-glass-merge-ink]").click();
  await expect(dialog).toContainText("Ink → SVG picture");
  const beforeInk = await bytes();
  await page.locator("[data-glass-merge-dialog] .glass-merge-accept").click();
  await expect.poll(text).toMatch(/!\[\[assets\/ink-[a-z0-9]+\.svg\|640\]\]/);
  const inkName = /\[\[(assets\/ink-[a-z0-9]+\.svg)\|/.exec(await text())[1];
  assert.match(await readFile(path.join(vault, inkName), "utf8"), /^<svg[^>]+viewBox=/);
  await axi("glass", "merge-undo", "--note", doc);
  await expect.poll(bytes).toEqual(beforeInk);

  // Dark mode at 1440 and 720 keeps the dialog readable.
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "omarchy-dark"));
  await ready(page);
  await resize(app, page, 1440);
  await expect(glassOf(page)).toHaveAttribute("data-glass", "on");
  await axi("glass", "add", "--note", doc, "--kind", "sticky", "--text", "Dark preview.", "--near", first, "--magnet", "m-dark");
  await page.locator('[data-glass-merge="m-dark"]').evaluate(button => button.click());
  await expect(dialog).toBeVisible();
  await shot(page, "dark-1440-preview");
  await resize(app, page, 720);
  await shot(page, "dark-720-preview");
  await dialog.locator(".glass-merge-actions [data-glass-merge-cancel]").click();
  await expect(dialog).toHaveCount(0);
  await resize(app, page, 1440);
  assert.deepEqual(errors, []);
  console.log("PASS: merge preview/cancel/accept for sticky, picture and ink; stale choice, undo, lift paragraph and picture");
} finally { await app.close(); }
