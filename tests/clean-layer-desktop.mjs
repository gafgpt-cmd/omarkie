import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "omarkie-clean-ui-"));
const file = path.join(dir, "sample.md"), profile = path.join(dir, "profile");
const hookRuns = path.join(dir, "clean-runs");
const hook = fileURLToPath(new URL("./fixtures/clean-script.cjs", import.meta.url));
const source = "# Sample\n\npublisher artifact\n\nMethods\n\nA reconst-\nruction.\n";
await writeFile(file, source);
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: profile, OMARKIE_LANGUAGE: "en", OMARKIE_TEST_CLEAN_RUN: hookRuns, OMARKIE_CLEAN_SCRIPT: JSON.stringify([process.execPath, hook, "complete"]) });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [root, ...headlessArguments, file], env });
try {
  const page = await app.firstWindow();
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  const preview = page.getByRole("region", { name: "Clean layer preview" });
  const open = async () => {
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Clean converted text…", exact: true }).click();
    await expect(preview.getByRole("heading", { name: "Methods", exact: true })).toBeVisible();
  };
  const bake = preview.getByRole("button", { name: "Bake into source" });
  const disk = () => readFile(file, "utf8");
  await expect(rich.getByText("publisher artifact", { exact: true })).toBeVisible();
  await expect.poll(() => readFile(path.join(profile, "session.json"), "utf8").catch(() => "")).toContain("sample.md");
  await page.evaluate(() => localStorage.setItem("omarkie-autosave", "false"));
  const chunks = [];
  page.on("request", request => { if (/\/CleanLayer-[^/]+\.js$/.test(request.url())) chunks.push(request.url()); });
  await page.reload();
  await expect(rich.getByText("publisher artifact", { exact: true })).toBeVisible();
  assert.equal(chunks.length, 0);
  await assert.rejects(readFile(hookRuns), { code: "ENOENT" });

  await open();
  assert.ok(chunks.length > 0);
  assert.equal(await readFile(hookRuns, "utf8"), "run\n");
  await expect(preview.getByText("A reconstruction.", { exact: true })).toBeVisible();
  await expect(preview.getByText("publisher artifact", { exact: true })).toHaveCount(0);
  await preview.getByRole("button", { name: "Show changes" }).click();
  await expect(preview.locator("pre").first()).toContainText("publisher artifact");
  await expect(preview.locator("pre").last()).toContainText("## Methods");
  assert.equal(await disk(), source);
  await preview.getByRole("button", { name: "Back to source" }).click();
  await expect(rich.getByText("publisher artifact", { exact: true })).toBeVisible();

  await open();
  await bake.click();
  await expect(preview).toBeHidden();
  await expect(rich.getByRole("heading", { name: "Methods", exact: true })).toBeVisible();
  assert.equal(await disk(), source);
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(disk).toContain("## Methods");
  await rich.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rich.getByText("publisher artifact", { exact: true })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(disk).toBe(source);

  await open();
  const edited = source + "\nAn external edit.\n";
  await writeFile(file, edited);
  await bake.click();
  await expect(preview.getByRole("alert")).toHaveText("The source changed. Reopen the preview.");
  assert.equal(await disk(), edited);
  console.log("PASS: lazy clean layer, non-destructive preview, diff, bake, save, undo, and stale source rejection");
} finally { await app.close(); }
