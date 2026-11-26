import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import koffi from "koffi";
import { _electron as launch, expect } from "playwright/test";
import { endpoint } from "../electron/tutor-transport.mjs";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// A Glass bridge that cannot bind retries; the retry must leave open storage serving writes.
if (process.platform === "win32") process.exit(0);
const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "omarkie-bridge-retry-")));
const vault = path.join(home, "vault"), doc = "retry.md", file = path.join(vault, doc);
const source = "# Bridge retry\n\nWrites keep landing while the bridge heals.\n";
await mkdir(path.join(vault, ".omarkie", "glass"), { recursive: true });
await writeFile(path.join(vault, ".omarkie", "glass", "vault.json"), `${JSON.stringify({ version: 1, visible: true })}\n`);
await writeFile(file, source, "utf8");
const record = { id: "fixture", path: file, name: doc, content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");

// Hold the bridge lock the way a second Omarkie would, so every bind attempt fails until it is released.
const place = endpoint(vault, "glass");
await mkdir(place.directory, { recursive: true, mode: 0o700 });
const lock = await open(place.lock, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
const flock = koffi.load(null).func("int flock(int fd, int operation)");
assert.equal(flock(lock.fd, 2 | 4), 0);
let held = true;
const release = async () => { if (!held) return; held = false; flock(lock.fd, 8); await lock.close(); };

const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
let refused = 0;
for (const stream of [app.process().stdout, app.process().stderr]) stream?.on("data", chunk => { refused += String(chunk).split("Glass bridge: Another Omarkie process").length - 1; });
try {
  const page = await app.firstWindow();
  await page.getByRole("heading", { name: "Bridge retry", exact: true }).waitFor({ timeout: 30_000 });
  await page.evaluate(() => {
    window.__retryStop = false;
    const failures = [];
    let written = 0, next = 0;
    // Parallel lanes keep a write inside storage at any moment, as an agent and the UI do together.
    const lane = async () => {
      while (!window.__retryStop) {
        const id = next++;
        const result = await window.desktop.glass({ action: "add", note: "retry.md", magnet: `m-retry-${id}`, kind: "sticky", text: `Retry ${id}`, x: 20, y: 20,
          anchor: { version: 1, landmarks: [{ kind: "block", block: "Writes keep landing while the bridge heals.", headings: ["Bridge retry"], line: 3 }] } }).catch(error => ({ ok: false, error: error.message }));
        if (result?.ok) written += 1; else failures.push(result?.error ?? "add failed");
      }
    };
    window.__retryWrites = Promise.all(Array.from({ length: 8 }, lane)).then(() => ({ written, failures }));
  });
  // The first refusal is the startup bind; the second proves a retry ran while writes were in flight.
  await expect.poll(() => refused, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(300);
  await release();
  const { written, failures } = await page.evaluate(async () => { window.__retryStop = true; return window.__retryWrites; });
  assert.deepEqual(failures, []);
  assert.ok(written > 0, "no write landed while the bridge was down");
  await expect.poll(() => lstat(place.socket).then(item => item.isSocket(), () => false), { timeout: 30_000 }).toBe(true);
  const listed = await page.evaluate(() => window.desktop.glass({ action: "list", note: "retry.md" }));
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.value.magnets.filter(item => item.id.startsWith("m-retry-")).length, written);
  console.log(`glass bridge retry desktop: ok (${written} writes across ${refused} refused binds)`);
} finally {
  await release();
  await app.close();
  await rm(home, { recursive: true, force: true });
}
