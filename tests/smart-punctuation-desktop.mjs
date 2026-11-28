import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createTranslator } from "../shared/i18n.mjs";
import { fullSize, headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

// Synthetic handout in EN/ES/CA with the literals that must survive: numbers, ranges, code, math, URLs, escapes.
const content = [
  "# Regional \"blocks\"",
  "",
  "EN: The tutor said \"aspirate first\" -- it isn't 'optional'... Onset---then spread.",
  "",
  "ES: Dijo \"bloqueo del plexo\" -- con 'calma'...",
  "",
  "CA: Va dir \"bloqueig\" -- l'anestèsia...",
  "",
  "Literal: 10--20 mg, -5 °C, 5'10\", 1...5, --verbose, `\"x\" -- ...`, $a--b$, \\\"kept\\\", <https://example.test/a--b>.",
  "",
].join("\n");
const glyphs = /[“”‘’«»—–…]/g;
const qa = process.env.OMARKIE_QA_DIR || path.join(os.tmpdir(), "omarkie-smart-qa"), passed = [];
await mkdir(qa, { recursive: true });
const pass = message => { passed.push(message); console.log("PASS", message); };

async function launch(language) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), `omarkie-smart-${language}-`))), file = path.join(directory, "handout.md");
  await writeFile(file, content);
  await writeFile(path.join(directory, "session.json"), JSON.stringify({ version: 1, folder: directory, activeId: "fixture", documents: [{ id: "fixture", path: file, name: "handout.md", content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), bom: false, lineEnding: "\n" }] }));
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: directory, OMARKIE_LANGUAGE: language }); delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL;
  const application = await electron.launch({ args: [process.cwd(), ...headlessArguments], env }), page = await application.firstWindow(), errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => requests.push(request.url()));
  await fullSize(application, page);
  return { application, page, errors, requests, directory, file, t: createTranslator(language) };
}

async function run(language, style, full) {
  const { application, page, errors, requests, directory, file, t } = await launch(language);
  const rich = page.locator(".document-editor:not([hidden]) .rich-document"), smart = rich.locator(".md-smart");
  const learning = page.getByRole("button", { name: t("Learning mode"), exact: true });
  const shown = () => smart.evaluateAll(elements => elements.map(element => element.dataset.smart).join(""));
  async function theme(name) {
    await page.evaluate(name => localStorage.setItem("omarkie-theme", name), name); await page.reload();
    await expect(rich).toBeVisible({ timeout: 30_000 }); await fullSize(application, page);
  }
  try {
    await expect(rich).toBeVisible({ timeout: 30_000 });
    await expect(rich.getByText(/aspirate first/)).toBeVisible();
    await learning.click(); await expect(rich).toHaveAttribute("aria-readonly", "true");
    assert.equal(await smart.count(), 0);
    await learning.click(); await expect(rich).toHaveAttribute("aria-readonly", "false");
    pass(`${language}: off by default, reading view keeps straight punctuation`);

    // Keyboard path: Ctrl+, opens Preferences, focus the select, arrow to a style, Escape.
    await rich.click(); await page.keyboard.press("Control+Comma");
    const dialog = page.getByRole("dialog"), select = dialog.getByLabel(t("Smart punctuation"), { exact: true });
    await expect(select).toBeVisible();
    await select.focus();
    for (const _ of ["off", "en", "es", "ca"].slice(0, ["off", "en", "es", "ca"].indexOf(style))) await page.keyboard.press("ArrowDown");
    await expect(select).toHaveValue(style);
    await expect(select).toHaveAccessibleDescription(t("Quotes, dashes and ellipses in reading mode and exports. The note keeps its straight punctuation."));
    await select.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(qa, `smart-${language}-preferences.png`) });
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
    assert.equal(await smart.count(), 0, "editable surface stays literal");
    await learning.click(); await expect(rich).toHaveAttribute("aria-readonly", "true");
    await expect(smart.first()).toBeVisible();
    const reading = await shown();
    assert.ok(reading.length > 10);
    // The drawn glyph replaces the source characters on screen.
    const line = rich.locator("p").filter({ hasText: language === "en" ? "EN:" : "ES:" });
    const screenText = await line.evaluate(element => { const copy = element.cloneNode(true); for (const glyph of copy.querySelectorAll(".md-smart")) glyph.replaceWith(glyph.dataset.smart); for (const hidden of copy.querySelectorAll(".md-meta")) hidden.remove(); return copy.textContent; });
    assert.equal(screenText, style === "en" ? "EN: The tutor said “aspirate first” – it isn’t ‘optional’… Onset—then spread." : "ES: Dijo «bloqueo del plexo» – con ‘calma’…");
    const literal = await rich.locator("p").filter({ hasText: "Literal:" }).locator(".md-smart").count();
    assert.equal(literal, 0, "numbers, units, code, math, escapes and URLs stay literal");
    await expect(page.locator(".dirty-dot")).toHaveCount(0);
    assert.equal(await readFile(file, "utf8"), content);
    pass(`${language}: ${style} style drawn in reading view; literal line untouched; note not dirty, file unchanged`);

    for (const name of ["light", "dark"]) {
      await theme(name);
      if (await rich.getAttribute("aria-readonly") !== "true") await learning.click();
      await expect(smart.first()).toBeVisible();
      await page.screenshot({ path: path.join(qa, `smart-${language}-${name}-reading.png`) });
    }
    pass(`${language}: light and dark reading screenshots`);

    if (full) {
      const html = path.join(directory, "handout.html"), pdf = path.join(directory, "handout.pdf");
      await application.evaluate(({ dialog }, files) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: files.shift() }); }, [html, pdf]);
      await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("html").click());
      await expect.poll(() => readFile(html, "utf8").catch(() => ""), { timeout: 30_000 }).toContain("</html>");
      const exported = await page.evaluate(markup => { const document = new DOMParser().parseFromString(markup, "text/html"); return document.body.textContent; }, await readFile(html, "utf8"));
      assert.equal(exported.match(glyphs).join(""), reading, "HTML export glyphs match the reading view");
      assert.ok(exported.includes("10--20 mg, -5 °C, 5'10\", 1...5, --verbose,") && exported.includes("\"x\" -- ...") && exported.includes("\"kept\""));
      await application.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("pdf").click());
      await expect.poll(async () => (await readFile(pdf).catch(() => Buffer.alloc(0))).subarray(0, 5).toString(), { timeout: 60_000 }).toBe("%PDF-");
      const pdfText = (await promisify(execFile)("pdftotext", ["-enc", "UTF-8", pdf, "-"])).stdout;
      assert.equal(pdfText.match(glyphs).join(""), reading, "PDF glyphs match the reading view");
      await expect(page.locator(".dirty-dot")).toHaveCount(0);
      assert.equal(await readFile(file, "utf8"), content);
      pass(`${language}: HTML and PDF exports carry the same glyphs as the reading view; source unchanged`);
    }
    assert.deepEqual(requests.filter(url => /^https?:/.test(url) && !url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")), []);
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: path.join(qa, `smart-${language}-failure.png`) }).catch(() => {});
    throw error;
  } finally { await application.close(); }
}

await run("en", "en", true);
await run("es", "es", true);
await writeFile(path.join(qa, "smart-results.json"), JSON.stringify(passed, null, 2));
console.log(`Smart punctuation desktop: ${passed.length} checks passed; screenshots in ${qa}`);
