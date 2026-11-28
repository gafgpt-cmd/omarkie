import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "playwright/test";
import { fold, launch, learning, openFold, resize, rich, settle, shooter, stop, theme } from "./fold-desktop.mjs";

// OM-107: Glass in the fold. Marks projected onto the fold's lines, pinned highlights, out of fold, decks, ink glyphs, tray.
const ward = await readFile(fileURLToPath(new URL("./fixtures/fold/01-adhf-ward-guide/input.md", import.meta.url)), "utf8");
const lines = ward.split("\n"), lineOf = start => lines.findIndex(line => line.startsWith(start)) + 1;
const DEFINITION = lineOf("Acute decompensated heart failure is"), ASSESSMENT = lineOf("Assess perfusion"), PITFALLS_HEAD = lineOf("## Pitfalls");
const TREATMENT = lineOf("Intravenous furosemide"), PITFALLS = lineOf("Do not give fluids");
const FIRST_HOUR = "Assess perfusion and congestion within the first hour.";
const NEGATION = "Do not stop beta blockers abruptly unless there is shock.";
const REASSESS = "Reassess urine output and symptoms at 2 hours, then every 6 hours.";
const STICKY = "Weigh before the ward round", CLIPS = ["Diuretic titration card", "Loop diuretic doses"];
const evidence = process.env.OMARKIE_QA_DIR ?? await mkdtemp(path.join(os.tmpdir(), "omarkie-fold-glass-shots-"));
await mkdir(evidence, { recursive: true });
const capture = shooter(evidence, fileURLToPath(new URL("./fixtures/fold-glass/", import.meta.url)));

const unit = (page, line) => page.locator(`.fold-unit[data-line="${line}"]`);
const headings = line => {
  const path = [];
  for (const text of lines.slice(0, line - 1)) {
    const match = /^(#+)\s+(.*)$/.exec(text);
    if (match) { path.length = match[1].length - 1; path.push(match[2]); }
  }
  return path.filter(Boolean);
};
const anchor = line => ({ version: 2, landmarks: [{ kind: "block", block: lines[line - 1], headings: headings(line), line }] });

// Synthetic Glass: two clips in Pitfalls (one deck), a sticky on the assessment, one pen stroke on the definition.
async function seed(page, t) {
  await page.evaluate(() => window.desktop.glassState({ action: "write", visible: true }));
  await page.reload();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  await learning(page, t);
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
  const magnets = [
    { magnet: "clip-1", fields: { kind: "clip", title: CLIPS[0], text: "", anchor: anchor(PITFALLS) } },
    { magnet: "clip-2", fields: { kind: "clip", title: CLIPS[1], text: "", anchor: anchor(PITFALLS) } },
    { magnet: "sticky-1", fields: { kind: "sticky", text: STICKY, color: "yellow", x: 8, y: 12, w: 180, h: 120, anchor: anchor(ASSESSMENT) } },
    { magnet: "ink-1", fields: { kind: "ink", layer: "ink", tool: "pen", color: "#1d4ed8", size: 4,
      parts: [{ box: { kind: "block" }, anchor: anchor(DEFINITION), points: [[0.04, 0.3, 0.5], [0.18, 0.42, 0.6], [0.34, 0.28, 0.6], [0.52, 0.46, 0.5]] }] } },
  ];
  await page.evaluate(async magnets => {
    for (const { magnet, fields } of magnets) {
      const reply = await window.desktop.glass({ note: "ward.md", action: "add", magnet, fields });
      if (!reply?.ok) throw new Error(reply?.error ?? "seed failed");
    }
  }, magnets);
}

// Mouse path: select words on a fold line, then the colour choice opens under them.
async function selectWords(page, line, text) {
  await page.evaluate(({ line, text }) => {
    const root = document.querySelector(`.fold-unit[data-line="${line}"]`);
    const tokens = [...root.querySelectorAll(".fold-w:not(.fold-added)")], squash = value => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    let joined = "";
    const starts = tokens.map(token => { const at = joined.length; joined += squash(token.textContent ?? ""); return at; });
    const needle = squash(text), at = joined.indexOf(needle), end = at + needle.length;
    const hit = tokens.filter((_, k) => starts[k] < end && (k + 1 < tokens.length ? starts[k + 1] : joined.length) > at);
    const range = document.createRange();
    range.setStartBefore(hit[0]); range.setEndAfter(hit.at(-1));
    getSelection().removeAllRanges(); getSelection().addRange(range);
  }, { line, text });
  await page.locator(".fold-scroller").dispatchEvent("pointerup");
}
async function highlightWords(page, t, line, text, colour) {
  await selectWords(page, line, text);
  const pick = page.getByRole("group", { name: t("选区操作"), exact: true });
  await pick.getByRole("button", { name: t("Highlight: {{colour}}", { colour: t(colour) }), exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: t("Highlight added") })).toBeVisible();
}
// Words of a line carrying a mark, and whether any of them is folded away.
const tinted = (page, line) => unit(page, line).evaluate(root => {
  const tokens = [...root.querySelectorAll(".fold-w[data-mark]")];
  return { text: tokens.map(token => token.textContent).join(" ").replace(/\s+/g, " ").trim(), hidden: tokens.some(token => token.classList.contains("fold-off")) };
});
// Rider animations the next key press starts: a glide moves, reduced motion only crossfades the page.
// Animations already running are tagged first, so a glide that is still finishing is not counted.
async function riderMotion(page) {
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.id = "before"; });
  return { done: page.evaluate(() => new Promise(resolve => {
    let glides = 0, fades = 0, ticks = 0;
    const tick = () => {
      for (const animation of document.getAnimations()) {
        if (animation.id === "before") continue;
        const target = animation.effect?.target, frames = animation.effect?.getKeyframes?.() ?? [];
        if (target?.classList?.contains("fold-rider") && frames.some(frame => frame.transform && frame.transform !== "none")) glides += 1;
        else if (target?.classList?.contains("fold-document")) fades += 1;
      }
      if (glides || fades || ++ticks > 40) resolve({ glides, fades }); else setTimeout(tick, 10);
    };
    tick();
  })) };
}
const ticks = page => page.locator(".fold-ticks").allTextContents();

