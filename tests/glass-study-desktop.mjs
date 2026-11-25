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
const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-g14-"));
const vault = path.join(home, "vault"), doc = "review.md";
const shots = process.env.OMARKIE_GLASS_G14_SHOTS ?? path.join(home, "screens");
await mkdir(vault, { recursive: true });
await mkdir(shots, { recursive: true });
const heading = "Nerve review";
const first = "The median nerve travels through the carpal tunnel and supplies the thenar muscles.";
const second = "A second paragraph gives the margin room for a pin.";
const source = `# ${heading}\n\n${first}\n\n${second}\n`;
await writeFile(path.join(vault, doc), source, "utf8");
const scene = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240">
  <rect width="360" height="240" fill="#e7efe6"/>
  <path d="M40 120 C120 60 220 180 320 100" stroke="#b5651d" stroke-width="8" fill="none"/>
  <circle cx="190" cy="120" r="9" fill="#326eaa"/>
</svg>`;
const photo = await sharp(Buffer.from(scene)).png().toBuffer();
const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));

function session(folder, name, content) {
  const file = path.join(folder, name);
  return { version: 1, activeId: "fixture", folder, documents: [{ id: "fixture", path: file, name,
    content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), lineEnding: "\n" }] };
}
async function boot(data = home, text = source) {
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, "session.json"), JSON.stringify(session(vault, doc, text)), "utf8");
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: data, OMARKIE_LANGUAGE: "en" });
  delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
  const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  return { app, page, env, errors };
}
async function axiIn(folder, env, ...args) {
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: folder, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 60_000 });
  return decode(stdout);
}
async function resize(app, page, width, height = 900) {
  await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setContentSize(width, height), [width, height]);
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
  await rich.click({ position: { x: 4, y: 4 } });
  if (!await page.locator(".glass-layer").count()) await page.keyboard.press("g");
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:glass-ready").length > 0);
  return rich;
}
async function dropPhoto(page) {
  const block = page.locator(".rich-document > [data-cid]", { hasText: second }).first();
  const box = await block.boundingBox();
  assert.ok(box, "paragraph is on screen");
  await page.evaluate(async ({ point, bytes, name }) => {
    const binary = atob(bytes);
    const data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], name, { type: "image/png" }));
    const scroller = document.querySelector(".rich-scroller");
    scroller.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, dataTransfer: transfer }));
    scroller.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, dataTransfer: transfer }));
  }, { point: { x: box.x + 36, y: box.y + 16 }, bytes: photo.toString("base64"), name: "median nerve.png" });
}
async function waitDue(folder, env, count) {
  await expect.poll(async () => (await axiIn(folder, env, "srs", "due", "--vault", ".")).count, { timeout: 20_000 }).toBe(count);
}

{
  const { app, page, env, errors } = await boot();
  try {
    await resize(app, page, 1440);
    await openGlass(page);
    await dropPhoto(page);
    const frame = page.locator(".glass-image");
    await expect(frame).toHaveCount(1, { timeout: 20_000 });
    await expect(frame.locator("[data-glass-image-source]")).toBeVisible({ timeout: 20_000 });
    const imageId = await frame.getAttribute("data-magnet");
    const imageBox = await frame.locator("[data-glass-image-body]").boundingBox();

    // Pin a label on the picture; it starts in edit mode and persists only the label.
    await page.locator('[data-glass-tool="label"]').click();
    await page.mouse.click(imageBox.x + Math.round(imageBox.width * 0.55), imageBox.y + Math.round(imageBox.height * 0.45));
    const input = page.locator("[data-label-input]");
    await expect(input).toBeVisible();
    await input.fill("Median nerve");
    await input.press("Enter");
    const label = page.locator("[data-label]");
    await expect(label).toHaveCount(1);
    await expect(label.locator(".glass-label-name")).toHaveText("Median nerve");
    const listed = await axiIn(vault, env, "glass", "list", "--note", doc);
    const labelMagnet = listed.magnets.find(magnet => magnet.fields.kind === "label");
    assert.ok(labelMagnet, "the label is stored as a magnet");
    assert.deepEqual(labelMagnet.fields.target, { kind: "magnet", magnet: imageId });
    assert.equal(labelMagnet.fields.text, "Median nerve");
    assert.equal(await page.locator(".glass-image").count(), 1, "the page keeps the picture mark");
    const hid = await axiIn(vault, env, "glass", "label", "hide", "--note", doc, "--magnet", labelMagnet.id);
    assert.equal(hid.hidden, true);
    assert.equal(hid.count, 1);
    const shown = await axiIn(vault, env, "glass", "label", "reveal", "--note", doc, "--magnet", labelMagnet.id);
    assert.equal(shown.hidden, false);

    // Hide labels: the pin stays, the name becomes the answer.
    await page.locator("[data-labels-hide]").click();
    await expect(page.locator("[data-labels-hide]")).toHaveAttribute("aria-pressed", "true");
    await expect(label).toHaveAttribute("data-hidden", "true");
    await expect(label.locator(".glass-label-name")).toHaveCount(0);
    await label.locator("[data-label-pin]").click();
    await expect(label.locator(".glass-label-name")).toBeVisible();
    await page.screenshot({ path: path.join(shots, "g14-label-reveal-light-1440.png") });

    // A miss is a card: wrong grades Again and lands in the rail due count.
    await label.locator("[data-label-wrong]").click();
    await waitDue(vault, env, 1);
    await expect(page.locator("[data-srs-open]").first()).toHaveAttribute("data-srs-count", "1");

    // Review with the keyboard: Space reveals, 3 is Good, due count returns to zero.
    await page.locator("[data-srs-open]").first().click();
    const panel = page.locator("[data-srs-panel]");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-srs-front]")).toContainText("Name the pinned structure");
    await page.keyboard.press("Space");
    await expect(panel.locator("[data-srs-back]")).toHaveText("Median nerve");
    await page.screenshot({ path: path.join(shots, "g14-review-light-1440.png") });
    await page.keyboard.press("3");
    await waitDue(vault, env, 0);
    await expect(panel.locator("[data-srs-count]")).toHaveText("No cards due");
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    // Mark it, fold everything to a cue, reveal one by one, leave without changing due dates.
    await page.locator("[data-labels-hide]").click();
    await expect(label.locator(".glass-label-name")).toBeVisible();
    await label.locator("[data-label-mark]").click();
    await expect(label).toHaveAttribute("data-marked", "true");
    await page.locator("[data-exam-toggle]").click();
    const exam = page.locator("[data-exam-panel]");
    await expect(exam).toBeVisible();
    await expect(exam.locator("[data-exam-cue]")).toContainText("Name the pinned structure");
    await expect(label.locator(".glass-label-name")).toHaveCount(0);
    await page.keyboard.press("Space");
    await expect(exam.locator("[data-exam-answer]")).toHaveText("Median nerve");
    await page.keyboard.press("4");
    await expect.poll(async () => (await axiIn(vault, env, "srs", "due", "--vault", ".")).count, { timeout: 10_000 }).toBe(0);
    await page.screenshot({ path: path.join(shots, "g14-exam-light-1440.png") });
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-exam-toggle]")).toHaveAttribute("aria-pressed", "false");

    // 720 dark baseline, then restart: hidden labels stay hidden.
    await page.evaluate(() => localStorage.setItem("omarkie-theme", "omarchy-dark"));
    await page.reload();
    await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
    await openGlass(page);
    await resize(app, page, 720, 900);
    await page.locator("[data-labels-hide]").click();
    await expect(page.locator("[data-labels-hide]")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-label]")).toHaveAttribute("data-hidden", "true");
    await page.screenshot({ path: path.join(shots, "g14-quiz-omarchy-dark-720.png") });
    await resize(app, page, 1440, 900);
    await page.screenshot({ path: path.join(shots, "g14-quiz-omarchy-dark-1440.png") });
    const examOn = await axiIn(vault, env, "exam", "on", "--note", doc);
    assert.equal(examOn.exam, true);
    const examOff = await axiIn(vault, env, "exam", "off", "--note", doc);
    assert.equal(examOff.exam, false);
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
}

{
  const { app, page, env } = await boot();
  try {
    await resize(app, page, 1440);
    await openGlass(page);
    await expect(page.locator("[data-label]")).toHaveCount(1);
    await expect(page.locator("[data-labels-hide]")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[data-label]")).toHaveAttribute("data-hidden", "true");
    const due = await axiIn(vault, env, "srs", "due", "--vault", ".");
    assert.equal(due.count, 0, "restart persists labels and leaves the graded card scheduled");
  } finally { await app.close(); }
}
console.log(`glass study desktop ok · ${shots}`);
