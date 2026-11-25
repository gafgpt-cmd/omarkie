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
import { requestBridge } from "../electron/tutor-transport.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-landmarks-"));
const vault = path.join(home, "vault"), doc = "landmarks.md", file = path.join(vault, doc);
const original = `# Memory

## Retrieval

Alpha paragraph about retrieval practice.

Beta paragraph about spaced repetition over days.

## Interleaving

Gamma paragraph about interleaving related topics.

Delta paragraph about mixing problem types.

## Afterword

Epsilon paragraph that will be deleted.
`;
const edited = `# Memory

Inserted note above everything.

## Interleaving

Gamma paragraph now covers interleaving different topics.

Delta paragraph about mixing problem types.

Beta paragraph about spaced repetition over days.

## Retrieval

Alpha paragraph about retrieval practice.
`;
const magnets = [
  "Alpha paragraph about retrieval practice.",
  "Beta paragraph about spaced repetition over days.",
  "Gamma paragraph about interleaving related topics.",
  "Delta paragraph about mixing problem types.",
  "Epsilon paragraph that will be deleted.",
];
await mkdir(vault);
await writeFile(file, original, "utf8");
function session(content) {
  return { version: 1, activeId: "fixture", folder: vault, documents: [{ id: "fixture", path: file, name: doc,
    content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), lineEnding: "\n" }] };
}
await writeFile(path.join(home, "session.json"), JSON.stringify(session(original)), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const qa = process.env.OMARKIE_QA_DIR;
const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
async function axi(...args) {
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 15_000 });
  return decode(stdout);
}

async function open() {
  const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
  const page = await app.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(seeds => {
    localStorage.setItem("omarkie-glass-test", "1");
    localStorage.setItem("omarkie-glass-magnets", JSON.stringify(seeds));
  }, magnets);
  await page.reload();
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  await expect(rich.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  const key = name => page.getByRole("button", { name, exact: true });
  async function display(label, on) {
    await key("Display").click();
    const item = page.getByRole("menuitemcheckbox", { name: label, exact: true });
    const checked = (await item.getAttribute("aria-checked")) === "true";
    if (checked !== on) await item.click();
    await page.keyboard.press("Escape");
  }
  async function resize(width) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
  }
  async function pressG() {
    await rich.click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("g");
  }
  await resize(1440);
  if (process.platform === "linux") await display("Learning mode", true);
  else {
    const button = key("Learning mode");
    if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
  }
  await expect(rich).toHaveAttribute("contenteditable", "false");
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "light"));
  if ((await page.locator(".glass-layer").count()) === 0) await pressG();
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
  return { app, page, rich, errors };
}

async function inspect(page, expected) {
  const magnets = page.locator(".glass-magnet"), tray = page.locator("[data-glass-tray-item]");
  await expect(magnets).toHaveCount(expected.magnets);
  await expect(tray).toHaveCount(expected.tray);
  const states = await magnets.evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.glassObject, confidence: node.dataset.glassConfidence, tier: node.dataset.glassTier })));
  const trayIds = await tray.evaluateAll(nodes => nodes.map(node => node.dataset.glassTrayItem));
  return { states, trayIds };
}
async function capture(page, name) {
  if (qa) await page.screenshot({ path: path.join(qa, `glass-g2b-${name}.png`) });
}
async function inspectPlacementLayout(page) {
  await expect.poll(() => page.locator(".glass-magnet-row").evaluateAll(rows => rows.length > 0 && rows.every(row => {
    const origin = row.closest(".study-placement").getBoundingClientRect();
    const badges = [...row.children].map(badge => badge.getBoundingClientRect());
    return badges.every((badge, i) => badge.left >= origin.left && badge.right <= origin.right &&
      badges.slice(0, i).every(other => badge.top >= other.bottom || badge.left >= other.right));
  }))).toBe(true);
  const readable = page.locator(".rich-document").getByText("Gamma paragraph now covers interleaving different topics.", { exact: true });
  const check = page.locator('[data-glass-object="m-g2b-3"]');
  await expect(check.getByText("check me", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const [badge, text] = await Promise.all([check.boundingBox(), readable.boundingBox()]);
    return !!badge && !!text && badge.y >= text.y + text.height;
  }).toBe(true);
  await expect.poll(async () => {
    const [tray, status] = await Promise.all([
      page.getByRole("complementary", { name: "Check placement" }).boundingBox(),
      page.locator(".statusbar").boundingBox(),
    ]);
    return !!tray && !!status && tray.y + tray.height <= status.y;
  }).toBe(true);
}

const first = await open();
try {
  const placed = await inspect(first.page, { magnets: 5, tray: 0 });
  assert.deepEqual(placed.states.map(state => state.confidence), Array(5).fill("placed"));
  await capture(first.page, "light-1440-placed");
  assert.equal((await axi("glass", "list", "--note", doc)).magnets.length, 5);
} finally { await first.app.close(); }

await writeFile(file, edited, "utf8");
await writeFile(path.join(home, "session.json"), JSON.stringify(session(edited)), "utf8");
const replacement = "Delta paragraph about mixing three problem types.";

