import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-g6-"));
const shots = process.env.OMARKIE_GLASS_SHOTS || path.join(home, "screens");
await mkdir(shots, { recursive: true });
const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
const first = "First paragraph with enough words to show how a picture pushes this text aside while the glass is on.";
const second = "Second paragraph holds the photo drop and keeps its own words flowing around the picture.";
const third = "Third paragraph stays plain so the wrap modes have something to push against.";
const heading = "Harbour notes";
const source = `# ${heading}\n\n${first}\n\n${second}\n\n${third}\n`;
const scene = (width, height) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7fb2d6"/><stop offset="1" stop-color="#efe2c8"/></linearGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#sky)"/>
  <circle cx="${width * 0.76}" cy="${height * 0.22}" r="${Math.min(width, height) * 0.09}" fill="#fff6d8"/>
  <path d="M0 ${height * 0.72} L${width * 0.22} ${height * 0.55} L${width * 0.46} ${height * 0.72} L${width * 0.72} ${height * 0.5} L${width} ${height * 0.72} L${width} ${height} L0 ${height}Z" fill="#3f6d8e"/>
  <path d="M0 ${height * 0.82} L${width} ${height * 0.78} L${width} ${height} L0 ${height}Z" fill="#27475c"/>
</svg>`;
const photo = await sharp(Buffer.from(scene(300, 200))).png().toBuffer();
const big = await sharp(Buffer.from(scene(6000, 4000))).jpeg({ quality: 70 }).toBuffer();

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

async function resize(app, page, width) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
}

async function openGlass(page, app) {
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

async function shoot(page, app, width, theme, name) {
  await reload(page, app, width, theme);
  await page.screenshot({ path: path.join(shots, `g6-${name}-${theme}-${width}.png`) });
}

async function reload(page, app, width, theme) {
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
  await page.waitForFunction(() => [...document.querySelectorAll(".glass-image img, [data-glass-image-paint]")].every(img => img.complete), null, { timeout: 20_000 });
  await resize(app, page, width);
  await page.waitForTimeout(400);
}

async function blockFor(page, text) {
  return page.locator(".rich-document > [data-cid]", { hasText: text }).first();
}

async function lines(page, text) {
  return page.evaluate(text => {
    const block = [...document.querySelectorAll(".rich-document > [data-cid]")].find(node => node.textContent?.includes(text));
    if (!block) return null;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].map(rect => ({ left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top) }));
    }
    return null;
  }, text);
}

async function clickFrameBody(frame) {
  const body = frame.locator("[data-glass-image-body]");
  const box = await body.boundingBox();
  await body.click({ position: { x: Math.min(120, Math.round(box.width / 2)), y: Math.round(box.height * 0.65) } });
}

async function selectImage(page, id) {
  const frame = page.locator(`.glass-image[data-magnet="${id}"]`);
  await clickFrameBody(frame);
  await expect(frame.locator("[data-glass-wrap]").first()).toBeVisible();
  return frame;
}

async function dropFile(page, block, bytes, name, dx = 24) {
  const box = await block.boundingBox();
  assert.ok(box, "paragraph is on screen");
  const point = { x: box.x + dx, y: box.y + 12 };
  await page.evaluate(async ({ point, bytes, name }) => {
    const binary = atob(bytes);
    const data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], name, { type: "image/png" }));
    const scroller = document.querySelector(".rich-scroller");
    scroller.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, dataTransfer: transfer }));
    scroller.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, dataTransfer: transfer }));
  }, { point, bytes: bytes.toString("base64"), name });
}

async function pasteFile(page, bytes, name) {
  await page.evaluate(async ({ bytes, name }) => {
    const binary = atob(bytes);
    const data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], name, { type: "image/png" }));
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transfer });
    window.dispatchEvent(event);
  }, { bytes: bytes.toString("base64"), name });
}

async function pointerDrag(page, locator, dx, dy, modifiers = []) {
  const box = await locator.boundingBox();
  assert.ok(box, "handle has a box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx / 2, box.y + box.height / 2 + dy / 2, { steps: 6 });
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
  await page.mouse.up();
  for (const key of modifiers) await page.keyboard.up(key);
}

// A. The main flow: drop, paste, move, resize, rotate, wraps, tape, lock, delete, undo.
const vault = path.join(home, "vault"), doc = "Photo notes.md", file = path.join(vault, doc);
await mkdir(vault, { recursive: true });
await writeFile(file, source, "utf8");
await writeFile(path.join(vault, "big harbour.jpg"), big);
await writeFile(path.join(home, "session.json"), JSON.stringify(session(vault, doc, source)), "utf8");
{
  const { app, page, env, errors } = await boot();
  try {
    const rich = await openGlass(page, app);
    const localPath = await page.evaluate(() => window.desktop.glass({ action: "add", image: { path: "unapproved.png" } }));
    assert.deepEqual({ ok: localPath.ok, error: localPath.error }, { ok: false, error: "Desktop image magnets require image bytes." });
    await resize(app, page, 1440);
    const secondBlock = await blockFor(page, second);
    const baseLines = await lines(page, second);

    // Drop a photo on the glass: it lands anchored to the paragraph under the pointer.
    await dropFile(page, secondBlock, photo, "Harbour at dusk.png");
    const frame = page.locator(".glass-image");
    await expect(frame).toHaveCount(1, { timeout: 20_000 });
    const id = await frame.getAttribute("data-magnet");
    assert.match(id, /^m-/);
    await expect(frame.locator("[data-glass-image-source]")).toBeVisible({ timeout: 20_000 });
    let listed = await axiIn(vault, env, "glass", "list", "--note", doc);
    let image = listed.magnets.find(magnet => magnet.id === id);
    assert.equal(image.fields.kind, "image");
    assert.equal(image.fields.asset, "Harbour at dusk.png");
    assert.equal(image.fields.display, null, "a small picture keeps just the original");
    assert.equal(image.fields.anchor.landmarks[0].block, second);
    assert.equal(image.fields.wrap, "left");
    const assetRoot = path.join(vault, ".omarkie", "assets");
    const folders = await (await import("node:fs/promises")).readdir(assetRoot);
    const stored = folders.length === 1
      ? await readFile(path.join(assetRoot, folders[0], "Harbour at dusk.png")).catch(() => null) : null;
    assert.ok(stored?.length, `the original bytes are on disk: ${folders.join(",")}`);
    assert.equal(await readFile(file, "utf8"), source, "glass never writes the page");

    // Paste works on the same path; a second picture joins the first.
    await pasteFile(page, photo, "Pasted photo.png");
    await expect(frame).toHaveCount(2, { timeout: 20_000 });
    listed = await axiIn(vault, env, "glass", "list", "--note", doc);
    assert.ok(listed.magnets.some(magnet => magnet.fields.asset === "Pasted photo.png"));
    const pasted = page.locator(".glass-image").last();
    await clickFrameBody(pasted);
    await pasted.locator("[data-glass-trash-image]").click();
    await expect(page.locator(".glass-image")).toHaveCount(1);

    // Text wrap: left pushes the first line right, right pulls the last edge in.
    const firstFrame = page.locator(`.glass-image[data-magnet="${id}"]`);
    await firstFrame.click({ position: { x: 20, y: 20 } });
    await firstFrame.locator('[data-glass-wrap="left"]').click();
    const flow = secondBlock.locator(".glass-flow");
    await expect(flow).toHaveCount(1);
    await expect(flow).toHaveAttribute("data-glass-flow", id);
    assert.equal(await flow.evaluate(node => getComputedStyle(node).cssFloat), "left");
    const leftLines = await lines(page, second);
    assert.ok(leftLines[0].left > baseLines[0].left + 40, `text moved aside: ${JSON.stringify({ baseLines, leftLines })}`);

    await firstFrame.locator('[data-glass-wrap="right"]').click();
    await expect(flow).toHaveCount(1);
    assert.equal(await flow.evaluate(node => getComputedStyle(node).cssFloat), "right");
    const rightLines = await lines(page, second);
    assert.ok(Math.max(...rightLines.map(line => line.right)) < Math.max(...baseLines.map(line => line.right)) - 40, "text kept clear on the right");

    // The selected frame carries its wrap, tape, lock and trash tools.
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shots, "g6-selected-light-1440.png") });
    await reload(page, app, 1440, "omarchy-dark");
    await selectImage(page, id);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(shots, "g6-selected-omarchy-dark-1440.png") });
    await reload(page, app, 1440, "light");

    // Behind text: the picture paints under the page, the frame stays as its handle.
    await selectImage(page, id);
    await firstFrame.locator('[data-glass-wrap="behind"]').click();
    await expect(page.locator("[data-glass-under] [data-glass-image-paint]")).toHaveCount(1);
    await expect(page.locator("[data-glass-under] [data-glass-image-paint]")).toHaveAttribute("src", /^data:image\//);
    await page.waitForFunction(() => document.querySelector("[data-glass-under] [data-glass-image-paint]")?.naturalWidth > 0, null, { timeout: 20_000 });
    await expect(firstFrame.locator("[data-glass-image-source]")).toHaveCount(0);
    await expect(rich).toHaveClass(/glass-above/);
    const under = await page.evaluate(() => {
      const paint = document.querySelector("[data-glass-under] [data-glass-image-paint]");
      const block = [...document.querySelectorAll(".rich-document > [data-cid]")].find(node => node.textContent?.includes("Second paragraph"));
      return { paint: paint?.getBoundingClientRect().toJSON(), block: block?.getBoundingClientRect().toJSON() };
    });
    assert.ok(under.paint && under.block, "both painted");
    await shoot(page, app, 1440, "light", "behind");
    await selectImage(page, id);

    // In front: the picture floats at a free offset and can be moved.
    await firstFrame.locator('[data-glass-wrap="front"]').click();
    await expect(secondBlock.locator(".glass-flow")).toHaveCount(0);
    const storedFields = async () => (await axiIn(vault, env, "glass", "list", "--note", doc)).magnets.find(magnet => magnet.id === id).fields;
    const before = await storedFields();
    await pointerDrag(page, firstFrame.locator("[data-glass-image-body]"), 48, 24);
    await expect.poll(async () => { const fields = await storedFields(); return fields.x >= before.x + 40 && fields.y >= before.y + 16; },
      { timeout: 15_000 }).toBe(true);

    // Resize; Shift keeps the picture's ratio.
    const moved = await storedFields();
    await pointerDrag(page, firstFrame.locator('[data-glass-handle="se"]'), 80, 20);
    await expect.poll(async () => (await storedFields()).w, { timeout: 15_000 }).toBeGreaterThan(moved.w + 60);
    const sized = await storedFields();
    await pointerDrag(page, firstFrame.locator('[data-glass-handle="se"]'), 90, 6, ["Shift"]);
    await expect.poll(async () => (await storedFields()).w, { timeout: 15_000 }).toBeGreaterThan(sized.w + 60);
    const shifted = await storedFields();
    const aspect = image.fields.aspect;
    assert.ok(Math.abs(shifted.w / shifted.h - aspect) < 0.06 * aspect, `shift kept the picture ratio: ${aspect} vs ${shifted.w / shifted.h}`);

    // Rotate by its handle.
    await pointerDrag(page, firstFrame.locator('[data-glass-handle="rotate"]'), 120, 60);
    await expect.poll(async () => (await storedFields()).rot, { timeout: 15_000 }).not.toBe(0);
    const turned = await storedFields();

    // Washi tape and lock: decorative glue, then the picture refuses to move.
    await selectImage(page, id);
    await firstFrame.locator("[data-glass-wrap]").first().click();
    await firstFrame.locator('[data-glass-tape]').click();
    await expect(firstFrame.locator("[data-glass-image-tape]")).toHaveCount(1);
    await firstFrame.locator("[data-glass-lock]").click();
    await expect(firstFrame.locator("[data-glass-handle]")).toHaveCount(0);
    const locked = (await axiIn(vault, env, "glass", "list", "--note", doc)).magnets.find(magnet => magnet.id === id).fields;
    assert.equal(locked.tape, true);
    assert.equal(locked.locked, true);
    await pointerDrag(page, firstFrame.locator("[data-glass-image-body]"), 60, 30);
    const still = (await axiIn(vault, env, "glass", "list", "--note", doc)).magnets.find(magnet => magnet.id === id).fields;
    assert.equal(still.x, locked.x);
    assert.equal(still.y, locked.y);
    await shoot(page, app, 1440, "light", "tape-lock");
    await shoot(page, app, 720, "light", "tape-lock");
    await shoot(page, app, 1440, "omarchy-dark", "tape-lock");
    await shoot(page, app, 720, "omarchy-dark", "tape-lock");
    await selectImage(page, id);
    await firstFrame.scrollIntoViewIfNeeded();
    await firstFrame.locator("[data-glass-lock]").click();

    // Delete and undo: the journal keeps the magnet and its bytes.
    await selectImage(page, id);
    await firstFrame.scrollIntoViewIfNeeded();
    await firstFrame.locator("[data-glass-trash-image]").click();
    await expect(page.locator(".glass-image")).toHaveCount(0);
    await page.locator("[data-glass-trash]").click();
    await expect(page.locator(`[data-glass-restore="${id}"]`)).toHaveCount(1);
    await page.locator(`[data-glass-restore="${id}"]`).click();
    await expect(page.locator(".glass-image")).toHaveCount(1);

    // An agent adds a 24 MP photo with no light copy; the renderer makes one.
    await axiIn(vault, env, "glass", "add", "--note", doc, "--kind", "image", "--file", "big harbour.jpg", "--near", second);
    await expect(page.locator(".glass-image")).toHaveCount(2, { timeout: 30_000 });
    await expect.poll(async () => (await axiIn(vault, env, "glass", "list", "--note", doc)).magnets
      .find(magnet => magnet.fields.asset === "big harbour.jpg")?.fields.display, { timeout: 40_000 }).toBeTruthy();
    assert.equal(errors.length, 0, errors.join("\n"));
  } finally { await app.close(); }
}

// B. Restart: the photo, its tilt, tape and wrap come back from the journal.
{
  const { app, page, errors } = await boot();
  try {
    await openGlass(page, app);
    const frames = page.locator(".glass-image");
    await expect(frames).toHaveCount(2, { timeout: 30_000 });
    const frame = frames.first();
    await expect(frame).toHaveAttribute("data-wrap", "left");
    await expect(frame).toHaveAttribute("data-tape", "true");
    const tilt = await frame.evaluate(node => getComputedStyle(node).getPropertyValue("--glass-image-rot"));
    assert.match(tilt.trim(), /-?\d/);
    assert.equal(errors.length, 0, errors.join("\n"));
  } finally { await app.close(); }
}

// C. Legacy Learning-mode image scraps migrate in place, blob and note untouched.
{
  const legacyVault = path.join(home, "legacy"), hash = "b".repeat(64);
  const legacyDoc = "Cells.md";
  const legacySource = `# Cells\n\nA membrane keeps the cell together.\n`;
  const legacyFile = path.join(legacyVault, legacyDoc);
  const scrap = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#6d8c5f" } }).png().toBuffer();
  await mkdir(path.join(legacyVault, ".omarkie", "scraps"), { recursive: true });
  await writeFile(legacyFile, legacySource, "utf8");
  await writeFile(path.join(legacyVault, ".omarkie", "scraps", hash), scrap);
  await writeFile(path.join(legacyVault, ".omarkie", "store.jsonl"), `${JSON.stringify({ v: 1, entry: { id: "legacy-a", type: "scrap",
    kind: "clip", sheet: "images", document: legacyDoc, body: "Cell membrane", image: { hash, side: "left", width: 240 },
    anchor: { block: "A membrane keeps the cell together.", line: 2, headings: ["Cells"] } } })}\n`, "utf8");
  await writeFile(path.join(home, "session.json"), JSON.stringify(session(legacyVault, legacyDoc, legacySource)), "utf8");
  const { app, page, env, errors } = await boot();
  try {
    await page.locator(".document-editor:not([hidden]) .rich-document").getByRole("heading", { name: "Cells", exact: true }).waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
    await page.evaluate(() => localStorage.setItem("omarkie-theme", "light"));
    await page.locator(".document-editor:not([hidden]) .rich-document").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("g");
    await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
    await expect(page.locator(".glass-image")).toHaveCount(1, { timeout: 30_000 });
    const listed = await axiIn(legacyVault, env, "glass", "list", "--note", legacyDoc);
    const migrated = listed.magnets.find(magnet => magnet.id === "m-scrap-legacy-a");
    assert.ok(migrated, JSON.stringify(listed));
    assert.equal(migrated.fields.name, "Cell membrane");
    assert.equal(migrated.fields.wrap, "left");
    assert.equal(await readFile(legacyFile, "utf8"), legacySource, "the page is untouched");
    assert.equal((await readFile(path.join(legacyVault, ".omarkie", "scraps", hash))).length, scrap.length, "the old blob is untouched");
    await expect(page.locator(".glass-image [data-glass-image-source]")).toBeVisible({ timeout: 20_000 });
    await shoot(page, app, 1440, "light", "migrated");
    assert.equal(errors.length, 0, errors.join("\n"));
  } finally { await app.close(); }
}

