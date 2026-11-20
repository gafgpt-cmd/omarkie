import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "playwright/test";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-reading-layers-"));
const vault = path.join(home, "vault"), file = path.join(vault, "reading.md"), sidecar = path.join(vault, ".omarkie");
const body = "This paragraph uses distinct words to preserve its identity through small spelling edits.";
const original = `# Reading\r\n\r\n## Section\r\n\r\n${body}\r\n\r\n![Remote sample](https://example.invalid/remote.png)\r\n\r\n![Local sample](figure.svg)\r\n`;
await mkdir(vault);
await writeFile(file, original, "utf8");
await writeFile(path.join(vault, "figure.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="32"><rect width="48" height="32" fill="teal"/></svg>', "utf8");
const record = { id: "fixture", path: file, name: "reading.md", content: original, savedContent: original, diskHash: createHash("sha256").update(original).digest("hex"), lineEnding: "\r\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const errors = [], requested = [];
async function launch() {
  app = await electron.launch({ args: [process.cwd(), ...headlessArguments], env });
  page = await app.firstWindow();
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => requested.push(request.url()));
  await expect(page.locator(".document-editor:not([hidden]) h1")).toHaveText("Reading");
}
async function openRail() {
  await page.getByRole("button", { name: "Reading Layers", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Reading Layers", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Margin notes", exact: true })).toBeVisible();
}
async function selectWords(locator, text) {
  const { x, y, end } = await locator.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, index = node.textContent.indexOf(text);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index); range.setEnd(node, index + text.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2, end: rect.right - 1 };
    }
    throw new Error(`Selection text not found: ${text}`);
  }, text);
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(end, y, { steps: 8 }); await page.mouse.up();
  const popover = page.getByRole("dialog", { name: "Selection actions", exact: true });
  await expect(popover).toBeVisible();
  return popover;
}
try {
  await launch();
  requested.length = 0;
  await page.reload();
  await expect(page.locator(".document-editor:not([hidden]) h1")).toHaveText("Reading");
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  assert.ok(!requested.some(url => /\/(?:ReadingLayers|MarginNotes)-/.test(url)));
  await assert.rejects(stat(sidecar), { code: "ENOENT" });
  await page.keyboard.press("ControlOrMeta+/");
  const source = page.locator(".document-editor:not([hidden]) .source-surface:not([hidden]) .cm-content");
  await expect(source).toBeVisible();
  await openRail();
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  await expect(rich).toBeVisible();
  await expect(rich).toHaveAttribute("contenteditable", "false");
  const rail = page.getByRole("complementary", { name: "Reading Layers", exact: true });
  const canvas = rail.locator("li").last();
  await expect(canvas).toContainText("L0Source");
  await expect(canvas.getByRole("button")).toHaveCount(0);
  await expect(rail.locator('[data-active="true"]')).toContainText("Margin notes");

  await page.keyboard.press("ControlOrMeta+,");
  const preferences = page.getByRole("dialog", { name: "Preferences", exact: true });
  const remote = preferences.getByRole("checkbox", { name: "Show remote images", exact: true });
  await remote.check();
  await expect(rich.locator(".remote-image")).toContainText("Remote sample");
  await expect(rich.getByRole("img", { name: "Remote sample", exact: true })).toHaveCount(0);
  await remote.uncheck();
  await preferences.getByRole("button", { name: "Done", exact: true }).click();

  const popover = await selectWords(rich.locator("p").filter({ hasText: body }), "distinct words");
  await expect(popover.getByRole("button")).toHaveCount(3);
  await page.keyboard.press("Alt+Enter");
  await expect(popover.getByRole("button", { name: "Note to self", exact: true })).toBeFocused();
  await popover.getByRole("button", { name: "Note to self", exact: true }).click();
  await popover.getByRole("textbox", { name: "Note to self", exact: true }).fill("A durable margin note");
  await popover.getByRole("button", { name: "Pin note", exact: true }).click();
  const margin = page.getByRole("complementary", { name: "Margin notes", exact: true });
  await expect(margin.getByRole("button", { name: /Reading.*Section.*distinct words/ })).toBeVisible();
  await expect(margin).toContainText("A durable margin note");
  assert.equal(await readFile(file, "utf8"), original);
  const log = path.join(sidecar, "store.jsonl");
  const { entry } = JSON.parse(await readFile(log, "utf8"));
  assert.equal(entry.document, "reading.md");
  assert.deepEqual(entry.anchor.headings, ["Reading", "Section"]);

  await rail.getByRole("button", { name: "Hide Margin notes", exact: true }).click();
  await expect(margin).toHaveCount(0);
  await rail.getByRole("button", { name: "Show Margin notes", exact: true }).click();
  await expect(margin).toContainText("A durable margin note");
  await rail.getByRole("button", { name: "Hide Visual", exact: true }).click();
  await expect(source).toBeVisible();
  const sourcePopup = await selectWords(source.getByText(body, { exact: true }), "distinct words");
  await sourcePopup.getByRole("button", { name: "Note to self", exact: true }).click();
  await sourcePopup.getByRole("textbox").fill("Source selection note");
  await sourcePopup.getByRole("button", { name: "Pin note", exact: true }).click();
  await expect(margin).toContainText("Source selection note");
  await rail.getByRole("button", { name: "Show Visual", exact: true }).click();
  await expect(rich).toBeVisible();

  const output = path.join(home, "export.md");
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
  await margin.getByRole("button", { name: "Export notes and cards", exact: true }).click();
  await expect.poll(() => readFile(output, "utf8").catch(() => "")).toContain("A durable margin note");
  assert.equal(await readFile(file, "utf8"), original);
  if (process.env.OMARKIE_QA_DIR) {
    await mkdir(process.env.OMARKIE_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.OMARKIE_QA_DIR, "reading-layers.png") });
  }
  await rich.getByRole("img", { name: "Local sample", exact: true }).click();
  await popover.getByRole("button", { name: "Note to self", exact: true }).click();
  await popover.getByRole("button", { name: "Cancel", exact: true }).click();
  await rail.getByRole("button", { name: "Close Reading Layers", exact: true }).click();
  await expect(source).toHaveAttribute("contenteditable", "true");

  await app.close();
  await writeFile(file, original.replace(body, `An inserted paragraph.\r\n\r\n${body.replace("spelling", "speling")}`), "utf8");
  await launch(); await openRail();
  await expect(page.locator(".layers-note button.layers-reference")).toHaveCount(2);
  await app.close();
  await writeFile(file, "# Reading\r\n\r\n## Section\r\n\r\nNo matching block.\r\n", "utf8");
  await launch(); await openRail();
  await expect(page.locator(".layers-orphans")).toContainText("Orphaned notes (2)");
  await expect(page.locator(".layers-orphans")).toContainText("Source selection note");
  assert.deepEqual(errors, []);
  assert.deepEqual(requested.filter(url => /^(https?|wss?):/i.test(url)), []);
  console.log("PASS: lazy Reading Layers, rich/source selection, lossless local notes, export, reattachment and orphans");
} finally { await app?.close().catch(() => {}); }
