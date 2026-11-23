import { chromium, expect } from "playwright/test";
import { preview } from "vite";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Shipped introductions: five English notes, eight pictures, unchanged Markdown.
const notes = new Map([
  ["travel-journal.md", 4], ["recipe-card.md", 1], ["space-explainer.md", 1],
  ["launch-plan.md", 1], ["poetry-and-type.md", 1],
]);
const server = await preview({ preview: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.OMARKIE_BROWSER_EXECUTABLE });
  const context = await browser.newContext({ locale: "es-ES", viewport: { width: 1380, height: 960 } });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const collectorChunks = [];
  page.on("request", request => { if (/\/reading-collector-[^/]+\.js$/.test(request.url())) collectorChunks.push(request.url()); });
  await page.goto(server.resolvedUrls.local[0]);
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.getByRole("button", { name: "Más acciones", exact: true })).toBeVisible();
  const active = page.locator(".document-editor:not([hidden])");
  await expect(active.getByRole("heading", { name: "Seven Days on the Lighthouse Coast 🌄", exact: true })).toBeVisible();
  for (const name of notes.keys()) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  for (const [name, count] of notes) {
    await page.getByRole("button", { name, exact: true }).click();
    const images = active.locator("img");
    await expect(images).toHaveCount(count);
    for (let index = 0; index < count; index++) {
      const image = images.nth(index);
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0), { message: `${name}: picture ${index + 1} decodes` }).toBe(true);
    }
    await page.locator(".source-toggle").click();
    await expect(active.locator(".cm-content")).toContainText("images/");
    await page.locator(".source-toggle").click();
  }
  await page.getByRole("button", { name: "travel-journal.md", exact: true }).click();
  await page.locator(".source-toggle").click();
  const editor = active.locator(".cm-content");
  await editor.click();
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("\nRetained browser draft.\n");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("omarkie-session-v1"))).toContain("Retained browser draft.");
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem("omarkie-session-v1")));
  for (const record of before.documents) {
    const original = await readFile(new URL(`../docs/showcase/${record.name}`, import.meta.url), "utf8");
    assert.equal(record.savedContent, original);
    if (record.id !== before.activeId) assert.equal(record.content, original);
  }
  await page.reload();
  await expect(active).toContainText("Retained browser draft.");
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem("omarkie-session-v1")));
  assert.equal(after.activeId, before.activeId);
  assert.deepEqual(after.documents, before.documents);
  if (await page.locator(".source-toggle").getAttribute("aria-pressed") === "true") await page.locator(".source-toggle").click();
  const photo = active.locator("img").first();
  await photo.scrollIntoViewIfNeeded();
  await expect.poll(() => photo.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  assert.deepEqual(collectorChunks, [], "opening and editing notes do not load the collector");
  await page.locator(".source-toggle").click();
  await editor.press("ControlOrMeta+End");
  const excerpt = "\n\n==Unsaved collector highlight==\n\n> [!tip]+ Collector callout\n> Callout body.\n";
  await page.keyboard.insertText(excerpt);
  const recovered = () => page.evaluate(() => JSON.parse(localStorage.getItem("omarkie-session-v1")));
  await expect.poll(async () => (await recovered()).documents.find(record => record.id === after.activeId)?.content).toContain(excerpt.trim());
  const source = (await recovered()).documents.find(record => record.id === after.activeId);
  await page.getByRole("button", { name: "Más acciones", exact: true }).click();
  await page.getByRole("menuitem", { name: "Recopilar resaltados y avisos", exact: true }).click();
  await expect(page.locator(".document-title")).toHaveAttribute("title", "Resumen de lectura.md");
  await expect.poll(async () => {
    const session = await recovered();
    return session.documents.find(record => record.id === session.activeId)?.content;
  }).toContain("- Unsaved collector highlight\n\n> [!tip]+ Collector callout\n> Callout body.");
  if (await page.locator(".source-toggle").getAttribute("aria-pressed") !== "true") await page.locator(".source-toggle").click();
  await editor.press("ControlOrMeta+End");
  await page.keyboard.insertText("\nEditable collector draft.");
  await expect(editor).toContainText("Editable collector draft.");
  const collected = await recovered();
  assert.deepEqual(collected.documents.find(record => record.id === source.id), source);
  assert.ok(collectorChunks.length > 0, "only executing the collector loads its module");
  assert.deepEqual(errors, []);
  console.log("Browser startup: eight decoded pictures; source, restored draft and lazy reading summary verified");
} finally {
  try { await browser?.close(); }
  finally { await server.close(); }
}
