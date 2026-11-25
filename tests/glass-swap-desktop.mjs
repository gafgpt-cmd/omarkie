import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import electron from "electron";
import sharp from "sharp";
import { _electron as launch, expect } from "playwright/test";
import { decode } from "@toon-format/toon";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

if (process.platform === "win32") process.exit(0);
const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-g22-"));
const shots = process.env.OMARKIE_G22_SHOTS || path.join(home, "screens");
await mkdir(shots, { recursive: true });
const vault = path.join(home, "vault"), doc = "swap.md", file = path.join(vault, doc);
await mkdir(vault);
const heading = "Swap anything";
const first = "Kerma is the kinetic energy released per unit mass of tissue.";
const source = `# ${heading}\n\n${first}\n\n![Badge](badge.png)\n\n\`\`\`mermaid\ngraph TD\n  A[Start] --> B[End]\n\`\`\`\n`;
const badg = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#8ab3d7" } }).png().toBuffer();
const better = await sharp({ create: { width: 900, height: 640, channels: 3, background: "#d7b38a" } }).png().toBuffer();
await writeFile(file, source, "utf8");
await writeFile(path.join(vault, "badge.png"), badg);
await writeFile(path.join(vault, "median-nerve.png"), better);
const script = name => path.join(home, `${name}.mjs`);
await writeFile(script("enhance"), `import { copyFile } from "node:fs/promises";\nawait copyFile(process.argv[2], process.argv[3]);\n`);
await writeFile(script("stt"), `process.stdout.write("this picture looks nothing like a nerve");\n`);
const search = path.join(home, "search.json");
await writeFile(search, JSON.stringify([{ title: "Median nerve anatomy", creator: "Ada Lovelace", sourceUrl: "https://commons.wikimedia.org/wiki/File:Median_nerve.jpg",
  licence: { code: "by", version: "3.0", url: "https://creativecommons.org/licenses/by/3.0/", attribution: "Ada Lovelace" }, width: 900, height: 640,
  bytesBase64: better.toString("base64") }]), "utf8");
const tutor = JSON.stringify({
  rewrite: JSON.stringify({ feedback: "Clearer cue.", replacement: "Kerma: energy released per unit mass." }),
  redraw: JSON.stringify({ feedback: "Straightened.", replacement: "graph TD\n  A[Start] --> C[End, clearer]" }),
});
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en",
  OMARKIE_ENHANCE: JSON.stringify(["node", script("enhance")]), OMARKIE_STT: JSON.stringify(["node", script("stt")]),
  OMARKIE_SWAP_SEARCH: search, OMARKIE_TUTOR_STUB: tutor });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
async function axi(...args) {
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 60_000 });
  return decode(stdout);
}
const original = await readFile(file);
function session(content) {
  return { version: 1, activeId: "fixture", folder: vault, documents: [{ id: "fixture", path: file, name: doc,
    content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), lineEnding: "\n" }] };
}
await writeFile(path.join(home, "session.json"), JSON.stringify(session(source)), "utf8");

