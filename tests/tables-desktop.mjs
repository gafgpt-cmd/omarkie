import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createTranslator } from "../shared/i18n.mjs";
import { fullSize, headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// Synthetic course comparison: alignment, inline code with an escaped pipe and an escaped prose pipe.
const content = "# Local anaesthetics\n\n| Drug | Onset | Note |\n| :--- | :---: | ---: |\n| Lidocaine | Fast | `pH \\| pKa` |\n| Bupivacaine | Slow | 0.25 % |\n| Ropivacaine | Medium | a\\|b |\n\nAfter the table.\n";
const qa = process.env.OMARKIE_QA_DIR || path.join(os.tmpdir(), "omarkie-tables-qa"), passed = [];
await mkdir(qa, { recursive: true });
const pass = message => { passed.push(message); console.log("PASS", message); };

async function launch(language) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), `omarkie-tables-${language}-`))), file = path.join(directory, "tables.md");
  await writeFile(file, content);
  await writeFile(path.join(directory, "session.json"), JSON.stringify({ version: 1, folder: directory, activeId: "fixture", documents: [{ id: "fixture", path: file, name: "tables.md", content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), bom: false, lineEnding: "\n" }] }));
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: directory, OMARKIE_LANGUAGE: language }); delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL;
  const application = await electron.launch({ args: [process.cwd(), ...headlessArguments], env }), page = await application.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await fullSize(application, page);
  return { application, page, errors, file, t: createTranslator(language) };
}

