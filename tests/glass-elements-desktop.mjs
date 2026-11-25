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

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-elements-"));
const vault = path.join(home, "vault"), doc = "elements.md", file = path.join(vault, doc);
const source = `# Element boxes

Kerma is the kinetic energy released per unit mass.

## Reading

- first item
- second item
  - nested item

| Dose | Unit |
| --- | --- |
| 1 Gy | J/kg |

![Film badge](badge.png)

$$ K = \\frac{dE}{dm} $$

\`\`\`ts
const kerma = 1;
\`\`\`

> [!warning] Careful
> Shielding matters.

Closing paragraph.
`;
const badge = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#8ab3d7" } }).png().toBuffer();
await mkdir(vault);
await writeFile(file, source, "utf8");
await writeFile(path.join(vault, "badge.png"), badge);
function session(content) {
  return { version: 1, activeId: "fixture", folder: vault, documents: [{ id: "fixture", path: file, name: doc,
    content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), lineEnding: "\n" }] };
}
await writeFile(path.join(home, "session.json"), JSON.stringify(session(source)), "utf8");
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: "en" });
delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const qa = process.env.OMARKIE_QA_DIR;
if (qa) await mkdir(qa, { recursive: true });
const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
async function axi(...args) {
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 15_000 });
  return decode(stdout);
}

async function capture(page, name, extra = 0) {
  if (!qa) return;
  const box = await page.locator(".element-halo-box").first().boundingBox();
  const size = page.viewportSize() ?? { width: 1440, height: 900 };
  if (!box) { await page.screenshot({ path: path.join(qa, `g4-${name}.png`) }); return; }
  const x = Math.max(0, Math.floor(box.x - 12)), y = Math.max(0, Math.floor(box.y - 26));
  const width = Math.min(size.width - x, Math.ceil(box.width + 24)), height = Math.min(size.height - y, Math.ceil(box.height + 38 + extra));
  if (width < 8 || height < 8) return;
  await page.screenshot({ path: path.join(qa, `g4-${name}.png`), clip: { x, y, width, height } });
}

