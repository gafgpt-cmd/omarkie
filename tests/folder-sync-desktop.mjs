import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { _electron as launch, expect } from "playwright/test";
import { conflictCopy } from "../shared/sync-conflicts.mjs";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// Folder sync on the desktop: a sync app (Syncthing-style temp file + rename, old timestamps) changes,
// copies, deletes and moves an open note. Every outcome is decided by the person, never by a clock;
// nothing is lost and nothing leaves the machine. Runs in English and Spanish; OMARKIE_QA_DIR adds
// light/dark screenshots of the banner and the compare dialog.
const qa = process.env.OMARKIE_QA_DIR;
if (qa) await mkdir(qa, { recursive: true });
// Native Trash rejects system-temporary mounts: keep fixtures on the same disk as the isolated Trash.
const fixtureRoot = qa ? path.dirname(path.resolve(qa)) : "test-results";
await mkdir(fixtureRoot, { recursive: true });
const sha = text => createHash("sha256").update(text).digest("hex");
const old = new Date("2020-01-01T00:00:00Z");

// Write like a sync engine: temp file beside the target, then rename, keeping the remote's old mtime.
async function syncWrite(file, text) {
  const temp = path.join(path.dirname(file), `.syncthing.${path.basename(file)}.tmp`);
  await writeFile(temp, text);
  await utimes(temp, old, old);
  await rename(temp, file);
}

