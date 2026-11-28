import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as launch, expect } from "playwright/test";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// An edit made right after first paint, while Glass startup is still held back, saves and survives Glass coming up.
const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "omarkie-early-edit-")));
const vault = path.join(home, "vault"), doc = "early.md", file = path.join(vault, doc), log = path.join(home, "debug.log");
const source = "# Early edit\n\nTyped before Glass is ready.\n";
await mkdir(vault, { recursive: true });
await writeFile(file, source, "utf8");
const record = { id: "fixture", path: file, name: doc, content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");

const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en", OMARKIE_DEBUG_LOG: log, OMARKIE_TEST_GLASS_DELAY_MS: "6000" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
const events = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").map(line => line.split(" ").slice(1, 3).join(" "));
try {
  const page = await app.firstWindow();
  const root = page.locator(".document-editor:not([hidden]) .rich-document");
  const heading = root.getByRole("heading", { name: "Early edit", exact: true });
  await heading.waitFor({ timeout: 30_000 });
  await heading.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" now");
  await expect.poll(() => readFile(file, "utf8"), { timeout: 10_000 }).toBe(source.replace("Early edit", "Early edit now"));
  const order = await events();
  assert.ok(order.includes("save done"), order.join("\n"));
  assert.equal(order.includes("glass ready"), false, `the save must land while Glass startup is held:\n${order.join("\n")}`);

  await expect.poll(async () => (await events()).includes("glass ready"), { timeout: 30_000 }).toBe(true);
  await expect(root.getByRole("heading", { name: "Early edit now", exact: true })).toBeVisible();
  assert.equal(await readFile(file, "utf8"), source.replace("Early edit", "Early edit now"));
  await page.keyboard.insertText(" too");
  await expect.poll(() => readFile(file, "utf8"), { timeout: 10_000 }).toBe(source.replace("Early edit", "Early edit now too"));
  console.log("glass early edit desktop: ok (edit saved before Glass startup and kept after it)");
} finally {
  await app.close();
  await rm(home, { recursive: true, force: true });
}
