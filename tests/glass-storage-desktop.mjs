import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";
import { _electron as playwright, expect } from "playwright/test";
import electron from "electron";
import { endpoint } from "../electron/tutor-transport.mjs";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

if (process.platform === "win32") process.exit(0);
const temp = await realpath(await mkdtemp(path.join(tmpdir(), "omarkie-glass-live-")));
const home = path.join(temp, "home"), second = path.join(temp, "home-2"), vault = path.join(temp, "vault"), doc = "map.md";
const file = path.join(vault, doc);
const source = "# Reading a contour map\n\nClosely spaced contour lines indicate a steep slope.\n\nA saddle is a low point between two summits.\n";
for (const folder of [home, second, vault]) await mkdir(folder);
await writeFile(file, source);
async function session(folder) {
  const fixture = { version: 1, activeId: "fixture", folder: vault, documents: [{ id: "fixture", path: file, name: doc,
    content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\n" }] };
  await writeFile(path.join(folder, "session.json"), JSON.stringify(fixture));
}
await session(home);
await session(second);
const entry = path.resolve("electron/omarkie-axi.mjs");
const cliEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", OMARKIE_LANGUAGE: "en" };
async function axi(...args) {
  try {
    const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: cliEnv, timeout: 20_000 });
    return decode(stdout);
  } catch (error) {
    if (typeof error.code !== "number" || !error.stdout) throw error;
    return { exit: error.code, ...decode(error.stdout) };
  }
}
async function checksums() {
  const result = new Map();
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, item.name);
      if (item.name === ".omarkie") continue;
      if (item.isDirectory()) await walk(target);
      else result.set(path.relative(vault, target), createHash("sha256").update(await readFile(target)).digest("hex"));
    }
  }
  await walk(vault);
  return result;
}
async function launch(dataDir) {
  const environment = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: dataDir, OMARKIE_LANGUAGE: "en", OMARKIE_TEST_HIDDEN: "0" });
  delete environment.OMARKIE_DEV_URL; delete environment.ELECTRON_RUN_AS_NODE;
  const app = await playwright.launch({ args: [process.cwd(), ...headlessArguments], env: environment });
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "Reading a contour map", exact: true }).waitFor({ timeout: 30_000 });
  return { app, page };
}
const place = endpoint(vault, "glass");
const bridgeReady = async () =>
  (await lstat(place.socket).then(item => item.isSocket(), () => false)) &&
  (await lstat(place.discovery).then(item => item.isFile(), () => false));
const before = await checksums();
const first = await launch(home);
try {
  await expect.poll(bridgeReady, { timeout: 30_000 }).toBe(true);
  assert.equal((await lstat(place.discovery)).mode & 0o777, 0o600);
  await assert.rejects(lstat(path.join(vault, ".omarkie")), error => error.code === "ENOENT");
  const cold = await axi("glass", "status");
  assert.equal(cold.initialized, false);
  assert.equal(cold.mode, null);
  assert.equal((await axi("glass", "--on")).glass, "on");
  const added = await axi("glass", "add", "--note", doc, "--text", "debug magnet", "--kind", "debug", "--magnet", "m-debug");
  assert.equal(added.note, doc);
  assert.match(added.journal, /^glass\/map ~[a-z0-9]{6}\.jsonl$/);
  assert.equal(added.magnet.id, "m-debug");
  assert.equal(added.magnet.fields.text, "debug magnet");
  const listed = await axi("glass", "list", "--note", doc);
  assert.deepEqual(listed.magnets.map(item => item.id), ["m-debug"]);
  const shown = await axi("glass", "show", "--note", doc, "--magnet", "m-debug");
  assert.equal(shown.magnet.fields.kind, "debug");
  const status = await axi("glass", "status");
  assert.equal(status.mode, "inside");
  assert.equal(status.readOnly, false);
  assert.equal(status.pending, 0);
  assert.equal(await readFile(file, "utf8"), source);

  const competing = await launch(second);
  try {
    await expect.poll(bridgeReady, { timeout: 30_000 }).toBe(true);
    const response = await competing.page.evaluate(() => window.desktop.glass({ action: "status" }));
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.value.readOnly, true);
    assert.match(response.value.readOnlyReason, /another/);
    const rejected = await competing.page.evaluate(() => window.desktop.glass({ action: "add", note: "map.md", text: "blocked" }));
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /read-only/i);
    assert.deepEqual((await axi("glass", "list", "--note", doc)).magnets.map(item => item.id), ["m-debug"]);
  } finally { await competing.app.close(); }
} finally { await first.app.close(); }

const reopened = await launch(home);
try {
  await expect.poll(bridgeReady, { timeout: 30_000 }).toBe(true);
  const persisted = await axi("glass", "show", "--note", doc, "--magnet", "m-debug");
  assert.equal(persisted.magnet.fields.text, "debug magnet");
  assert.equal((await axi("glass", "list", "--note", doc)).magnets.length, 1);
  assert.equal((await axi("glass")).glass, "on");
  assert.equal((await axi("glass", "--off")).glass, "off");
  assert.equal((await axi("glass", "show", "--note", doc, "--magnet", "m-debug")).magnet.fields.text, "debug magnet");
  assert.equal(await readFile(file, "utf8"), source);
} finally { await reopened.app.close(); }

assert.deepEqual(await checksums(), before);
await rm(temp, { recursive: true, force: true });
console.log("glass storage desktop: ok");
