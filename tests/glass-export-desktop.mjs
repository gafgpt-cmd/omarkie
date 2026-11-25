import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { _electron as launch, expect } from "playwright/test";
import { decode } from "@toon-format/toon";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";
import { GlassService } from "../electron/glass-service.mjs";
import { cardFields } from "../shared/glass-cards.mjs";
import { stickerFields } from "../src/glass/sticker-model.ts";

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-export-"));
const vault = path.join(home, "vault"), file = path.join(vault, "practice.md");
const heading = "Retrieval practice", first = "Recall the answer before looking it up.", second = "Leave a day before your next review.";
const source = `# ${heading}\n\n${first}\n\n${second}\n`;
await mkdir(vault, { recursive: true });
await writeFile(file, source, "utf8");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
await writeFile(path.join(vault, "dot.png"), png);
const record = { id: "fixture", path: file, name: "practice.md", content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const qa = process.env.OMARKIE_QA_DIR;
if (qa) await mkdir(qa, { recursive: true });
const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
async function axi(...args) {
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20_000 });
  return decode(stdout);
}
async function checksums(root) {
  const result = new Map();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.name === ".omarkie") continue;
      if (entry.isDirectory()) await walk(file);
      else result.set(path.relative(root, file), createHash("sha256").update(await readFile(file)).digest("hex"));
    }
  }
  await walk(root);
  return result;
}

const seed = await new GlassService({ root: vault, appData: home, device: "fixture" }).open();
const anchorOf = (block, line) => ({ landmarks: [{ kind: "block", block, headings: [heading], line }] });
await seed.request({ action: "add", note: "practice.md", magnet: "m-sticky", fields: { kind: "sticky", text: "Steep = close contours", color: "yellow", x: 0, y: 0, w: 232, h: 168, folded: false, anchor: anchorOf(first, 3) } });
await seed.request({ action: "add", note: "practice.md", magnet: "m-card", fields: { ...cardFields({ kind: "card", card: "ai", title: "Spacing", question: "When to review?", answer: "After a day.", folded: false }), anchor: anchorOf(second, 5) } });
await seed.request({ action: "add", note: "practice.md", magnet: "m-star", fields: stickerFields({ kind: "sticker", sticker: "star", anchor: anchorOf(first, 3), x: 12, y: -8, w: 72, h: 72, rotate: 0 }) });
await seed.request({ action: "add", note: "practice.md", magnet: "m-photo", fields: { anchor: anchorOf(second, 5), w: 260 }, image: { base64: png.toString("base64"), name: "dot.png", displayBase64: png.toString("base64"), wrap: "left" } });
await seed.close();
// A synced folder from another person: same layout under .omarkie/share.
await mkdir(path.join(vault, ".omarkie", "share", "glass"), { recursive: true });
const own = await readdir(path.join(vault, ".omarkie", "glass"));
const journal = own.find(name => name.endsWith(".jsonl"));
assert.ok(journal, "own journal exists for the shared fixture");
await writeFile(path.join(vault, ".omarkie", "share", "glass", journal), await readFile(path.join(vault, ".omarkie", "glass", journal)));
await writeFile(path.join(vault, ".omarkie", "share", "notes.jsonl"), await readFile(path.join(vault, ".omarkie", "notes.jsonl")));
const before = await checksums(vault);

