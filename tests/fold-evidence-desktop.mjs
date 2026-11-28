import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "playwright/test";
import { fold, launch, learning, openFold, resize, rich, settle, shooter, theme, watchMotion } from "./fold-desktop.mjs";

// OM-106: evidence peek, editor reveal and the way back, Rayos X lens, Corte divider.
const ward = await readFile(fileURLToPath(new URL("./fixtures/fold/01-adhf-ward-guide/input.md", import.meta.url)), "utf8");
const lines = ward.split("\n"), lineOf = start => lines.findIndex(line => line.startsWith(start)) + 1;
const DEFINITION = lineOf("Acute decompensated heart failure is"), ASSESSMENT = lineOf("Assess perfusion");
const definition = lines[DEFINITION - 1];
const evidence = process.env.OMARKIE_QA_DIR ?? await mkdtemp(path.join(os.tmpdir(), "omarkie-fold-evidence-shots-"));
await mkdir(evidence, { recursive: true });
const capture = shooter(evidence, fileURLToPath(new URL("./fixtures/fold-evidence/", import.meta.url)));

const unit = (page, line) => page.locator(`.fold-unit[data-line="${line}"]`);
const top = locator => locator.evaluate(element => element.getBoundingClientRect().top);
const near = (actual, expected, slack, label) => assert.ok(Math.abs(actual - expected) <= slack, `${label}: ${actual} vs ${expected}`);
async function focusUnit(page, line) {
  await unit(page, line).evaluate(element => element.focus({ preventScroll: true }));
  await expect(unit(page, line)).toBeFocused();
}
// Every word and block on the page, so a lens or divider can prove nothing moved.
const layout = page => page.evaluate(() => ({
  height: document.querySelector(".fold-scroller").scrollHeight,
  rects: [...document.querySelectorAll(".fold-scroller .fold-unit, .fold-scroller .fold-w")].map(element => { const box = element.getBoundingClientRect(); return [box.x, box.y, box.width, box.height].map(Math.round).join(","); }),
}));
// Units on screen lay out fully once the observer marks them near; measure layout after that.
async function laidOut(page) {
  await expect.poll(() => page.evaluate(() => {
    const view = document.querySelector(".fold-scroller").getBoundingClientRect();
    return [...document.querySelectorAll(".fold-scroller .fold-unit:not(.fold-off)")].filter(unit => {
      const box = unit.getBoundingClientRect();
      return box.bottom > view.top && box.top < view.bottom && !unit.classList.contains("fold-near");
    }).length;
  })).toBe(0);
  await settle(page);
}
// Word tokens of prose units near the viewport: index into all tokens, and what Corte did to each.
const words = page => page.evaluate(() => [...document.querySelectorAll(".fold-document .fold-w:not(.fold-added)")].map((word, index) => ({
  index, near: !!word.closest(".fold-near"), shown: word.getClientRects().length > 0,
  cut: word.classList.contains("fold-cut"), gone: word.classList.contains("fold-cut-gone"), tint: getComputedStyle(word).backgroundColor,
})));
const divider = (page, t) => page.getByRole("slider", { name: t("Divider between Full and {{level}}", { level: t("Key") }), exact: true });
const lens = page => page.locator("[data-fold-lens]");
async function pointAt(page, locator) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + Math.min(box.width / 2, 200), box.y + 12);
}