// The marks every state shows: keyboard highlight on the assessment, mouse highlight on the negation.
async function mark(page, t) {
  await stop(page, "4", "takeaway");
  await unit(page, ASSESSMENT).focus();
  await page.keyboard.press("h");
  await expect(page.getByRole("button", { name: t("Highlight: {{colour}}", { colour: t("amber") }), exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: t("Highlight added") })).toBeVisible();
  await expect.poll(() => tinted(page, ASSESSMENT)).toEqual({ text: FIRST_HOUR, hidden: false });
  await stop(page, "1", "full");
  await highlightWords(page, t, PITFALLS, NEGATION, "rose");
  await expect.poll(() => tinted(page, PITFALLS)).toEqual({ text: NEGATION, hidden: false });
}

async function states(app, page, t, language) {
  for (const width of [1440, 720]) {
    await resize(app, page, width);
    for (const scheme of ["light", "dark"]) {
      await theme(page, t, `omarchy-${scheme}`);
      await expect(fold(page, t)).toBeVisible();
      const name = `${language}-${scheme}-${width}`;
      await page.locator(".fold-document").focus();
      await stop(page, "3", "key");
      await capture(page, `glass-key-${name}`);
      await stop(page, "5", "topic");
      await capture(page, `glass-topic-${name}`, { baseline: false });
      await stop(page, "3", "key");
    }
    await theme(page, t, "omarchy-light");
  }
  await resize(app, page, 1440);
}

