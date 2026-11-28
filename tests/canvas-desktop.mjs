import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as launch, expect } from "playwright/test";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";
import { parseCanvas } from "../shared/json-canvas.mjs";
import { clipKey } from "../shared/papercut.mjs";

// Synthetic ES/CA course module; no real notes or patients.
const passage = "La cirugía de hombro y clavícula distal es la indicación principal.";
const note = `# Mòdul 3 · Bloqueig interescalènic\n\n## Indicaciones\n\n${passage}\n\n## Evidència\n\nEl bloqueig redueix el dolor postoperatori durant 24 hores.\n`;
const board = {
  nodes: [
    { id: "group1", type: "group", x: -40, y: -60, width: 760, height: 400, label: "Plan" },
    { id: "text1", type: "text", x: 0, y: 0, width: 260, height: 140, text: "**Repaso** antes del examen" },
    { id: "file1", type: "file", x: 320, y: 0, width: 360, height: 280, file: "Cursos/Mòdul 3.md", subpath: "#Evidència" },
    { id: "link1", type: "link", x: 0, y: 420, width: 300, height: 120, url: "https://example.invalid/guia" },
  ],
  edges: [{ id: "edge1", fromNode: "text1", fromSide: "right", toNode: "file1", toSide: "left" }],
};
const qa = process.env.OMARKIE_QA_DIR;
if (qa) await mkdir(qa, { recursive: true });

async function run(language, steps) {
  const catalog = JSON.parse(await readFile(new URL(`../shared/locales/${language}.json`, import.meta.url), "utf8"));
  const L = (key, args = {}) => (catalog[key] ?? key).replace(/{{(\w+)}}/g, (_, name) => args[name]);
  const home = await mkdtemp(path.join(os.tmpdir(), `omarkie-canvas-${language}-`));
  const vault = path.join(home, "vault"), notePath = path.join(vault, "Cursos", "Mòdul 3.md"), boardPath = path.join(vault, "Boards", "Mapa.canvas");
  await mkdir(path.dirname(notePath), { recursive: true });
  await mkdir(path.dirname(boardPath), { recursive: true });
  await writeFile(notePath, note);
  await writeFile(boardPath, `${JSON.stringify(board, null, "\t")}\n`);
  const record = { id: "fixture", path: notePath, name: "Mòdul 3.md", content: note, savedContent: note, diskHash: createHash("sha256").update(note).digest("hex"), lineEnding: "\n" };
  await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, activeId: record.id, folder: vault, documents: [record] }), "utf8");
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: language });
  delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
  const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env, timeout: 30_000 });
  const network = [], errors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    const rich = page.locator(".document-editor:not([hidden]) .rich-document");
    await expect(rich.getByRole("heading", { name: "Mòdul 3 · Bloqueig interescalènic", exact: true })).toBeVisible({ timeout: 30_000 });
    const ui = {
      app, page, rich, L, vault, boardPath, notePath,
      dialog: page.getByRole("dialog", { name: "Mapa.canvas", exact: true }),
      node: id => page.locator(`.react-flow__node[data-id="${id}"]`),
      disk: async () => JSON.parse(await readFile(boardPath, "utf8")),
      capture: async name => { if (qa) await page.screenshot({ path: path.join(qa, `canvas-${language}-${name}.png`) }); },
      async display(item, role = "menuitem") {
        await page.getByRole("button", { name: L("显示"), exact: true }).click();
        await page.getByRole(role, { name: L(item), exact: true }).click();
      },
      async theme(theme) {
        await page.keyboard.press("Control+,");
        const preferences = page.getByRole("dialog", { name: L("偏好设置"), exact: true });
        await expect(preferences).toBeVisible();
        await preferences.getByRole("combobox", { name: L("主题"), exact: true }).selectOption(theme);
        await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
        await preferences.getByRole("button", { name: L("关闭{{title}}", { title: L("偏好设置") }), exact: true }).click();
      },
      async selectPassage() {
        await rich.getByText(passage, { exact: true }).selectText();
        await page.keyboard.press("Alt+Enter");
        const popup = page.getByRole("group", { name: L("选区操作"), exact: true });
        await expect(popup).toBeVisible();
        return popup;
      },
      async pickMapa() {
        const picker = page.getByRole("dialog", { name: L("Canvas boards"), exact: true });
        await expect(picker).toBeVisible();
        await picker.getByRole("button", { name: /^Mapa/ }).click();
        await expect(ui.dialog).toBeVisible();
      },
      async settle() { await expect(ui.dialog.locator(".board-status")).toHaveText(L("Saved"), { timeout: 10_000 }); },
    };
    await ui.display("Learning mode", "menuitemcheckbox");
    await steps(ui);
    assert.deepEqual(network, [], `canvas stays offline, saw ${network.join(", ")}`);
    assert.deepEqual(errors, [], `renderer errors: ${errors.join(" | ")}`);
  } finally {
    await app.close();
  }
}

