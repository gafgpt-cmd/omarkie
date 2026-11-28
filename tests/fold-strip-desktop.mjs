import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "playwright/test";
import { closeFold, fold, launch, learning, openFold, resize, shooter, stop, theme } from "./fold-desktop.mjs";
import { stableHost } from "./frame-cadence.mjs";

// OM-108: pre-fold strip (what the fold keeps, adjustable), suggested red flags, post-fold hints, cards from highlights.
const ward = await readFile(fileURLToPath(new URL("./fixtures/fold/01-adhf-ward-guide/input.md", import.meta.url)), "utf8");
const lines = ward.split("\n"), lineOf = start => lines.findIndex(line => line.startsWith(start)) + 1;
const LIST = lineOf("- Nitrates"), PITFALLS = lineOf("Do not give fluids");
const FLUIDS = "Do not give fluids for a low blood pressure that comes with congestion.";
const NEGATION = "Do not stop beta blockers abruptly unless there is shock.";
const evidence = process.env.OMARKIE_QA_DIR ?? await mkdtemp(path.join(os.tmpdir(), "omarkie-fold-strip-shots-"));
await mkdir(evidence, { recursive: true });
const capture = shooter(evidence, fileURLToPath(new URL("./fixtures/fold-strip/", import.meta.url)));

const unit = (page, line) => page.locator(`.fold-unit[data-line="${line}"]`);
const squash = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
// The words a fold line shows at the current stop.
const shown = (page, line) => unit(page, line).evaluate(root =>
  [...root.querySelectorAll(".fold-w:not(.fold-off):not(.fold-added)")].map(token => token.textContent).join("").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""));
const headings = line => {
  const trail = [];
  for (const text of lines.slice(0, line - 1)) {
    const match = /^(#+)\s+(.*)$/.exec(text);
    if (match) { trail.length = match[1].length - 1; trail.push(match[2]); }
  }
  return trail.filter(Boolean);
};
const anchor = line => ({ version: 2, landmarks: [{ kind: "block", block: lines[line - 1].replace(/^- /, ""), headings: headings(line), line }] });

// Synthetic Glass: one arrow from the first treatment bullet to the pitfalls; arrows point the way, so they fold.
async function seed(page, t) {
  await page.evaluate(() => window.desktop.glassState({ action: "write", visible: true }));
  await page.reload();
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  await learning(page, t);
  await expect(page.locator(".glass-layer")).toHaveAttribute("data-glass", "on");
  const fields = { kind: "arrow", from: { kind: "element", element: "nitrates", anchor: anchor(LIST) }, to: { kind: "element", element: "pitfalls", anchor: anchor(PITFALLS) } };
  const reply = await page.evaluate(fields => window.desktop.glass({ note: "ward.md", action: "add", magnet: "arrow-1", fields }), fields);
  assert.ok(reply?.ok, reply?.error ?? "seed failed");
}

// Mouse path from the Glass-in-the-fold test: select the words, pick a colour.
async function highlightWords(page, t, line, text) {
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
  const pick = page.getByRole("group", { name: t("选区操作"), exact: true });
  await pick.getByRole("button", { name: t("Highlight: {{colour}}", { colour: t("rose") }), exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: t("Highlight added") })).toBeVisible();
}

const strip = (page, t) => page.getByRole("group", { name: t("What the fold keeps"), exact: true });
const adjust = (page, t) => strip(page, t).getByRole("button", { name: t("Adjust"), exact: true });
const check = (page, group) => page.locator(`.fold-strip-list label[data-group="${group}"] input`);