const second = await open();
try {
  const result = await inspect(second.page, { magnets: 4, tray: 1 });
  const byId = Object.fromEntries(result.states.map(state => [state.id, state]));
  assert.equal(byId["m-g2b-1"].confidence, "placed", "an insertion above keeps the paragraph silent");
  assert.equal(byId["m-g2b-2"].confidence, "placed", "a moved paragraph keeps its fingerprint");
  assert.equal(byId["m-g2b-4"].confidence, "placed", "a reordered section keeps its fingerprint");
  assert.equal(byId["m-g2b-3"].confidence, "check", "a rewritten paragraph lands dotted, not silently");
  assert.deepEqual(result.trayIds, ["m-g2b-5"], "a deleted paragraph waits in the tray");
  assert.deepEqual(second.errors, []);
  await inspectPlacementLayout(second.page);
  await capture(second.page, "light-1440-tray");
  await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(720, 900));
  await expect.poll(() => second.page.evaluate(() => innerWidth)).toBe(720);
  await inspectPlacementLayout(second.page);
  await capture(second.page, "light-720-tray");
  await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await expect.poll(() => second.page.evaluate(() => innerWidth)).toBe(1440);
  const rich = second.page.locator(".document-editor:not([hidden]) .rich-document");
  async function reloadTheme(theme) {
    await second.page.evaluate(theme => localStorage.setItem("omarkie-theme", theme), theme);
    await second.page.reload();
    await expect(rich.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
    await second.page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
    await expect(second.page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
    await expect(second.page.locator(".glass-magnet")).toHaveCount(4);
    await expect(second.page.locator("[data-glass-tray-item]")).toHaveCount(1);
  }
  await reloadTheme("omarchy-dark");
  await inspectPlacementLayout(second.page);
  await capture(second.page, "dark-1440-tray");
  await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(720, 900));
  await expect.poll(() => second.page.evaluate(() => innerWidth)).toBe(720);
  await inspectPlacementLayout(second.page);
  await capture(second.page, "dark-720-tray");
  await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await expect.poll(() => second.page.evaluate(() => innerWidth)).toBe(1440);
  await reloadTheme("light");
  const tray = second.page.locator('[data-glass-tray-item="m-g2b-5"] button');
  await tray.press("Enter");
  await expect(second.page.getByRole("status").filter({ hasText: "Click the paragraph this magnet belongs to." })).toBeVisible();
  await capture(second.page, "light-1440-placing");
  await second.rich.locator('[data-cid]', { hasText: "Delta paragraph about mixing problem types." }).click();
  await expect(second.page.getByRole("complementary", { name: "Check placement" })).toHaveCount(0);
  await expect(second.page.locator(".glass-magnet")).toHaveCount(5);
  const moved = await second.page.locator('[data-glass-object="m-g2b-5"]').getAttribute("data-glass-confidence");
  assert.equal(moved, "placed", "clicking a paragraph re-anchors the tray magnet");
  const badges = second.page.locator(".glass-magnet-row").filter({ has: second.page.locator('[data-glass-object="m-g2b-5"]') });
  await expect(badges.locator(".glass-magnet")).toHaveCount(2);
  await expect.poll(async () => {
    const [delta, epsilon] = await Promise.all(["4", "5"].map(id => badges.locator(`[data-glass-object="m-g2b-${id}"]`).boundingBox()));
    return !!delta && !!epsilon && (epsilon.x >= delta.x + delta.width || delta.x >= epsilon.x + epsilon.width ||
      epsilon.y >= delta.y + delta.height || delta.y >= epsilon.y + epsilon.height);
  }, { message: "Two magnets on the same paragraph do not overlap" }).toBe(true);
  assert.equal((await readFile(file, "utf8")), edited, "glass never rewrites the page");
  await capture(second.page, "light-1440-replaced");
  const listed = await axi("glass", "list", "--note", doc);
  assert.equal(listed.magnets.length, 5, "no magnet is deleted while re-anchoring");
  await second.rich.getByText(magnets[3], { exact: true }).selectText();
  await second.page.keyboard.press("Alt+Enter");
  await expect(second.page.getByRole("group", { name: "Selection actions" })).toBeVisible();
  await second.page.keyboard.press("p");
  const tutor = second.page.getByRole("complementary", { name: "Tutor", exact: true });
  const instructions = tutor.getByRole("textbox", { name: "Instructions (optional)" });
  await instructions.fill("Specify three problem types."); await instructions.press("Enter");
  await expect.poll(() => requestBridge(vault, { op: "home" }, 1200).then(value => value?.asks[0]?.verb)).toBe("propose");
  const { ask } = await requestBridge(vault, { op: "poll", owner: "Fixture tutor" }, 3_000);
  assert.equal(ask.paragraph, magnets[3]);
  await requestBridge(vault, { op: "reply", id: ask.id, text: replacement }, 3_000);
  await tutor.getByRole("button", { name: "Accept into Markdown", exact: true }).click();
  await expect(second.rich.getByText(replacement, { exact: true })).toBeVisible();
  await second.page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => readFile(file, "utf8")).toBe(edited.replace(magnets[3], replacement));
  await expect.poll(async () => {
    const { magnets: stored } = await axi("glass", "list", "--note", doc);
    const quotes = new Map(stored.map(magnet => [magnet.id, magnet.fields.anchor.landmarks.find(landmark => landmark.kind === "quote").value.exact]));
    return [3, 4, 5].map(id => quotes.get(`m-g2b-${id}`));
  }).toEqual([magnets[2], replacement, replacement]);
  assert.deepEqual(second.errors, []);
  console.log("PASS: five debug magnets survive insert, move, rewrite, section reorder and delete; deleted one re-anchors from the tray");
} finally { await second.app.close(); }
