import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { _electron as launch, expect } from "playwright/test";
import { decode } from "@toon-format/toon";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-glass-bubble-"));
const vault = path.join(home, "vault"), doc = "review.md", file = path.join(vault, doc);
const clean = "Kerma is the kinetic energy released per unit mass.";
const privateText = "Patient: Juan Pérez, MRN 88213, born 12/03/1975.";
const source = `# Bubble review

${clean}

Dose audit waits for the physicist.

${privateText}
`;
await mkdir(vault);
await writeFile(file, source, "utf8");
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
  const { stdout } = await promisify(execFile)(electron, [entry, ...args], { cwd: vault, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20_000 });
  return decode(stdout);
}
function listening(owner) {
  return new Promise((resolve, reject) => {
    execFile(electron, [entry, "poll", "--wait", "--owner", owner], { cwd: vault, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 60_000 }, (error, stdout) => {
      if (error) { reject(error); return; }
      resolve(decode(stdout));
    });
  });
}
async function answer(question, text, owner) {
  await expect(page.getByRole("button", { name: "Waiting for the agent…", exact: true })).toBeVisible();
  let claimed;
  // The bridge socket is created by the first submit, so a poll can land just before it exists.
  for (let attempt = 0; attempt < 40 && !claimed; attempt++) {
    const state = await listening(owner);
    if (state.ask) claimed = state.ask;
    else await page.waitForTimeout(150);
  }
  assert.ok(claimed, "the agent claims the bubble question");
  assert.equal(claimed.origin, "bubble");
  assert.equal(claimed.question, question);
  await axi("reply", claimed.id, "--text", text);
  return claimed;
}
async function shot(name) {
  if (qa) await page.screenshot({ path: path.join(qa, `g5-${name}.png`) });
}

