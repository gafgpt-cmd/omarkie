import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as launch, expect } from "playwright/test";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// G12/G18 input and layout: the wheel keeps scrolling while a pen is in hand, an open dialog owns
// the keyboard, and the bottom panels never sit on top of the pencil case when it wraps.
const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-input-"));
const vault = path.join(home, "vault"), doc = "input.md", file = path.join(vault, doc);
const paragraphs = Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1}: recall the answer before looking it up.`);
const source = `# Glass input\n\n${paragraphs.join("\n\n")}\n`;
await mkdir(path.join(vault, ".omarkie", "glass"), { recursive: true });
await writeFile(path.join(vault, ".omarkie", "glass", "vault.json"), `${JSON.stringify({ version: 1, visible: true })}\n`);
await writeFile(file, source, "utf8");
const record = { id: "fixture", path: file, name: doc, content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;

const richOf = page => page.locator(".document-editor:not([hidden]) .rich-document");
const scrollerOf = page => page.locator(".rich-scroller");
async function resize(app, page, width) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
}
async function ready(page) {
  await expect(richOf(page).getByRole("heading", { name: "Glass input", exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
}
async function learning(page) {
  if (process.platform === "linux") {
    await page.getByRole("button", { name: "Display", exact: true }).click();
    const item = page.getByRole("menuitemcheckbox", { name: "Learning mode", exact: true });
    if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
    else await page.keyboard.press("Escape");
  } else {
    const button = page.getByRole("button", { name: "Learning mode", exact: true });
    if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
  }
  await expect(richOf(page)).toHaveAttribute("contenteditable", "false");
}

const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
const page = await app.firstWindow();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") console.log("PAGE:", message.text()); });
try {
  await resize(app, page, 1200);
  await page.reload();
  await ready(page);
  await learning(page);
  const tray = page.locator("[data-glass-tray]");
  await expect(tray).toBeVisible();

  // 1. A pen in hand must not kill the wheel: the page still scrolls under the fixed ink surface.
  await page.locator('[data-glass-tool="ink"]').click();
  await expect(page.locator("[data-ink-surface]")).toBeVisible();
  await page.mouse.move(600, 430);
  // Chromium applies a fresh wheel gesture on its second event; the first only opens the gesture.
  await page.mouse.wheel(0, 450);
  await page.waitForTimeout(150);
  await page.mouse.wheel(0, 450);
  await expect.poll(() => scrollerOf(page).evaluate(element => element.scrollTop),
    { message: "the wheel scrolls the note while the pen tool is active" }).toBeGreaterThan(0);

  // 2. A dialog owns the keyboard: no mark may be made behind it.
  await page.locator('[data-glass-tool="select"]').click();
  await page.locator("[data-glass-compare]").click();
  await expect(page.locator("[data-compare-dialog]")).toBeVisible();
  const notes = page.locator(".glass-note");
  await expect(notes).toHaveCount(0);
  await page.keyboard.press("n");
  await page.waitForTimeout(500);
  await expect(notes, { message: "N is inert while a dialog is open" }).toHaveCount(0);
  await expect(page.locator("[data-compare-dialog]")).toBeVisible();
  await page.locator("[data-compare-cancel]").click();
  await expect(page.locator("[data-compare-dialog]")).toHaveCount(0);

  // 3. At 660 px the pencil case wraps to two rows; the notice must clear it instead of covering it.
  await resize(app, page, 660);
  await page.waitForTimeout(300);
  await page.locator("[data-glass-magic]").click();
  await expect(page.locator(".glass-notice")).toBeVisible();
  await page.waitForTimeout(150);
  const geometry = await page.evaluate(() => {
    const caseBox = document.querySelector("[data-glass-tray]").getBoundingClientRect();
    const noticeBox = document.querySelector(".glass-notice").getBoundingClientRect();
    const covered = [...document.querySelectorAll("[data-glass-tray] button")].filter(button => {
      const box = button.getBoundingClientRect();
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      return x > noticeBox.left && x < noticeBox.right && y > noticeBox.top && y < noticeBox.bottom;
    }).map(button => button.getAttribute("aria-label"));
    return { caseTop: caseBox.top, caseHeight: caseBox.height, noticeBottom: noticeBox.bottom, covered,
      measured: getComputedStyle(document.documentElement).getPropertyValue("--glass-tray-height").trim() };
  });
  assert.ok(geometry.caseHeight > 44, `the case wraps at 660 px (height ${geometry.caseHeight}px)`);
  assert.equal(geometry.measured, `${Math.round(geometry.caseHeight)}px`, "the case publishes its height for the panels below");
  assert.deepEqual(geometry.covered, [], `no pencil-case button sits under the notice (${JSON.stringify(geometry.covered)})`);
  assert.ok(geometry.noticeBottom <= geometry.caseTop + 0.5,
    `notice bottom ${geometry.noticeBottom} clears the case top ${geometry.caseTop}`);
  assert.deepEqual(errors, []);
  console.log("glass input: wheel, dialog keyboard and 660 px panels ok");
} finally {
  await app.close();
}