async function states(app, page, t, language) {
  for (const width of [1440, 720]) {
    await resize(app, page, width);
    for (const scheme of ["light", "dark"]) {
      await theme(page, t, `omarchy-${scheme}`);
      await expect(fold(page, t)).toBeVisible();
      const name = `${language}-${scheme}-${width}`;
      await page.locator(".fold-scroller").evaluate(element => { element.scrollTop = 0; });
      await focusUnit(page, DEFINITION);
      await page.keyboard.press("Enter");
      await expect(page.locator(".fold-peek-card")).toBeVisible();
      await capture(page, `peek-${name}`, { reset: false });
      await page.keyboard.press("Escape");
      await expect(page.locator(".fold-peek-card")).toHaveCount(0);
      await page.keyboard.press("c");
      await expect(divider(page, t)).toBeFocused();
      await capture(page, `corte-${name}`, { reset: false, baseline: width === 1440 });
      await page.keyboard.press("Escape");
      await expect(page.locator(".fold-view")).not.toHaveAttribute("data-cut", "true");
      await pointAt(page, unit(page, DEFINITION));
      await page.keyboard.down("Alt");
      await expect(lens(page)).toBeAttached();
      await capture(page, `lens-${name}`, { reset: false, baseline: false });
      await page.keyboard.up("Alt");
      await expect(lens(page)).toHaveCount(0);
    }
    await theme(page, t, "omarchy-light");
  }
  await resize(app, page, 1440);
}

