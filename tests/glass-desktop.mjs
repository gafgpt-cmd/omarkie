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

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-"));
const vault = path.join(home, "vault"), file = path.join(vault, "practice.md");
const heading = "Retrieval practice", first = "Recall the answer before looking it up.", second = "Leave a day before your next review.", added = "glass guard text.";
const source = `# ${heading}\r\n\r\n${first}\r\n\r\n${second}\r\n`;
await mkdir(vault);
await writeFile(file, source, "utf8");
const record = { id: "fixture", path: file, name: "practice.md", content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\r\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const qa = process.env.OMARKIE_QA_DIR;
const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
async function axi(...args) {
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 15_000 });
  return decode(stdout);
}
const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
try {
  const page = await app.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("omarkie-glass-test", "1"));
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  const glass = page.locator(".glass-layer");
  const debug = page.locator('.glass-debug[data-glass-object="fixture"]');
  const key = name => page.getByRole("button", { name, exact: true });
  const sourceSurface = page.locator(".document-editor:not([hidden]) .cm-content");
  async function resize(width) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
  }
  async function blockBox(text) {
    return page.evaluate(text => {
      const block = [...document.querySelectorAll(".rich-document > [data-cid]")].find(node => node.textContent?.trim() === text);
      if (!block) return null;
      const rect = block.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    }, text);
  }
  async function pinnedTo(text) {
    await expect(debug).toHaveAttribute("data-glass-status", "resolved");
    await expect.poll(async () => {
      const [box, block] = await Promise.all([debug.boundingBox(), blockBox(text)]);
      if (!box || !block) return "missing";
      return Math.abs(box.y - block.y) > 2 || Math.abs(box.x - block.x) > 2 || Math.abs(box.width - block.width) > 2 ? JSON.stringify([box, block]) : "pinned";
    }).toBe("pinned");
  }
  async function noExtraScrollbars() {
    await expect.poll(() => rich.evaluate(page => {
      const scroller = page.parentElement;
      return [scroller.scrollWidth - scroller.clientWidth, scroller.scrollHeight - scroller.clientHeight];
    }), { message: "Short document still fits with Glass on after resizing" }).toEqual([0, 0]);
  }
  async function capture(name) {
    if (qa) await page.screenshot({ path: path.join(qa, `glass-${name}.png`) });
  }
  async function setDisplay(label, on, screenshot) {
    await key("Display").click();
    const item = page.getByRole("menuitemcheckbox", { name: label, exact: true });
    const checked = (await item.getAttribute("aria-checked")) === "true";
    if (screenshot) await capture(screenshot);
    await item.click();
    assert.equal(checked, !on, `${label} started ${checked ? "on" : "off"}`);
  }
  async function learning(on) {
    if (process.platform === "linux") return setDisplay("Learning mode", on);
    const button = key("Learning mode");
    if ((await button.getAttribute("aria-pressed")) !== String(on)) await button.click();
  }
  async function glassMenu(on, screenshot) {
    if (process.platform === "linux") return setDisplay("Glass overlay", on, screenshot);
    if (((await glass.count()) > 0) !== on) await pressG();
  }
  async function pressG() {
    await rich.click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("g");
  }
  async function mountBudget() {
    await page.evaluate(() => { performance.clearMarks("omarkie:glass-toggle"); performance.clearMarks("omarkie:glass-mounted"); });
    await pressG();
    await expect(glass).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => performance.getEntriesByName("omarkie:glass-mounted").length)).toBeGreaterThan(0);
    return page.evaluate(() => {
      const start = performance.getEntriesByName("omarkie:glass-toggle").at(-1)?.startTime;
      const end = performance.getEntriesByName("omarkie:glass-mounted").at(-1)?.startTime;
      return start != null && end != null ? end - start : null;
    });
  }
  await resize(1440);
  await page.reload();
  await expect(rich.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  await learning(true);
  await expect(rich).toHaveAttribute("contenteditable", "false");
  await expect(glass).toHaveCount(0);
  assert.equal((await axi("glass", "--vault", vault)).glass, "off");
  await glassMenu(true, "light-1440-menu");
  await expect(glass).toHaveAttribute("data-glass", "on");
  await pinnedTo(first);
  await capture("light-1440-on");
  const nativeGlassChecked = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("glass").checked);
  await expect.poll(nativeGlassChecked).toBe(true);
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const item = Menu.getApplicationMenu().getMenuItemById("glass");
    item.click({}, window, window.webContents);
  });
  await expect.poll(nativeGlassChecked).toBe(false);
  await expect(glass).toHaveCount(0);
  await capture("light-1440-off");
  assert.equal((await axi("glass", "--vault", vault)).glass, "off");
  await pressG();
  await expect(glass).toHaveAttribute("data-glass", "on");
  await expect(debug).toBeVisible();
  await resize(720);
  await pinnedTo(first);
  await noExtraScrollbars();
  await capture("light-720-on");
  await glassMenu(false, "light-720-menu");
  await expect(glass).toHaveCount(0);
  await capture("light-720-off");
  await pressG();
  await expect(glass).toHaveAttribute("data-glass", "on");
  await resize(1440);
  await pinnedTo(first);
  const budgets = [];
  for (let run = 0; run < 3; run++) {
    await pressG();
    await expect(glass).toHaveCount(0);
    budgets.push(await mountBudget());
  }
  const best = Math.min(...budgets);
  assert.ok(best !== null && best >= 0 && best < 50, `G toggled the glass in ${best}ms; budget is 50ms (${budgets.join(", ")})`);
  assert.equal(await readFile(file, "utf8"), source, "glass toggles never write the page");
  await learning(false);
  await expect(rich).toHaveAttribute("contenteditable", "true");
  await setDisplay("Source Code Mode", true);
  await expect(sourceSurface).toBeVisible();
  await sourceSurface.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type(`${added}\n\n`);
  await expect.poll(() => page.evaluate(() => document.querySelector(".cm-content")?.textContent?.startsWith("glass guard text."))).toBe(true);
  assert.equal((await axi("glass", "--vault", vault)).glass, "on", "typing a bare g must not toggle the glass");
  const editedSource = `${added}\r\n\r\n${source}`;
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(editedSource);
  await setDisplay("Source Code Mode", false);
  await learning(true);
  await expect(rich).toHaveAttribute("contenteditable", "false");
  await expect(glass).toHaveAttribute("data-glass", "on");
  await pinnedTo(first);
  const [addedBox, firstBox] = await Promise.all([blockBox(added), blockBox(first)]);
  assert.ok(addedBox && firstBox && addedBox.y + addedBox.height <= firstBox.y, "the inserted paragraph must sit above the anchored one");
  await capture("light-1440-edited");
  const [box, addedText] = await Promise.all([debug.boundingBox(), Promise.resolve(addedBox)]);
  assert.ok(box && addedText && box.y >= addedText.y + addedText.height - 1, "the pinned box must follow its paragraph, not the new one");
  assert.equal((await axi("glass", "--vault", vault)).glass, "on");
  assert.equal((await axi("glass", "--off", "--vault", vault)).glass, "off");
  await expect(glass).toHaveCount(0);
  assert.equal((await axi("glass", "--on", "--vault", vault)).glass, "on");
  await expect(glass).toHaveAttribute("data-glass", "on");
  await pinnedTo(first);
  await page.reload();
  await expect(glass).toHaveAttribute("data-glass", "on");
  await pinnedTo(first);
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "omarchy-dark"));
  await page.reload();
  await expect(rich.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  await resize(1440);
  await expect(glass).toHaveAttribute("data-glass", "on");
  await pinnedTo(first);
  await capture("dark-1440-on");
  await glassMenu(false, "dark-1440-menu");
  await expect(glass).toHaveCount(0);
  await capture("dark-1440-off");
  await pressG();
  await expect(glass).toHaveCount(1);
  await resize(720);
  await pinnedTo(first);
  await noExtraScrollbars();
  await capture("dark-720-on");
  await glassMenu(false, "dark-720-menu");
  await expect(glass).toHaveCount(0);
  await capture("dark-720-off");
  await resize(1440);
  assert.equal(await readFile(file, "utf8"), editedSource, "Glass does not write to Markdown");
  assert.deepEqual(errors, []);
  console.log("PASS: Glass surface follows its paragraph through edits and resize; menu, G and omarkie-axi toggle one per-vault state");
} finally { await app.close(); }