async function scenario(language) {
  const catalogue = JSON.parse(await readFile(new URL(`../shared/locales/${language}.json`, import.meta.url), "utf8"));
  const tr = (key, values = {}) => (catalogue[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => values[name]);
  const home = await mkdtemp(path.resolve(fixtureRoot, `omarkie-folder-sync-${language}-`)), vault = path.join(home, "vault");
  const note = path.join(vault, "notes", "Plan.md"), source = "# Plan\n\nPack the charts.\n";
  await mkdir(path.dirname(note), { recursive: true });
  await writeFile(note, source);
  await mkdir(path.join(vault, ".stfolder"));
  const record = { id: "plan", path: note, name: "Plan.md", content: source, savedContent: source, diskHash: sha(source), lineEnding: "\n" };
  await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: language });
  delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
  const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env, timeout: 30_000 });
  const network = [], errors = [];
  let page;
  // Screenshots in both app themes, switched through the app's own theme sync so open dialogs stay open.
  async function shoot(name) {
    if (!qa) return;
    const theme = value => page.evaluate(value => window.dispatchEvent(new StorageEvent("storage", { key: "omarkie-theme", newValue: value })), value);
    for (const scheme of ["light", "dark"]) {
      await theme(scheme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      await page.screenshot({ path: path.join(qa, `folder-sync-${name}-${language}-${scheme}.png`) });
    }
    await theme("light");
  }
  try {
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1280, height: 860 }));
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (/^(https?|wss?):/.test(request.url())) network.push(request.url()); });
    const active = page.locator(".document-editor:not([hidden])");
    await expect(active.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();

    // 1. Dirty draft + the sync app replaces the file with an older timestamp: nothing auto-resolves.
    await page.locator(".source-toggle").click();
    const editor = active.locator(".cm-content");
    await editor.click();
    await editor.press("ControlOrMeta+End");
    await page.keyboard.insertText("Draft line from this laptop.\n");
    const remote = "# Plan\n\nPack the charts.\nRemote line from the phone.\n";
    await syncWrite(note, remote);
    const banner = page.locator(".conflict-banner[role=alert]");
    await expect(banner).toContainText(tr("文件在磁盘上已改变。当前草稿已保留。"));
    await shoot("banner");
    await banner.getByRole("button", { name: tr("Compare versions"), exact: true }).press("Enter");
    let dialog = page.getByRole("dialog", { name: tr("Compare versions") });
    await expect(dialog.getByRole("status")).toHaveText(tr("{{count}} lines differ. Changed lines are marked on each side._one", { count: 1 }));
    await expect(dialog.getByRole("region", { name: tr("{{label}}, text", { label: tr("On disk now") }) })).toContainText("Remote line from the phone.");
    await shoot("compare");
    // Keyboard path: Tab from Cancel reaches the actions; Enter keeps the draft.
    await dialog.getByRole("button", { name: tr("取消"), exact: true }).focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: tr("Keep my draft"), exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(banner).toHaveCount(0);
    assert.match(await readFile(note, "utf8"), /Draft line from this laptop\./);
    let siblings = await readdir(path.dirname(note));
    const diskCopy = siblings.find(name => conflictCopy(name)?.origin === "disk");
    assert.ok(diskCopy, `the replaced disk version is kept beside the note: ${siblings}`);
    assert.equal(await readFile(path.join(path.dirname(note), diskCopy), "utf8"), remote);

    // 2. Syncthing's own conflict copy arrives: compare and adopt it; the note being replaced goes to the Trash.
    const syncthingCopy = "Plan.sync-conflict-20200101-000000-PHONE01.md", phone = "# Plan\n\nPhone rewrite of the plan.\n";
    await syncWrite(path.join(path.dirname(note), syncthingCopy), phone);
    const syncBanner = page.locator(".sync-banner");
    await expect(syncBanner).toContainText(tr("A sync app kept another version of this note."), { timeout: 15_000 });
    await syncBanner.getByRole("button", { name: tr("Compare versions"), exact: true }).click();
    dialog = page.getByRole("dialog", { name: tr("Compare versions") });
    const select = dialog.getByRole("combobox");
    await select.selectOption(await select.locator("option", { hasText: "PHONE01" }).getAttribute("value"));
    await expect(dialog.getByRole("region", { name: tr("{{label}}, text", { label: tr("Other version") }) })).toContainText("Phone rewrite of the plan.");
    await shoot("copies");
    await dialog.getByRole("button", { name: tr("Use other version"), exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(active).toContainText("Phone rewrite of the plan.");
    assert.equal(await readFile(note, "utf8"), phone);
    siblings = await readdir(path.dirname(note));
    assert.ok(!siblings.includes(syncthingCopy), "the adopted copy became the note");
    const trash = path.join(home, "share", "Trash", "files");
    assert.ok((await readdir(trash).catch(() => [])).some(name => name.startsWith("Plan")), "the replaced note is recoverable from the Trash");

    // 3. The remaining Omarkie copy: keep this note, the copy goes to the Trash.
    await syncBanner.getByRole("button", { name: tr("Compare versions"), exact: true }).click();
    await dialog.getByRole("button", { name: tr("Keep this note"), exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(syncBanner).toHaveCount(0);
    assert.deepEqual(await readdir(path.dirname(note)), ["Plan.md"]);

    // 4. The sync app deletes the open note: the text stays and one click restores the file.
    await rm(note);
    await expect(banner).toContainText(tr("This note is gone from disk: deleted or moved away by another app. Your text is kept here."));
    await banner.getByRole("button", { name: tr("Restore file"), exact: true }).click();
    await expect(banner).toHaveCount(0);
    assert.equal(await readFile(note, "utf8"), phone);

    // 5. The sync app moves the note to another folder: Omarkie follows the identical file.
    const moved = path.join(vault, "archive", "Plan.md");
    await mkdir(path.dirname(moved));
    await rename(note, moved);
    await expect(page.locator(".toast")).toContainText(tr("“{{name}}” was renamed or moved on disk. Omarkie followed it.", { name: "Plan.md" }), { timeout: 15_000 });
    await expect(banner).toHaveCount(0);
    await editor.press("ControlOrMeta+End");
    await page.keyboard.insertText("Saved after the move.\n");
    await page.keyboard.press("ControlOrMeta+S");
    await expect.poll(() => readFile(moved, "utf8")).toContain("Saved after the move.");
    assert.deepEqual(await readdir(path.join(vault, "notes")), []);

    assert.deepEqual(network, [], "folder sync never contacts the network");
    assert.deepEqual(errors, []);
  } catch (error) {
    if (qa) await page?.screenshot({ path: path.join(qa, `folder-sync-failure-${language}.png`) }).catch(() => {});
    throw error;
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}

await scenario("en");
await scenario("es");
console.log("Folder sync desktop: compare and keep draft, adopt Syncthing copy, drop own copy, restore deleted, follow moved; no network");
