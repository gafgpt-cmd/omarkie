import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { _electron as launch, expect } from "playwright/test";
import { decode } from "@toon-format/toon";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";
import { GitSync } from "../electron/git-sync.mjs";
import { gitHttpServer } from "./git-http.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const tokenStub = { readToken: async () => null, hasToken: async () => false, keychain: () => ({ available: true, backend: "os", secure: true }) };
const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-sync-board-"));
const vault = path.join(home, "vault"), appData = path.join(home, "appdata"), remoteRoot = path.join(home, "remote.git");
const heading = "Retrieval practice", first = "Recall the answer before looking it up.";
const source = `# ${heading}\n\n${first}\n\nLeave a day before your next review.\n`;
await mkdir(vault, { recursive: true });
await writeFile(path.join(vault, "practice.md"), source);
git(home, "init", "--bare", remoteRoot);
git(remoteRoot, "config", "http.receivepack", "true");
// A bare repo's HEAD follows the host's init.defaultBranch; point it at the branch the vault pushes.
git(remoteRoot, "symbolic-ref", "HEAD", "refs/heads/main");
git(vault, "init", "-b", "main");
git(vault, "config", "user.name", "Test");
git(vault, "config", "user.email", "test@example.com");
git(vault, "remote", "add", "origin", "https://example.invalid/vault.git");
const server = await gitHttpServer(home);
git(vault, "remote", "set-url", "origin", `${server.url}/remote.git`);
const seed = new GitSync({ root: vault, appData, tokenStore: tokenStub });
await seed.setRemote(`${server.url}/remote.git`, "main");
await seed.syncNow();

