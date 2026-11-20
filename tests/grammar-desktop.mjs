import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "playwright/test";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), "omarkie-grammar-"));
const file = path.join(directory, "sample.md"), note = "# Sample\r\n\r\nA 🐈 **are** here.\n";
await writeFile(file, note);
await writeFile(path.join(directory, "session.json"), JSON.stringify({ version: 1, activeId: "sample", documents: [{
  id: "sample", path: await realpath(file), name: "sample.md", content: note, savedContent: note,
  diskHash: createHash("sha256").update(note).digest("hex"), bom: false, encoding: "utf-8", lineEnding: "\r\n",
}] }));
const requests = [];
const server = createServer(async (request, response) => {
  let form = "";
  for await (const chunk of request.setEncoding("utf8")) form += chunk;
  const body = new URLSearchParams(form), text = body.get("text");
  requests.push([request.method, request.url, text, body.get("language")]);
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ matches: [{
    offset: text?.indexOf("are"), length: 3, message: "Use a singular verb.", replacements: [{ value: "is" }],
  }] }));
});
server.listen(0, "127.0.0.1");
let application;
try {
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}/v2/check`;
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: directory, OMARKIE_LANGUAGE: "en" });
  delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [root, ...headlessArguments], env });
  const page = await application.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  const check = page.getByRole("button", { name: "Check grammar…" });
  const confirm = page.getByRole("dialog", { name: "Send to LanguageTool?" });
  const fix = page.getByRole("dialog", { name: "Grammar quick fix" });
  const settings = page.getByRole("dialog", { name: "Preferences" });
  const enable = settings.getByLabel("Enable on-demand grammar checks");
  const endpointField = settings.getByLabel("LanguageTool check URL");
  const openPreferences = async () => {
    await page.getByRole("button", { name: "Omarkie", exact: true }).click();
    await page.getByRole("menuitem", { name: "Preferences…", exact: true }).click();
    await expect(settings).toBeVisible();
  };
  await expect(rich.getByRole("heading", { name: "Sample" })).toBeVisible();
  await page.evaluate(() => localStorage.setItem("omarkie-autosave", "false"));
  const startup = [];
  page.on("request", request => startup.push(request.url()));
  await page.reload();
  await expect(rich.getByRole("heading", { name: "Sample" })).toBeVisible();
  await expect(check).toHaveCount(0);
  assert.deepEqual(startup.filter(url => /\/GrammarCheck-[^/]+\./.test(url)), []);
  assert.deepEqual(requests, []);

  await openPreferences(); await enable.check();
  await expect(endpointField).toHaveValue("http://127.0.0.1:8081/v2/check");
  await endpointField.fill("https://first.invalid/v2/check");
  await settings.getByLabel("Allow this origin: https://first.invalid").check();
  await endpointField.fill("https://first.invalid:8443/v2/check");
  await expect(settings.getByLabel("Allow this origin: https://first.invalid:8443")).not.toBeChecked();
  await page.keyboard.press("Escape");
  await check.click();
  await expect(page.getByText("Allow this LanguageTool origin in Preferences first.")).toBeVisible();
  assert.deepEqual(requests, []);

  await openPreferences(); await endpointField.fill(endpoint); await page.keyboard.press("Escape");
  await check.click(); await expect(confirm.getByText(endpoint, { exact: true })).toBeVisible();
  await expect(confirm).toContainText("Do not send patient data");
  assert.deepEqual(requests, []);
  await page.keyboard.press("Escape"); await expect(confirm).toBeHidden();
  assert.deepEqual(requests, []);
  await check.click(); await confirm.getByRole("button", { name: "Send note" }).click();
  await expect(page.getByLabel("Grammar findings")).toBeVisible();
  assert.deepEqual(requests, [["POST", "/v2/check", note.replaceAll("\r\n", "\n"), "auto"]]);
  const marks = () => page.evaluate(() => Array.from(CSS.highlights.get("omarkie-grammar") ?? [], range => range.toString()));
  await expect.poll(marks).toEqual(["are"]);
  assert.equal(await readFile(file, "utf8"), note);
  const toggle = page.locator(".source-toggle");
  await toggle.click(); await expect(page.locator(".source-surface:not([hidden]) .cm-content")).toBeVisible();
  await expect.poll(marks).toEqual(["are"]);
  await toggle.click(); await expect(rich).toBeVisible();
  await expect.poll(marks).toEqual(["are"]);
  const { x, y } = await page.evaluate(() => {
    const rect = [...CSS.highlights.get("omarkie-grammar")][0].getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(x, y); await expect(fix).toBeVisible();
  if (process.env.OMARKIE_QA_DIR) await page.screenshot({ path: path.join(process.env.OMARKIE_QA_DIR, "grammar-quick-fix.png") });
  await fix.getByRole("button", { name: "is", exact: true }).click();
  await expect(rich.locator("strong")).toHaveText("is");
  await expect.poll(marks).toEqual([]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rich.locator("strong")).toHaveText("are");
  await openPreferences(); await enable.uncheck(); await page.keyboard.press("Escape");
  await expect(check).toHaveCount(0);
  await rich.locator("p").filter({ hasText: "are" }).click(); await page.keyboard.type("x");
  assert.equal(requests.length, 1);
  assert.equal(await readFile(file, "utf8"), note);
  assert.deepEqual(errors, []);
  console.log("PASS: no startup/edit requests; explicit POST; rich/source marks; quick fix and undo");
} finally {
  await application?.close();
  server.close();
}