await run("en", async ({ app, page, L, dialog, node, disk, capture, theme, selectPassage, pickMapa, settle, boardPath, notePath }) => {
  // Open the board from the Learning rail: no board used yet, so the picker asks.
  await page.getByRole("button", { name: L("Papercut board"), exact: true }).click();
  await pickMapa();
  await expect(node("file1")).toContainText("El bloqueig redueix el dolor postoperatori durant 24 hores.");
  await expect(node("link1")).toContainText("https://example.invalid/guia");
  await expect(node("text1").locator("strong")).toHaveText("Repaso");
  await page.getByRole("button", { name: L("Close board"), exact: true }).click();
  await expect(dialog).toBeHidden();

  // Clip the selected words; the last board reopens with the snapshot in view.
  const popup = await selectPassage();
  await capture("selection-light");
  await popup.getByRole("button", { name: L("Clip to board"), exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(L("Clip added to the board."), { exact: true })).toBeVisible();
  await settle();
  let saved = await disk();
  const clip = saved.nodes.find(item => item[clipKey]);
  assert.ok(clip, "clip saved with its source");
  assert.deepEqual(clip[clipKey], { file: "Cursos/Mòdul 3.md", quote: passage, line: 5, heading: "Indicaciones" });
  assert.match(clip.text, /^> La cirugía de hombro/);

  // Keyboard: focus, select, move across the grid, undo one step.
  await node(clip.id).focus();
  await page.keyboard.press("Enter");
  await expect(node(clip.id)).toHaveClass(/selected/);
  await expect(page.getByRole("textbox", { name: L("Card text") })).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await settle();
  assert.equal((await disk()).nodes.find(item => item.id === clip.id).x, clip.x + 20, "arrow moves one grid step");
  await page.keyboard.press("Control+z");
  await settle();
  assert.equal((await disk()).nodes.find(item => item.id === clip.id).x, clip.x, "undo puts it back");
  for (let step = 0; step < 6; step++) await page.keyboard.press("Shift+ArrowDown");
  await settle();
  const placed = (await disk()).nodes.find(item => item.id === clip.id);
  assert.equal(placed.y, clip.y + 6 * 80);

  // Connect the evidence card, then group both.
  await node(clip.id).click({ position: { x: 12, y: 8 } });
  await node("file1").click({ position: { x: 12, y: 8 }, modifiers: ["Shift"] });
  await page.keyboard.press("Control+l");
  await page.keyboard.press("Control+g");
  const label = page.getByRole("textbox", { name: L("Group name") });
  await expect(label).toBeFocused();
  await label.fill("Evidencia");
  await page.keyboard.press("Enter");
  await settle();
  saved = await disk();
  assert.ok(saved.edges.some(edge => edge.fromNode === clip.id && edge.toNode === "file1"), "evidence connected");
  const grouped = saved.nodes.find(item => item.type === "group" && item.label === "Evidencia");
  assert.ok(grouped && grouped.x <= placed.x && grouped.y <= 0, "group wraps clip and evidence");
  assert.ok(saved.nodes.indexOf(grouped) < saved.nodes.findIndex(item => item.id === clip.id), "group sits below its cards");
  await dialog.getByRole("button", { name: L("Fit board to view"), exact: true }).click();
  await capture("board-light");

  // External edits: a clean board follows the disk; a dirty one keeps the user's work.
  const outside = await disk();
  outside.nodes.push({ id: "ext1", type: "text", x: 800, y: 0, width: 200, height: 100, text: "Nota externa" });
  await writeFile(boardPath, JSON.stringify(outside, null, "\t"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(node("ext1")).toContainText("Nota externa");
  outside.nodes.find(item => item.id === "ext1").text = "Otra app";
  await writeFile(boardPath, JSON.stringify(outside, null, "\t"));
  // Enter on the focused clip selects it; it must not open the editor of the group selected before.
  await node(clip.id).focus();
  await page.keyboard.press("Enter");
  await expect(node(clip.id)).toHaveClass(/selected/);
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByRole("alert").filter({ hasText: L("The board changed on disk. Your edits are kept.") })).toBeVisible({ timeout: 10_000 });
  await capture("conflict-light");
  await dialog.getByRole("button", { name: L("Keep my version"), exact: true }).click();
  await settle();
  saved = await disk();
  assert.equal(saved.nodes.find(item => item.id === "ext1").text, "Nota externa");
  assert.equal(saved.nodes.find(item => item.id === clip.id).x, clip.x - 20);

  // Jump to source closes the board and lands the editor on the passage.
  await node(clip.id).getByRole("button", { name: L("Jump to source"), exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => getSelection()?.anchorNode?.parentElement?.closest("p")?.textContent ?? "")).toContain("La cirugía de hombro");

  // Reopen: the board is restored; a note edit updates the live card, never the snapshot.
  await page.getByRole("button", { name: L("Papercut board"), exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(node(clip.id)).toContainText(passage);
  const frozen = (await disk()).nodes.find(item => item.id === clip.id);
  await writeFile(notePath, note.replace("24 hores", "12 a 24 hores").replace("hombro", "hombro derecho"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(node("file1")).toContainText("12 a 24 hores");
  await expect(node(clip.id)).toContainText(L("Source moved"));
  await expect(node(clip.id)).toContainText(passage);
  assert.deepEqual((await disk()).nodes.find(item => item.id === clip.id), frozen);
  await node(clip.id).getByRole("button", { name: L("Jump to source"), exact: true }).click();
  await expect(dialog.getByText(L("The source passage moved or changed. The snapshot is kept as clipped."))).toBeVisible();
  await expect(dialog).toBeVisible();

  await page.getByRole("button", { name: L("Close board"), exact: true }).click();
  await theme("dark");
  await page.getByRole("button", { name: L("Papercut board"), exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: L("Fit board to view"), exact: true }).click();
  await capture("board-dark");

  // Tutor: only on request, only the selected clips, previewed first.
  await expect(page.getByRole("complementary", { name: L("Tutor"), exact: true })).toHaveCount(0);
  await node(clip.id).click({ position: { x: 12, y: 8 } });
  await node("text1").click({ modifiers: ["Shift"] });
  await dialog.getByRole("button", { name: L("Ask Tutor"), exact: true }).click();
  const preview = page.getByRole("dialog", { name: L("Context sent to Tutor"), exact: true });
  await expect(preview.locator("pre")).toContainText(passage);
  await expect(preview.locator("pre")).not.toContainText("Repaso");
  await capture("tutor-preview-dark");
  await preview.getByRole("button", { name: L("Cancel"), exact: true }).click();
  await expect(preview).toBeHidden();
  await dialog.getByRole("button", { name: L("Ask Tutor"), exact: true }).click();
  await preview.getByRole("button", { name: L("Open in Tutor"), exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("complementary", { name: L("Tutor"), exact: true })).toBeVisible();

  const final = await readFile(boardPath, "utf8");
  const reopened = parseCanvas(final);
  assert.equal(reopened.editable, true);
  assert.deepEqual(reopened.issues, []);
  assert.ok(!/tutor/i.test(final), "no Tutor state in the board file");
});

await run("es", async ({ page, L, dialog, capture, theme, selectPassage, pickMapa, display }) => {
  await display("Canvas boards…");
  await pickMapa();
  await capture("board-light");
  await page.getByRole("button", { name: L("Close board"), exact: true }).click();
  const popup = await selectPassage();
  await expect(popup.getByRole("button", { name: L("Clip to board"), exact: true })).toBeVisible();
  await expect(popup.getByRole("button", { name: L("Heading to board"), exact: true })).toBeVisible();
  await capture("selection-light");
  await page.keyboard.press("Escape");
  await theme("dark");
  await display("Canvas boards…");
  await pickMapa();
  await capture("board-dark");
  await page.getByRole("button", { name: L("Close board"), exact: true }).click();
  const darkPopup = await selectPassage();
  await capture("selection-dark");
  await darkPopup.getByRole("button", { name: L("Heading to board"), exact: true }).click();
  await expect(dialog.locator(".react-flow__node-file").filter({ hasText: "Indicaciones" })).toHaveCount(1);
  await capture("heading-card-dark");
});
console.log("PASS: canvas boards and Papercut clips stayed local in EN and ES");
