import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";
const directory = await mkdtemp(path.join(os.tmpdir(), "omarkie-startup-"));
const content = "# Startup\n\nReadable restored text.\n\n```js\nconst answer = 42;\n```\n", file = path.join(directory, "startup.md");
await writeFile(file, content, "utf8");
await writeFile(path.join(directory, "session.json"), JSON.stringify({ version: 1, folder: directory, activeId: "startup", documents: [{ id: "startup", path: file, name: "startup.md", content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), bom: false, lineEnding: "\n" }] }), "utf8");
const env = { ...process.env, OMARKIE_DATA_DIR: directory, OMARKIE_LANGUAGE: "zh", OMARKIE_TRACE_STARTUP: "1" };
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [process.cwd()], env });
try {
  const page = await app.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await expect(page.locator(".rich-document:visible")).toContainText("Readable restored text.");
  await expect.poll(() => page.evaluate(() => performance.getEntriesByName("omarkie:first-document-painted").length)).toBe(1);
  const loaded = () => page.evaluate(() => performance.getEntriesByType("resource").map(entry => entry.name));
  assert.ok(!(await loaded()).some(url => /codeMirror-|clipboard-/.test(url)), "reading needs neither CodeMirror nor Turndown");
  assert.ok(!(await loaded()).some(url => /\/(?:en|es|ca|ro)-/.test(url)), "Chinese startup needs no translation catalogs");
  await expect(page.locator(".md-fence .hljs-keyword")).toHaveText("const");
  await page.keyboard.press("Control+/");
  const source = page.locator(".source-mode:visible .cm-content");
  await expect(source).toContainText("const answer = 42;");
  await source.click(); await page.keyboard.press("Control+End"); await page.keyboard.insertText("\nsource edit");
  await page.keyboard.press("Control+/");
  await expect(page.locator(".rich-document:visible")).toContainText("source edit");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".rich-document:visible")).not.toContainText("source edit");
  await page.locator(".md-fence").click();
  await expect(page.locator(".fence-editing .cm-content")).toContainText("const answer = 42;");
  assert.deepEqual(errors, []);
} finally { await app.close(); }

// An explicit file argument must become the first painted document without the restored session flashing first.
const explicitDirectory = await mkdtemp(path.join(os.tmpdir(), "omarkie-startup-explicit-"));
const big = "# 巨大会话文档\n\n" + Array.from({ length: 5600 }, (_, index) => `第 ${index} 段：恢复的会话内容不应在显式打开文件时先显示。Restored session text that must stay hidden.`).join("\n\n") + "\n";
const bigFile = path.join(explicitDirectory, "big-session.md"), smallFile = path.join(explicitDirectory, "explicit.md"), small = "# 显式文件\n\n显式打开的小文件。\n";
await writeFile(bigFile, big, "utf8"); await writeFile(smallFile, small, "utf8");
await writeFile(path.join(explicitDirectory, "session.json"), JSON.stringify({ version: 1, folder: explicitDirectory, activeId: "big", documents: [{ id: "big", path: bigFile, name: "big-session.md", content: big, savedContent: big, diskHash: createHash("sha256").update(big).digest("hex"), bom: false, lineEnding: "\n" }] }), "utf8");
const explicitEnv = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: explicitDirectory, OMARKIE_LANGUAGE: "zh" }); delete explicitEnv.OMARKIE_DEV_URL; delete explicitEnv.ELECTRON_RUN_AS_NODE;
const explicitApp = await electron.launch({ args: [process.cwd(), ...headlessArguments, smallFile], env: explicitEnv });
try {
  const page = await explicitApp.firstWindow(), started = Date.now(), errors = [], seen = [];
  page.on("pageerror", error => errors.push(error.message));
  let state;
  for (;;) {
    state = await page.evaluate(() => ({ title: document.title, name: document.querySelector(".document-title")?.textContent || "", heading: document.querySelector(".document-editor:not([hidden]) .rich-document h1")?.textContent || "", painted: performance.getEntriesByName("omarkie:first-document-painted").length > 0 })).catch(() => null);
    if (state) seen.push(state);
    if (state?.painted && state.title.startsWith("explicit.md") && state.heading.includes("显式文件")) break;
    assert.ok(Date.now() - started < 30000, `explicit file never painted: ${JSON.stringify(state)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  console.log(`explicit file painted ${Date.now() - started} ms after the first window (${big.length} chars restored session)`);
  assert.ok(!seen.some(item => /big-session/.test(item.title + item.name) || item.heading.includes("巨大会话文档")), "the restored session document became active before the explicit file");
  assert.equal(await page.locator(".document-editor:not([hidden]) .rich-document").getByText("巨大会话文档").count(), 0);
  assert.deepEqual(errors, []);
} finally { await explicitApp.close(); }