async function run(language, full) {
  const { application, page, errors, file, t } = await launch(language);
  const rich = page.locator(".document-editor:not([hidden]) .rich-document"), table = rich.locator("table");
  const rowGrip = page.locator(".table-grip-row"), columnGrip = page.locator(".table-grip-column"), picker = page.locator(".table-size-picker"), grid = picker.locator(".table-size-grid");
  const toggle = page.locator(".source-toggle");
  async function source() { if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click(); const lines = page.locator(".document-editor:not([hidden]) .source-surface .cm-line"); await expect(lines.first()).toBeVisible(); let text = ""; await expect.poll(async () => { const previous = text; text = (await lines.allTextContents()).join("\n"); return text.trim() !== "" && text === previous; }, { intervals: [50] }).toBe(true); await toggle.click(); await expect(rich).toBeVisible(); return text; }
  const cells = () => table.locator("tr").evaluateAll(rows => rows.map(row => [...row.cells].map(cell => cell.innerText.trim())));
  const center = async locator => { const box = await locator.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
  async function theme(name) {
    await page.evaluate(name => localStorage.setItem("omarkie-theme", name), name); await page.reload();
    await expect(table).toBeVisible({ timeout: 30_000 }); await fullSize(application, page);
  }
  try {
    await expect(table).toBeVisible({ timeout: 30_000 });
    await table.getByText("Lidocaine", { exact: true }).click();
    await expect(rowGrip).toBeVisible(); await expect(columnGrip).toBeVisible();
    await expect(page.locator(".table-tools").getByRole("button", { name: t("Table size"), exact: true })).toBeVisible();
    await expect(rowGrip).toHaveAccessibleName(t("Move row: drag, or press Up and Down"));
    pass(`${language}: caret cell shows row and column grips and the size button`);

    if (full) {
      // A cancelled drag previews only: Escape leaves no source change and no undo entry.
      let at = await center(rowGrip), last = await table.locator("tr").last().boundingBox();
      await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x, last.y + last.height - 2, { steps: 6 });
      await expect(page.locator(".table-drag-ghost")).toBeVisible(); await expect(page.locator(".table-drop-line")).toBeVisible();
      await page.keyboard.press("Escape"); await page.mouse.up();
      await expect(page.locator(".table-drag-ghost")).toBeHidden();
      await rich.press("ControlOrMeta+z");
      assert.equal(await source(), content);
      pass("cancelled drag writes nothing and leaves no undo entry");

      await table.getByText("Lidocaine", { exact: true }).click();
      at = await center(rowGrip); last = await table.locator("tr").last().boundingBox();
      await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x, last.y + last.height - 2, { steps: 6 }); await page.mouse.up();
      await expect.poll(cells).toEqual([["Drug", "Onset", "Note"], ["Bupivacaine", "Slow", "0.25 %"], ["Ropivacaine", "Medium", "a|b"], ["Lidocaine", "Fast", "pH | pKa"]]);
      let text = await source();
      assert.equal(text, "# Local anaesthetics\n\n| Drug | Onset | Note |\n| :--- | :---: | ---: |\n| Bupivacaine | Slow | 0.25 % |\n| Ropivacaine | Medium | a\\|b |\n| Lidocaine | Fast | `pH \\| pKa` |\n\nAfter the table.\n");
      await expect.poll(() => page.evaluate(() => getSelection()?.anchorNode?.parentElement?.closest("td")?.innerText.trim())).toBe("Lidocaine");
      await rich.press("ControlOrMeta+z"); assert.equal(await source(), content);
      await rich.press("ControlOrMeta+Shift+z"); assert.equal(await source(), text); await rich.press("ControlOrMeta+z");
      pass("row drag moves exact source lines, keeps the caret in its cell, undo and redo restore exact source");

      await table.getByText("Drug", { exact: true }).click();
      at = await center(columnGrip); const lastHeader = await table.locator("th").last().boundingBox();
      await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(lastHeader.x + lastHeader.width - 2, at.y, { steps: 6 }); await page.mouse.up();
      await expect.poll(cells).toEqual([["Onset", "Note", "Drug"], ["Fast", "pH | pKa", "Lidocaine"], ["Slow", "0.25 %", "Bupivacaine"], ["Medium", "a|b", "Ropivacaine"]]);
      text = await source();
      assert.match(text, /\| Onset \| Note \| Drug \|\n\| :---: \| ---: \| :--- \|\n\| Fast \| `pH \\\| pKa` \| Lidocaine \|/);
      assert.deepEqual(await table.locator("th").evaluateAll(cells => cells.map(cell => getComputedStyle(cell).textAlign)), ["center", "right", "left"]);
      await rich.press("ControlOrMeta+z"); assert.equal(await source(), content);
      pass("column drag carries alignment, escaped pipes and inline code; undo restores exact source");

      await table.getByText("Lidocaine", { exact: true }).click();
      await page.locator(".table-size-button").click(); await expect(picker).toBeVisible();
      await grid.locator('[data-size="2x2"]').hover();
      await expect(picker.locator(".table-size-note")).toHaveClass(/is-warning/);
      await grid.locator('[data-size="5x4"]').hover(); await expect(grid).toHaveAttribute("aria-valuetext", t("Rows {{rows}} · Columns {{columns}}", { rows: 5, columns: 4 }));
      await grid.locator('[data-size="5x4"]').click(); await expect(picker).toBeHidden();
      await expect(table.locator("tr")).toHaveCount(5); await expect(table.locator("th")).toHaveCount(4);
      text = await source();
      assert.match(text, /\| Drug \| Onset \| Note \|  \|\n\| :--- \| :---: \| ---: \| --- \|\n\| Lidocaine \| Fast \| `pH \\\| pKa` \|  \|/);
      await rich.press("ControlOrMeta+z"); assert.equal(await source(), content);
      pass("size picker grows rows and columns in one pointer transaction and undoes exactly");

      await table.getByText("Lidocaine", { exact: true }).click();
      await rowGrip.focus(); await page.keyboard.press("ArrowDown");
      await expect.poll(cells).toEqual([["Drug", "Onset", "Note"], ["Bupivacaine", "Slow", "0.25 %"], ["Lidocaine", "Fast", "pH | pKa"], ["Ropivacaine", "Medium", "a|b"]]);
      await expect(rowGrip).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect.poll(cells).toEqual([["Drug", "Onset", "Note"], ["Bupivacaine", "Slow", "0.25 %"], ["Ropivacaine", "Medium", "a|b"], ["Lidocaine", "Fast", "pH | pKa"]]);
      await rich.press("ControlOrMeta+z"); await rich.press("ControlOrMeta+z"); assert.equal(await source(), content);
      pass("focused row grip moves by arrow keys, keeps focus, each step is one undo entry");

      await table.getByText("Bupivacaine", { exact: true }).click();
      await application.evaluate(({ Menu, BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; Menu.getApplicationMenu().getMenuItemById("table-size").click({}, window, window.webContents); });
      await expect(picker).toBeVisible(); await expect(grid).toBeFocused();
      await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowUp");
      await expect(picker.locator(".table-size-note")).toHaveText(t("Removes {{count}} filled cells", { count: 6 }));
      await page.keyboard.press("Escape"); await expect(picker).toBeHidden();
      assert.equal(await source(), content);
      await table.getByText("Bupivacaine", { exact: true }).click();
      await application.evaluate(({ Menu, BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; Menu.getApplicationMenu().getMenuItemById("table-size").click({}, window, window.webContents); });
      await expect(grid).toBeFocused(); await page.keyboard.press("ArrowUp"); await page.keyboard.press("Enter");
      await expect(table.locator("tr")).toHaveCount(3);
      assert.equal(await source(), "# Local anaesthetics\n\n| Drug | Onset | Note |\n| :--- | :---: | ---: |\n| Lidocaine | Fast | `pH \\| pKa` |\n| Bupivacaine | Slow | 0.25 % |\n\nAfter the table.\n");
      await rich.press("ControlOrMeta+s"); await expect.poll(() => readFile(file, "utf8")).toBe("# Local anaesthetics\n\n| Drug | Onset | Note |\n| :--- | :---: | ---: |\n| Lidocaine | Fast | `pH \\| pKa` |\n| Bupivacaine | Slow | 0.25 % |\n\nAfter the table.\n");
      pass("menu opens the size picker for keyboard; Escape cancels; Enter shrinks with kept lines; save writes the result");
    }

    for (const name of ["light", "dark"]) {
      await theme(name);
      await table.getByText(full ? "Lidocaine" : "Bupivacaine", { exact: true }).click(); await expect(rowGrip).toBeVisible();
      await rowGrip.focus(); await page.screenshot({ path: path.join(qa, `tables-${language}-${name}-grip-focus.png`) });
      await table.locator("td").first().click(); await page.locator(".table-size-button").click(); await expect(picker).toBeVisible();
      await grid.locator('[data-size="2x2"]').hover(); await page.screenshot({ path: path.join(qa, `tables-${language}-${name}-picker.png`) });
      await page.keyboard.press("Escape"); await expect(picker).toBeHidden();
      await table.locator("td").first().click();
      const at = await center(rowGrip), last = await table.locator("tr").last().boundingBox();
      await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x, last.y + last.height - 2, { steps: 6 });
      await page.screenshot({ path: path.join(qa, `tables-${language}-${name}-drag.png`) });
      await page.keyboard.press("Escape"); await page.mouse.up();
    }
    pass(`${language}: light and dark screenshots of grip focus, size picker and drag preview`);
    assert.deepEqual(errors, []);
  } catch (error) { await page.screenshot({ path: path.join(qa, `tables-${language}-failure.png`) }); throw error; } finally { await application.close(); }
}

await run("en", true);
await run("es", false);
await writeFile(path.join(qa, "tables-results.json"), JSON.stringify({ passed }, null, 2));
console.log(JSON.stringify({ passed, qa }, null, 2));