async function states(app, page, t, language) {
  for (const width of [1440, 720]) {
    await resize(app, page, width);
    for (const scheme of ["light", "dark"]) {
      await theme(page, t, `omarchy-${scheme}`);
      await expect(fold(page, t)).toBeVisible();
      await page.locator(".fold-document").focus();
      await stop(page, "3", "key");
      if ((await adjust(page, t).getAttribute("aria-expanded")) !== "true") await adjust(page, t).click();
      await capture(page, `strip-open-${language}-${scheme}-${width}`);
      await adjust(page, t).click();
      await capture(page, `strip-line-${language}-${scheme}-${width}`);
      // The pitfalls at Key: the suggested red flag and the reader's own pin, each with its quiet hint.
      await unit(page, PITFALLS).scrollIntoViewIfNeeded();
      await capture(page, `strip-hints-${language}-${scheme}-${width}`, { reset: false, baseline: false });
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
  await openFold(page, t);
  const view = fold(page, t);

  // First fold of the note: the strip opens by itself above the first line, suggestions ticked.
  await expect(adjust(page, t)).toHaveAttribute("aria-expanded", "true");
  await expect(strip(page, t)).toContainText(t("Fold keeps {{list}}", { list: t("{{count}} red flags", { count: 2 }) }));
  await expect(check(page, "navigation")).not.toBeChecked();
  await expect(check(page, "redflag")).toBeChecked();
  await expect(page.locator('.fold-strip-list label[data-group="navigation"]')).toContainText(t("Suggested: let fold · they point the way, they are not facts"));
  assert.equal(await page.locator(".fold-scroller").evaluate(scroller => scroller.scrollTop), 0);
  assert.ok(await page.evaluate(() => document.querySelector(".fold-strip").getBoundingClientRect().bottom <= document.querySelector(".fold-unit").getBoundingClientRect().top),
    "the strip sits above the first fold line");

  // Red flags reach Takeaway in the author's words, flagged ⚑ as a suggestion, not ★.
  await stop(page, "4", "takeaway");
  await expect.poll(() => shown(page, PITFALLS)).toBe(squash(`${FLUIDS} ${NEGATION}`));
  await expect(unit(page, PITFALLS).getByRole("img", { name: t("Red flag: kept by suggestion"), exact: true })).toHaveText("⚑");

  // Keyboard: untick red flags and they fold like any line; keys typed in the strip stay there; Use suggestions restores.
  await page.evaluate(() => { window.longTasks = []; new PerformanceObserver(list => window.longTasks.push(...list.getEntries().map(entry => Math.round(entry.duration)))).observe({ type: "longtask" }); });
  await check(page, "redflag").focus();
  await page.keyboard.press("Space");
  await expect(check(page, "redflag")).not.toBeChecked();
  await expect(check(page, "redflag")).toBeFocused();
  await expect(strip(page, t)).toContainText(t("Fold keeps none of your marks"));
  await expect.poll(() => shown(page, PITFALLS)).not.toContain(squash(NEGATION));
  await expect(unit(page, PITFALLS).locator(".fold-pin")).toHaveCount(0);
  await page.keyboard.press("1");
  await expect(view).toHaveAttribute("data-stop", "takeaway");
  const reset = strip(page, t).getByRole("button", { name: t("Use suggestions"), exact: true });
  await reset.focus();
  await page.keyboard.press("Enter");
  await expect(check(page, "navigation")).toBeFocused();
  await expect(check(page, "redflag")).toBeChecked();
  await expect(reset).toHaveCount(0);
  await expect.poll(() => shown(page, PITFALLS)).toContain(squash(NEGATION));
  // Same budget rule as the other fold gestures: 50 ms on a quiet host, loose on a loaded dev box.
  const longest = Math.max(0, ...await page.evaluate(() => window.longTasks));
  console.log(`strip refold: longest task ${longest} ms`);
  assert.ok(longest <= (stableHost() ? 50 : 500), `a ${longest} ms long task blocks the page while the choice refolds it`);
  // Escape folds the checklist back to its line and leaves focus on Adjust; the fold stays open.
  await page.keyboard.press("Escape");
  await expect(adjust(page, t)).toHaveAttribute("aria-expanded", "false");
  await expect(adjust(page, t)).toBeFocused();
  await expect(view).toBeVisible();

  // Post-fold hint: the arrow's bullets fold at Takeaway; Keep is offered, never applied by itself.
  await expect(unit(page, LIST)).toHaveClass(/fold-off/);
  const keep = page.locator(".fold-document").getByRole("button", { name: t("Keep {{count}} marks in the fold", { count: 1 }), exact: true });
  await keep.focus();
  await page.keyboard.press("Enter");
  await expect(unit(page, LIST)).not.toHaveClass(/fold-off/);
  await expect(unit(page, LIST).getByRole("img", { name: t("Pinned: kept in the author's words"), exact: true })).toHaveText("★");
  await expect(keep).toHaveCount(0);
  await expect(strip(page, t)).toContainText(t("{{count}} labels and arrows", { count: 1 }));

  // The reader's own highlight on the negation: ★ and the class its plain stop would drop.
  await stop(page, "1", "full");
  await highlightWords(page, t, PITFALLS, NEGATION);
  await stop(page, "3", "key");
  const why = t("{{kept}}: {{level}} alone would drop it from your highlight", { kept: t("Condition kept"), level: t("Key") });
  await expect(unit(page, PITFALLS).getByRole("img", { name: `${t("Pinned: kept in the author's words")} · ${why}`, exact: true })).toHaveText("★");
  await expect(unit(page, PITFALLS).locator(".fold-kept")).toHaveText(t("Condition kept"));

  // A highlight without a card: Make cards opens drafts to review; nothing is saved until the reader saves.
  await expect(strip(page, t)).toContainText(t("{{count}} highlights have no card", { count: 1 }));
  await strip(page, t).getByRole("button", { name: t("Make cards"), exact: true }).click();
  const cards = page.getByRole("complementary", { name: t("学习卡片"), exact: true });
  await expect(cards.getByRole("status").filter({ hasText: t("{{count}} card drafts from your highlights: review them, then save.", { count: 1 }) })).toBeVisible();
  await expect(cards.getByRole("textbox", { name: t("答案"), exact: true })).toHaveValue(new RegExp("beta blockers abruptly"));
  await cards.getByRole("button", { name: t("取消"), exact: true }).click();
  await cards.getByRole("button", { name: t("关闭{{title}}", { title: t("学习卡片") }), exact: true }).click();
  await expect(cards).toHaveCount(0);
  await expect(strip(page, t)).toContainText(t("{{count}} highlights have no card", { count: 1 }));

  // Reopened, the strip remembers this note: one quiet line, the reader's choice kept.
  await closeFold(page);
  await expect(view).toHaveCount(0);
  await openFold(page, t);
  await expect(adjust(page, t)).toHaveAttribute("aria-expanded", "false");
  await expect(strip(page, t)).toContainText(t("{{count}} labels and arrows", { count: 1 }));
  await expect(check(page, "navigation")).toHaveCount(0);

  await states(app, page, t, "en");
  assert.deepEqual(errors, []);
} finally { await app.close(); }

// Spanish: first fold opens the strip, labels in Spanish, at both widths and themes.
({ app, page, errors, t } = await launch("es", { "ward.md": ward }));
watch(page);
try {
  await learning(page, t);
  await seed(page, t);
  await openFold(page, t);
  await expect(adjust(page, t)).toHaveAttribute("aria-expanded", "true");
  await expect(strip(page, t)).toContainText("El pliegue conserva 2 banderas rojas");
  await stop(page, "1", "full");
  await highlightWords(page, t, PITFALLS, NEGATION);
  await expect(strip(page, t)).toContainText(t("{{count}} highlights have no card", { count: 1 }));
  await states(app, page, t, "es");
  assert.deepEqual(errors, []);
} finally { await app.close(); }
assert.deepEqual(external, [], "the strip stays offline");
console.log(`PASS: pre-fold strip: opens once then remembered, keyboard adjust + Escape, red flags ⚑ refold, Keep hint, ★ with kept class, Make cards drafts unsaved, no long task, offline, EN/ES light/dark baselines (${evidence}).`);
