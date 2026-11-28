import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "playwright/test";
import { closeFold, fold, launch, learning, openFold, rich, settle, theme } from "./fold-desktop.mjs";

// OM-118: a fold line leaves the page (D menu or drag) for a study sheet, the loose tray, the page as a card, or another app.
const ward = await readFile(fileURLToPath(new URL("./fixtures/fold/01-adhf-ward-guide/input.md", import.meta.url)), "utf8");
const lines = ward.split("\n"), lineOf = start => lines.findIndex(line => line.startsWith(start)) + 1;
const DEFINITION = lineOf("Acute decompensated heart failure is"), ASSESSMENT = lineOf("Assess perfusion");
const definition = lines[DEFINITION - 1];
const evidence = process.env.OMARKIE_QA_DIR ?? await mkdtemp(path.join(os.tmpdir(), "omarkie-fold-drag-shots-"));
await mkdir(evidence, { recursive: true });
const shot = (page, name) => settle(page).then(() => page.screenshot({ path: path.join(evidence, `${name}.png`) }));

const unit = (page, line) => page.locator(`.fold-unit[data-line="${line}"]`);
const notice = page => page.locator(".fold-sent");
async function focusUnit(page, line) {
  await unit(page, line).evaluate(element => element.focus({ preventScroll: true }));
  await expect(unit(page, line)).toBeFocused();
}
async function menuFor(page, t, line) {
  await focusUnit(page, line);
  await page.keyboard.press("d");
  const menu = page.getByRole("menu", { name: t("Send line to"), exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  return menu;
}
// The grip's drag, as the browser fires it: dragstart fills one DataTransfer, the drop reads it back.
async function dragLine(page, line, target) {
  await unit(page, line).hover({ position: { x: 40, y: 8 } });
  await expect(page.locator(".fold-grip")).toBeVisible();
  const types = await page.locator(".fold-grip").evaluate(grip => {
    window.omarkieDrag = new DataTransfer();
    grip.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: window.omarkieDrag }));
    return Object.fromEntries(window.omarkieDrag.types.map(type => [type, window.omarkieDrag.getData(type)]));
  });
  await expect(page.locator(".fold-view")).toHaveAttribute("data-dragging", "true");
  // The tray opening moves the column; the grip stays in the gutter of its line.
  await expect.poll(() => unit(page, line).evaluate(element => {
    const grip = document.querySelector(".fold-grip").getBoundingClientRect(), box = element.getBoundingClientRect();
    return grip.right <= box.left && Math.abs(grip.top - box.top) <= 1;
  })).toBe(true);
  await target.evaluate(zone => {
    const dataTransfer = window.omarkieDrag;
    const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer });
    zone.dispatchEvent(over);
    if (!over.defaultPrevented) throw new Error("the zone refused the fold line");
    zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    document.querySelector(".fold-grip")?.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
  });
  await expect(page.locator(".fold-view")).not.toHaveAttribute("data-dragging", "true");
  return types;
}
const tray = page => page.locator('.study-tray[data-fold-drop="tray"]');
// Renderer main-thread tasks while the menu, sends and drags run. The gate is each task's thread CPU time
// (trace `tdur`): wall time on a shared runner also counts the time other processes held the core.
async function traceTasks(page) {
  const cdp = await page.context().newCDPSession(page), events = [];
  cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] } });
  return async () => {
    const done = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
    await cdp.send("Tracing.end");
    await done;
    await cdp.detach();
    const main = new Set(events.filter(event => event.name === "thread_name" && event.args?.name === "CrRendererMain").map(event => `${event.pid}:${event.tid}`));
    const tasks = events.filter(event => event.name === "RunTask" && event.ph === "X" && main.has(`${event.pid}:${event.tid}`));
    assert.ok(tasks.length > 0 && tasks.every(task => Number.isFinite(task.tdur)), "the trace has renderer tasks with thread time");
    return tasks.map(task => ({ cpu: Math.round(task.tdur / 1000), wall: Math.round(task.dur / 1000) }));
  };
}