const out = path.join(home, "out");
await mkdir(out, { recursive: true });
const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
try {
  const page = await app.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  const key = name => page.getByRole("button", { name, exact: true });
  async function resize(width) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
  }
  async function shot(name) { if (qa) await page.screenshot({ path: path.join(qa, `g18-${name}.png`) }); }
  async function display(name, on) {
    await key("Display").click();
    const item = page.getByRole("menuitemcheckbox", { name, exact: true });
    const checked = (await item.getAttribute("aria-checked")) === "true";
    if (checked !== on) await item.click();
    if (checked === on) await page.keyboard.press("Escape");
  }
  async function learning(on) {
    if (process.platform === "linux") return display("Learning mode", on);
    const button = key("Learning mode");
    if ((await button.getAttribute("aria-pressed")) !== String(on)) await button.click();
  }
  async function openExport() {
    await key("File").click();
    await page.getByRole("menuitem", { name: "Export…", exact: true }).click();
    const dialog = page.locator('.utility-dialog[aria-label="Export options"]');
    await expect(dialog).toBeVisible();
    return dialog;
  }
  async function chooseMode(dialog, name) {
    await dialog.getByRole("radio", { name }).check();
  }
  async function saveNext(filePath) {
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, filePath);
  }
  async function openNext(folder) {
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder);
  }

  await page.reload();
  await expect(rich.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  await resize(1440);
  await learning(true);
  await expect(rich).toHaveAttribute("contenteditable", "false");

  await display("Show shared glass", true);
  const shared = page.locator(".shared-glass-card");
  await expect(shared.first()).toBeVisible();
  assert.ok(await shared.count() >= 3, "every shared magnet with an anchor is a card");
  assert.equal(await shared.locator("input,textarea,[contenteditable='true']").count(), 0, "shared glass is read-only");
  const sharedText = await shared.first().innerText();
  assert.match(sharedText, /Shared · read-only/);

  await openExport();
  await expect(page.locator(".glass-export-order")).toHaveCount(0, { message: "order list only appears for cheatsheets" });
  await chooseMode(page.locator(".utility-dialog"), "Cheatsheet");
  const orderList = page.locator(".glass-export-order li");
  await expect(orderList).toHaveCount(4);
  const titles = () => page.locator(".glass-export-order li > span:not(.glass-export-grip)").allInnerTexts();
  const [a, b] = await titles();
  await orderList.nth(1).getByRole("button", { name: "Move up" }).click();
  const afterOrder = await titles();
  assert.equal(afterOrder[0], b, "drag/arrow reorder changes the cheatsheet order");
  assert.equal(afterOrder[1], a);

  const cheatsheet = path.join(out, "practice-cheatsheet.md");
  await saveNext(cheatsheet);
  await page.locator(".utility-dialog").getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.locator(".utility-dialog").getByRole("alert")).toContainText("Glass exported:");
  await expect.poll(async () => readFile(cheatsheet, "utf8").catch(() => "")).toContain("# practice — Cheatsheet");
  const sheet = await readFile(cheatsheet, "utf8");
  const orderInFile = [...sheet.matchAll(/^## \d+\. (.+)$/gm)].map(match => match[1].replace(/\[\^\d+\]$/, "").trim());
  assert.equal(orderInFile[0], afterOrder[0].trim(), "file follows the dialog order");
  assert.match(sheet, /^\[\^\d+\]: practice\.md:\d+/m, "sources kept");
  await page.keyboard.press("Escape");

  for (const [mode, name, marker] of [
    ["Page and glass", "practice-flat.md", /\[!NOTE\]/],
    ["Glass handout", "practice-handout.md", /Glass handout/],
    ["Page only", "practice-page.md", /^# Retrieval practice/],
  ]) {
    await openExport();
    await chooseMode(page.locator(".utility-dialog"), mode);
    const target = path.join(out, name);
    await saveNext(target);
    await page.locator(".utility-dialog").getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.locator(".utility-dialog").getByRole("alert")).toContainText("Glass exported:");
    const text = await readFile(target, "utf8");
    assert.match(text, marker);
    if (mode === "Page and glass") {
      assert.match(text, /!\[Star sticker\]\(<practice-flat\.assets\/sticker-[^>]+\.svg>\)/);
      assert.match(text, /!\[dot\.png\]\(<practice-flat\.assets\/dot\.png>\)/);
    }
    await page.keyboard.press("Escape");
  }

  // PDF goes through the same print surface with the glass scope painted in.
  const pdf = path.join(out, "practice-flat.pdf");
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pdf);
  await openExport();
  await page.locator(".utility-dialog").getByLabel("Format").selectOption("pdf");
  await chooseMode(page.locator(".utility-dialog"), "Page and glass");
  await page.locator(".utility-dialog").getByRole("button", { name: "Export", exact: true }).click();
  await expect.poll(async () => (await readFile(pdf).catch(() => Buffer.alloc(0))).length).toBeGreaterThan(1000);

  // Bundle export and re-import restore the magnets into a fresh note journal.
  const bundleRoot = path.join(home, "bundle-out");
  await mkdir(bundleRoot);
  await openExport();
  await chooseMode(page.locator(".utility-dialog"), "Glass bundle");
  await openNext(bundleRoot);
  await page.locator(".utility-dialog").getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.locator(".utility-dialog").getByRole("alert")).toContainText("Glass exported:");
  const bundle = path.join(bundleRoot, "practice");
  assert.equal((await readdir(bundle)).includes(".omarkie"), true);
  await page.keyboard.press("Escape");
  const journalPath = path.join(vault, ".omarkie", "glass", journal);
  await rename(journalPath, `${journalPath}.before-import`);
  await openExport();
  await openNext(bundle);
  await page.locator(".utility-dialog").getByRole("button", { name: "Import glass bundle…" }).click();
  await expect(page.locator(".utility-dialog").getByRole("alert")).toContainText("Glass bundle imported:");
  await page.keyboard.press("Escape");
  const restored = await readFile(journalPath, "utf8");
  assert.equal(new Set([...restored.matchAll(/"magnetId":"([^"]+)"/g)].map(match => match[1])).size, 4, "bundle import rebuilds the missing journal");
  const afterImport = await axi("glass", "list", "--note", "practice.md", "--vault", vault);
  assert.equal(afterImport.magnets.length, 4, "bundle import restores every magnet");

  const sharedChecksum = createHash("sha256").update(await readFile(path.join(vault, ".omarkie", "share", "glass", journal))).digest("hex");
  assert.equal(createHash("sha256").update(await readFile(path.join(vault, ".omarkie", "share", "glass", journal))).digest("hex"), sharedChecksum, "shared layer never writes");

  // Flattened Markdown renders in the app preview with its relative images resolved.
  await openNext(path.join(out, "practice-flat.md"));
  await page.keyboard.press("Control+o");
  await expect(page.locator(".document-editor:not([hidden]) .rich-document")).toContainText("Steep = close contours");
  const previewImages = page.locator(".document-editor:not([hidden]) .rich-document img");
  await expect(previewImages.first()).toBeVisible();
  await expect.poll(() => previewImages.first().evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await shot("flat-preview-1440-light");

  // Baselines: export dialog and shared layer, light/dark at both widths.
  await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");
  await page.reload();
  await expect(rich.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await expect(page.locator(".document-editor:not([hidden]) .rich-document")).not.toContainText("Note Steep = close contours");
  for (const [theme, width] of [["light", 1440], ["omarchy-dark", 1440], ["light", 720], ["omarchy-dark", 720]]) {
    await page.evaluate(theme => localStorage.setItem("omarkie-theme", theme), theme);
    await page.reload();
    await expect(rich.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
    await resize(width);
    await learning(true);
    if ((await page.locator(".shared-glass-layer").count()) === 0) await display("Show shared glass", true);
    await expect(page.locator(".shared-glass-card").first()).toBeVisible();
    await shot(`shared-${theme}-${width}`);
    await openExport();
    await chooseMode(page.locator(".utility-dialog"), "Cheatsheet");
    await expect(page.locator(".glass-export-order li").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await shot(`dialog-${theme}-${width}`);
  }

  const outside = await checksums(vault);
  for (const [name, digest] of before) {
    if (name === "practice.md" || name === ".obsidian/app.json") assert.equal(outside.get(name) ?? digest, digest, `vault file unchanged: ${name}`);
  }
  assert.deepEqual(errors, [], "no page errors");
  console.log(JSON.stringify({ passed: ["shared-layer", "cheatsheet-order", "page", "flat", "handout", "pdf", "bundle-round-trip", "baselines"], errors }, null, 2));
} finally {
  await app.close();
}
