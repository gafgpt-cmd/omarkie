import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createTranslator } from "../shared/i18n.mjs";
import { fullSize, headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// Synthetic handout: accents, math, a remote image that must stay unloaded, and a local
// 1200 px image of 2 px red/blue columns shown at 600 CSS px: only its original pixels keep pure columns at 2x.
const content = [
  "# Anestesia regional: técnica básica",
  "",
  "Línea de prueba con acentos: àèéíòóúüñç, «comillas» y ŝ.",
  "",
  "$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$",
  "",
  "![Stripes](stripes.png){width=600}",
  "",
  "![Remote](https://example.test/remote.png)",
  "",
  "| Fase | Duración |",
  "|---|---|",
  "| Inicio | 10 min |",
  "",
].join("\n");
const long = Array.from({ length: 2500 }, (_, index) => `Paragraph ${index + 1} of a synthetic long note.`).join("\n\n") + "\n";
function png(width, height, color) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(color(x), 1 + x * 3);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(height).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}
const qa = process.env.OMARKIE_QA_DIR || path.join(os.tmpdir(), "omarkie-image-qa"), passed = [];
await mkdir(qa, { recursive: true });
const pass = message => { passed.push(message); console.log("PASS", message); };
const record = (id, name, file, text) => ({ id, path: file, name, content: text, savedContent: text, diskHash: createHash("sha256").update(text).digest("hex"), bom: false, lineEnding: "\n" });