let { app, page, errors, t } = await launch("en", { "ward.md": ward });
try {
  await expect(rich(page).getByRole("heading").first()).toBeVisible();
  await learning(page, t);
  await openFold(page, t);
  await expect(unit(page, DEFINITION)).toBeVisible();
  const stopTrace = await traceTasks(page);

  // D: the keyboard drag. Targets are the page, each study sheet, the loose tray, then the clipboard.
  let menu = await menuFor(page, t, DEFINITION);
  const items = await menu.getByRole("menuitem").evaluateAll(buttons => buttons.map(button => button.dataset.foldTarget));
  assert.deepEqual([items[0], items.at(-2), items.at(-1)], ["page", "tray", "copy"]);
  assert.ok(items.filter(item => item === "sheet").length >= 3, "every study sheet is a target");
  await expect(menu.getByRole("menuitem").first()).toHaveText(t("Scrap on the page"));
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitem", { name: t("Loose scraps"), exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(notice(page)).toHaveText(new RegExp(`^${t("Added to loose scraps")}`));
  await expect(unit(page, DEFINITION)).toBeFocused();
  // The tray scrap keeps the fold line and, under it, the author's words.
  const kept = tray(page).locator(".study-scrap", { has: page.locator(".study-fold-line") }).first();
  await expect(kept.locator("q")).toHaveText(definition);

  // A study sheet: the scrap is anchored to the evidence paragraph; Undo peels it off.
  menu = await menuFor(page, t, ASSESSMENT);
  const doubts = menu.locator('[data-fold-target="sheet"][data-sheet="doubts"]');
  await doubts.focus();
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText(t("Added to {{sheet}}", { sheet: t("Doubts") }));
  await expect(notice(page).getByRole("button", { name: t("Show on page"), exact: true })).toBeVisible();
  await notice(page).getByRole("button", { name: t("撤销"), exact: true }).click();
  await expect(notice(page)).toHaveCount(0);

  // Ctrl+C and the menu's copy put the same four types on the clipboard.
  await page.evaluate(() => document.addEventListener("copy", event => {
    window.omarkieCopied = Object.fromEntries(event.clipboardData.types.map(type => [type, event.clipboardData.getData(type)]));
  }));
  menu = await menuFor(page, t, DEFINITION);
  await menu.locator('[data-fold-target="copy"]').click();
  await expect(notice(page)).toHaveText(t("Linked excerpt copied"));
  const copied = await page.evaluate(() => window.omarkieCopied);
  assert.deepEqual(Object.keys(copied).sort(), ["application/x-omarkie-fold+json", "text/markdown", "text/plain", "text/uri-list"]);

  // The grip's drag onto the tray carries the four types: plain words, a linked excerpt, the payload, the way back.
  const types = await dragLine(page, ASSESSMENT, tray(page));
  await expect(notice(page)).toHaveText(new RegExp(`^${t("Added to loose scraps")}`));
  assert.deepEqual(Object.keys(types).sort(), ["application/x-omarkie-fold+json", "text/markdown", "text/plain", "text/uri-list"]);
  assert.equal(types["text/uri-list"], `omarkie://open?note=ward.md&line=${ASSESSMENT}&stop=key`);
  assert.match(types["text/markdown"], new RegExp(`> — \\[\\[ward#[^\\]]+\\]\\] · L${ASSESSMENT}\\n$`));
  const payload = JSON.parse(types["application/x-omarkie-fold+json"]);
  assert.equal(payload.note, "ward.md");
  assert.equal(payload.quote, lines.slice(ASSESSMENT - 1, payload.endLine).join("\n").trim());
  assert.deepEqual(copied["text/uri-list"], `omarkie://open?note=ward.md&line=${DEFINITION}&stop=key`);

  // Dropped on another line of the page: a scrap pinned at its own evidence.
  await dragLine(page, ASSESSMENT, unit(page, DEFINITION));
  await expect(notice(page)).toContainText(t("Added to {{sheet}}", { sheet: t("Notes") }));
  const tasks = await stopTrace(), worst = Math.max(...tasks.map(task => task.cpu));
  assert.ok(worst <= 50, `slowest task ${worst} ms CPU: ${JSON.stringify(tasks.filter(task => task.cpu > 50))}`);
  console.log(`${tasks.length} renderer tasks, slowest ${worst} ms CPU (${Math.max(...tasks.map(task => task.wall))} ms wall)`);

  // Glass on: the page target is a G9 card that unfolds to the evidence.
  await closeFold(page);
  await rich(page).click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("g");
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:glass-ready").length > 0);
  await openFold(page, t);
  menu = await menuFor(page, t, DEFINITION);
  await expect(menu.getByRole("menuitem").first()).toHaveText(t("Card on the page"));
  await page.keyboard.press("Enter");
  await expect(notice(page)).toContainText(t("Card pinned beside line {{line}}", { line: DEFINITION }));
  await shot(page, "en-light-sent-card");
  await notice(page).getByRole("button", { name: t("Show on page"), exact: true }).click();
  await expect(fold(page, t)).toHaveCount(0);
  const card = page.locator('.glass-card[data-card-kind="fold"]');
  await expect(card).toBeVisible({ timeout: 15_000 });
  if (await card.getAttribute("data-folded") === "true") await card.locator("[data-card-pill]").click();
  await expect(card.locator("[data-card-evidence]")).toHaveText(definition, { timeout: 15_000 });
  await expect(card).toContainText("[[ward#");
  await shot(page, "en-light-glass-card");
  await page.keyboard.press("g");

  // A linked excerpt pasted into a note lands as its own quoted block with the way back.
  await page.getByRole("button", { name: t("显示"), exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: t("Learning mode"), exact: true }).click();
  await expect(rich(page)).toHaveAttribute("contenteditable", "true");
  await rich(page).getByText(definition, { exact: true }).click();
  await page.keyboard.press("End");
  await rich(page).evaluate((element, json) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("application/x-omarkie-fold+json", json);
    clipboardData.setData("text/plain", "plain words");
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  }, JSON.stringify(payload));
  await expect(rich(page).locator("blockquote", { hasText: `· L${ASSESSMENT}` })).toBeVisible();
  await expect(rich(page).getByText("plain words")).toHaveCount(0);
  assert.deepEqual(errors, []);
} finally { await app.close(); }

// Both languages, both themes: the menu and the sent notice beside the open tray.
for (const language of ["en", "es"]) {
  ({ app, page, errors, t } = await launch(language, { "ward.md": ward }));
  try {
    await learning(page, t);
    await openFold(page, t);
    for (const scheme of ["light", "dark"]) {
      await theme(page, t, `omarchy-${scheme}`);
      await expect(fold(page, t)).toBeVisible();
      await menuFor(page, t, DEFINITION);
      await shot(page, `${language}-${scheme}-menu`);
      await page.keyboard.press("Escape");
      await expect(unit(page, DEFINITION)).toBeFocused();
      await dragLine(page, DEFINITION, tray(page));
      await expect(notice(page)).toHaveText(new RegExp(`^${t("Added to loose scraps")}`));
      await shot(page, `${language}-${scheme}-tray`);
    }
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
}
console.log(`PASS: D menu and grip drag send a fold line to a sheet, the tray or the page (scrap or Glass card with its evidence), four drag types, linked-excerpt paste, no task over 50 ms. Shots in ${evidence}`);