let { app, page, errors, t } = await launch("en", { "ward.md": ward });
try {
  await expect(rich(page).getByRole("heading").first()).toBeVisible();
  await learning(page, t);
  // A synthetic amber mark on the definition, made the way a reader does, once Learning is listening.
  const actions = page.getByRole("group", { name: t("Selection actions"), exact: true });
  await expect(async () => {
    await rich(page).getByText(definition, { exact: true }).selectText();
    await page.keyboard.press("Alt+Enter");
    await expect(actions).toBeVisible({ timeout: 500 });
  }).toPass();
  await actions.getByRole("button", { name: t("Highlight: {{colour}}", { colour: t("amber") }), exact: true }).click();
  await expect.poll(() => page.evaluate(() => CSS.highlights.has("study-amber"))).toBe(true);
  await openFold(page, t);
  const view = fold(page, t);
  await expect(view).toHaveAttribute("data-stop", "key");
  await laidOut(page);

  // Peek: Enter opens the line's Full source under it; the stop and the line's y never change; Esc puts it back.
  const definitionUnit = unit(page, DEFINITION);
  await focusUnit(page, DEFINITION);
  const y0 = await top(definitionUnit);
  await page.keyboard.press("Enter");
  const card = page.getByRole("group", { name: t("Evidence"), exact: true });
  await expect(card).toBeVisible();
  await expect(card).toContainText(definition);
  await expect(card).toContainText(t("Source · line {{line}}", { line: DEFINITION }));
  await expect(card.getByRole("button", { name: t("Open in editor"), exact: true })).toBeVisible();
  await expect(card.locator("kbd")).toHaveText("⇧↵");
  await expect(view).toHaveAttribute("data-stop", "key");
  near(await top(definitionUnit), y0, 1, "peek keeps the line's y");
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect(view).toBeVisible();
  await expect(definitionUnit).toBeFocused();
  near(await top(definitionUnit), y0, 1, "closing the peek keeps the line's y");

  // One peek at a time; Alt+click toggles it too.
  await focusUnit(page, DEFINITION);
  await page.keyboard.press("Enter");
  await focusUnit(page, ASSESSMENT);
  await page.keyboard.press("Enter");
  await expect(page.locator(".fold-peek-card")).toHaveCount(1);
  await expect(unit(page, ASSESSMENT).locator(".fold-peek-card")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".fold-peek-card")).toHaveCount(0);
  const box = await definitionUnit.boundingBox();
  await page.keyboard.down("Alt");
  await page.mouse.click(box.x + 40, box.y + 8);
  await page.keyboard.up("Alt");
  await expect(definitionUnit.locator(".fold-peek-card")).toBeVisible();
  await expect(lens(page)).toHaveCount(0);
  await page.keyboard.down("Alt");
  await page.mouse.click(box.x + 40, box.y + 8);
  await page.keyboard.up("Alt");
  await expect(page.locator(".fold-peek-card")).toHaveCount(0);

  // Reduced motion: the peek crossfades the page; no word travels.
  await settle(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await focusUnit(page, DEFINITION);
  const calm = watchMotion(page);
  await page.keyboard.press("Enter");
  assert.deepEqual(await calm, { words: 0, page: 1 }, "reduced motion: crossfade, no word glides");
  await page.keyboard.press("Escape");
  await expect(page.locator(".fold-peek-card")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await settle(page);

  // Reveal: Shift+Enter opens the editor with the source line at the same y and flashes it 1.2 s.
  await page.locator(".fold-scroller").evaluate(element => { element.scrollTop = 0; });
  const assessment = unit(page, ASSESSMENT);
  await focusUnit(page, ASSESSMENT);
  const y1 = await top(assessment);
  await page.keyboard.press("Shift+Enter");
  await expect(view).toBeHidden();
  const flash = rich(page).locator(".fold-reveal-flash");
  await expect(flash).toHaveCount(1);
  await expect(flash).toContainText("Assess perfusion and congestion");
  near(await top(flash), y1, 4, "revealed line lands at the fold line's y");
  const back = page.getByRole("button", { name: t("Back to fold · Esc"), exact: true });
  await expect(back).toBeVisible();
  await expect(flash).toHaveCount(0, { timeout: 2500 });
  // Esc returns to the same line at the same y, focused, at the same stop.
  await page.keyboard.press("Escape");
  await expect(view).toBeVisible();
  await expect(view).toHaveAttribute("data-stop", "key");
  await expect(assessment).toBeFocused();
  near(await top(assessment), y1, 2, "Esc returns the fold line to its y");
  await laidOut(page);
  near(await top(assessment), y1, 2, "the line holds its y once the page lays out");
  await expect(back).toHaveCount(0);
  // The peek's button and the pill do the same.
  await page.keyboard.press("Enter");
  await unit(page, ASSESSMENT).getByRole("button", { name: t("Open in editor"), exact: true }).click();
  await expect(view).toBeHidden();
  await expect(rich(page).locator(".fold-reveal-flash")).toContainText("Assess perfusion and congestion");
  await back.click();
  await expect(view).toBeVisible();
  await expect(assessment).toBeFocused();
  near(await top(assessment), y1, 2, "the pill returns the fold line to its y");

  // Rayos X: Alt over a line shows its source and marks in a lens; nothing under it moves.
  await laidOut(page);
  const still = await layout(page);
  await pointAt(page, definitionUnit);
  await page.keyboard.down("Alt");
  await expect(lens(page)).toBeAttached();
  await expect(lens(page)).toContainText(definition);
  await expect.poll(() => page.evaluate(() => CSS.highlights.has("fold-lens-amber"))).toBe(true);
  assert.deepEqual(await layout(page), still, "the lens shifts no layout");
  await page.keyboard.up("Alt");
  await expect(lens(page)).toHaveCount(0);
  assert.equal(await page.evaluate(() => CSS.highlights.has("fold-lens-amber")), false);
  // Keyboard path: pointer off the page, Alt shows the focused line's source.
  await page.mouse.move(2, 2);
  await focusUnit(page, ASSESSMENT);
  await page.keyboard.down("Alt");
  await expect(lens(page)).toContainText("Assess perfusion and congestion");
  await page.keyboard.up("Alt");
  await expect(lens(page)).toHaveCount(0);
  // Pen: press and hold.
  const pen = await definitionUnit.boundingBox();
  const penAt = { x: pen.x + 60, y: pen.y + 10 };
  await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "pen", pointerId: 7, clientX: x, clientY: y, isPrimary: true, button: 0, buttons: 1 }));
  }, penAt);
  await expect(lens(page)).toContainText(definition, { timeout: 2000 });
  assert.deepEqual(await layout(page), still, "the pen lens shifts no layout");
  await page.evaluate(({ x, y }) => window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "pen", pointerId: 7, clientX: x, clientY: y })), penAt);
  await expect(lens(page)).toHaveCount(0);

  // Corte: C splits the page. Home = the stop exactly; End = Full with the dropped words tinted.
  await page.locator(".fold-scroller").evaluate(element => { element.scrollTop = 0; });
  await settle(page);
  const keyShown = new Set((await words(page)).filter(word => word.shown).map(word => word.index));
  await focusUnit(page, DEFINITION);
  await page.keyboard.press("c");
  await expect(view).toHaveAttribute("data-cut", "true");
  const handle = divider(page, t);
  await expect(handle).toBeFocused();
  await expect(handle).toHaveAttribute("aria-valuetext", t("{{percent}}% shows Full", { percent: 50 }));
  await expect(page.getByRole("button", { name: t("Corte"), exact: true })).toHaveAttribute("aria-pressed", "true");
  await settle(page);
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "0");
  const left = (await words(page)).filter(word => word.near);
  assert.ok(left.length > 20 && left.some(word => word.cut), "Corte covers the near words and some are dropped");
  assert.deepEqual(left.filter(word => !word.gone).map(word => word.index), left.filter(word => keyShown.has(word.index)).map(word => word.index), "Home: visible words are the Key stop's words");
  assert.ok(left.every(word => word.cut === !keyShown.has(word.index)), "dropped words are the ones Key hides");
  const fixed = await layout(page);
  for (let step = 0; step < 10; step++) await page.keyboard.press("Shift+ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "100");
  assert.deepEqual(await layout(page), fixed, "moving the divider shifts no layout");
  await page.keyboard.press("End");
  const right = (await words(page)).filter(word => word.near);
  assert.ok(right.every(word => !word.gone), "End: every Full word is shown");
  const tinted = right.find(word => word.cut), plain = right.find(word => !word.cut);
  assert.notEqual(tinted.tint, plain.tint, "dropped words are tinted");
  // Drag: the handle follows the pointer; the page underneath stays put.
  for (let step = 0; step < 5; step++) await page.keyboard.press("Shift+ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", "50");
  const grip = await handle.boundingBox(), area = await page.locator(".fold-scroller").boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.3, grip.y + grip.height / 2, { steps: 6 });
  await page.mouse.up();
  const dragged = Number(await handle.getAttribute("aria-valuenow"));
  assert.ok(dragged > 15 && dragged < 45, `drag moves the divider: ${dragged}`);
  assert.deepEqual(await layout(page), fixed, "dragging shifts no layout");
  // Stops still move under Corte; Esc closes Corte back to the stop, then leaves the fold.
  await page.keyboard.press("Escape");
  await expect(view).not.toHaveAttribute("data-cut", "true");
  await expect(view).toHaveAttribute("data-stop", "key");
  await settle(page);
  assert.equal(await page.locator(".fold-cut, .fold-cut-gone, .fold-cut-block").count(), 0);
  assert.deepEqual(new Set((await words(page)).filter(word => word.shown).map(word => word.index)), keyShown);
  await page.getByRole("button", { name: t("Corte"), exact: true }).click();
  await expect(view).toHaveAttribute("data-cut", "true");
  await page.getByRole("button", { name: t("Corte"), exact: true }).click();
  await expect(view).not.toHaveAttribute("data-cut", "true");

  await states(app, page, t, "en");
  assert.deepEqual(errors, []);
} finally { await app.close(); }

// Spanish: labels and the same three states at both widths and themes.
({ app, page, errors, t } = await launch("es", { "ward.md": ward }));
try {
  await learning(page, t);
  await openFold(page, t);
  await focusUnit(page, DEFINITION);
  await page.keyboard.press("Enter");
  const card = page.getByRole("group", { name: "Evidencia", exact: true });
  await expect(card).toContainText(`Fuente · línea ${DEFINITION}`);
  await expect(card.getByRole("button", { name: "Abrir en editor", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Corte", exact: true })).toHaveAttribute("title", "Comparar con Completo · C");
  await states(app, page, t, "es");
  assert.deepEqual(errors, []);
} finally { await app.close(); }
console.log("PASS: evidence peek keeps stop and y, Shift+Enter reveal flashes and Esc returns, Rayos X lens without layout shift (Alt, keyboard, pen, marks), Corte divider Home=stop End=Full tinted, EN/ES baselines.");