const app = await launch.launch({ args: [process.cwd(), ...headlessArguments, "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"], env });
try {
  const page = await app.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__swapActions = [];
    window.addEventListener("omarkie:element-action", event => window.__swapActions.push(event.detail));
  });
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  await expect(rich.getByRole("heading", { name: heading, exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  if (process.platform === "linux") {
    await page.getByRole("button", { name: "Display", exact: true }).click();
    const item = page.getByRole("menuitemcheckbox", { name: "Learning mode", exact: true });
    if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
    await page.keyboard.press("Escape");
  }
  await expect(rich).toHaveAttribute("contenteditable", "false");
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "light"));
  await rich.click({ position: { x: 4, y: 4 } });
  if (!await page.locator(".glass-layer").count()) await page.keyboard.press("g");
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:glass-ready").length > 0);

  async function rearm() {
    await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
    await expect(rich.getByRole("heading", { name: heading, exact: true })).toBeVisible({ timeout: 30_000 });
    if (process.platform === "linux") {
      await page.getByRole("button", { name: "Display", exact: true }).click();
      const item = page.getByRole("menuitemcheckbox", { name: "Learning mode", exact: true });
      if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
      await page.keyboard.press("Escape");
    }
    await rich.click({ position: { x: 4, y: 4 } });
    if (!await page.locator(".glass-layer").count()) await page.keyboard.press("g");
    await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on", { timeout: 15_000 });
    await page.waitForFunction(() => performance.getEntriesByName("omarkie:glass-ready").length > 0);
  }

  const panel = page.locator("[data-swap-panel]");
  const notice = page.locator("[data-swap-notice]");
  async function select(target) {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    assert.ok(box, "element box");
    await page.mouse.move(box.x + 2, Math.max(2, box.y - 8));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await target.click();
    const selected = page.locator(".element-halo-box.is-selected");
    if (!await selected.isVisible()) await target.click();
    await expect(selected).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-element-action="change"]').click();
    await expect(panel).toBeVisible();
  }
  async function chip(name) {
    await panel.locator(`[data-swap-kind="${name}"]`).click();
    await expect(panel.locator("[data-swap-cards]")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: path.join(shots, "g22-panel-light-1440.png") });
  }
  async function close() {
    if (await panel.count()) await panel.locator("[data-swap-close]").click();
    await expect(panel).toHaveCount(0);
  }

  // 1. Picture: enhance hook → cover leaves the note byte-identical → undo.
  await select(rich.locator('img[alt="Badge"]'));
  await expect(panel.locator("[data-swap-cards]")).toBeVisible({ timeout: 20_000 });
  await chip("enhance");
  const enhanced = panel.locator('[data-swap-candidate]').filter({ hasText: "sharpened" }).first();
  await expect(enhanced).toBeVisible({ timeout: 20_000 });
  await enhanced.click();
  await panel.locator("[data-swap-cover]").click();
  await expect(notice).toContainText("Covered", { timeout: 20_000 });
  assert.equal((await readFile(file)).equals(original), true, "cover must not touch the note");
  await page.screenshot({ path: path.join(shots, "g22-cover-light-1440.png") });
  await panel.locator("[data-swap-restore]").click();
  await expect(notice).toContainText("Restored", { timeout: 20_000 });

  // 2. Replace in page: diff preview, then Accept, footnote with licence data; undo restores bytes.
  await chip("find");
  await panel.locator("[data-swap-complaint]").fill("nerve");
  await panel.locator("[data-swap-search]").click();
  const vaultCard = panel.locator('[data-swap-candidate]').filter({ hasText: "median-nerve" }).first();
  await expect(vaultCard).toBeVisible({ timeout: 20_000 });
  await vaultCard.click();
  await expect(panel.locator("[data-swap-compare]")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "g22-compare-light-1440.png") });
  await panel.locator("[data-swap-replace]").click();
  await expect(panel.locator("[data-swap-preview]")).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator("[data-swap-preview]")).toContainText("Replace in page");
  await page.screenshot({ path: path.join(shots, "g22-diff-light-1440.png") });
  await panel.locator("[data-swap-accept]").click();
  await expect(notice).toContainText("Replaced", { timeout: 20_000 });
  const replaced = await readFile(file, "utf8");
  assert.match(replaced, /median-nerve/, "the page points at the new vault picture");
  assert.match(replaced, /\[\^swap-[a-f0-9]{12}\]:/, "the footnote is written");
  assert.match(replaced, /from your vault/, "vault provenance is named");
  assert.equal(replaced.includes("![Badge](badge.png)"), false);
  await panel.locator("[data-swap-restore]").click();
  await expect(notice).toContainText("Restored", { timeout: 20_000 });
  assert.equal((await readFile(file)).equals(original), true, "undo restores the exact bytes");
  await close();

  // 3. Voice complaint fills the box; offline search stays behind the explicit click.
  await select(rich.locator('img[alt="Badge"]'));
  await panel.locator("[data-swap-mic]").click();
  await expect(panel.locator("[data-swap-mic]")).toHaveAttribute("data-recording", "on");
  await panel.locator("[data-swap-mic]").click();
  await expect(panel.locator('[data-swap-mic]:not([data-recording])')).toContainText("Say it", { timeout: 20_000 });
  await expect(panel.locator("[data-swap-complaint]")).toHaveValue("this picture looks nothing like a nerve", { timeout: 20_000 });
  await panel.locator('[data-swap-kind="find"]').click();
  await expect(panel.locator("[data-swap-online]")).toBeVisible({ timeout: 20_000 });
  assert.equal(await panel.locator("[data-swap-online]").isChecked(), false, "online is never on by default");
  await panel.locator("[data-swap-never-online]").check();
  await expect(panel.locator("[data-swap-online]")).toBeDisabled();
  assert.equal(await page.evaluate(() => document.querySelector("[data-swap-online]")?.closest("label")?.textContent), "This vault never goes online.");
  await panel.locator("[data-swap-never-online]").uncheck();
  await panel.locator("[data-swap-online]").check();
  const onlineCard = panel.locator('[data-swap-candidate]').filter({ hasText: "Median nerve anatomy" }).first();
  await expect(onlineCard).toBeVisible({ timeout: 20_000 });
  await expect(onlineCard).toContainText("BY 3.0");
  await onlineCard.click();
  await page.screenshot({ path: path.join(shots, "g22-online-light-1440.png") });
  await close();

  // 4. Text: Rewrite via the Tutor bridge, replace with preview + Accept, undo.
  await select(rich.locator("p[data-cid]", { hasText: "Kerma is the kinetic energy" }));
  await chip("rewrite");
  assert.equal(await panel.locator("[data-swap-cards]").count(), 1);
  await panel.locator("[data-swap-tutor]").click();
  await expect(panel.locator("[data-swap-textdiff]")).toContainText("Kerma: energy released per unit mass.", { timeout: 20_000 });
  await panel.locator("[data-swap-replace]").click();
  await expect(panel.locator("[data-swap-preview]")).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator("[data-swap-preview]")).toContainText(/the tutor/i);
  await panel.locator("[data-swap-accept]").click();
  await expect(notice).toContainText("Replaced", { timeout: 20_000 });
  const rewritten = await readFile(file, "utf8");
  assert.match(rewritten, /Kerma: energy released per unit mass\./);
  assert.match(rewritten, /the tutor/i, "the Tutor is credited in the footnote");
  await panel.locator("[data-swap-restore]").click();
  await expect(notice).toContainText("Restored", { timeout: 20_000 });
  assert.equal((await readFile(file)).equals(original), true);
  await close();

  // 5. Diagram: Redraw renders the Mermaid candidate under securityLevel strict, then replaces.
  await select(rich.locator(".md-fence").first());
  await chip("redraw");
  await panel.locator("[data-swap-tutor]").click();
  await expect(panel.locator("[data-swap-mermaid] svg")).toBeVisible({ timeout: 20_000 });
  await panel.locator("[data-swap-replace]").click();
  await panel.locator("[data-swap-accept]").click();
  await expect(notice).toContainText("Replaced", { timeout: 20_000 });
  const redrawn = await readFile(file, "utf8");
  assert.match(redrawn, /A\[Start\] --> C\[End, clearer\]/);
  await panel.locator("[data-swap-restore]").click();
  await expect(notice).toContainText("Restored", { timeout: 20_000 });
  assert.equal((await readFile(file)).equals(original), true);
  await close();

  // 6. Background proposals wait as cards and dismiss without touching the note.
  const element = await axi("element", "list", "--note", doc, "--vault", vault);
  const paragraph = element.elements.find(row => row.kind === "paragraph");
  assert.ok(paragraph, "a paragraph element exists");
  const agentView = await axi("element", "swap", "--note", doc, "--element", paragraph.id, "--complaint", "too dense");
  assert.equal(agentView.element.id, paragraph.id);
  assert.deepEqual(agentView.actions, ["rewrite"]);
  assert.equal(agentView.candidates[0].current, true);
  const proposed = await page.evaluate(async ({ note, element }) => {
    const proposal = { id: "p-1", kind: "rewrite", title: "Proposed cue", source: "tutor", sourceLabel: "the Tutor",
      licence: { code: "tutor", attribution: "Tutor", required: false }, text: "Proposed: kerma is energy per mass." };
    return window.desktop.glass({ note, action: "swap-propose", element, candidates: [proposal] });
  }, { note: doc, element: paragraph.id });
  assert.equal(proposed.ok, true);
  await select(rich.locator('img[alt="Badge"]'));
  await page.evaluate(async note => window.desktop.glass({ note, action: "swap-state" }), doc);
  await expect(panel.locator("[data-swap-proposals] [data-swap-proposal]").first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: path.join(shots, "g22-proposals-light-1440.png") });
  await panel.locator("[data-swap-proposals] [data-swap-proposal]").first().getByRole("button", { name: "Dismiss" }).click();
  await expect(panel.locator("[data-swap-proposals] [data-swap-proposal]")).toHaveCount(0, { timeout: 20_000 });
  await close();

  // 7. Narrow width and dark theme keep the rail inside the screen.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(720, 900));
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([720, 900]);
  await select(rich.locator('img[alt="Badge"]'));
  const box = await panel.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 720, `panel fits 720: ${JSON.stringify(box)}`);
  await page.screenshot({ path: path.join(shots, "g22-panel-light-720.png") });
  await close();
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "dark"));
  await page.reload();
  await rearm();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1440);
  await select(rich.locator('img[alt="Badge"]'));
  await expect(panel.locator("[data-swap-cards]")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: path.join(shots, "g22-panel-dark-1440.png") });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(720, 900));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(720);
  await page.screenshot({ path: path.join(shots, "g22-panel-dark-720.png") });
  await close();
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "light"));
  await page.reload();
  await rearm();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1440);
  await page.screenshot({ path: path.join(shots, "g22-note-light-1440.png") });

  assert.deepEqual(errors, [], "no page errors");
  const unchanged = (await readFile(file)).equals(original);
  assert.equal(unchanged, true, "the note ends byte-identical after every undo");
  console.log("G22 desktop: cover/replace/undo, voice, online-offline, rewrite, redraw, proposals, 720 rail — ok");
} finally {
  await app.close();
}
