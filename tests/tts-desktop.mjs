import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const scratch = await mkdtemp(path.join(os.tmpdir(), "omarkie-tts-"));
const note = path.join(scratch, "read.md"), hook = path.join(scratch, "speech hook.cjs"), log = path.join(scratch, "spoken.json");
const selected = "Only café $(literal) 理解.";
const markdown = `**Read** this [label](https://example.invalid).\n\n${selected}\n\nSkip. **Keep this.**`;
await writeFile(note, markdown, "utf8");
await writeFile(hook, `const { readFileSync, writeFileSync } = require("node:fs");
const [file, flag] = process.argv.slice(2);
const text = readFileSync(0, "utf8");
writeFileSync(file, JSON.stringify({ pid: process.pid, flag, text }));
setInterval(() => {}, 1000);
`, "utf8");

async function withApp(name, configured, run) {
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: path.join(scratch, name), OMARKIE_LANGUAGE: "en" });
  delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL; delete env.OMARKIE_TTS;
  if (configured) env.OMARKIE_TTS = configured;
  const app = await electron.launch({ args: [process.cwd(), ...headlessArguments, note], env, timeout: 30_000 });
  try {
    const page = await app.firstWindow();
    const paragraphs = page.locator(".document-editor:not([hidden]) .rich-document p");
    await expect(paragraphs).toHaveCount(3);
    await run(page, paragraphs);
  } finally { await app.close(); }
}

async function command(page, name) {
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
async function spoken(text) {
  let record;
  await expect.poll(async () => {
    const json = await readFile(log, "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return ""; });
    try { record = JSON.parse(json); } catch { return null; }
    return { text: record.text, flag: record.flag };
  }).toEqual({ text, flag: "fixed argument" });
  process.kill(record.pid, 0);
  return record.pid;
}
async function stopped(pid) {
  await expect.poll(() => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code !== "ESRCH") throw error; return false; }
  }).toBe(false);
}

await withApp("configured", JSON.stringify([process.execPath, hook, log, "fixed argument"]), async (page, paragraphs) => {
  assert.equal(existsSync(log), false, "a configured hook does not start at launch");
  await command(page, "Stop reading");
  assert.equal(existsSync(log), false, "stop does not start a hook");

  await paragraphs.nth(1).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await command(page, "Read selection or paragraph");
  const selectionPid = await spoken(selected);
  await command(page, "Stop reading");
  await stopped(selectionPid);

  await paragraphs.first().click();
  await command(page, "Read selection or paragraph");
  const paragraphPid = await spoken("Read this label.");

  await page.locator(".source-toggle").click();
  await page.locator(".document-editor:not([hidden]) .cm-content").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Home");
  for (let index = 0; index < "Skip. ".length; index++) await page.keyboard.press("ArrowRight");
  await command(page, "Read from cursor");
  const cursorPid = await spoken("**Keep this.**");
  await stopped(paragraphPid);
  await command(page, "Stop reading");
  await stopped(cursorPid);
  await expect(page.locator(".toast")).toHaveCount(0);
});

await withApp("unconfigured", null, async (page, paragraphs) => {
  await paragraphs.first().click();
  await command(page, "Read selection or paragraph");
  await expect(page.locator(".toast")).toContainText("Read aloud is not configured. Set OMARKIE_TTS.");
  await expect(paragraphs.nth(1)).toHaveText(selected);
});

await withApp("missing-executable", path.join(scratch, "not installed"), async (page, paragraphs) => {
  await paragraphs.first().click();
  await command(page, "Read selection or paragraph");
  await expect(page.locator(".toast")).toContainText("Could not start the speech program. Check OMARKIE_TTS.");
});
assert.equal(await readFile(note, "utf8"), markdown);
console.log("PASS: lazy local speech; literal selection, rich paragraph, source cursor, stop, replacement and hook notices");
