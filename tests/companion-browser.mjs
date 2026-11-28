import { chromium, expect } from "playwright/test";
import { preview } from "vite";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { conflictCopy, copiesOf } from "../shared/sync-conflicts.mjs";

// Phone companion on the built PWA: import a synthetic vault, read, search and edit it offline,
// survive a suspend that kills the tab, export changes as conflict copies, remove it cleanly.
// Run after `npm run build`. OMARKIE_QA_DIR adds light/dark, English/Spanish screenshots.
const scratch = await mkdtemp(path.join(os.tmpdir(), "omarkie-companion-")), vault = path.join(scratch, "field-vault");
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const files = {
  "index.md": "# Field index\n\nStart at the harbor.\n\n![Harbor](photos/harbor.png)\n",
  "logs/Harbor log.md": "# Harbor log\n\nThe keeper counted forty-two gulls.\n",
  "photos/harbor.png": pixel,
  "boards/plan.base": "views: []\n",
  ".obsidian/app.json": "{}",
  ".stversions/index~20240101-101010.md": "# Old index\n",
};
for (const [name, content] of Object.entries(files)) {
  await mkdir(path.dirname(path.join(vault, name)), { recursive: true });
  await writeFile(path.join(vault, name), content);
}
const qa = process.env.OMARKIE_QA_DIR;
const server = await preview({ preview: { host: "127.0.0.1", port: 0 } });
const url = server.resolvedUrls.local[0], origin = new URL(url).origin;

async function importVault(page, labels) {
  // The editor takes focus once the session restores; start the keyboard path after that.
  await expect(page.locator(".document-editor:not([hidden])")).toBeVisible();
  await page.getByRole("button", { name: labels.companion, exact: true }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: labels.companion });
  await expect(dialog.getByRole("status")).toHaveText(labels.empty);
  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: labels.importFolder, exact: true }).press("Enter");
  await (await chooser).setFiles(vault);
  await expect(dialog.locator("dl")).toContainText("field-vault");
  return dialog;
}
async function showTree(page, label = "File Tree") {
  await page.locator(".sidebar-switcher").click();
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
}