async function run(language) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), `omarkie-image-${language}-`))), file = path.join(directory, "handout.md"), longFile = path.join(directory, "long.md");
  await writeFile(file, content); await writeFile(longFile, long);
  await writeFile(path.join(directory, "stripes.png"), png(1200, 120, x => Math.floor(x / 2) % 2 ? [0, 0, 255] : [255, 0, 0]));
  await writeFile(path.join(directory, "session.json"), JSON.stringify({ version: 1, folder: directory, activeId: "handout", documents: [record("handout", "handout.md", file, content), record("long", "long.md", longFile, long)] }));
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: directory, OMARKIE_LANGUAGE: language }); delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL;
  const application = await electron.launch({ args: [process.cwd(), ...headlessArguments], env }), page = await application.firstWindow(), errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => requests.push(request.url()));
  // Every request any export window makes, allowed or blocked.
  await application.evaluate(({ app }) => {
    globalThis.exportRequests = [];
    app.on("web-contents-created", (_, contents) => {
      const note = details => globalThis.exportRequests.push(details.url);
      contents.session.webRequest.onCompleted(note); contents.session.webRequest.onErrorOccurred(note);
    });
  });
  const t = createTranslator(language);
  await fullSize(application, page);
  const rich = page.locator(".document-editor:not([hidden]) .rich-document"), toast = page.locator(".toast");
  const written = target => expect.poll(() => readFile(target).then(bytes => bytes.length, () => 0), { timeout: 60_000 }).toBeGreaterThan(100);
  const save = target => application.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => target ? { canceled: false, filePath: target } : { canceled: true }; }, target);
  // Keyboard path: menu command, then the dialog's selects and Export button by keys only.
  async function exportImage({ selection = false, scale, light }) {
    await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("image-export").click());
    const dialog = page.getByRole("dialog", { name: t("Export image") });
    await expect(dialog).toBeVisible();
    const content = dialog.getByLabel(t("Content"), { exact: true }), size = dialog.getByLabel(t("Scale"), { exact: true }), theme = dialog.getByLabel(t("主题"), { exact: true });
    await expect(content).toBeFocused();
    if (selection) await page.keyboard.press("ArrowDown");
    await expect(content).toHaveValue(selection ? "selection" : "note");
    await page.keyboard.press("Tab"); await expect(size).toBeFocused();
    await page.keyboard.press(scale === 1 ? "ArrowUp" : "ArrowDown"); await expect(size).toHaveValue(String(scale));
    await page.keyboard.press("Tab"); await expect(theme).toBeFocused();
    if (light) await page.keyboard.press("ArrowDown");
    await expect(theme).toHaveValue(light ? "light" : "active");
    const app = await page.locator("html").getAttribute("data-appearance");
    await page.screenshot({ path: path.join(qa, `image-${language}-dialog-app-${app}-${light ? "plain-white" : "current"}.png`) });
    await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: t("导出"), exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
  }
  const inspect = target => application.evaluate(({ nativeImage }, target) => {
    const image = nativeImage.createFromPath(target), { width, height } = image.getSize(), bitmap = image.toBitmap();
    const pixel = (x, y) => { const at = (y * width + x) * 4; return [bitmap[at + 2], bitmap[at + 1], bitmap[at]]; };
    let red = 0, blue = 0, stripeRow = -1;
    for (let y = 0; y < height && stripeRow < 0; y += 2) { const [r, g, b] = pixel(Math.floor(width / 2), y); if (r > 200 && g < 40 && b < 40) stripeRow = y + 4; }
    if (stripeRow >= 0) for (let x = 0; x < width; x++) { const [r, g, b] = pixel(x, stripeRow); if (r > 230 && g < 25 && b < 25) red++; if (b > 230 && r < 25 && g < 25) blue++; }
    return { width, height, corner: pixel(2, 2), red, blue };
  }, target);
  try {
    await expect(rich).toBeVisible({ timeout: 30_000 });
    await expect(rich.locator("img[alt='Stripes']")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("data-appearance", "light");
    const pngs = async () => (await readdir(directory)).filter(name => name.endsWith(".png")), before = await pngs();
    await save(null); await exportImage({ scale: 1, light: false });
    await page.waitForTimeout(1000);
    assert.deepEqual(await pngs(), before);
    pass(`${language}: cancel writes nothing`);

    await page.evaluate(() => localStorage.setItem("omarkie-theme", "dark")); await page.reload();
    await expect(rich.locator("img[alt='Stripes']")).toBeVisible({ timeout: 30_000 }); await fullSize(application, page);

    const dark = path.join(directory, "dark-1x.png");
    await save(dark); await exportImage({ scale: 1, light: false });
    await written(dark); await expect(toast).toContainText(t("{{format}} 已导出。", { format: "PNG" }));
    const one = await inspect(dark);
    assert.equal(one.width, 800); assert.ok(one.height > 300 && one.height < 2000, `1x height ${one.height}`);
    assert.ok(Math.max(...one.corner) < 90, `active dark theme paper ${one.corner}`);
    pass(`${language}: 1x active theme PNG ${one.width}x${one.height}, dark paper`);

    const light = path.join(directory, "light-2x.png");
    await save(light); await exportImage({ scale: 2, light: true });
    await written(light); await expect(toast).toContainText(t("{{format}} 已导出。", { format: "PNG" }));
    const two = await inspect(light);
    assert.equal(two.width, 1600); assert.ok(Math.abs(two.height - 2 * one.height) <= 4, `2x height ${two.height} vs ${one.height}`);
    assert.ok(Math.min(...two.corner) > 240, `light paper ${two.corner}`);
    assert.ok(two.red > 500 && two.blue > 500, `original stripes stay sharp at 2x: red ${two.red}, blue ${two.blue}`);
    pass(`${language}: 2x light PNG ${two.width}x${two.height}; image kept at original resolution`);

    // Selection: the heading line only.
    await rich.locator("h1").click(); await page.keyboard.press("Home"); await page.keyboard.press("Shift+End");
    const part = path.join(directory, "selection.png");
    await save(part); await exportImage({ selection: true, scale: 1, light: true });
    await written(part); await expect(toast).toContainText(t("{{format}} 已导出。", { format: "PNG" }));
    const selected = await inspect(part);
    assert.equal(selected.width, 800); assert.ok(selected.height < one.height / 2, `selection height ${selected.height}`);
    pass(`${language}: selected lines export a shorter PNG (${selected.height}px)`);

    await page.getByText("long.md", { exact: true }).first().click();
    await expect(rich.getByText("Paragraph 1 of a synthetic long note.", { exact: true })).toBeVisible({ timeout: 30_000 });
    const refused = path.join(directory, "long.png");
    await save(refused); await exportImage({ scale: 2, light: true });
    await expect(toast).toContainText(t("This note is too long for one image. Export PDF instead, or select fewer lines."), { timeout: 60_000 });
    await assert.rejects(access(refused));
    pass(`${language}: long note refused with a PDF hint; nothing written`);

    await expect(page.locator(".dirty-dot")).toHaveCount(0);
    assert.equal(await readFile(file, "utf8"), content); assert.equal(await readFile(longFile, "utf8"), long);
    const remote = url => /^https?:/.test(url) && !url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost");
    assert.deepEqual(requests.filter(remote), []);
    assert.deepEqual((await application.evaluate(() => globalThis.exportRequests)).filter(remote), []);
    assert.deepEqual(errors, []);
    pass(`${language}: sources unchanged, no remote requests from the app or export windows`);
    for (const [from, to] of [[dark, `image-${language}-export-dark-1x.png`], [light, `image-${language}-export-light-2x.png`]]) await writeFile(path.join(qa, to), await readFile(from));
  } catch (error) {
    await page.screenshot({ path: path.join(qa, `image-${language}-failure.png`) }).catch(() => {});
    throw error;
  } finally { await application.close(); }
}

await run("en");
await run("es");
await writeFile(path.join(qa, "image-results.json"), JSON.stringify(passed, null, 2));
console.log(`Image export desktop: ${passed.length} checks passed; outputs in ${qa}`);
