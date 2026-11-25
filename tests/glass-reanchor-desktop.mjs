import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as launch, expect } from "playwright/test";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-reanchor-"));
const vault = path.join(home, "vault"), doc = "edition.md", file = path.join(vault, doc);
const first = `# Memory

Alpha paragraph about retrieval practice and spacing over days.

Beta paragraph about interleaving related topics.

Gamma paragraph that will be deleted.
`;
const second = `# Memory

New preface paragraph inserted by the edition.

Alpha rewritten: retrieval practice now covers interleaving and spacing in three dimensions.

Beta paragraph about interleaving related topics.
`;
const paragraphs = [
  { text: "Alpha paragraph about retrieval practice and spacing over days.", heading: "Memory", line: 3 },
  { text: "Beta paragraph about interleaving related topics.", heading: "Memory", line: 5 },
  { text: "Gamma paragraph that will be deleted.", heading: "Memory", line: 7 },
];
await mkdir(vault);
await writeFile(file, first, "utf8");
function session(content) {
  return { version: 1, activeId: "fixture", folder: vault, documents: [{ id: "fixture", path: file, name: doc,
    content, savedContent: content, diskHash: "0".repeat(64), lineEnding: "\n" }] };
}
await writeFile(path.join(home, "session.json"), JSON.stringify(session(first)), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const evidence = process.env.OMARKIE_EVIDENCE;

async function open() {
  const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
  const page = await app.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.reload();
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  await expect(rich.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  await page.getByRole("button", { name: "Display", exact: true }).click();
  const learning = page.getByRole("menuitemcheckbox", { name: "Learning mode", exact: true });
  if ((await learning.getAttribute("aria-checked")) !== "true") await learning.click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.desktop.glassState({ action: "write", visible: true }));
  await page.reload();
  await expect(rich.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1440);
  return { app, page, rich, errors };
}

let errors;
{
  const opened = await open();
  try {
    errors = opened.errors;
    await opened.page.evaluate(async paragraphs => {
      for (const [index, paragraph] of paragraphs.entries()) {
        const value = await window.desktop.glass({ note: "edition.md", action: "add", magnet: `ed-${index + 1}`,
          fields: { kind: "sticky", text: `Edition note ${index + 1}`, color: "blue", x: 8, y: 12, w: 180, h: 120,
            anchor: { version: 2, landmarks: [{ kind: "block", block: paragraph.text, headings: [paragraph.heading], line: paragraph.line }] } } });
        if (!value?.ok) throw new Error(value?.error ?? "seed failed");
      }
    }, paragraphs);
  } finally { await opened.app.close(); }
}

await writeFile(file, second, "utf8");
await writeFile(path.join(home, "session.json"), JSON.stringify(session(second)), "utf8");

{
  const { app, page, errors: pageErrors } = await open();
  try {
    await expect(page.locator(".glass-check")).toBeVisible({ timeout: 20_000 });
    const row = page.locator("[data-glass-check]").first();
    await expect(row).toContainText("Old");
    await expect(row).toContainText("New");
    await expect(page.locator("[data-glass-orphan]")).toHaveCount(1);
    const listed = await page.evaluate(async () => window.desktop.glass({ note: "edition.md", action: "list" }));
    assert.ok(listed?.value?.magnets, `glass list failed: ${JSON.stringify(listed)}`);
    const before = listed.value.magnets.length;
    assert.equal(before, 3, "nothing is lost when the edition changes");

    const checkId = await row.getAttribute("data-glass-check");
    await row.locator("[data-glass-place]").click();
    await expect(page.locator(`[data-glass-check="${checkId}"]`)).toHaveCount(0);
    const keptId = await page.locator("[data-glass-orphan]").first().getAttribute("data-glass-orphan");
    await page.locator(`[data-glass-orphan="${keptId}"] [data-glass-keep]`).click();
    await expect(page.locator(`[data-glass-orphan="${keptId}"]`)).toHaveCount(0);
    await expect.poll(() => page.evaluate(async () => {
      const response = await window.desktop.glass({ note: "edition.md", action: "list" });
      return (response.value?.magnets ?? []).map(magnet => magnet.id).sort();
    })).toEqual(["ed-1", "ed-2", "ed-3"]);

    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: path.join(evidence, "glass-g19-reanchor-1440.png") });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(720, 900));
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(720);
      await page.screenshot({ path: path.join(evidence, "glass-g19-reanchor-720.png") });
    }
    await page.emulateMedia({ forcedColors: "active" });
    const forced = await page.locator(".glass-check").evaluate(element => getComputedStyle(element).borderStyle);
    assert.notEqual(forced, "none");
    await page.emulateMedia({ forcedColors: "none" });
    assert.equal(await readFile(file, "utf8"), second, "re-anchoring never rewrites the page");
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(errors, []);
    console.log("PASS: new edition opens the check-placement tray; place and keep lose nothing");
  } finally { await app.close(); }
}
