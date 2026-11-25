import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";
import { _electron as playwright } from "playwright/test";
import electron from "electron";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";
import { GlassService } from "../electron/glass-service.mjs";
import { GlassFinder } from "../electron/glass-finder.mjs";

if (process.platform === "win32") process.exit(0);
const temp = await realpath(await mkdtemp(path.join(tmpdir(), "omarkie-glass-moves-")));
const screens = process.env.OMARKIE_GLASS_SCREENS || path.join(temp, "screens");
await mkdir(screens, { recursive: true });
const entry = path.resolve("electron/omarkie-axi.mjs");
const cliEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", OMARKIE_LANGUAGE: "en" };

async function axiIn(folder, ...args) {
  try {
    const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: folder, env: cliEnv, timeout: 60_000 });
    return decode(stdout);
  } catch (error) {
    if (typeof error.code !== "number" || !error.stdout) throw error;
    return { exit: error.code, ...decode(error.stdout) };
  }
}
async function axi(...args) { return axiIn(vault, ...args); }

async function fixture(folder, files) {
  await mkdir(folder, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(folder, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

async function session(dataDir, vault, file, content) {
  const record = { id: "fixture", path: path.join(vault, file), name: file,
    content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), lineEnding: "\n" };
  await writeFile(path.join(dataDir, "session.json"), JSON.stringify({ version: 1, activeId: "fixture", folder: vault, documents: [record] }));
}

async function launch(dataDir) {
  const environment = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: dataDir, OMARKIE_LANGUAGE: "en", OMARKIE_TEST_HIDDEN: "0" });
  delete environment.OMARKIE_DEV_URL; delete environment.ELECTRON_RUN_AS_NODE;
  const app = await playwright.launch({ args: [process.cwd(), ...headlessArguments], env: environment });
  const page = await app.firstWindow();
  return { app, page };
}

async function waitFor(check, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  throw last ?? new Error("Timed out waiting for the vault to settle.");
}

async function shoot(page, app, width, height, name) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: size.width, height: size.height }), { width, height });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(screens, `${name}.png`) });
}