const record = { id: "fixture", path: path.join(vault, "practice.md"), name: "practice.md", content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const qa = process.env.OMARKIE_QA_DIR;
if (qa) await mkdir(qa, { recursive: true });
const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
async function axi(...args) {
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 });
  return decode(stdout);
}
const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env, timeout: 30_000 });
let network = [];
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await page.reload();
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  await expect(rich.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  async function resize(width) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
  }
  async function capture(name) { if (qa) await page.screenshot({ path: path.join(qa, `glass-g20-${name}.png`) }); }
  async function preferences() {
    await page.keyboard.press("Control+,");
    await expect(page.getByRole("dialog", { name: "Preferences", exact: true })).toBeVisible();
  }
  async function closePreferences() {
    await page.getByRole("button", { name: "Close Preferences", exact: true }).click();
  }
  async function syncNow() {
    const before = (await axi("sync", "status", "--vault", vault)).last?.at ?? null;
    const button = syncDialog.getByTestId("sync-now");
    await expect(button).toBeEnabled({ timeout: 20_000 });
    await button.click();
    await expect(button).toContainText("Sync now", { timeout: 30_000 });
    await expect.poll(async () => (await axi("sync", "status", "--vault", vault)).last?.at ?? null, { timeout: 30_000 }).not.toBe(before);
    return (await axi("sync", "status", "--vault", vault)).last;
  }
  async function learningMode(on) {
    await page.getByRole("button", { name: "Display", exact: true }).click();
    const item = page.getByRole("menuitemcheckbox", { name: "Learning mode", exact: true });
    const checked = (await item.getAttribute("aria-checked")) === "true";
    if (checked !== on) await item.click();
    else await page.keyboard.press("Escape");
  }
  async function glassMenu(on) {
    await page.getByRole("button", { name: "Display", exact: true }).click();
    const item = page.getByRole("menuitemcheckbox", { name: "Glass overlay", exact: true });
    const checked = (await item.getAttribute("aria-checked")) === "true";
    if (checked !== on) await item.click();
    else await page.keyboard.press("Escape");
  }
  async function setTheme(theme) {
    await preferences();
    await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption(theme);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
    await closePreferences();
  }
  await resize(1440);

  // Sync: the button runs the real engine against a local smart-HTTP bare remote.
  const firstSticker = await axi("glass", "add", "--note", "practice.md", "--kind", "sticker", "--sticker", "star", "--near", first, "--vault", vault);
  assert.ok(firstSticker.magnet?.id, "CLI added a sticker through the running app");
  await page.locator('[data-testid="sync-button"]').click();
  const syncDialog = page.getByRole("dialog", { name: "Sync", exact: true });
  await expect(syncDialog).toBeVisible();
  await expect(syncDialog.getByTestId("sync-status")).toContainText("Remote:");
  await capture("sync-light-1440");
  assert.equal((await syncNow()).state, "ok");

  const journalPath = (await readdir(path.join(vault, ".omarkie", "glass"))).find(name => name.endsWith(".jsonl"));
  assert.ok(journalPath, "glass journal exists");
  const journal = path.join(vault, ".omarkie", "glass", journalPath);
  const firstLines = (await readFile(journal, "utf8")).trim().split("\n");

  const vaultB = path.join(home, "vault-b");
  await mkdir(vaultB);
  git(vaultB, "init", "-b", "main");
  git(vaultB, "config", "user.name", "Test");
  git(vaultB, "config", "user.email", "test@example.com");
  git(vaultB, "remote", "add", "origin", `${server.url}/remote.git`);
  const second = new GitSync({ root: vaultB, appData, tokenStore: tokenStub });
  await second.syncNow();
  const remoteMagnet = "b-device-sticker";
  const copied = firstLines.map(line => JSON.parse(line)).filter(line => line.magnetId === firstSticker.magnet.id);
  const copiedLines = copied.map((line, index) => {
    const next = { ...line, magnetId: remoteMagnet, device: "device-b", hlc: `900-${index}` };
    delete next.opId;
    return JSON.stringify(next);
  });
  await appendFile(path.join(vaultB, ".omarkie", "glass", journalPath), `${copiedLines.join("\n")}\n`);
  await second.syncNow();

  const secondSticker = await axi("glass", "add", "--note", "practice.md", "--kind", "sticker", "--sticker", "heart", "--near", first, "--vault", vault);
  assert.ok(secondSticker.magnet?.id);
  assert.equal((await syncNow()).state, "ok");
  const mergedText = await readFile(journal, "utf8");
  assert.ok(mergedText.includes(remoteMagnet), "the other device's journal op arrived");
  assert.ok(mergedText.includes(secondSticker.magnet.id), "local op stayed");
  const listed = await axi("glass", "list", "--note", "practice.md", "--vault", vault);
  assert.ok(JSON.stringify(listed).includes(remoteMagnet), "reader sees the merged magnet");
  await resize(720);
  await capture("sync-light-720");
  await resize(1440);
  await syncDialog.getByRole("button", { name: "Close", exact: true }).click();

  // Board off by default, enabled in Preferences, then drawn and persisted.
  await learningMode(true);
  await glassMenu(true);
  await expect(page.locator(".glass-layer")).toHaveCount(1);
  assert.equal(await page.locator("[data-glass-board]").count(), 0, "board tray button is off by default");
  await preferences();
  const boardToggle = page.getByRole("checkbox", { name: "Enable boards (Excalidraw)", exact: true });
  await expect(boardToggle).not.toBeChecked();
  await boardToggle.check();
  await closePreferences();
  await expect(page.locator("[data-glass-board]")).toHaveCount(1);
  network = [];
  await page.locator("[data-glass-board]").click();
  await expect(page.locator(".board-backdrop")).toBeVisible();
  const canvas = page.locator(".excalidraw__canvas.interactive").first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  const boardDir = path.join(vault, ".omarkie", "assets", "boards");
  const boardFile = (await readdir(boardDir)).find(name => name.endsWith(".excalidraw.json"));
  assert.ok(boardFile);
  const box = await canvas.boundingBox();
  assert.ok(box && box.width > 100 && box.height > 100);
  const rectangle = page.getByRole("button", { name: "Rectangle", exact: true }).first();
  if (await rectangle.count()) await rectangle.click();
  else { await canvas.click({ position: { x: 420, y: 320 } }); await page.keyboard.press("r"); }
  await page.mouse.move(box.x + 420, box.y + 260);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.move(box.x + 650, box.y + 430, { steps: 12 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(1500);
  await expect.poll(async () => JSON.parse(await readFile(path.join(boardDir, boardFile), "utf8")).elements.length, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(page.locator(".board-status")).not.toContainText("Saving", { timeout: 10_000 });
  const scene = JSON.parse(await readFile(path.join(boardDir, boardFile), "utf8"));
  await capture("board-light-1440");
  await resize(720);
  await capture("board-light-720");
  await resize(1440);
  await page.getByRole("button", { name: "Close board", exact: true }).click();

  await setTheme("dark");
  await page.locator('[data-testid="sync-button"]').click();
  await expect(syncDialog).toBeVisible();
  await capture("sync-dark-1440");
  await resize(720);
  await capture("sync-dark-720");
  await resize(1440);
  await syncDialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator("[data-glass-board]").click();
  await page.locator("[data-board-open]").first().click();
  await expect(page.locator(".board-backdrop")).toBeVisible();
  await expect(page.locator(".excalidraw__canvas.interactive").first()).toBeVisible({ timeout: 30_000 });
  await capture("board-dark-1440");
  await resize(720);
  await capture("board-dark-720");
  await resize(1440);

  assert.deepEqual(network, [], `board use must stay offline, saw ${network.join(", ")}`);
  assert.deepEqual(errors, [], `renderer errors: ${errors.join(" | ")}`);
  console.log("PASS: sync merged two journals through a bare remote and board stayed offline");
} finally {
  await app.close();
  await server.close();
}
