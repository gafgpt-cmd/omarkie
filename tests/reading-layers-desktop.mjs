import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "playwright/test";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-reading-layers-"));
const vault = path.join(home, "vault"), file = path.join(vault, "reading.md"), sidecar = path.join(vault, ".omarkie");
const body = "This paragraph uses distinct words to preserve its identity through small spelling edits.";
let sends = 0, cssRequests = 0;
const server = createServer((request, response) => {
  if (request.url === "/css-image") cssRequests++; else sends++;
  response.writeHead(500).end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const original = `# Reading\r\n\r\n## Section\r\n\r\n${body}\r\n\r\n## Retrieval practice\r\n\r\n==Recall before looking up the answer.== Use a question that makes you retrieve one idea, not recognize a phrase.\r\n\r\nReview after a delay and make a new card only when the idea still needs practice.\r\n\r\n![Remote sample](https://example.invalid/remote.png)\r\n\r\n![Local sample](figure.svg)\r\n\r\n<div style='background-image: image-set("${origin}/css-image" 1x)'>Offline style fixture</div>\r\n`;
await mkdir(vault);
await writeFile(file, original, "utf8");
await writeFile(path.join(vault, "figure.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="32"><rect width="48" height="32" fill="teal"/></svg>', "utf8");
const record = { id: "fixture", path: file, name: "reading.md", content: original, savedContent: original, diskHash: createHash("sha256").update(original).digest("hex"), lineEnding: "\r\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const qa = process.env.OMARKIE_QA_DIR;
let app, page;
const errors = [], requested = [];
async function launch() {
  app = await electron.launch({ args: [process.cwd(), ...headlessArguments], env });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1440, 900]);
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => requested.push(request.url()));
  await expect(page.locator(".document-editor:not([hidden]) h1")).toHaveText("Reading");
}
async function openRail() {
  await page.getByRole("button", { name: "Reading Layers", exact: true }).click();
  await expectRail(true);
}
async function expectRail(open) {
  const rail = page.getByRole("complementary", { name: "Reading Layers", exact: true });
  const toggle = page.getByRole("button", { name: "Reading Layers", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", String(open));
  if (open) {
    await expect(rail).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Margin notes", exact: true })).toBeVisible();
  } else await expect(rail).toHaveCount(0);
}
async function bounds(element) {
  await expect(element).toBeVisible();
  const rect = await element.boundingBox();
  assert.ok(rect, "A visible layout surface must have bounds");
  return rect;
}
async function selectFolder(folder) {
  await app.evaluate(({ BrowserWindow, dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    BrowserWindow.getAllWindows()[0].webContents.send("app:command", { action: "folder" });
  }, folder);
}
async function capture(name) {
  if (qa) await page.screenshot({ path: path.join(qa, `reading-layers${name ? `-${name}` : ""}.png`) });
}
async function expectDiskText(text) {
  const paragraph = page.locator(".rich-document").getByText(text, { exact: true });
  const reload = page.getByRole("alert").getByRole("button", { name: "Reload", exact: true });
  await expect(paragraph.or(reload).first()).toBeVisible();
  if (await reload.isVisible()) await reload.click();
  await expect(paragraph).toBeVisible();
}
async function selectWords(locator, text) {
  await locator.click();
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
  if (qa) await mkdir(qa, { recursive: true });
  await launch();
  await page.evaluate(() => localStorage.setItem("omarkie-autosave", "false"));
  requested.length = 0;
  await page.reload();
  await expect(page.locator(".document-editor:not([hidden]) h1")).toHaveText("Reading");
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  assert.ok(!requested.some(url => /\/(?:ReadingLayers|MarginNotes|CleanLayer|Flashcards|PayloadPanel)-/.test(url)));
  await assert.rejects(stat(sidecar), { code: "ENOENT" });
  await page.keyboard.press("ControlOrMeta+/");
  const source = page.locator(".document-editor:not([hidden]) .source-surface:not([hidden]) .cm-content");
  await expect(source).toBeVisible();
  if (process.platform === "linux") {
    await page.getByRole("button", { name: "Display", exact: true }).click();
    const menuToggle = page.getByRole("menuitemcheckbox", { name: "Reading Layers", exact: true });
    await expect(menuToggle).toHaveAttribute("aria-checked", "false");
    await menuToggle.click();
    await expectRail(true);
  } else await openRail();
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  await expect(rich).toBeVisible();
  await expect(rich).toHaveAttribute("contenteditable", "false");
  const rail = page.getByRole("complementary", { name: "Reading Layers", exact: true });
  const margin = page.getByRole("complementary", { name: "Margin notes", exact: true });
  const [left, center, right] = await Promise.all([bounds(rail), bounds(page.locator(".document-editor:not([hidden])")), bounds(margin)]);
  assert.ok(left.x + left.width <= center.x && center.x + center.width <= right.x, "Desktop order must be Layers → document → notes");
  assert.ok(right.y - center.y < 48, "Notes must start alongside the document, not below it");
  await expect(page.locator(".sidebar")).toBeHidden();
  const canvas = rail.locator("li").last();
  await expect(canvas).toContainText("L0Source");
  const rowBounds = await Promise.all((await rail.locator("li").all()).map(bounds));
  assert.equal(rowBounds.length, 6);
  assert.ok(rowBounds.every((row, index) => !index || rowBounds[index - 1].y + rowBounds[index - 1].height <= row.y), "Each layer must have its own vertical row");
  await expect(canvas.getByRole("button")).toHaveCount(0);
  await expect(rail.locator('[data-active="true"]')).toContainText("Margin notes");
  const clean = page.getByRole("region", { name: "Clean layer preview", exact: true });
  await rail.getByRole("button", { name: "Show Clean", exact: true }).click();
  await clean.getByRole("button", { name: "Bake into source", exact: true }).click();
  await expect(clean).toBeHidden();
  await rail.getByRole("button", { name: "Close Reading Layers", exact: true }).click();
  await expect(source.locator(".cm-line").nth(1)).toHaveText('"type": "Reference"');
  await source.press("ControlOrMeta+z");
  await expect(source.locator(".cm-line").first()).toHaveText("# Reading");
  assert.equal(await readFile(file, "utf8"), original);
  await expectRail(false);
  await page.keyboard.press("ControlOrMeta+Shift+Y");
  await expectRail(true);
  await page.reload();
  await expectRail(true);

  await page.keyboard.press("ControlOrMeta+,");
  const preferences = page.getByRole("dialog", { name: "Preferences", exact: true });
  const remote = preferences.getByRole("checkbox", { name: "Show remote images", exact: true });
  await remote.check();
  await expect(rich.locator(".remote-image")).toContainText("Remote sample");
  await expect(rich.getByRole("img", { name: "Remote sample", exact: true })).toHaveCount(0);
  await remote.uncheck();
  await preferences.getByLabel("Enable Payload").check();
  await preferences.getByLabel("Payload model").fill("offline-fixture");
  await preferences.getByLabel("Payload base URL").fill(`${origin}/v1`);
  if (qa) await preferences.getByRole("combobox", { name: "Theme", exact: true }).selectOption("omarchy-dark");
  await preferences.getByRole("button", { name: "Done", exact: true }).click();

  const popover = await selectWords(rich.locator("p").filter({ hasText: body }), "distinct words");
  await expect(popover.getByRole("button")).toHaveCount(3);
  await page.keyboard.press("Alt+Enter");
  await expect(popover.getByRole("button", { name: "Note to self", exact: true })).toBeFocused();
  await capture("selection");
  await popover.getByRole("button", { name: "Note to self", exact: true }).click();
  await popover.getByRole("textbox", { name: "Note to self", exact: true }).fill("A durable margin note");
  await popover.getByRole("button", { name: "Pin note", exact: true }).click();
  await expect(margin.getByRole("button", { name: /Reading.*Section.*distinct words/ })).toBeVisible();
  await expect(margin).toContainText("A durable margin note");
  await capture("");
  assert.equal(await readFile(file, "utf8"), original);
  const log = path.join(sidecar, "store.jsonl");
  const { entry } = JSON.parse(await readFile(log, "utf8"));
  assert.equal(entry.document, "reading.md");
  assert.deepEqual(entry.anchor.headings, ["Reading", "Section"]);

  const payload = page.getByRole("complementary", { name: "Payload", exact: true });
  await rail.getByRole("button", { name: "Show Ask / Summary", exact: true }).click();
  await expect(payload.getByRole("button", { name: "Send text for summary", exact: true })).toBeEnabled();
  await expect(payload.getByRole("textbox", { name: "Ask one question about this text", exact: true })).toBeVisible();
  assert.ok((await bounds(payload)).x >= center.x + center.width, "Payload must be right of the document");
  await capture("payload");
  await rail.getByRole("button", { name: "Hide Ask / Summary", exact: true }).click();
  await expect(payload).toHaveCount(0);
  const paragraph = rich.locator("p").filter({ hasText: body });
  await selectWords(paragraph, "distinct words");
  await popover.getByRole("button", { name: "Ask about it", exact: true }).click();
  await expect(payload).toContainText(`Sends the selected text to ${origin}.`);
  await expect(payload.getByRole("button", { name: "Send question", exact: true })).toBeDisabled();
  await expect(payload.getByRole("button", { name: "Send text for summary", exact: true })).toHaveCount(0);
  await payload.getByRole("button", { name: "Close Payload", exact: true }).click();
  assert.equal(sends, 0);
  assert.equal(JSON.parse(await readFile(log, "utf8")).entry.type, "note");

  await selectWords(paragraph, "distinct words");
  await popover.getByRole("button", { name: "Make it a card", exact: true }).click();
  const cards = page.getByRole("complementary", { name: "Study cards", exact: true });
  await expect(cards.getByRole("textbox", { name: "Answer", exact: true })).toHaveValue(entry.anchor.quote);
  assert.ok((await bounds(cards)).x >= center.x + center.width, "Cards must be right of the document");
  await capture("cards");
  await cards.getByRole("button", { name: "Save selected cards", exact: true }).click();
  await expect(cards).toContainText("Cards in this note: 1 / 10");
  await rail.getByRole("button", { name: "Hide Cards", exact: true }).click();
  await expect(cards).toHaveCount(0);
  const saved = (await readFile(log, "utf8")).trim().split("\n").map(row => JSON.parse(row).entry);
  assert.deepEqual(saved.map(item => item.type), ["note", "card"]);
  assert.equal(saved[1].anchor.hash, saved[0].anchor.hash);
  assert.equal(saved[1].anchor.quote, saved[0].anchor.quote);

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
  assert.match(await readFile(output, "utf8"), /\[\u2026\][\s\S]*distinct words/);
  assert.equal(await readFile(file, "utf8"), original);
  await rich.getByRole("img", { name: "Local sample", exact: true }).click();
  await popover.getByRole("button", { name: "Note to self", exact: true }).click();
  await popover.getByRole("button", { name: "Cancel", exact: true }).click();
  await rail.getByRole("button", { name: "Close Reading Layers", exact: true }).click();
  await expect(rich).toHaveAttribute("contenteditable", "true");
  await expectRail(false);
  await page.reload();
  await expectRail(false);
  await openRail();
  const otherVault = path.join(home, "other-vault");
  await mkdir(otherVault);
  await selectFolder(otherVault);
  await expectRail(false);
  await selectFolder(vault);
  await expectRail(true);

  await app.close();
  await writeFile(file, original.replace(body, `An inserted paragraph.\r\n\r\n${body.replace("spelling", "speling")}`), "utf8");
  await launch(); await expectRail(true);
  await expectDiskText(body.replace("spelling", "speling"));
  await expect(page.locator(".layers-note button.layers-reference")).toHaveCount(2);
  await app.close();
  await writeFile(file, "# Reading\r\n\r\n## Section\r\n\r\nNo matching block.\r\n", "utf8");
  await launch(); await expectRail(true);
  await expectDiskText("No matching block.");
  await expect(page.locator(".layers-orphans")).toContainText("Orphaned notes (2)");
  await expect(page.locator(".layers-orphans")).toContainText("Source selection note");
  assert.deepEqual(errors, []);
  assert.deepEqual(requested.filter(url => /^(https?|wss?):/i.test(url)), []);
  assert.equal(cssRequests, 0);
  assert.equal(sends, 0);
  console.log("PASS: three columns, Display/toolbar/shortcut, vault persistence, selection actions, lazy layers, persisted anchors, Markdown export and orphan tray");
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