// D. Fifty pictures on one note still open the glass quickly.
{
  const denseVault = path.join(home, "dense"), denseDoc = "Album.md";
  const denseSource = `# Album\n\n${first}\n\n${second}\n`;
  await mkdir(denseVault, { recursive: true });
  await writeFile(path.join(denseVault, denseDoc), denseSource, "utf8");
  await writeFile(path.join(home, "session.json"), JSON.stringify(session(denseVault, denseDoc, denseSource)), "utf8");
  const { GlassService } = await import("../electron/glass-service.mjs");
  const seed = await new GlassService({ root: denseVault, appData: home, device: "desktop-test" }).open();
  const anchor = { landmarks: [{ kind: "block", block: second, headings: ["Album"] }] };
  for (let index = 1; index <= 50; index++) {
    await seed.request({ action: "add", note: denseDoc, magnet: `m-photo-${index}`, fields: { anchor, w: 200 },
      image: { base64: photo.toString("base64"), name: `Photo ${index}.png`, wrap: index % 2 ? "left" : "behind", displayBase64: photo.toString("base64") } });
  }
  await seed.close();
  const { app, page, errors } = await boot();
  try {
    const rich = page.locator(".document-editor:not([hidden]) .rich-document");
    await expect(rich.getByRole("heading", { name: "Album", exact: true })).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
    await page.evaluate(() => { performance.clearMarks("omarkie:glass-toggle"); performance.clearMarks("omarkie:glass-ready"); });
    await rich.click({ position: { x: 4, y: 4 } });
    const started = Date.now();
    await page.keyboard.press("g");
    await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
    await page.waitForFunction(() => performance.getEntriesByName("omarkie:glass-ready").length > 0, null, { timeout: 20_000 });
    const elapsed = Date.now() - started;
    // Fifty pictures exist; only the ones near the viewport hold DOM nodes.
    await expect.poll(() => page.evaluate(() => Number(document.querySelector(".glass-layer")?.dataset.glassTotal ?? 0))).toBeGreaterThanOrEqual(50);
    const mounted = await page.locator(".glass-image").count();
    assert.ok(mounted > 0 && mounted < 50, `fifty pictures mount a viewport window, not all fifty (${mounted})`);
    assert.ok(elapsed < 2_500, `glass opened in ${elapsed} ms with fifty pictures`);
    assert.equal(errors.length, 0, errors.join("\n"));
    await shoot(page, app, 1440, "light", "fifty");
  } finally { await app.close(); }
}

console.log(`glass images desktop: ok (screens in ${shots})`);