let { app, page, errors, t } = await launch("en", { "ward.md": ward });
const external = [], watch = page => page.on("request", request => { if (/^https?:/.test(request.url()) && !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(request.url())) external.push(request.url()); });
watch(page);
try {
  await learning(page, t);
  await seed(page, t);
  const home = await app.evaluate(() => process.env.OMARKIE_DATA_DIR), file = path.join(home, "vault", "ward.md");
  await openFold(page, t);
  const view = fold(page, t);
  await expect(view).toHaveAttribute("data-stop", "key");

  // Glass se pliega: the section's magnets stack into one deck; clips fold to their titles.
  const deck = unit(page, PITFALLS_HEAD).getByRole("button", { name: t("Magnets in this section · {{n}}", { n: 2 }), exact: true });
  await deck.focus();
  await page.keyboard.press("Enter");
  const pop = page.getByRole("dialog", { name: t("Magnets in this section · {{n}}", { n: 2 }), exact: true });
  for (const title of CLIPS) await expect(pop).toContainText(title);
  await expect(pop.getByRole("button").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await expect(deck).toBeFocused();

  // A sticky folds to "your words", opened from the keyboard.
  const words = unit(page, ASSESSMENT).getByRole("button", { name: t("Your words · {{n}}", { n: 1 }), exact: true });
  await words.focus();
  await page.keyboard.press("Enter");
  await expect(words).toHaveAttribute("aria-expanded", "true");
  await expect(unit(page, ASSESSMENT).getByRole("region", { name: t("Your words"), exact: true })).toHaveText(STICKY);
  await page.keyboard.press("Enter");
  await expect(words).toHaveAttribute("aria-expanded", "false");

  // Ink compresses to a glyph off Full and re-expands to the very same path.
  const glyph = unit(page, DEFINITION).getByRole("button", { name: t("Ink: show at full size"), exact: true });
  const glyphPath = await glyph.locator("path").getAttribute("d");
  assert.ok(glyphPath && glyphPath.length > 20, "the glyph draws the stroke");
  await glyph.focus();
  await page.keyboard.press("Enter");
  const inPlace = unit(page, DEFINITION).locator(".fold-ink path");
  await expect(inPlace).toHaveAttribute("d", glyphPath);
  await expect(glyph).toHaveCount(0);

  // Takeaway mark from the keyboard shows at Key and Full; Ctrl+Z takes it back, nothing else.
  await stop(page, "4", "takeaway");
  await unit(page, ASSESSMENT).focus();
  await page.keyboard.press("h");
  await page.keyboard.press("Enter");
  await expect.poll(() => tinted(page, ASSESSMENT)).toEqual({ text: FIRST_HOUR, hidden: false });
  await page.keyboard.press("Control+z");
  await expect.poll(() => tinted(page, ASSESSMENT)).toEqual({ text: "", hidden: false });
  await expect(page.getByRole("status").filter({ hasText: t("Highlight added") })).toHaveCount(0);
  await mark(page, t);
  for (const [key, name] of [["3", "key"], ["1", "full"]]) {
    await stop(page, key, name);
    await expect.poll(() => tinted(page, ASSESSMENT)).toEqual({ text: FIRST_HOUR, hidden: false });
  }

  // A highlighted negation is pinned: its own words at every stop that shows the line, out of fold at Topic.
  for (const [key, name] of [["1", "full"], ["2", "brief"], ["3", "key"], ["4", "takeaway"]]) {
    await stop(page, key, name);
    await expect.poll(() => tinted(page, PITFALLS)).toEqual({ text: NEGATION, hidden: false });
    await expect(unit(page, PITFALLS).getByRole("img", { name: t("Pinned: kept in the author's words"), exact: true })).toHaveCount(name === "key" || name === "takeaway" ? 1 : 0);
  }
  await settle(page);
  const motion = await riderMotion(page);
  await stop(page, "5", "topic");
  assert.ok((await motion.done).glides > 0, "riders glide to their new place");
  await expect(unit(page, PITFALLS)).toHaveClass(/fold-off/);
  const out = unit(page, DEFINITION).getByRole("button", { name: t("{{n}} marks out of fold at this line: show them", { n: 4 }), exact: true });
  await expect(out).toContainText(t("Out of fold · {{n}}", { n: 4 }));
  // Slider ticks: marks shown at each stop beside its % of words; every mark is somewhere at every stop.
  assert.deepEqual(await ticks(page), ["6/6", "6/6", "6/6", "6/6", "2/6"]);
  await out.focus();
  await page.keyboard.press("Enter");
  await expect(view).toHaveAttribute("data-stop", "takeaway");
  await expect.poll(() => tinted(page, PITFALLS)).toEqual({ text: NEGATION, hidden: false });

  // Reduced motion: the page crossfades; nothing glides.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await settle(page);
  const calm = await riderMotion(page);
  await stop(page, "3", "key");
  const still = await calm.done;
  assert.equal(still.glides, 0, "no glide with reduced motion");
  assert.ok(still.fades > 0, "reduced motion crossfades");
  await page.emulateMedia({ reducedMotion: null });
  await settle(page);

  await states(app, page, t, "en");

  // Nothing writes Markdown: every mark above lives outside the note.
  assert.equal(await readFile(file, "utf8"), ward);

  // Deleting the highlighted sentence on the page sends its mark to the re-anchor tray.
  await stop(page, "1", "full");
  await highlightWords(page, t, TREATMENT, REASSESS, "blue");
  // A pinned highlight keeps its sentence at every stop that shows its line.
  await expect.poll(() => ticks(page)).toEqual(["7/7", "7/7", "7/7", "7/7", "2/7"]);
  await page.locator(".fold-document").focus();
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
  await page.getByRole("button", { name: t("显示"), exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: t("Learning mode"), exact: true }).click();
  await expect(rich(page)).toHaveAttribute("contenteditable", "true");
  await rich(page).focus();
  await rich(page).evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.nodeValue.indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at); range.setEnd(node, at + text.length + 1);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      return;
    }
    throw new Error("sentence not on the page");
  }, REASSESS);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.keyboard.press("Delete");
  await expect(rich(page)).not.toContainText(REASSESS);
  await learning(page, t);
  await openFold(page, t);
  const tray = page.getByRole("button", { name: t("Re-anchor tray · {{n}}", { n: 1 }), exact: true });
  await tray.click();
  const trayPop = page.getByRole("dialog", { name: t("Re-anchor tray"), exact: true });
  await expect(trayPop).toContainText(t("Without a line"));
  await expect(trayPop).toContainText(REASSESS);
  await capture(page, "glass-tray-en-light-1440", { reset: false, baseline: false });
  await trayPop.getByRole("button", { name: t("Open on the page"), exact: true }).click();
  await expect(view).toHaveCount(0);
  assert.deepEqual(errors, []);
} finally { await app.close(); }

// Spanish: the same marks, labels in Spanish, at both widths and themes.
({ app, page, errors, t } = await launch("es", { "ward.md": ward }));
watch(page);
try {
  await learning(page, t);
  await seed(page, t);
  await openFold(page, t);
  await mark(page, t);
  await stop(page, "3", "key");
  await expect(unit(page, ASSESSMENT).getByRole("button", { name: "tus palabras · 1", exact: true })).toBeVisible();
  await stop(page, "5", "topic");
  await expect(unit(page, DEFINITION).locator(".fold-out")).toContainText("fuera del pliegue · 4");
  await expect(page.locator(".fold-track")).toHaveAttribute("aria-valuetext", /2\/6 marcas$/);
  await states(app, page, t, "es");
  assert.deepEqual(errors, []);
} finally { await app.close(); }
assert.deepEqual(external, [], "Glass in the fold stays offline");
console.log("PASS: Glass in the fold: deck of clip titles, tus palabras, ink glyph re-expands to the same path, keyboard Takeaway mark at Key/Full with undo, pinned negation at every stop, out-of-fold jump, ticks, glide and reduced-motion crossfade, re-anchor tray, no Markdown written, offline, EN/ES baselines.");
