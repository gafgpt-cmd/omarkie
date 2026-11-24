import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "playwright/test";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-sheets-"));
const vault = path.join(home, "vault"), file = path.join(vault, "practice.md");
const first = "Recall the answer before looking it up.";
const second = "Leave a day before your next review.";
const third = "A good question asks for one idea, not a list.";
const source = `# Retrieval practice\r\n\r\n${first}\r\n\r\n${second}\r\n\r\n${third}\r\n`;
await mkdir(vault);
await writeFile(file, source, "utf8");
const record = { id: "fixture", path: file, name: "practice.md", content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\r\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const qa = process.env.OMARKIE_QA_DIR;
const app = await electron.launch({ args: [process.cwd(), ...headlessArguments], env });
try {
  const page = await app.firstWindow(), requests = [], errors = [];
  page.on("request", request => requests.push(request.url()));
  page.on("pageerror", error => errors.push(error.message));
  const toggle = page.getByRole("button", { name: "Learning mode", exact: true });
  const sheets = page.getByRole("complementary", { name: "Sheets", exact: true });
  const sheetChips = page.getByRole("group", { name: "Sheets", exact: true });
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  const tray = page.getByRole("complementary", { name: "Loose scraps", exact: true });
  const journal = path.join(vault, ".omarkie", "store.jsonl");
  const actions = page.getByRole("group", { name: "Selection actions", exact: true });
  const saveCopy = sheets.getByRole("button", { name: "Export notes and cards", exact: true });
  const scrap = name => page.getByRole("article", { name, exact: true });
  const tab = name => page.getByRole("button", { name: `Fold or unfold: ${name}`, exact: true });
  const key = name => page.getByRole("button", { name, exact: true });
  async function resize(width) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
  }
  async function select(text) {
    await rich.getByText(text, { exact: true }).selectText();
    await page.keyboard.press("Alt+Enter");
    await expect(actions).toBeVisible();
  }
  async function note(text, body) {
    await select(text);
    await actions.getByRole("button", { name: "Note", exact: true }).click();
    await actions.getByRole("textbox", { name: "Note", exact: true }).fill(body);
    await actions.getByRole("button", { name: "Pin note", exact: true }).click();
    await expect(scrap(body)).toBeVisible();
  }
  async function capture(name) {
    if (qa) await page.screenshot({ path: path.join(qa, `learning-${name}.png`) });
  }
  await resize(1440);
  await page.reload();
  await expect(rich.getByRole("heading", { name: "Retrieval practice", exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  assert.ok(!requests.some(url => /LearningMode-|PayloadPanel-|Flashcards-/.test(url)));
  await assert.rejects(stat(path.dirname(journal)), { code: "ENOENT" });
  if (process.platform === "linux") {
    await key("Display").click();
    await page.getByRole("menuitemcheckbox", { name: "Learning mode", exact: true }).click();
  } else await toggle.click();
  await expect(sheets).toBeVisible();
  await expect(rich).toHaveAttribute("contenteditable", "false");
  await expect(key("Payload")).toHaveCount(0);
  await assert.rejects(stat(path.dirname(journal)), { code: "ENOENT" });
  if (qa) {
    await page.keyboard.press("ControlOrMeta+,");
    const preferences = page.getByRole("dialog", { name: "Preferences", exact: true });
    await preferences.getByRole("combobox", { name: "Theme", exact: true }).selectOption("omarchy-dark");
    await preferences.getByRole("button", { name: "Done", exact: true }).click();
  }
  const one = "Active recall", two = "Spacing", three = "Single idea";
  await note(first, one);
  await note(second, two);
  await note(third, three);
  await select(third);
  await actions.getByRole("button", { name: "Highlight: amber", exact: true }).click();
  await expect.poll(() => page.evaluate(() => CSS.highlights.get("study-amber")?.size)).toBe(1);
  await tab(one).click();
  await expect(tab(one)).toHaveAttribute("aria-expanded", "false");
  await expect(scrap(one)).toHaveCount(0);
  await tab(one).press("Enter");
  await expect(scrap(one)).toBeVisible();
  await scrap(one).getByRole("button", { name: "Move", exact: true }).click();
  await rich.getByText(second, { exact: true }).click();
  await expect(scrap(one).getByText(second, { exact: true })).toBeVisible();
  await scrap(two).getByRole("button", { name: "Move", exact: true }).click();
  await scrap(one).getByRole("button", { name: "Stack here", exact: true }).click();
  await expect(scrap(one).getByRole("article", { name: two, exact: true })).toBeVisible();
  const nested = scrap(one).getByRole("article", { name: two, exact: true });
  await nested.getByRole("button", { name: "Peel off", exact: true }).click();
  await expect(scrap(two)).toHaveCount(0);
  await sheets.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(nested).toBeVisible();
  await scrap(three).getByRole("button", { name: "Move", exact: true }).click();
  await tray.getByRole("button", { name: "Move to tray", exact: true }).click();
  await expect(tray.getByRole("article", { name: three, exact: true })).toBeVisible();
  const order = await Promise.all([sheets, rich, tray].map(locator => locator.boundingBox()));
  assert.ok(order[0].x + order[0].width < order[1].x + 1 && order[1].x + order[1].width <= order[2].x);
  if (qa) await capture("1440");
  await key("Peek").focus();
  await page.keyboard.down("Space");
  await expect(tab(one)).toHaveCount(0);
  assert.equal(await page.evaluate(() => CSS.highlights.has("study-amber")), false);
  await page.keyboard.up("Space");
  await expect(tab(one)).toBeVisible();
  await key("Notes").click();
  await expect(tab(one)).toHaveCount(0);
  await key("Notes").click();
  await expect(tab(one)).toBeVisible();
  await resize(720);
  await expect(sheets).toBeHidden();
  await expect(sheetChips.getByRole("button", { name: "Notes", pressed: true, exact: true })).toBeVisible();
  const [chips, pageBox] = await Promise.all([sheetChips.boundingBox(), rich.boundingBox()]);
  assert.ok(chips.y + chips.height <= pageBox.y && chips.width > 600);
  if (qa) await capture("720");
  await resize(1440);
  const output = path.join(home, "export.md");
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
  await saveCopy.click();
  await expect.poll(() => readFile(output, "utf8").catch(() => "")).toContain(one);
  await expect.poll(() => readFile(output, "utf8").catch(() => "")).toContain(three);
  await page.reload();
  await expect(sheets).toBeVisible();
  await expect(nested).toBeVisible();
  await expect(tray).toContainText(three);
  assert.equal(await readFile(file, "utf8"), source);
  const rows = (await readFile(journal, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(rows.some(row => row.entry.type === "mark" && row.entry.document === "practice.md" && row.entry.anchor.hash.length === 64));
  assert.ok(rows.some(row => row.entry.type === "sheet" && row.entry.id === "notes"));
  await page.keyboard.press("ControlOrMeta+Shift+Y");
  await expect(sheets).toHaveCount(0);
  await expect(rich).toHaveAttribute("contenteditable", "true");
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.filter(url => /^(https?|wss?):/i.test(url)), []);
  console.log("PASS: Learning mode, notes, visual highlights, fold, move, stack, peel, undo, peek, half tile, restart, unchanged Markdown");
} finally { await app.close(); }