const app = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
let page;
try {
  page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const rich = page.locator(".document-editor:not([hidden]) .rich-document");
  const panel = page.locator(".glass-bubble");
  const question = page.locator(".bubble-question textarea");
  const send = page.locator("[data-bubble-send]");
  const xray = page.locator(".bubble-xray-toggle");
  const key = name => page.getByRole("button", { name, exact: true });
  async function display(label, on) {
    await key("Display").click();
    const item = page.getByRole("menuitemcheckbox", { name: label, exact: true });
    if (((await item.getAttribute("aria-checked")) === "true") !== on) await item.click();
    await page.keyboard.press("Escape");
  }
  async function resize(width) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 900), width);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 900]);
  }
  async function learning() {
    if (process.platform === "linux") await display("Learning mode", true);
    else if ((await key("Learning mode").getAttribute("aria-pressed")) !== "true") await key("Learning mode").click();
    await expect(rich).toHaveAttribute("contenteditable", "false");
  }
  await expect(rich.getByRole("heading", { name: "Bubble review", exact: true })).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  await resize(1440);
  await learning();
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "light"));
  await rich.click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("g");
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
  await expect(page.locator(".element-halo")).toHaveAttribute("data-element-halo", "on");

  const target = () => rich.locator("p[data-cid]", { hasText: "Kerma is the kinetic energy" });
  const privateTarget = () => rich.locator("p[data-cid]", { hasText: "Patient: Juan Pérez" });
  async function commentOn(locator) {
    await locator.scrollIntoViewIfNeeded();
    const bounds = await locator.boundingBox();
    assert.ok(bounds, "element box");
    const point = await locator.evaluate(element => {
      const box = element.getBoundingClientRect();
      for (const left of [0.5, 0.7, 0.85, 0.15]) for (const top of [0.5, 0.25, 0.75]) {
        const x = box.left + box.width * left, y = box.top + box.height * top;
        if (element.contains(document.elementFromPoint(x, y))) return { x, y };
      }
      return null;
    });
    assert.ok(point, "an exposed point of the element is clickable");
    await page.mouse.click(point.x, point.y);
    await expect(page.locator(".element-halo-pill")).toBeVisible();
    await page.locator('[data-element-action="comment"]').click();
    await expect(panel).toBeVisible();
    return bounds;
  }
  async function closeBubble() {
    if (await panel.count()) await page.locator(".bubble-close").click();
    await expect(panel).toHaveCount(0);
  }

  // Element → bubble → question → X-ray → Send → threaded reply → pin.
  const cleanBox = await commentOn(target());
  await expect(panel.locator(".bubble-path")).toHaveText("Bubble review");
  await page.waitForTimeout(100);
  const anchored = await panel.boundingBox();
  assert.ok(anchored && anchored.y >= cleanBox.y + cleanBox.height - 2, "the bubble sits below its element");
  const contextBundle = panel.locator(".bubble-context");
  await contextBundle.locator("summary").click();
  await expect(contextBundle.locator(".bubble-quote")).toContainText(clean);
  await contextBundle.locator("summary").click();
  await question.fill("Why does mass matter for kerma?");
  await shot("open-light-1440");
  await xray.click();
  await expect(page.locator(".bubble-xray")).toBeVisible();
  assert.equal(await send.isDisabled(), false, "a clean payload may be sent");
  await shot("xray-light-1440");
  await xray.click();
  await expect(panel.locator(".bubble-xray")).toBeHidden();
  await xray.click();
  const answerText = "Kerma is energy per mass: **J/kg**, not newtons.";
  await send.click();
  await answer("Why does mass matter for kerma?", answerText, "Bubble agent");
  await expect(panel.locator('.bubble-thread li[data-bubble-role="agent"]')).toContainText("energy per mass");
  await shot("thread-light-1440");
  const pin = panel.getByRole("button", { name: "Pin as cue card", exact: true });
  await pin.click();
  await expect(panel.getByRole("button", { name: "Pinned as card", exact: true })).toBeDisabled();
  const cue = page.locator('.glass-card[data-card-kind="ai"]');
  await expect(cue).toHaveCount(1);
  await expect(cue).toContainText("Why does mass matter for kerma?");
  await expect(cue).toContainText("energy per mass");
  const listed = await axi("glass", "bubble", "list", "--note", doc);
  const savedBubble = listed.bubbles.find(bubble => bubble.question === "Why does mass matter for kerma?");
  assert.ok(savedBubble, "the CLI sees the bubble");
  assert.deepEqual(savedBubble.thread.map(entry => entry.role), ["you", "agent"]);
  await closeBubble();

  // Text range: the selection popup opens the same bubble and sends only the selected quote.
  await target().scrollIntoViewIfNeeded();
  const row = await target().boundingBox();
  assert.ok(row, "paragraph box");
  await page.mouse.move(row.x + 4, row.y + 10);
  await page.mouse.down();
  await page.mouse.move(row.x + 132, row.y + 10, { steps: 6 });
  await page.mouse.up();
  const selectionPopup = page.locator(".layers-selection");
  await expect(selectionPopup).toBeVisible();
  await selectionPopup.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(panel).toBeVisible();
  await xray.click();
  await expect(page.locator("[data-bubble-quote]")).toContainText("Kerma");
  const selected = await page.locator("[data-bubble-quote]").innerText();
  await question.fill("Just this phrase?");
  await send.click();
  const rangeAsk = await answer("Just this phrase?", "Cue: the quote carries the range.", "Bubble agent range");
  assert.equal(rangeAsk.quote, selected, "the bridge receives exactly the quoted range");
  await expect(panel.locator('.bubble-thread li[data-bubble-role="agent"]')).toContainText("carries the range");
  await closeBubble();

  // Identifiers: flagged, Send blocked, removable, then sent.
  await commentOn(privateTarget());
  await question.fill("¿Es correcta esta dosis?");
  await xray.click();
  const flags = page.locator(".bubble-flags li");
  await expect.poll(() => flags.count()).toBeGreaterThanOrEqual(3);
  await expect(send).toBeDisabled();
  await expect(page.locator(".bubble-blocked")).toBeVisible();
  await shot("blocked-light-1440");
  await expect(page.locator(".bubble-flags code", { hasText: "Patient: Juan Pérez" })).toBeVisible();
  const checks = flags.getByRole("checkbox", { name: "Not identifying" });
  await checks.first().check();
  await expect(send).toBeDisabled();
  await checks.first().uncheck();
  await expect(send).toBeDisabled();
  await question.fill("Check " + Array.from({ length: 13 }, (_, index) => `MRN ${10000 + index}`).join(", "));
  await expect(flags).toHaveCount(16);
  for (const box of (await checks.all()).slice(0, 12)) await box.check();
  await expect(send).toBeDisabled();
  await question.fill("¿Es correcta esta dosis?");
  for (const box of await checks.all()) await box.uncheck();
  assert.equal((await axi("home")).asks?.length ?? 0, 0, "blocked input must not queue a Tutor ask");
  const textToSend = page.locator(".bubble-text textarea");
  await textToSend.fill("Shielding matters for this patient case.");
  await expect(send).toBeEnabled();
  await send.click();
  await answer("¿Es correcta esta dosis?", "Cue: J/kg · check mass.", "Bubble agent 2");
  await expect(panel.locator('.bubble-thread li[data-bubble-role="agent"]')).toContainText("J/kg");
  await closeBubble();

  // Keyboard only: Tab walks elements, Enter reaches the pill, Enter opens the bubble, Tab reaches Send.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.mouse.move(cleanBox.x + 30, cleanBox.y + 10);
  await page.keyboard.press("Tab");
  await expect(page.locator(".element-halo-box.is-selected")).toHaveAttribute("data-element-kind", "heading");
  await page.keyboard.press("Tab");
  await expect(page.locator(".element-halo-box.is-selected")).toHaveAttribute("data-element-kind", "paragraph");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-element-action="change"]')).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator('[data-element-action="comment"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await expect(question).toBeFocused();
  await page.keyboard.type("Keyboard question?");
  await page.keyboard.press("Tab");
  await expect(xray).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(send).toBeFocused();
  await page.keyboard.press("Enter");
  await answer("Keyboard question?", "Cue: keyboard works.", "Bubble agent 3");
  await expect(panel.locator('.bubble-thread li[data-bubble-role="agent"]')).toContainText("keyboard works");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  assert.equal(await readFile(file, "utf8"), source, "bubbles never type into the note");

  // CLI parity: an agent can open a bubble and answer a pending one.
  const elements = await axi("element", "list", "--note", doc);
  const paragraph = elements.elements.find(element => element.kind === "paragraph" && element.text.startsWith("Kerma is"));
  const opened = await axi("glass", "bubble", "add", "--note", doc, "--element", paragraph.id, "--text", "Agent: what is kerma measured in?");
  assert.ok(opened.bubble.id, "the CLI opens a bubble");
  await expect(page.locator(`[data-bubble="${opened.bubble.id}"]`)).toBeVisible({ timeout: 10_000 });
  const pending = await axi("glass", "bubble", "list", "--note", doc, "--pending");
  assert.equal(pending.count, 1);
  await axi("glass", "bubble", "reply", "--note", doc, "--element", paragraph.id, "--text", "Agent answer: joules per kilogram.");
  await page.locator(`[data-bubble="${opened.bubble.id}"]`).click();
  await expect(panel.locator('.bubble-thread li[data-bubble-role="agent"]')).toContainText("joules per kilogram", { timeout: 10_000 });
  await shot("cli-thread-light-1440");
  await closeBubble();

  // Every state at both themes and widths: open, X-ray, thread, blocked identifiers.
  for (const [theme, width] of [["light", 720], ["omarchy-dark", 1440], ["omarchy-dark", 720]]) {
    await page.evaluate(theme => localStorage.setItem("omarkie-theme", theme), theme);
    await page.reload();
    await expect(rich.getByRole("heading", { name: "Bubble review", exact: true })).toBeVisible();
    await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
    await learning();
    await resize(width);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if ((await page.locator(".glass-layer").getAttribute("data-glass")) !== "on") {
      await rich.click({ position: { x: 4, y: 4 } });
      await page.keyboard.press("g");
    }
    await expect(page.locator(".element-halo")).toHaveAttribute("data-element-halo", "on");
    await commentOn(target());
    const combo = `Combo ${theme} ${width}?`;
    await question.fill(combo);
    await expect(page.locator("[data-bubble-send]")).toBeEnabled();
    await shot(`open-${theme}-${width}`);
    await xray.click();
    await expect(page.locator(".bubble-xray")).toBeVisible();
    await shot(`xray-${theme}-${width}`);
    await send.click();
    await answer(combo, `Cue for ${theme}.`, `Bubble agent ${theme} ${width}`);
    await expect(panel.locator('.bubble-thread li[data-bubble-role="agent"]')).toContainText(theme);
    await shot(`thread-${theme}-${width}`);
    await closeBubble();
    await commentOn(privateTarget());
    await question.fill(`Bloqueada ${theme} ${width}?`);
    await xray.click();
    await expect(send).toBeDisabled();
    await shot(`blocked-${theme}-${width}`);
    await closeBubble();
  }
  await page.evaluate(() => localStorage.setItem("omarkie-theme", "light"));

  // Restart: the bubble and its thread come back from the glass journal.
  await app.close();
  const second = await launch.launch({ args: [process.cwd(), ...headlessArguments], env });
  try {
    page = await second.firstWindow();
    const started = [];
    page.on("pageerror", error => started.push(error.message));
    const rich2 = page.locator(".document-editor:not([hidden]) .rich-document");
    await expect(rich2.getByRole("heading", { name: "Bubble review", exact: true })).toBeVisible();
    await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
    if (process.platform === "linux") {
      await page.getByRole("button", { name: "Display", exact: true }).click();
      const item = page.getByRole("menuitemcheckbox", { name: "Learning mode", exact: true });
      if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
      await page.keyboard.press("Escape");
    }
    await expect(rich2).toHaveAttribute("contenteditable", "false");
    if ((await page.locator(".glass-layer").getAttribute("data-glass")) !== "on") {
      await rich2.click({ position: { x: 4, y: 4 } });
      await page.keyboard.press("g");
    }
    await expect(page.locator(`[data-bubble="${opened.bubble.id}"]`)).toBeVisible({ timeout: 10_000 });
    await page.locator(`[data-bubble="${opened.bubble.id}"]`).press("Enter");
    await expect(page.locator('.bubble-thread li[data-bubble-role="agent"]')).toContainText("joules per kilogram");
    await expect(page.locator(".bubble-thread li")).toHaveCount(2);
    assert.deepEqual(started, []);
  } finally { await second.close(); }
  assert.deepEqual(errors, []);
  console.log("PASS: bubble anchors to its element, X-ray shows the payload, identifiers block Send until removed, replies thread, cards pin, CLI opens and answers bubbles, restart keeps the thread");
} finally {
  await app.close().catch(() => {});
}
