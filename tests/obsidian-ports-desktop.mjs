// Obsidian ports end to end: Dataview fences and Spaced Repetition import on synthetic notes, through the Plugin Manager
// and keyboard, with notes left byte-identical. Proves the chunks load only when enabled and only after first paint.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "playwright/test";
import { fullSize, headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-obsidian-ports-"));
const vault = path.join(home, "vault");
const files = {
  "dashboard.md": "# Dashboard\n\n```dataview\nTABLE status, due FROM \"projects\" WHERE status = \"active\" SORT due ASC\n```\n\n```dataview\nLIST FROM #archive\n```\n",
  "projects/alpha.md": "---\nstatus: active\ndue: 2026-03-01\n---\n# Alpha\n\nSee [[beta]].\n",
  "projects/beta.md": "---\nstatus: done\ndue: 2026-02-01\ntags: [archive]\n---\n# Beta\n",
  "projects/gamma.md": "---\nstatus: active\ndue: 2026-01-15\n---\n# Gamma\n\nGamma body.\n",
  "cards.md": "# Cells\n\nMitochondria::Powerhouse of the cell\n\nWhat is ATP?\n?\nEnergy currency\n\nThe ==nucleus== holds DNA.\n",
};
await mkdir(path.join(vault, "projects"), { recursive: true });
for (const [name, content] of Object.entries(files)) await writeFile(path.join(vault, name), content);
const dashboard = path.join(vault, "dashboard.md"), source = files["dashboard.md"];
const record = { id: "fixture", path: dashboard, name: "dashboard.md", content: source, savedContent: source, diskHash: createHash("sha256").update(source).digest("hex"), lineEnding: "\n" };
await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }));
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const ports = /\/(?:dataview|spaced_repetition)-[^/]+\.js$/;
const app = await electron.launch({ args: [process.cwd(), ...headlessArguments], env });
try {
  const page = await app.firstWindow(), requests = [], external = [], errors = [];
  page.on("request", request => { requests.push(request.url()); if (/^(?:https?|wss?):/i.test(request.url())) external.push(request.url()); });
  page.on("pageerror", error => errors.push(error.message));
  await fullSize(app, page);
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  const results = rich.locator(".dataview-result");
  async function manager() {
    await page.getByRole("button", { name: "More actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Plugin Manager…", exact: true }).click();
    return page.getByRole("dialog", { name: "Plugin Manager", exact: true });
  }
  async function toggle(name, enabled) {
    const dialog = await manager(), input = dialog.getByRole("checkbox", { name: `Enable ${name}`, exact: true });
    await input.setChecked(enabled);
    await expect(input.locator("..")).toContainText(enabled ? "Enabled" : "Disabled");
    return dialog;
  }
  const open = name => page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
  const unchanged = async () => { for (const [name, content] of Object.entries(files)) assert.equal(await readFile(path.join(vault, name), "utf8"), content, `${name} must stay byte-identical`); };

  await page.reload();
  await expect(rich.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(rich.locator('code[data-highlight-language="dataview"]').first()).toContainText("TABLE status");
  await expect(results).toHaveCount(0);
  assert.ok(!requests.some(url => ports.test(url)), "disabled ports are never imported");

  let dialog = await toggle("Dataview", true);
  const card = dialog.locator('[data-plugin-id="dataview"]');
  await expect(card).toContainText("Obsidian port · bundled");
  await expect(card.getByRole("list", { name: "Access", exact: true })).toContainText("Read notes in the open folder");
  await expect(card.getByRole("list", { name: "Access", exact: true })).toContainText("No network access. Never changes notes.");
  await expect(card.getByRole("button", { name: "Toggle Effect", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  const table = results.first().getByRole("table");
  await expect(table.getByRole("columnheader")).toHaveText(["File", "status", "due"]);
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByRole("row").nth(1)).toContainText("gamma");
  await expect(table.getByRole("row").nth(2)).toContainText("alpha");
  await expect(results.first()).toContainText("Results: 2 · Notes: 5");
  await expect(results.nth(1).getByRole("listitem")).toHaveText(["beta"]);
  assert.ok(requests.some(url => /\/dataview-[^/]+\.js$/.test(url)) && !requests.some(url => /\/spaced_repetition-[^/]+\.js$/.test(url)));

  // Keyboard: a result link is a real button; Enter opens the note through the port.
  await table.getByRole("button", { name: "gamma", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(rich.getByRole("heading", { name: "Gamma" })).toBeVisible();
  await open("dashboard.md");
  await expect(results.first().getByRole("table")).toBeVisible();

  // Clicking the rendered block still edits its query.
  await rich.locator(".md-fence").first().click({ position: { x: 4, y: 4 } });
  await expect(rich.locator(".md-fence.fence-editing")).toHaveCount(1);
  await page.keyboard.press("Escape");

  dialog = await toggle("Dataview", false);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(results).toHaveCount(0);
  await expect(rich.locator('code[data-highlight-language="dataview"]').first()).toBeVisible();
  await open("cards.md"); await open("dashboard.md");
  await expect(rich.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(results).toHaveCount(0);
  await unchanged();

  dialog = await toggle("Spaced Repetition", true);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await open("cards.md");
  await expect(rich.getByRole("heading", { name: "Cells" })).toBeVisible();
  await rich.locator("h1").click();
  await page.keyboard.press("Control+Alt+Shift+KeyC");
  const cards = page.getByRole("complementary", { name: "Study cards", exact: true });
  await expect(cards).toContainText("Spaced Repetition: 3 cards found, 3 new.");
  const answers = cards.getByRole("textbox", { name: "Answer", exact: true });
  await expect(answers).toHaveCount(3);
  await expect(answers.first()).toHaveValue("Powerhouse of the cell");
  await cards.getByRole("button", { name: "Save selected cards", exact: true }).click();
  await expect(cards).toContainText("Cards in this note: 3 / 10");
  const journal = (await readFile(path.join(vault, ".omarkie", "store.jsonl"), "utf8")).trim().split("\n").map(row => JSON.parse(row).entry);
  assert.deepEqual(journal.map(entry => entry.front), ["Mitochondria", "What is ATP?", "The […] holds DNA."]);
  assert.ok(journal.every(entry => entry.document === "cards.md" && entry.anchor.hash));
  await cards.getByRole("button", { name: "Test me", exact: true }).click();
  const study = page.getByRole("complementary", { name: "Test me", exact: true });
  await expect(study.getByRole("button", { name: "Show answer", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await study.getByRole("button", { name: /Perfect recall/ }).click();
  await study.getByRole("button", { name: "Back to cards", exact: true }).click();
  await rich.locator("h1").click();
  await page.keyboard.press("Control+Alt+Shift+KeyC");
  await expect(cards).toContainText("Spaced Repetition: 3 cards found, 0 new. 3 already saved.");
  await expect(cards).toContainText("No new cards to import from this note.");

  dialog = await toggle("Spaced Repetition", false);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Close Study cards", exact: true }).click();
  await rich.locator("h1").click();
  await page.keyboard.press("Control+Alt+Shift+KeyC");
  await expect(cards).toHaveCount(0);
  await unchanged();

  // Saved enabled ports start only after the document paints.
  await page.evaluate(() => window.desktop.savePluginPreferences(JSON.stringify({ dataview: { enabled: true }, spaced_repetition: { enabled: true } })));
  const paintedFirst = [];
  await page.route(ports, async route => {
    paintedFirst.push(await page.evaluate(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0));
    await route.continue();
  });
  await page.reload();
  await expect(rich.getByRole("heading", { name: "Cells" })).toBeVisible();
  await expect.poll(() => paintedFirst.length).toBe(2);
  assert.deepEqual(paintedFirst, [true, true]);
  await unchanged();
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  await expect(page.locator(".toast", { hasText: /permission|not available|turned off/ })).toHaveCount(0);
  console.log("PASS: Dataview tables and links, Spaced Repetition import/review, capability-scoped ports, unload on disable, notes untouched, chunks after paint");
} finally { await app.close(); }
