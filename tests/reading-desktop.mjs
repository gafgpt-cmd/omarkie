import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { JSDOM } from "jsdom";
import { fullSize, headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const evidence = process.env.OMARKIE_QA_DIR || await mkdtemp(path.join(os.tmpdir(), "omarkie-reading-evidence-"));
await mkdir(evidence, { recursive: true });
const exportDirectory = await mkdtemp(path.join(evidence, 'exports-'));
const directory = await mkdtemp(path.join(os.tmpdir(), "omarkie-reading-")), file = path.join(directory, "reading.md");
await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#7599a8" } }).jpeg().toFile(path.join(directory, "figure.jpg"));
const original = '# Reading\n\n> [!abstract]- A **custom** title\n> first body line\n>\n> second paragraph\n\n> [!tip]+ Expanded title\n> body\n\n| A | B |\n| --- | --- |\n| one | two |\n\n![Markdown](figure.jpg "keep title"){width=240 height=120}\n\n<img src="figure.jpg" alt="HTML" width="240" height="120" />\n\n![[figure.jpg|240x120]]\n\n```text\nfirst line\nsecond line\n```\n\n## Lower heading\n\nSlash target\n';
await writeFile(file, original, "utf8");
for (const name of ["figure(v2).jpg", "spaced.jpg", "spaced-suffix.jpg"]) await writeFile(path.join(directory, name), await readFile(path.join(directory, "figure.jpg")));
const mixedImages = [
  ['Caption', '![[figure.jpg|Caption]]{width=240 height=120}'],
  ['figure.jpg', '| Figure | Example |\n| --- | --- |\n| ![[figure.jpg\\| 100 x 50 ]] | <span>![[hidden.png]] #hidden</span> |', '| Figure | Example |\n| --- | --- |\n| ![[figure.jpg\\|300x150]] | <span>![[hidden.png]] #hidden</span> |', 100, 300],
  ['spaced.jpg', '![[spaced.jpg| 100 X 50 ]]', '![[spaced.jpg|300x150]]', 100, 300],
  ['spaced-suffix.jpg', '![[spaced-suffix.jpg| 100 x 50 ]]{width=100}', '![[spaced-suffix.jpg|300x150]]{width=300}', 100, 300],
  ['Balanced path', '![Balanced path](figure(v2).jpg "keep (title)"){width=240 height=120}'],
  ['Double before > src', '<img alt="Double before > src" src="figure.jpg" width="240" height="120" class="keep">'],
  ['Double after > src', '<img src="figure.jpg" alt="Double after > src" width="240" height="120" class="keep">'],
  ['Single before > src', "<img alt='Single before > src' src='figure.jpg' width='240' height='120' class='keep'>"],
  ['Single after > src', "<img src='figure.jpg' alt='Single after > src' width='240' height='120' class='keep'>"],
];
const mixedFile = path.join(directory, "mixed-image.md"), mixedOriginal = '---\r\ncustom: retained # keep\r\n---\r\n# Mixed image\n\nBefore image.\r\n\r\n' + mixedImages.map(([, markup]) => markup).join('\r\n\n') + '\r\n\nAfter image.\r\n';
await writeFile(mixedFile, mixedOriginal, "utf8");
const slashFile = path.join(directory, "raw-slash.md"), slashOriginal = '# CR slash\r\r/ta'; await writeFile(slashFile, slashOriginal, 'utf8');
const virtual = '# Virtual\n\n> [!tip]- Windowed title\n> body\n\n| A | B |\n| --- | --- |\n| one | two |\n\n' + Array.from({ length: 1200 }, (_, index) => `Paragraph ${index}.\n\n`).join('') + '## Final heading\n\nEnd.\n';
const virtualFile = path.join(directory, "virtual.md"); await writeFile(virtualFile, virtual, "utf8");
await writeFile(path.join(directory, "session.json"), JSON.stringify({ version: 1, activeId: "fixture", documents: [{ id: "fixture", path: file, name: "reading.md", content: original, savedContent: original, diskHash: createHash("sha256").update(original).digest("hex"), bom: false, lineEnding: "\n" }, { id: "virtual", path: virtualFile, name: "virtual.md", content: virtual, savedContent: virtual, diskHash: createHash("sha256").update(virtual).digest("hex"), bom: false, lineEnding: "\n" }, { id: "mixed-image", path: mixedFile, name: "mixed-image.md", content: mixedOriginal, savedContent: mixedOriginal, diskHash: createHash("sha256").update(mixedOriginal).digest("hex"), bom: false, lineEnding: "\r\n" }, { id: "raw-slash", path: slashFile, name: "raw-slash.md", content: slashOriginal, savedContent: slashOriginal, diskHash: createHash("sha256").update(slashOriginal).digest("hex"), bom: false, lineEnding: "\r" }] }), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: directory, OMARKIE_LANGUAGE: "en" }); delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
// Pointer drags on this surface need a mapped window in headless Chromium.
if (process.platform === "linux" && !process.env.OMARKIE_TEST_DISPLAY) env.OMARKIE_TEST_HIDDEN = "0";
let application, page;
const errors = [], external = [], resources = [], passed = [];
async function launch() {
  application = await electron.launch({ args: [process.cwd(), ...headlessArguments], env }); page = await application.firstWindow();
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { resources.push(request.url()); if (/^(?:https?|wss?):/i.test(request.url())) external.push(request.url()); });
  await fullSize(application, page); await expect(page.locator(".document-editor:not([hidden]) .rich-document")).toBeVisible();
}
const rich = () => page.locator(".document-editor:not([hidden]) .rich-document");
async function manager() {
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Plugin Manager…", exact: true }).click();
  return page.getByRole("dialog", { name: "Plugin Manager", exact: true });
}
async function toggle(name, enabled) {
  const dialog = await manager(), input = dialog.getByRole("checkbox", { name: `Enable ${name}`, exact: true });
  await input.setChecked(enabled); await expect(input).toBeEnabled();
  if (enabled) await expect(input.locator("..")).toContainText("Enabled");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
}
async function sourceText() {
  if (await rich().isVisible()) await page.keyboard.press("ControlOrMeta+/");
  const source = page.locator(".document-editor:not([hidden]) .source-surface:not([hidden]) .cm-content"); await expect(source).toBeVisible();
  const text = (await source.locator(".cm-line").allTextContents()).join("\n");
  await page.keyboard.press("ControlOrMeta+/"); await expect(rich()).toBeVisible(); return text;
}
async function preferences() {
  await page.keyboard.press("ControlOrMeta+,"); return page.getByRole("dialog", { name: "Preferences", exact: true });
}
try {
  await launch();
  await page.getByRole("button", { name: "More actions", exact: true }).click(); await page.getByRole("menuitemcheckbox", { name: "Auto-save existing files", exact: true }).click();
  assert.equal(await sourceText(), original);
  await page.evaluate(() => localStorage.setItem('omarkie-plugins-v1', JSON.stringify({ read_only: { enabled: true } })));
  await page.reload();
  await expect(rich()).toHaveAttribute('contenteditable', 'false', { timeout: 30000 });
  await toggle('Read-Only Mode', false);
  await expect(rich()).toHaveAttribute('contenteditable', 'true');
  passed.push('saved read-only plugin activates after reload and releases editing on disable');
  const requested = await page.evaluate(() => performance.getEntriesByType("resource").map(entry => entry.name));
  assert.equal(requested.some(url => /(?:callouts|imageViewer|resizeImage|foldTables|widthSlider|slashCommands|rightOutline)-/.test(url)), false);
  passed.push("all reading implementations remain unloaded while disabled");
  for (const name of ["Callouts", "Image viewer", "Resize images", "Fold tables", "Editor width slider", "Slash commands", "Right outline"]) await toggle(name, true);
  const firstCallout = rich().locator("blockquote[data-alert=abstract]");
  await expect(firstCallout).toHaveClass(/reading-folded/); await expect(firstCallout.locator("strong")).toHaveText("custom");
  await firstCallout.getByRole("button", { name: "Fold callout" }).click(); await expect(firstCallout).not.toHaveClass(/reading-folded/);
  await firstCallout.getByRole("button", { name: "Fold callout" }).click();
  await expect(rich().locator("blockquote[data-alert=tip]")).not.toHaveClass(/reading-folded/);
  const table = rich().locator("table"); await table.getByRole("button", { name: "Fold table", exact: true }).click(); await expect(table.locator("tbody")).toBeHidden(); await expect(table.locator("thead")).toBeVisible();
  assert.equal(await sourceText(), original);
  passed.push("custom callouts +/- fold and table header folding do not change source");
  const outline = page.getByRole("complementary", { name: "Right outline" }); await expect(outline).toBeVisible();
  await expect(outline.getByRole("button", { name: "Lower heading", exact: true })).toBeVisible();
  assert.ok(await page.locator(".sidebar").isVisible());
  await outline.getByRole("button", { name: "Lower heading", exact: true }).click();
  passed.push("right outline navigates full model headings while files stay left");
  await page.locator('.sidebar').getByRole('button', { name: 'virtual.md', exact: true }).click();
  await expect(outline.getByRole('button', { name: 'Final heading', exact: true })).toBeVisible();
  await outline.getByRole('button', { name: 'Virtual', exact: true }).click();
  const windowedCallout = rich().locator('blockquote[data-alert=tip]'); await expect(windowedCallout).toHaveClass(/reading-folded/);
  await windowedCallout.getByRole('button', { name: 'Fold callout' }).click();
  await rich().locator('table').getByRole('button', { name: 'Fold table', exact: true }).click();
  await outline.getByRole('button', { name: 'Final heading', exact: true }).click();
  await expect(rich().locator('.md-window-spacer')).not.toHaveCount(0);
  await expect(rich().locator('h2')).toContainText('Final heading');
  await outline.getByRole('button', { name: 'Virtual', exact: true }).click();
  await expect(windowedCallout).not.toHaveClass(/reading-folded/); await expect(rich().locator('table tbody')).toBeHidden();
  assert.equal(await rich().locator('.md-window-spacer.reading-folded,.md-window-spacer.reading-table-folded').count(), 0);
  await page.locator('.sidebar').getByRole('button', { name: 'reading.md', exact: true }).click();
  passed.push('windowed blocks retain per-document folding; outline reaches off-screen headings and ignores spacers');
  const markdownImage = rich().locator('img[alt="Markdown"]'); await markdownImage.scrollIntoViewIfNeeded(); await markdownImage.click();
  const viewer = page.getByRole("dialog", { name: "Image viewer", exact: true }); await expect(viewer).toBeVisible();
  const viewerImage = viewer.locator("img"); assert.doesNotMatch(await viewerImage.getAttribute("src"), /preview=/); await expect.poll(() => viewerImage.evaluate(image => image.naturalWidth)).toBe(2000);
  await viewer.getByRole("button", { name: "Zoom in", exact: true }).click(); await expect(viewer.locator("output")).toHaveText("120%");
  await page.keyboard.press("="); await expect(viewer.locator("output")).toHaveText("140%");
  await page.keyboard.press("ArrowRight"); assert.match(await viewerImage.getAttribute("style"), /translate\(40px/);
  const box = await viewerImage.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 + 20); await page.mouse.up();
  assert.match(await viewerImage.getAttribute("style"), /translate\(75px, 20px\)/);
  await page.screenshot({ path: path.join(evidence, "viewer.png") }); await page.keyboard.press("Escape"); await expect(viewer).not.toBeVisible();
  assert.equal(await sourceText(), original);
  passed.push("original-image viewing: pointer/keyboard zoom and pan, Escape close, source unchanged");
  for (const alt of ["Markdown", "HTML", "figure.jpg"]) {
    const image = rich().locator(`img[alt="${alt}"]`); await image.scrollIntoViewIfNeeded(); await image.hover();
    const handle = page.getByRole("button", { name: "Resize image", exact: true }); await expect(handle).toBeVisible();
    const corner = await handle.boundingBox(); await page.mouse.move(corner.x + 8, corner.y + 8); await page.mouse.down(); await page.mouse.move(corner.x + 88, corner.y + 8); await page.mouse.up();
    const changed = await sourceText(); assert.notEqual(changed, original);
    if (alt === "Markdown") assert.match(changed, /!\[Markdown\]\(figure.jpg "keep title"\)\{width=320 height=160\}/);
    if (alt === "HTML") assert.match(changed, /<img src="figure.jpg" alt="HTML" width="320" height="160" \/>/);
    if (alt === "figure.jpg") assert.match(changed, /!\[\[figure.jpg\|320x160\]\]/);
    await rich().press("ControlOrMeta+z"); assert.equal(await sourceText(), original);
  }
  passed.push("Markdown/HTML/wiki drag sizing retains syntax and dimensions; one undo restores bytes");
  await page.locator('.sidebar').getByRole('button', { name: 'mixed-image.md', exact: true }).click();
  await expect(rich().getByRole('heading', { name: 'Mixed image', exact: true })).toBeVisible();
  for (const [alt, markup, expected = markup.replace('240', '320').replace('120', '160'), initialWidth = 240, targetWidth = 320] of mixedImages) for (const undoMode of ['source', 'rich']) {
    const mixedImage = rich().locator(`img[alt="${alt}"]`); await mixedImage.scrollIntoViewIfNeeded(); await mixedImage.hover();
    const mixedHandle = page.getByRole('button', { name: 'Resize image', exact: true }); await expect(mixedHandle).toBeVisible();
    const mixedCorner = await mixedHandle.boundingBox(); await page.mouse.move(mixedCorner.x + 8, mixedCorner.y + 8); await page.mouse.down(); await page.mouse.move(mixedCorner.x + 8 + targetWidth - initialWidth, mixedCorner.y + 8); await page.mouse.up();
    await expect(mixedImage).toHaveAttribute('width', String(targetWidth)); await expect(mixedImage).toHaveAttribute('height', String(targetWidth / 2)); await rich().press('ControlOrMeta+s');
    await expect.poll(() => readFile(mixedFile, 'utf8'), { timeout: 20000 }).toBe(mixedOriginal.replace(markup, expected));
    await page.screenshot({ path: path.join(evidence, `mixed-image-resize-${alt.replace(/[^a-z0-9]+/gi, '-')}-${undoMode}.png`) });
    if (undoMode === 'source') await page.keyboard.press('ControlOrMeta+/');
    const editor = undoMode === 'source' ? page.locator('.document-editor:not([hidden]) .source-surface:not([hidden]) .cm-content') : rich();
    await expect(editor).toBeVisible(); await editor.press('ControlOrMeta+z'); await editor.press('ControlOrMeta+s');
    await expect.poll(() => readFile(mixedFile, 'utf8'), { timeout: 20000 }).toBe(mixedOriginal);
    if (undoMode === 'source') await page.keyboard.press('ControlOrMeta+/');
    await expect(rich()).toBeVisible(); await expect(mixedImage).toHaveAttribute('width', String(initialWidth));
  }
  const contextWord = path.join(exportDirectory, 'parser-context.docx');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, contextWord);
  await page.getByRole('button', { name: 'More actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Export Word…', exact: true }).click();
  await expect.poll(async () => readFile(contextWord).then(bytes => bytes.subarray(0, 2).toString(), () => ''), { timeout: 30000 }).toBe('PK');
  assert.equal(await readFile(mixedFile, 'utf8'), mixedOriginal);
  await page.locator('.sidebar').getByRole('button', { name: 'reading.md', exact: true }).click();
  passed.push('real Word export converts table images without reading hidden examples');
  passed.push('table/spaced wiki dimensions, balanced paths and quoted HTML resize proportionally; save/source/rich undo preserves mixed endings');
  await toggle("Read-Only Mode", true);
  await markdownImage.scrollIntoViewIfNeeded(); await markdownImage.hover(); await expect(page.getByRole("button", { name: "Resize image", exact: true })).toBeHidden();
  await markdownImage.click(); await expect(viewer).toBeVisible(); await page.keyboard.press("Escape");
  await firstCallout.scrollIntoViewIfNeeded();
  const readOnlyFold = firstCallout.getByRole("button", { name: "Fold callout" }), wasExpanded = await readOnlyFold.getAttribute('aria-expanded');
  await readOnlyFold.focus(); await readOnlyFold.press('Enter'); await expect(readOnlyFold).toHaveAttribute('aria-expanded', wasExpanded === 'true' ? 'false' : 'true');
  assert.equal(await sourceText(), original);
  await toggle("Read-Only Mode", false);
  passed.push("read-only permits viewing/folding but refuses source sizing");
  await markdownImage.scrollIntoViewIfNeeded();
  await rich().evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })));
  await markdownImage.hover(); await expect(page.getByRole('button', { name: 'Resize image', exact: true })).toBeHidden();
  await rich().evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));
  assert.equal(await sourceText(), original);
  passed.push('pending IME composition blocks image sizing without a source change');
  await page.keyboard.press("ControlOrMeta+="); await expect.poll(() => rich().evaluate(element => getComputedStyle(element).fontSize)).toBe("17px");
  await page.keyboard.press("ControlOrMeta+-"); await expect.poll(() => rich().evaluate(element => getComputedStyle(element).fontSize)).toBe("16px");
  await page.keyboard.press("ControlOrMeta+="); await page.keyboard.press("ControlOrMeta+0"); await expect.poll(() => rich().evaluate(element => getComputedStyle(element).fontSize)).toBe("16px");
  let prefs = await preferences(); await prefs.getByRole("spinbutton", { name: "Line height", exact: true }).fill("1.9"); await prefs.getByRole("spinbutton", { name: "Editor columns", exact: true }).fill("96"); await prefs.getByRole("checkbox", { name: "Source line numbers", exact: true }).check(); await prefs.getByRole("checkbox", { name: "Code block line numbers", exact: true }).check(); await prefs.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".reading-width-slider output")).toHaveText("96");
  await page.locator(".reading-width-slider input").focus(); for (let index = 0; index < 6; index++) await page.keyboard.press("ArrowLeft"); await expect(page.locator(".reading-width-slider output")).toHaveText("90");
  await expect.poll(() => rich().evaluate(element => getComputedStyle(element).lineHeight)).toBe("30.4px");
  const fence = rich().locator('.md-fence[data-kind="fence"]'); await fence.scrollIntoViewIfNeeded();
  await expect(fence.locator(".fence-body")).toHaveAttribute("data-line-numbers", "1\n2");
  await fence.locator("code").click(); await expect(fence.locator(".cm-lineNumbers")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+/"); await expect(page.locator(".document-editor:not([hidden]) .source-surface .cm-lineNumbers")).toBeVisible(); await page.keyboard.press("ControlOrMeta+/");
  passed.push("text-size shortcuts, line height/shared width, static/editing code and source line numbers work");
  for (const format of ['html', 'pdf']) {
    const target = path.join(exportDirectory, `reading.${format}`);
    await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, target);
    await page.getByRole('button', { name: 'More actions', exact: true }).click(); await page.getByRole('menuitem', { name: format === 'pdf' ? 'Export PDF' : 'Export HTML…', exact: true }).click();
    await expect.poll(async () => { try { return (await readFile(target)).length; } catch { return 0; } }, { timeout: 30000 }).toBeGreaterThan(1000);
    await expect(page.locator('body')).not.toHaveClass(/printing/);
    if (format === 'pdf') assert.equal((await readFile(target)).subarray(0, 5).toString(), '%PDF-');
    else {
      const exported = new JSDOM(await readFile(target, 'utf8')).window.document;
      assert.equal(exported.querySelector('tbody td').textContent, 'one'); assert.match(exported.body.textContent, /second paragraph/);
      for (const image of exported.querySelectorAll('img')) assert.ok(image.src.startsWith('data:image/'));
      assert.equal(exported.querySelector('.reading-fold,.reading-table-fold,.reading-image-viewer'), null);
    }
  }
  assert.equal(await sourceText(), original);
  passed.push('enabled reading plugins preserve full-table/body portable HTML and real PDF export without source edits');
  await page.locator('.sidebar').getByRole('button', { name: 'raw-slash.md', exact: true }).click();
  const rawSlash = rich().locator('p').filter({ hasText: '/ta' }); await rawSlash.click(); await page.keyboard.press('Home'); await page.keyboard.press('End');
  await expect(page.getByRole('listbox', { name: 'Slash commands', exact: true })).toBeVisible(); await page.keyboard.press('Enter');
  await expect(rich().locator('table')).toHaveCount(1); await rich().press('ControlOrMeta+s');
  await expect.poll(async () => (await readFile(slashFile, 'utf8')).startsWith('# CR slash\r\r| A | B |')).toBe(true);
  await rich().press('ControlOrMeta+z'); await rich().press('ControlOrMeta+s'); await expect.poll(() => readFile(slashFile, 'utf8')).toBe(slashOriginal);
  await page.locator('.sidebar').getByRole('button', { name: 'reading.md', exact: true }).click();
  passed.push('CR-only slash menu inserts a table; save and undo preserve original raw line endings');
  const paragraph = rich().locator("p").filter({ hasText: "Slash target" }); await paragraph.click(); await page.keyboard.press("Home"); await page.keyboard.press("Shift+End"); await page.keyboard.type("/ta");
  const slash = page.getByRole("listbox", { name: "Slash commands", exact: true }); await expect(slash).toBeVisible(); await page.keyboard.press("Enter"); await expect(rich().locator("table")).toHaveCount(2);
  const dirty = await sourceText(); assert.match(dirty, /\| A \| B \|/); assert.doesNotMatch(dirty, /\/ta/);
  passed.push("slash prefix filtering and keyboard selection insert an undoable table snippet");
  await page.screenshot({ path: path.join(evidence, "reading.png") });
  await expect.poll(async () => JSON.parse(await readFile(path.join(directory, "session.json"), "utf8")).documents.find(record => record.id === "fixture")?.content).toBe(dirty);
  await application.evaluate(({ app }) => app.exit(0)); await launch();
  assert.equal(await sourceText(), dirty);
  prefs = await preferences(); await expect(prefs.getByRole("spinbutton", { name: "Line height", exact: true })).toHaveValue("1.9"); await expect(prefs.getByRole("spinbutton", { name: "Editor columns", exact: true })).toHaveValue("90"); await expect(prefs.getByRole("checkbox", { name: "Source line numbers", exact: true })).toBeChecked(); await prefs.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal(await readFile(mixedFile, "utf8"), mixedOriginal);
  passed.push("display preferences and dirty draft survive a real process restart; original file bytes untouched");
  for (const name of ["Callouts", "Image viewer", "Resize images", "Fold tables", "Editor width slider", "Slash commands", "Right outline"]) await toggle(name, false);
  await expect(page.locator(".reading-right-outline,.reading-width-slider,.reading-image-viewer,.reading-image-resize,.reading-slash-menu,.reading-fold,.reading-table-fold")).toHaveCount(0);
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  passed.push("disable removes plugin controls/effects; no unexpected network requests or renderer errors");
  await writeFile(path.join(evidence, "result.json"), JSON.stringify({ passed, errors, external, directory, exportDirectory }, null, 2), "utf8");
  console.log(JSON.stringify({ passed, evidence }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(evidence, "failure.png") }).catch(() => {});
  await writeFile(path.join(evidence, "failure.json"), JSON.stringify({ passed, errors, external, resources, renderer: page && await page.evaluate(() => ({ plugins: localStorage.getItem('omarkie-plugins-v1'), marks: performance.getEntriesByType('mark').map(mark => mark.name), text: document.body.innerText })).catch(() => null), error: error.stack, directory }, null, 2), "utf8");
  throw error;
} finally { if (application) await application.close().catch(() => {}); }

await import("./reading-layers-desktop.mjs");