let browser, page;
const requests = [], errors = [];
try {
  browser = await chromium.launch({ executablePath: process.env.OMARKIE_BROWSER_EXECUTABLE });
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  context.on("request", request => requests.push(`${request.method()} ${request.url()}`));
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);

  const labels = { companion: "Phone companion", empty: "No vault on this device yet.", importFolder: "Import folder…" };
  let dialog = await importVault(page, labels);
  await expect(page.locator(".toast")).toContainText("Import finished: notes 2, photos 1, other files skipped 3.");
  await expect(dialog.locator("dl")).toContainText("Notes2Photos1");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await showTree(page);
  const tree = page.getByRole("tree");
  await tree.getByRole("button", { name: "index.md", exact: true }).click();
  const active = page.locator(".document-editor:not([hidden])");
  await expect(active.getByRole("heading", { name: "Field index" })).toBeVisible();
  const photo = active.locator("img").first();
  await expect.poll(() => photo.evaluate(image => image.complete && image.naturalWidth > 0), { message: "imported photo decodes from this device" }).toBe(true);

  await page.keyboard.press("ControlOrMeta+Shift+F");
  const search = page.getByRole("dialog", { name: "Search Folder Contents" });
  await search.getByRole("textbox").fill("gulls");
  await search.getByRole("button", { name: /forty-two gulls/ }).click();
  await expect(active.getByRole("heading", { name: "Harbor log" })).toBeVisible();

  await page.locator(".source-toggle").click();
  const editor = active.locator(".cm-content");
  await editor.click();
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("The keeper saw a seal.\n");
  await page.keyboard.press("ControlOrMeta+S");
  await expect(page.locator(".title-edited")).toHaveCount(0);
  await page.keyboard.insertText("Unsaved line before suspend.\n");
  await expect(editor).toContainText("Unsaved line before suspend.");
  // The phone hides the tab, then kills it: the hide alone must have stored the draft.
  const stored = await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    return localStorage.getItem("omarkie-session-v1");
  });
  assert.match(stored, /Unsaved line before suspend\./);
  await context.setOffline(true);
  await page.close();

  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url);
  const reopened = page.locator(".document-editor:not([hidden])");
  await expect(reopened).toContainText("Unsaved line before suspend.");
  await showTree(page);
  await expect.poll(async () => (await page.getByRole("tree").getByRole("button").allTextContents()).sort(), { message: "the vault reopens offline with only its own notes" }).toEqual(["Harbor log.md", "index.md", "logs"]);
  await page.keyboard.press("ControlOrMeta+Shift+F");
  const offlineSearch = page.getByRole("dialog", { name: "Search Folder Contents" });
  await offlineSearch.getByRole("textbox").fill("seal");
  await expect(offlineSearch.getByRole("button", { name: /saw a seal/ })).toHaveCount(1);
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+S");
  await page.getByRole("button", { name: "Phone companion", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Phone companion" });
  await expect(dialog.locator("dl")).toContainText("Changed, not exported1");
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export changes", exact: true }).click();
  const archive = unzipSync(new Uint8Array(await readFile(await (await download).path())));
  const [entry, ...extra] = Object.keys(archive);
  assert.deepEqual(extra, [], "only the changed note is exported");
  assert.match(entry, /^logs\/Harbor log\.omarkie-conflict-\d{8}-\d{6}-companion\.md$/);
  assert.match(strFromU8(archive[entry]), /saw a seal\.\nUnsaved line before suspend\./);
  // Unzipping into the desktop vault adds a sibling copy beside the note and overwrites nothing.
  await writeFile(path.join(vault, entry), archive[entry]);
  assert.equal(await readFile(path.join(vault, "logs/Harbor log.md"), "utf8"), files["logs/Harbor log.md"]);
  assert.deepEqual(conflictCopy(path.basename(entry))?.origin, "companion");
  assert.equal(copiesOf("logs/Harbor log.md", [{ path: "logs/Harbor log.md", name: "Harbor log.md" }, { path: entry, name: path.basename(entry) }]).length, 1);
  await expect(dialog.locator("dl")).toContainText("Changed, not exported0");

  await dialog.getByRole("button", { name: "Remove from this device", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Remove this vault from this device?");
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("No vault on this device yet.");
  await page.keyboard.press("Escape");
  await page.reload();
  // No phantom mount: the folder is gone, the open note comes back as an unsaved draft with its text.
  await expect(page.locator(".document-editor:not([hidden])")).toContainText("Unsaved line before suspend.");
  await showTree(page);
  await expect(page.getByRole("tree").getByRole("button")).toHaveCount(0);

  assert.deepEqual(requests.filter(request => !request.startsWith(`GET ${origin}/`) && !/^GET (blob|data):/.test(request)), [], "the companion never uploads or calls out");
  assert.deepEqual(errors, []);
  await context.close();

  if (qa) {
    await mkdir(qa, { recursive: true });
    for (const [locale, scheme, words] of [
      ["en-US", "light", labels], ["en-US", "dark", labels],
      ["es-ES", "light", { companion: "Acompañante del móvil", empty: "Aún no hay ninguna bóveda en este dispositivo.", importFolder: "Importar carpeta…" }],
      ["es-ES", "dark", { companion: "Acompañante del móvil", empty: "Aún no hay ninguna bóveda en este dispositivo.", importFolder: "Importar carpeta…" }],
    ]) {
      const shots = await browser.newContext({ locale, viewport: { width: 1280, height: 860 } }), shot = await shots.newPage();
      await shots.addInitScript(theme => localStorage.setItem("omarkie-theme", theme), scheme);
      await shot.goto(url);
      await expect(shot.locator("html")).toHaveAttribute("data-theme", scheme);
      await importVault(shot, words);
      await shot.screenshot({ path: path.join(qa, `companion-${locale.slice(0, 2)}-${scheme}.png`) });
      await shot.keyboard.press("Escape");
      await showTree(shot, locale === "es-ES" ? "Árbol de archivos" : "File Tree");
      await shot.getByRole("tree").getByRole("button", { name: "index.md", exact: true }).click();
      await shot.screenshot({ path: path.join(qa, `companion-note-${locale.slice(0, 2)}-${scheme}.png`) });
      // Phone width: the reader hides the sidebar to read the note.
      await shot.setViewportSize({ width: 412, height: 860 });
      await shot.getByRole("button", { name: locale === "es-ES" ? "Mostrar u ocultar barra lateral" : "Toggle Sidebar", exact: true }).click();
      await shot.screenshot({ path: path.join(qa, `companion-phone-${locale.slice(0, 2)}-${scheme}.png`) });
      await shots.close();
    }
  }
  console.log("Companion: offline import, search, suspend-safe draft, conflict-copy export and clean removal verified; no outbound requests");
} catch (error) {
  console.error({ errors, page: await page?.locator("body").innerText().then(text => text.slice(0, 600)).catch(() => "closed") });
  throw error;
} finally {
  try { await browser?.close(); }
  finally { await server.close(); await rm(scratch, { recursive: true, force: true }); }
}
