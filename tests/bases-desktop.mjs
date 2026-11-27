import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fullSize, headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bases-desktop-"))), vault = path.join(root, "vault"), profile = path.join(root, "profile");
for (const folder of [vault, path.join(vault, "Library"), profile]) await mkdir(folder, { recursive: true });
const qa = process.env.OMARKIE_QA_DIR || path.join(root, "qa"); await mkdir(qa, { recursive: true });
const book = (author, pages, status, extra = "") => `---\nauthor: ${author}\npages: ${pages}\nread: 0\nstatus: ${status}\npublished: 1900\n${extra}---\n# ${author}\n\nNotes here.\n`;
const notes = {
  "home.md": "# Home\n\nStart.\n",
  "Library/Moby.md": book("Melville", 600, "reading"),
  "Library/Dune.md": book("Herbert", 500, "todo"),
  "Library/Emma.md": book("Austen", 400, "todo"),
  "Library/Ulysses.md": book("Joyce", 700, "done"),
  "Library/Old.md": book("Anon", 900, "todo", "tags: [archive]\n"),
  "Outside.md": book("Elsewhere", 1000, "todo"),
};
for (const [relative, content] of Object.entries(notes)) await writeFile(path.join(vault, relative), content);
const reading = await readFile(path.join(repository, "tests/fixtures/bases/reading.base"), "utf8");
await writeFile(path.join(vault, "reading.base"), reading);
const home = { id: "home.md", path: path.join(vault, "home.md"), name: "home.md", content: notes["home.md"], savedContent: notes["home.md"], diskHash: createHash("sha256").update(notes["home.md"]).digest("hex"), bom: false, encoding: "utf-8", lineEnding: "\n" };
await writeFile(path.join(profile, "session.json"), JSON.stringify({ version: 1, folder: vault, activeId: "home.md", documents: [home] }));

async function launch(language) {
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: profile, OMARKIE_LANGUAGE: language });
  delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [repository, ...headlessArguments], env });
  const page = await application.firstWindow(), errors = [], outbound = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/^https?:/.test(request.url())) outbound.push(request.url()); });
  await fullSize(application, page);
  await page.evaluate(() => localStorage.setItem("omarkie-autosave", "false"));
  return { application, page, errors, outbound };
}
async function theme(page, name) {
  await page.evaluate(name => { localStorage.setItem("omarkie-theme", name); localStorage.setItem("omarkie-theme-chosen", "true"); }, name);
  await page.reload(); await page.locator(".app-shell").waitFor();
}

let { application, page, errors, outbound } = await launch("en");
try {
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  const dialog = page.getByRole("dialog", { name: "reading", exact: true });
  const rows = dialog.locator("tr.base-row");
  const names = () => rows.locator("td.base-name").allTextContents();
  await expect(rich.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await page.reload(); await page.locator(".app-shell").waitFor();

  await page.getByRole("button", { name: "reading.base", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".base-path")).toHaveText("reading.base · Read-only");
  await expect(dialog.getByRole("tab")).toHaveText(["Unread", "All books"]);
  await expect(dialog.getByRole("tab", { name: "Unread" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(names).toEqual(["Moby", "Dune"]);
  await expect(dialog.locator("th")).toHaveText(["Title", "Author", "pages"]);
  await expect(dialog.locator(".base-count")).toHaveText("Showing 2 of 3 notes");
  await expect(dialog.locator(".base-notice")).toHaveText(["Formula \"pages_left\" is not calculated."]);
  await expect(dialog.locator("th.base-number")).toHaveText(["pages"]);
  await dialog.screenshot({ path: path.join(qa, "bases-light-en.png") });

  await dialog.getByRole("tab", { name: "Unread" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("tab", { name: "All books" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("tab", { name: "All books" })).toBeFocused();
  await expect.poll(async () => (await names()).length).toBe(5);
  await expect(dialog.locator(".base-count")).toHaveText("Notes: 5");
  await page.keyboard.press("Home");
  await expect(dialog.getByRole("tab", { name: "Unread" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(names).toEqual(["Moby", "Dune"]);

  await page.keyboard.press("Tab");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await dialog.screenshot({ path: path.join(qa, "bases-keyboard-en.png") });
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(rich.getByRole("heading", { level: 1 }).first()).toHaveText("Herbert");

  await rich.getByText("Notes here.", { exact: true }).click();
  await page.keyboard.press("End"); await page.keyboard.type(" #archive");
  await page.getByRole("button", { name: "reading.base", exact: true }).click();
  await expect.poll(names).toEqual(["Moby", "Emma"]);
  await expect(dialog.locator(".base-count")).toHaveText("Notes: 2");
  assert.equal(await readFile(path.join(vault, "Library/Dune.md"), "utf8"), notes["Library/Dune.md"], "draft stays unsaved");

  await writeFile(path.join(vault, "Library/Moby.md"), book("Melville", 600, "done"));
  await writeFile(path.join(vault, "Library/New.md"), book("Fresh", 800, "todo"));
  await expect.poll(names, { timeout: 15_000 }).toEqual(["New", "Emma"]);
  await rename(path.join(vault, "Library/New.md"), path.join(vault, "Outside-new.md"));
  await expect.poll(names, { timeout: 15_000 }).toEqual(["Emma"]);
  await expect(dialog.locator(".base-count")).toHaveText("Notes: 1");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await theme(page, "dark");
  await page.getByRole("button", { name: "reading.base", exact: true }).click();
  await expect(dialog.locator(".base-count")).toHaveText(/^Notes: \d+$/);
  await dialog.screenshot({ path: path.join(qa, "bases-dark-en.png") });
  assert.equal(await readFile(path.join(vault, "reading.base"), "utf8"), reading, "the base file is never written");
  assert.deepEqual(errors, []);
  assert.deepEqual(outbound, []);
} finally { await application.close(); }

({ application, page, errors, outbound } = await launch("es"));
try {
  const dialog = page.getByRole("dialog", { name: "reading", exact: true });
  for (const [name, file] of [["light", "bases-light-es.png"], ["dark", "bases-dark-es.png"]]) {
    await theme(page, name);
    await page.getByRole("button", { name: "reading.base", exact: true }).click();
    await expect(dialog.locator(".base-path")).toHaveText("reading.base · Solo lectura");
    await expect(dialog.locator(".base-count")).toHaveText(/^Notas: \d+$/);
    await dialog.screenshot({ path: path.join(qa, file) });
    await page.keyboard.press("Escape");
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(outbound, []);
} finally { await application.close(); }
console.log("PASS: a .base opens from the sidebar as a read-only table, switches views and rows by keyboard, follows drafts and external edits/renames without writing the base");
