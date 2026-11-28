import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fullSize, headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "embeds-desktop-"))), vault = path.join(root, "vault"), profile = path.join(root, "profile");
for (const folder of [vault, path.join(vault, "b"), profile]) await mkdir(folder, { recursive: true });
const record = (relative, content) => ({ id: relative, path: path.join(vault, relative), name: path.basename(relative), content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), bom: false, encoding: "utf-8", lineEnding: "\n" });
const topic = "# Señales\n\nVisible text\n\n# Other\n\nhidden\n";
const notes = { "home.md": "# Home\n\n![[Topic#Señales]]\n\nAfter\n", "other.md": "# Second consumer\n\n![[b/Topic#Señales]]\n", "b/Topic.md": topic };
for (const [relative, content] of Object.entries(notes)) await writeFile(path.join(vault, relative), content);
const documents = Object.entries(notes).map(([relative, content]) => record(relative, content));
await writeFile(path.join(profile, "session.json"), JSON.stringify({ version: 1, folder: vault, activeId: "home.md", documents }));
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: profile, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ args: [process.cwd(), ...headlessArguments], env });
try {
  const page = await application.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await fullSize(application, page);
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  const open = async relative => {
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("app:command", { action: "opened", document: id }), documents.find(item => item.id === relative));
    await expect(rich.getByRole("heading", { level: 1 }).first()).toHaveText(relative === "b/Topic.md" ? "Señales" : relative === "home.md" ? "Home" : "Second consumer");
  };
  const embed = rich.locator(".note-embed");
  await expect(embed.locator(".note-embed-body")).toContainText("Visible text");
  await expect(embed).not.toContainText("hidden");
  await expect(embed.locator(".note-embed-path")).toHaveText("b/Topic.md");

  await open("b/Topic.md");
  await rich.getByText("Visible text", { exact: true }).click();
  await page.keyboard.press("End"); await page.keyboard.type(" plus draft");
  await open("other.md");
  await expect(embed.locator(".note-embed-body")).toContainText("Visible text plus draft");
  await open("home.md");
  await expect(embed.locator(".note-embed-body")).toContainText("Visible text plus draft");
  assert.equal(await readFile(path.join(vault, "b/Topic.md"), "utf8"), topic);

  await embed.locator("a.note-embed-open").click();
  await expect(rich.getByRole("heading", { level: 1 }).first()).toHaveText("Señales");
  await open("home.md");
  await rich.getByRole("heading", { name: "Home", exact: true }).click();
  await page.keyboard.press("End"); await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(rich.getByRole("heading", { level: 1 }).first()).toHaveText("Señales");
  await open("home.md");
  assert.equal(await readFile(path.join(vault, "home.md"), "utf8"), notes["home.md"]);
  await rich.getByRole("heading", { name: "Home", exact: true }).click();
  await page.keyboard.press("End"); await page.keyboard.press("ArrowDown"); await page.keyboard.type("Z");
  await page.locator(".source-toggle").click();
  const source = page.locator(".document-editor:not([hidden]) .source-surface:not([hidden]) .cm-content");
  await expect(source).toBeVisible();
  assert.equal((await source.locator(".cm-line").allTextContents()).join("\n"), "# Home\n\nZ![[Topic#Señales]]\n\nAfter\n");
  await page.keyboard.press("ControlOrMeta+z");
  await page.locator(".source-toggle").click();
  await expect(embed.locator(".note-embed-body")).toContainText("Visible text plus draft");

  const htmlPath = path.join(root, "export.html");
  await application.evaluate(({ dialog, BrowserWindow }, htmlPath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: htmlPath });
    BrowserWindow.getAllWindows()[0].webContents.send("app:command", { action: "html" });
  }, htmlPath);
  await expect.poll(async () => { try { return (await readFile(htmlPath, "utf8")).includes("Visible text plus draft"); } catch { return false; } }).toBe(true);
  const html = await readFile(htmlPath, "utf8");
  assert.match(html, /<div class="note-embed"[^>]*><span class="note-embed-head"><a [^>]*href="b\/Topic\.md"[^>]*>Señales<\/a>/);
  assert.match(html, /<div class="note-embed-body"><h1[^>]*>Señales<\/h1>\s*<p>Visible text plus draft<\/p>/);
  assert.ok(!html.includes(">hidden<")); assert.ok(!html.includes("data-embed-stamp"));
  assert.deepEqual(errors, []);
  console.log("PASS: section embeds update from drafts in two notes, open their source by click and Ctrl/Cmd+Enter, and freeze into HTML export");
} finally { await application.close(); }
