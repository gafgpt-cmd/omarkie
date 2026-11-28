import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";
import electron from "electron";
import { _electron as launch, expect } from "playwright/test";
import { endpoint } from "../electron/tutor-transport.mjs";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// Glass waits for the first note's paint; a window that never paints (minimized, hidden) must still answer omarkie-axi.
if (process.platform === "win32") process.exit(0);
const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "omarkie-unpainted-")));
const vault = path.join(home, "vault"), doc = "unpainted.md", file = path.join(vault, doc);
const source = "# Unpainted\n\nGlass comes up without a painted window.\n";
await mkdir(vault, { recursive: true });
await writeFile(file, source, "utf8");
await writeFile(path.join(vault, "Second.md"), "# Second\n", "utf8");
const record = { id: "fixture", path: file, name: doc, content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");

// The stand-in renderer restores the session and reports ready, as a minimized window does, but never paints a document.
const standIn = `data:text/html,${encodeURIComponent("<script>window.desktop.restore().then(() => window.desktop.ready())</script>")}`;
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en", OMARKIE_DEV_URL: standIn });
delete env.ELECTRON_RUN_AS_NODE;
const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
try {
  await app.firstWindow();
  await expect.poll(() => lstat(endpoint(vault, "glass").socket).then(item => item.isSocket(), () => false), { timeout: 30_000 }).toBe(true);
  const started = Date.now();
  const { stdout } = await promisify(execFile)(electron, [path.resolve("electron/omarkie-axi.mjs"), "vault", "map"],
    { cwd: vault, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OMARKIE_LANGUAGE: "en" }, timeout: 60_000 });
  const map = decode(stdout);
  assert.equal(map.files >= 2, true, JSON.stringify(map));
  console.log(`glass unpainted desktop: ok (vault map answered in ${Date.now() - started} ms without a painted window)`);
} finally {
  await app.close();
  await rm(home, { recursive: true, force: true });
}
