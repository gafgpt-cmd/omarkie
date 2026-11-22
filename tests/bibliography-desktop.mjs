import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), "omarkie-citations-ui-"));
const vault = path.join(scratch, "vault"), profile = path.join(scratch, "profile");
await Promise.all([mkdir(vault), mkdir(profile)]);
const note = path.join(vault, "note.md"), manual = path.join(scratch, "manual.json"), zotero = path.join(scratch, "zotero.json");
const pdf = path.join(scratch, "Paper.pdf"), replacement = path.join(scratch, "replacement.json");
const original = "# Evidence\n\nRich citation: \r\n\nSource citation: \n";
const item = (id, title, extra) => ({ id, type: "article-journal", title, ...extra });
await Promise.all([
  writeFile(note, original),
  writeFile(manual, JSON.stringify([item("initial", "Imported reference")])),
  writeFile(zotero, JSON.stringify([item("initial", "Watched reference", { author: [{ family: "García" }], "omarkie-pdf": [pdf] })])),
  writeFile(pdf, "%PDF-1.7\n"),
  writeFile(path.join(profile, "session.json"), JSON.stringify({ version: 1, folder: vault, activeId: "note", documents: [{ id: "note", path: note, name: "note.md", content: original, savedContent: original, diskHash: createHash("sha256").update(original).digest("hex"), encoding: "utf-8", bom: false, lineEnding: "\n" }] })),
]);
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: profile, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL;
delete env.ELECTRON_RUN_AS_NODE;
const useViewer = process.platform === "linux" && process.env.OMARKIE_VERIFY_PDF_READER === "1";
const viewed = path.join(scratch, "opened.txt");
if (useViewer) {
  const applications = path.join(env.XDG_DATA_HOME, "applications");
  await mkdir(applications, { recursive: true });
  await mkdir(env.XDG_CONFIG_HOME, { recursive: true });
  await writeFile(path.join(applications, "omarkie-pdf-test.desktop"), `[Desktop Entry]\nType=Application\nName=PDF test reader\nExec=pdftotext %f "${viewed}"\nMimeType=application/pdf;\n`);
  await writeFile(path.join(env.XDG_CONFIG_HOME, "mimeapps.list"), "[Default Applications]\napplication/pdf=omarkie-pdf-test.desktop\n");
  env.XDG_CURRENT_DESKTOP = "GNOME";
}
const app = await electron.launch({ args: [root, ...headlessArguments], env });
try {
  const page = await app.firstWindow(), requests = [];
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  const source = page.locator(".document-editor:not([hidden]) .source-surface:not([hidden]) .cm-content");
  const panel = page.getByRole("dialog", { name: "Document tools" });
  const suggestions = page.getByRole("listbox", { name: "Citation suggestions" });
  const bibliography = panel.getByLabel("CSL JSON bibliography");
  async function writing() {
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Document tools…", exact: true }).click();
    await panel.getByRole("button", { name: "Writing and export" }).click();
  }
  async function dismiss() { await page.keyboard.press("Escape"); await expect(panel).toBeHidden(); }
  await expect(rich.getByRole("heading", { name: "Evidence" })).toBeVisible();
  await assert.rejects(stat(path.join(profile, "bibliographies")), { code: "ENOENT" });
  await writing();
  await panel.getByLabel("Import CSL JSON").setInputFiles(manual);
  await expect(bibliography).toHaveValue(/Imported reference/);
  await page.reload();
  await expect(rich.getByRole("heading", { name: "Evidence" })).toBeVisible();
  await writing();
  await expect(bibliography).toHaveValue(/Imported reference/);
  await app.evaluate(({ dialog, shell }, { file, useViewer }) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    if (!useViewer) shell.openPath = async target => { globalThis.openedCitationPdf = target; return ""; };
  }, { file: zotero, useViewer });
  await panel.getByRole("button", { name: "Link Zotero auto-export" }).click();
  await expect(bibliography).toHaveValue(/Watched reference/);
  await dismiss();

  const richLine = rich.getByText("Rich citation:", { exact: false });
  await richLine.click(); await page.keyboard.press("End"); await page.keyboard.type("[@García");
  await expect(suggestions.getByRole("option", { name: /initial.*Watched reference/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(richLine).toContainText("[@initial]");
  await page.keyboard.press("ArrowLeft");
  if (useViewer) {
    const bytes = await app.evaluate(async ({ BrowserWindow }) => {
      const fixture = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
      try {
        await fixture.loadURL("data:text/html,%3Ch1%3EEvidence%20PDF%20fixture%3C%2Fh1%3E");
        return [...await fixture.webContents.printToPDF({})];
      } finally { fixture.destroy(); }
    });
    await writeFile(pdf, Buffer.from(bytes));
    await assert.rejects(stat(viewed), { code: "ENOENT" });
    await page.keyboard.press("Alt+Enter");
    await expect.poll(() => readFile(viewed, "utf8").catch(() => "")).toContain("Evidence PDF fixture");
  } else {
    assert.equal(await app.evaluate(() => globalThis.openedCitationPdf), undefined);
    await page.keyboard.press("Alt+Enter");
    await expect.poll(() => app.evaluate(() => globalThis.openedCitationPdf)).toBe(await realpath(pdf));
  }

  await writing();
  await writeFile(zotero, "[");
  await expect(panel.getByRole("alert")).toContainText("Using the last valid bibliography");
  await expect(bibliography).toHaveValue(/Watched reference/);
  await writeFile(replacement, JSON.stringify([item("updated", "Live replacement 研究方法")]));
  await rename(replacement, zotero);
  await expect(bibliography).toHaveValue(/Live replacement/);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await dismiss();
  await page.locator(".source-toggle").click();
  const sourceLine = source.getByText("Source citation:", { exact: false });
  await sourceLine.click(); await page.keyboard.press("End"); await page.keyboard.type("[@研究");
  await expect(sourceLine).toContainText("[@研究");
  await expect(suggestions.getByRole("option", { name: /updated.*Live replacement/ })).toBeVisible();
  await page.keyboard.press("Tab"); await expect(sourceLine).toContainText("[@updated]");
  await page.keyboard.press("ControlOrMeta+z"); await expect(sourceLine).toContainText("[@研究");
  await expect(sourceLine).not.toContainText("[@updated]");
  assert.deepEqual(requests, []);
  assert.deepEqual(errors, []);
  console.log("PASS: vault import, Zotero replacement, rich and source completion, undo, explicit PDF, no network");
} finally { await app.close(); }