// 1. Real watcher: rename a folder while the app is open.
const dataDir = path.join(temp, "data"), vault = path.join(temp, "vault");
await mkdir(dataDir, { recursive: true });
const notes = { "Lab/Alpha.md": "# Alpha\n\nA paragraph.\n", "Lab/Beta.md": "# Beta\n\nAnother paragraph.\n", "Lab/Pinned.md": "# Pinned\n\nGlass target.\n" };
await fixture(vault, notes);
await session(dataDir, vault, "Lab/Alpha.md", notes["Lab/Alpha.md"]);
const seed = await new GlassService({ root: vault, appData: dataDir, device: "desktop-test" }).open();
await seed.request({ action: "add", note: "Lab/Alpha.md", text: "alpha pin", kind: "note" });
await seed.request({ action: "add", note: "Lab/Beta.md", text: "beta pin", kind: "note" });
const added = await seed.request({ action: "add", note: "Lab/Pinned.md", text: "pin desktop", kind: "note" });
assert.equal(added.magnet.fields.text, "pin desktop");
await seed.close();
{
  const { app, page } = await launch(dataDir);
  try {
    await page.getByRole("heading", { name: "Alpha", exact: true }).waitFor({ timeout: 30_000 });
    const map = await axi("vault", "map");
    assert.equal(map.files >= 3, true, JSON.stringify(map));
    const found = await waitFor(async () => { const result = await axi("find", "pin desktop"); return result.count === 1 ? result : null; });
    assert.equal(found.results[0].path, "Lab/Pinned.md");

    await rename(path.join(vault, "Lab"), path.join(vault, "Renamed"));
    await waitFor(async () => (await axi("glass", "list", "--note", "Renamed/Pinned.md")).magnets?.length === 1);
    const lines = (await readFile(path.join(vault, ".omarkie", "notes.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(lines.filter(line => line.op === "folder").length, 1);
    assert.deepEqual({ from: lines.find(line => line.op === "folder").from, to: lines.find(line => line.op === "folder").to }, { from: "Lab", to: "Renamed" });
    const after = await axi("vault", "map");
    assert.equal(after.lost.length, 0);
    assert.equal(after.files >= 3, true);
    assert.equal((await axi("find", "pin desktop")).results[0].path, "Renamed/Pinned.md");
  } finally { await app.close(); }
}

// 2. A 50,000-note vault stays responsive, and glass from another folder is offered.
const big = path.join(temp, "big"), bigData = path.join(temp, "big-data");
await mkdir(big, { recursive: true });
for (let chunk = 0; chunk < 50_000; chunk += 500)
  await Promise.all(Array.from({ length: 500 }, (_, index) => writeFile(path.join(big, `Note ${chunk + index}.md`), `# Note ${chunk + index}\n\nUnique body ${chunk + index}.\n`)));
const lastNote = "# Note 49999\n\nUnique body 49999.\n";
await mkdir(bigData, { recursive: true });
await session(bigData, big, "Note 49999.md", lastNote);
const origin = path.join(temp, "origin");
await fixture(origin, { "Original.md": lastNote });
const source = await new GlassService({ root: origin, appData: bigData, device: "desktop-test" }).open();
source.finder = await new GlassFinder({ file: path.join(bigData, "glass-finder.jsonl") }).load();
const copied = await source.request({ action: "add", note: "Original.md", kind: "note", text: "original magnet" });
const originalJournal = path.join(source.storeDir, copied.journal);
const originalBytes = await readFile(originalJournal);
await source.close();
{
  const { app, page } = await launch(bigData);
  try {
    await page.getByRole("heading", { name: "Note 49999", exact: true }).waitFor({ timeout: 60_000 });
    const probe = await page.evaluate(async () => {
      const samples = [];
      for (let index = 0; index < 8; index += 1) {
        const started = performance.now();
        await new Promise(resolve => requestAnimationFrame(resolve));
        samples.push(performance.now() - started);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return samples;
    });
    assert.ok(Math.max(...probe) < 500, `renderer frame ${Math.max(...probe).toFixed(0)} ms while indexing`);

    const done = await waitFor(async () => { const map = await axiIn(big, "vault", "map"); return map.scanComplete ? map : null; }, 420_000);
    assert.equal(done.files, 50_000);
    assert.equal(done.indexing, false);
    await page.locator(".glass-banner").waitFor({ timeout: 30_000 });
    assert.match(await page.locator(".glass-banner").innerText(), /already ha(?:s|ve) glass/);
    await shoot(page, app, 1440, 900, "banner-light-1440");
    await shoot(page, app, 720, 720, "banner-light-720");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1440, height: 900 }));
    await page.waitForTimeout(350);
    await page.keyboard.press("ControlOrMeta+,");
    const preferences = page.getByRole("dialog", { name: "Preferences", exact: true });
    await preferences.getByLabel("Theme", { exact: true }).selectOption("dark");
    await page.keyboard.press("Escape");
    await page.locator(".glass-banner").waitFor({ timeout: 60_000 });
    await shoot(page, app, 1440, 900, "banner-dark-1440");
    await shoot(page, app, 720, 720, "banner-dark-720");
    const banner = page.getByRole("status").filter({ hasText: "1 note here already has glass on this computer." });
    await banner.getByRole("button", { name: "Dismiss", exact: true }).click();
    await banner.waitFor({ state: "hidden" });
    const target = "Note 49999.md";
    assert.equal((await axiIn(big, "glass", "list", "--note", target)).magnets.length, 0);
    await page.reload();
    await banner.waitFor({ timeout: 30_000 });
    await banner.getByRole("button", { name: "Bring glass", exact: true }).click();
    await waitFor(async () => (await axiIn(big, "glass", "list", "--note", target)).magnets[0]?.fields.text === "original magnet");
    await banner.waitFor({ state: "hidden" });
    assert.deepEqual(await readFile(originalJournal), originalBytes);
    assert.equal(await readFile(path.join(big, target), "utf8"), lastNote);
  } finally { await app.close(); }
}

console.log(`glass moves desktop: ok (${screens})`);