const first = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
try {
  const page = await first.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__elementActions = [];
    window.addEventListener("omarkie:element-action", event => window.__elementActions.push(event.detail));
  });
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  await expect(rich.getByRole("heading", { name: "Element boxes", exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  const key = name => page.getByRole("button", { name, exact: true });
  async function display(label, on) {
    await key("Display").click();
    const item = page.getByRole("menuitemcheckbox", { name: label, exact: true });
    const checked = (await item.getAttribute("aria-checked")) === "true";
    if (checked !== on) await item.click();
    await page.keyboard.press("Escape");
  }
  async function resize(width) {
    await first.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
  }
  await resize(1440);
  if (process.platform === "linux") await display("Learning mode", true);
  else if ((await key("Learning mode").getAttribute("aria-pressed")) !== "true") await key("Learning mode").click();
  await expect(rich).toHaveAttribute("contenteditable", "false");
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "light"));
  await rich.click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("g");
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
  await expect(page.locator(".element-halo")).toHaveAttribute("data-element-halo", "on");

  const hoverLabel = page.locator(".element-halo-box").first().locator(".element-halo-label");
  const hoverBox = page.locator(".element-halo-box").first();
  const selectedBox = page.locator(".element-halo-box.is-selected");
  const pill = page.locator(".element-halo-pill");
  const targets = {
    heading: () => rich.getByRole("heading", { name: "Element boxes", exact: true }),
    paragraph: () => rich.locator("p[data-cid]", { hasText: "Kerma is the kinetic energy" }),
    item: () => rich.getByRole("listitem").filter({ hasText: "first item" }),
    cell: () => rich.locator("td", { hasText: "1 Gy" }),
    image: () => rich.locator('img[alt="Film badge"]'),
    formula: () => rich.locator(".md-math"),
    code: () => rich.locator(".md-fence:not(.md-math)").first(),
    callout: () => rich.locator("blockquote").first(),
  };
  const labels = { heading: "Heading", paragraph: "Paragraph", item: "List item", cell: "Cell", image: "Image", formula: "Formula", code: "Code", callout: "Callout" };
  async function hover(name) {
    const target = targets[name]();
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    assert.ok(box, `${name} box`);
    await page.mouse.move(box.x + Math.min(box.width / 2, 60), box.y + Math.min(box.height / 2, 12));
    await expect(hoverLabel).toHaveText(labels[name]);
    return box;
  }
  async function aligned(name, target) {
    await expect.poll(async () => {
      const [box, halo] = await Promise.all([target.boundingBox(), page.locator(".element-halo-box").first().boundingBox()]);
      if (!box || !halo) return "missing";
      const delta = Math.max(Math.abs(box.x - halo.x), Math.abs(box.y - halo.y), Math.abs(box.width - halo.width), Math.abs(box.height - halo.height));
      return delta <= 2 ? "aligned" : JSON.stringify([box, halo]);
    }, { message: `${name} halo sits on its element` }).toBe("aligned");
  }

  const themes = [["light", 1440], ["light", 720], ["omarchy-dark", 1440], ["omarchy-dark", 720]];
  const kinds = { heading: "heading", paragraph: "paragraph", item: "list-item", cell: "table-cell", image: "image", formula: "formula", code: "code", callout: "callout" };
  for (const [theme, width] of themes) {
    if (theme !== "light" || width !== 1440) {
      await page.evaluate(theme => localStorage.setItem("omarkie-theme", theme), theme);
      await page.reload();
      await expect(rich.getByRole("heading", { name: "Element boxes", exact: true })).toBeVisible();
      await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
      await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
    }
    if (width !== 1440) await resize(width);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    for (const name of Object.keys(targets)) {
      const before = await hover(name);
      await aligned(name, targets[name]());
      assert.deepEqual(await targets[name]().boundingBox(), before, `${name} does not move when hovered`);
      await capture(page, `${name}-${theme}-${width}`);
      await expect(hoverBox).toHaveAttribute("data-element-kind", kinds[name]);
    }
    const paragraphBounds = await hover("paragraph");
    await page.mouse.click(paragraphBounds.x + 30, paragraphBounds.y + 10);
    await expect(selectedBox).toBeVisible();
    for (const name of ["Change", "Comment"]) await expect(pill.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
    await capture(page, `actions-${theme}-${width}`, 40);
    await page.keyboard.press("Escape");
    await expect(selectedBox).toBeHidden();
    await resize(1440);
  }
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "light"));
  await page.reload();
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
  await expect(page.locator(".element-halo")).toHaveAttribute("data-element-halo", "on");

  // Agent parity: the CLI and the halo name the same paragraph with the same id.
  const listed = await axi("element", "list", "--note", doc);
  const paragraph = listed.elements.find(element => element.kind === "paragraph" && element.text.startsWith("Kerma is"));
  assert.ok(paragraph, "CLI lists the paragraph");
  await hover("paragraph");
  await expect(hoverBox).toHaveAttribute("data-element-hover", paragraph.id);
  const shown = await axi("element", "show", paragraph.id, "--note", doc);
  assert.equal(shown.element.kind, "paragraph");
  assert.deepEqual(shown.element.headings, ["Element boxes"]);
  assert.equal(shown.element.box.line, paragraph.box.line);
  assert.equal(shown.element.landmarks.length, 6);

  // Click selects, the pill announces intent, Esc clears, and typing still edits the page.
  const paragraphBox = await targets.paragraph().boundingBox();
  await page.mouse.click(paragraphBox.x + 30, paragraphBox.y + 10);
  await expect(selectedBox).toBeVisible();
  await expect(selectedBox).toHaveAttribute("data-element-kind", "paragraph");
  await expect(pill.getByRole("button", { name: "Change", exact: true })).toBeVisible();
  await expect(pill.getByRole("button", { name: "Comment", exact: true })).toBeVisible();
  await expect(page.locator(".element-halo-live")).toContainText(`Selected Paragraph: ${paragraph.text}`);
  await capture(page, "selected-light-1440", 40);
  await pill.getByRole("button", { name: "Change", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__elementActions.map(action => action.action))).toEqual(["change"]);
  assert.equal((await page.evaluate(() => window.__elementActions[0].id)), paragraph.id);
  assert.equal((await page.evaluate(() => window.__elementActions[0].kind)), "paragraph");
  await pill.getByRole("button", { name: "Comment", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__elementActions.map(action => action.action))).toEqual(["change", "comment"]);
  const settled = await targets.paragraph().boundingBox();
  assert.ok(Math.abs(settled.y - paragraphBox.y) < 0.5 && Math.abs(settled.height - paragraphBox.height) < 0.5, "the halo never shifts the page");
  await page.keyboard.press("Escape");
  await expect(pill).toHaveCount(0);
  await expect(selectedBox).toBeHidden();
  await expect(page.locator(".element-halo-live")).toHaveText("");

  // Keyboard walk: Tab forward, Shift+Tab back, no tab characters land in the note.
  const before = await readFile(file, "utf8");
  await page.mouse.move(paragraphBox.x + 30, paragraphBox.y + 10);
  await page.keyboard.press("Tab");
  await expect(selectedBox).toHaveAttribute("data-element-kind", "heading");
  await page.keyboard.press("Tab");
  await expect(selectedBox).toHaveAttribute("data-element-kind", "paragraph");
  await page.keyboard.press("Enter");
  await expect(pill.getByRole("button", { name: "Change", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(pill.getByRole("button", { name: "Comment", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__elementActions.map(action => action.action))).toEqual(["change", "comment", "comment"]);
  await page.keyboard.press("Shift+Tab");
  await expect(pill.getByRole("button", { name: "Change", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(selectedBox).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(selectedBox).toHaveAttribute("data-element-kind", "heading");
  await page.keyboard.press("Tab");
  await expect(selectedBox).toHaveAttribute("data-element-kind", "paragraph");
  await capture(page, "tab-light-1440", 40);
  await page.keyboard.press("Shift+Tab");
  await expect(selectedBox).toHaveAttribute("data-element-kind", "heading");
  await page.keyboard.press("Escape");
  await expect(selectedBox).toBeHidden();
  assert.equal(await readFile(file, "utf8"), before, "walking elements never types into the note");

  // Editing still works with glass on: leave reading view, type in the source surface, undo.
  await display("Learning mode", false);
  await expect(rich).toHaveAttribute("contenteditable", "true");
  await display("Source Code Mode", true);
  const sourceSurface = page.locator(".document-editor:not([hidden]) .cm-content");
  await expect(sourceSurface).toBeVisible();
  await sourceSurface.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("Typed while glass was on.");
  await expect.poll(() => page.evaluate(() => document.querySelector(".cm-content")?.textContent?.startsWith("Typed while glass was on."))).toBe(true);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => page.evaluate(() => document.querySelector(".cm-content")?.textContent?.startsWith("# Element boxes"))).toBe(true);
  await display("Source Code Mode", false);
  await display("Learning mode", true);
  await expect(rich).toHaveAttribute("contenteditable", "false");
  await expect(page.locator(".element-halo")).toHaveAttribute("data-element-halo", "on");
  assert.equal(await readFile(file, "utf8"), before, "the note on disk is unchanged until save");

  // Glass off removes the halo and its listeners entirely.
  await rich.click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("g");
  await expect(page.locator(".glass-layer")).toHaveCount(0);
  await expect(page.locator(".element-halo")).toHaveCount(0);
  await page.mouse.move(paragraphBox.x + 30, paragraphBox.y + 10);
  await expect(page.locator(".element-halo-box")).toHaveCount(0);
  await page.keyboard.press("g");
  await expect(page.locator(".element-halo")).toHaveAttribute("data-element-halo", "on");
  assert.deepEqual(errors, []);
  console.log("PASS: hover labels every kind, click selects with a working pill, Tab walks, Esc clears, editing still works, glass off is inert");
} finally { await first.close(); }

// Budget: hover keeps 60 fps on a 1,000-paragraph note, and the model parses once per edit.
const bulkHome = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-elements-bulk-"));
const bulkVault = path.join(bulkHome, "vault"), bulkDoc = "bulk.md", bulkFile = path.join(bulkVault, bulkDoc);
const paragraphs = Array.from({ length: 1000 }, (_, index) => `Paragraph ${index + 1} keeps one quiet line about kerma and shielding.`).join("\n\n");
const bulk = `# Bulk\n\n${paragraphs}\n`;
await mkdir(bulkVault);
await writeFile(bulkFile, bulk, "utf8");
await writeFile(path.join(bulkHome, "session.json"), JSON.stringify({ version: 1, activeId: "fixture", folder: bulkVault,
  documents: [{ id: "fixture", path: bulkFile, name: bulkDoc, content: bulk, savedContent: bulk, diskHash: createHash("sha256").update(bulk).digest("hex"), lineEnding: "\n" }] }), "utf8");
const bulkEnv = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: bulkHome, OMARKIE_LANGUAGE: "en", OMARKIE_TEST_HIDDEN: "0" });
delete bulkEnv.OMARKIE_DEV_URL; delete bulkEnv.ELECTRON_RUN_AS_NODE;
const second = await launch.launch({ args: [process.cwd(), ...headlessArguments], env: bulkEnv });
try {
  const page = await second.firstWindow(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  await expect(rich.getByRole("heading", { name: "Bulk", exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  if (process.platform === "linux") {
    await page.getByRole("button", { name: "Display", exact: true }).click();
    const item = page.getByRole("menuitemcheckbox", { name: "Learning mode", exact: true });
    if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
    await page.keyboard.press("Escape");
  } else if ((await page.getByRole("button", { name: "Learning mode", exact: true }).getAttribute("aria-pressed")) !== "true") await page.getByRole("button", { name: "Learning mode", exact: true }).click();
  await expect(rich).toHaveAttribute("contenteditable", "false");
  await rich.click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("g");
  await expect(page.locator(".element-halo")).toHaveAttribute("data-element-halo", "on");
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    window.__rafWork = [];
    window.requestAnimationFrame = callback => raf((time) => {
      const start = performance.now();
      try { callback(time); } finally {
        const work = performance.now() - start;
        if (work > 0.05) window.__rafWork.push(work);
      }
    });
  });
  await page.reload();
  await expect(rich.getByRole("heading", { name: "Bulk", exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  await expect(rich).toHaveAttribute("contenteditable", "false");
  if ((await page.locator(".glass-layer").getAttribute("data-glass")) !== "on") {
    await rich.click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("g");
  }
  await expect(page.locator(".element-halo")).toHaveAttribute("data-element-halo", "on");
  const bulkAxi = async (...args) => {
    const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: bulkVault, env: { ...bulkEnv, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20_000 });
    return decode(stdout);
  };
  const bulkListed = await bulkAxi("element", "list", "--note", bulkDoc);
  assert.equal(bulkListed.count, 1001, "the model covers the whole 1,000-paragraph note");
  const hover = await page.evaluate(async () => {
    const blocks = [...document.querySelectorAll(".rich-document > p[data-cid]")];
    window.__rafWork = [];
    const seen = new Set();
    await new Promise(resolve => {
      let step = 0;
      const tick = () => {
        if (step >= 120) { resolve(); return; }
        const block = blocks[(step * 37) % blocks.length];
        const rect = block.getBoundingClientRect();
        block.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: rect.left + 8, clientY: rect.top + 6 }));
        seen.add(document.querySelector(".element-halo-box")?.dataset.elementHover);
        step++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const sorted = [...window.__rafWork].sort((left, right) => left - right);
    return { p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1), frames: sorted.length, distinct: seen.size };
  });
  assert.ok(hover.distinct >= 8, `the halo follows distinct paragraphs (${hover.distinct})`);
  assert.ok(hover.frames >= 50, `hover frames were measured (${hover.frames})`);
  assert.ok(hover.p95 <= 16.7, `hover main-thread work p95 ${hover.p95.toFixed(2)} ms stays inside a 60 fps frame`);
  await expect(page.locator(".element-halo-box").first().locator(".element-halo-label")).toHaveText("Paragraph");
  await page.evaluate(() => {
    let node = document.querySelector(".rich-document");
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) break;
      node = node.parentElement;
    }
    if (node) node.scrollTop = node.scrollHeight;
  });
  const last = page.locator(".rich-document p[data-cid]", { hasText: "Paragraph 1000 keeps" });
  await expect(last).toBeVisible();
  await last.hover();
  const lastListed = bulkListed.elements.find(element => element.kind === "paragraph" && element.text.startsWith("Paragraph 1000 "));
  await expect(page.locator(".element-halo-box").first()).toHaveAttribute("data-element-hover", lastListed.id);
  if (qa) await page.screenshot({ path: path.join(qa, "g4-bulk-light-1440.png") });
  assert.deepEqual(errors, []);
  console.log(`PASS: 1,000-paragraph hover p95 ${hover.p95.toFixed(2)} ms over ${hover.distinct} elements; last paragraph resolves to ${lastListed.id}`);
} finally { await second.close(); }
