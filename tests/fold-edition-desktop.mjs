import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "playwright/test";
import { fold, launch, learning, openFold, rich, settle, shooter, stop, theme } from "./fold-desktop.mjs";
import { assertWorkBudget, readWork, stableHost, watchWork } from "./frame-cadence.mjs";

// OM-123 Nueva edición: two editions of a protocol folded to what changed, keyboard only, local stops, no model.
const fixture = name => readFile(fileURLToPath(new URL(`./fixtures/fold-edition/${name}.md`, import.meta.url)), "utf8");
const evidence = process.env.OMARKIE_QA_DIR ?? await mkdtemp(path.join(os.tmpdir(), "omarkie-fold-edition-shots-"));
await mkdir(evidence, { recursive: true });
const capture = shooter(evidence, evidence);
const COUNTS = { changed: 5, added: 2, removed: 2 };
const view = page => page.locator(".fold-edition");
const cards = page => page.locator(".fold-edition-card");
const picker = (page, t) => page.getByRole("dialog", { name: t("Compare with an earlier edition"), exact: true });

// E opens the picker on the look-alike name; Enter folds the two editions.
async function compare(page, t, older) {
  await page.keyboard.press("e");
  await expect(picker(page, t)).toBeVisible();
  await expect(picker(page, t).getByRole("option", { selected: true })).toContainText(older);
  await page.keyboard.press("Enter");
  await expect(picker(page, t)).toHaveCount(0);
  await expect(view(page)).toBeFocused();
  await expect(cards(page)).toHaveCount(COUNTS.changed + COUNTS.added + COUNTS.removed);
  await expect(page.locator(".fold-edition-body[data-pending]")).toHaveCount(0);
}

async function shots(page, t, language) {
  for (const scheme of ["light", "dark"]) {
    await theme(page, t, `omarchy-${scheme}`);
    await page.evaluate(() => { const list = document.querySelector(".fold-edition"); if (list) list.scrollTop = 0; });
    await capture(page, `edition-${language}-${scheme}-1440`, { reset: false, baseline: false });
  }
  await theme(page, t, "omarchy-light");
}

async function walk(page, t, language) {
  await learning(page, t);
  await openFold(page, t);
  await watchWork(page);
  // The picker closes on Esc and leaves the fold as it was.
  await page.keyboard.press("e");
  await expect(picker(page, t)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker(page, t)).toHaveCount(0);
  await expect(fold(page, t)).toBeVisible();
  await expect(view(page)).toHaveCount(0);
  await compare(page, t, `${language === "en" ? "ahf" : "ica"}-2023.md`);
  await expect(page.locator(".fold-edition-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".fold-scroller")).toBeHidden();
  const counts = page.locator(".fold-edition-counts");
  await expect(counts).toContainText(t("Changed · {{n}}", { n: COUNTS.changed }));
  await expect(counts).toContainText(t("Added · {{n}}", { n: COUNTS.added }));
  await expect(counts).toContainText(t("Removed · {{n}}", { n: COUNTS.removed }));
  await expect(counts).toContainText(t("New never-dos · {{n}}", { n: 2 }));
  // Numbers read old → new; the new never-do and the dropped recommendation are marked by name, not colour alone.
  const dose = page.locator('.fold-edition-fact[data-class="number"][data-change="changed"]').filter({ has: page.locator("del", { hasText: "40 mg" }) }).first();
  await expect(dose.locator("ins")).toHaveText("80 mg");
  await expect(dose).toHaveAttribute("aria-label", t("{{what}}: {{old}} → {{new}}", { what: t("Number"), old: "40 mg", new: "80 mg" }));
  const never = language === "en" ? "Never stop beta blockers abruptly unless there is cardiogenic shock." : "Nunca suspender bruscamente los betabloqueantes salvo shock cardiogénico.";
  await expect(page.locator('.fold-edition-fact[data-class="negation"][data-change="added"]').filter({ hasText: never }))
    .toHaveAttribute("aria-label", t("{{what}}: {{value}}", { what: t("New never-do"), value: never }));
  await expect(page.locator('.fold-edition-card[data-kind="removed"] .fold-edition-badge').first()).toContainText(t("Removed"));
  const changed = page.locator('.fold-edition-card[data-kind="changed"]').filter({ has: page.locator(".fold-edition-body del", { hasText: "40" }) }).first();
  await expect(changed.locator(".fold-edition-body ins").filter({ hasText: "80" })).toHaveCount(1);
  // Local stops drive the cards; the cards stay the changed units only.
  await stop(page, "4", "takeaway", 4);
  await expect(cards(page)).toHaveCount(COUNTS.changed + COUNTS.added + COUNTS.removed);
  await stop(page, "[", "key", 3);
  await expect(page.locator(".fold-edition-body[data-pending]")).toHaveCount(0);
  // Arrows walk the cards, Enter shows one in Full, Esc folds it back, Esc again leaves the edition.
  await page.keyboard.press("ArrowDown");
  await expect(cards(page).first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const second = cards(page).nth(1);
  await expect(second).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(second).toHaveAttribute("data-open", "true");
  await expect(second.getByRole("button", { name: t("Full"), exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(second).not.toHaveAttribute("data-open", /.*/);
  await expect(view(page)).toBeVisible();
  const work = await readWork(page);
  assertWorkBudget({ work: work.events, longTasks: work.longTasks, gesture: `${language} edition keyboard path`, minimum: 0, p95: 16, longest: stableHost() ? 50 : 500 });
  await shots(page, t, language);
  await view(page).focus();
  await page.keyboard.press("Escape");
  await expect(view(page)).toHaveCount(0);
  await expect(page.locator(".fold-scroller")).toBeVisible();
  await expect(page.locator(".fold-document")).toBeFocused();
  await expect(page.locator(".fold-view")).toHaveAttribute("data-stop", "key");
}

let { app, page, errors, t } = await launch("en", { "ahf-2025.md": await fixture("ahf-2025"), "ahf-2023.md": await fixture("ahf-2023") });
try {
  await walk(page, t, "en");
  // Shift+Enter on a card opens the new edition's line in the editor.
  await compare(page, t, "ahf-2023.md");
  const first = await cards(page).evaluateAll(list => list.findIndex(card => card.dataset.kind !== "removed"));
  for (let step = 0; step <= first; step++) await page.keyboard.press("ArrowDown");
  await expect(cards(page).nth(first)).toBeFocused();
  await page.keyboard.press("Shift+Enter");
  await expect(fold(page, t)).toHaveCount(0);
  await expect(rich(page)).toBeVisible();
  assert.deepEqual(errors, []);
} finally { await app.close(); }

({ app, page, errors, t } = await launch("es", { "ica-2025.md": await fixture("ica-2025"), "ica-2023.md": await fixture("ica-2023") }));
try {
  await walk(page, t, "es");
  assert.deepEqual(errors, []);
} finally { await app.close(); }

// Budget: a 300-section pair (~50 kB each) folds in the worker; the page never blocks over 50 ms while it lands and the stops move.
const section = (i, dose) => `## Section ${i}\n\nPatient group ${i} receives drug ${i} at ${dose} mg twice daily. Review renal function every ${i % 7 + 1} days. Do not combine drug ${i} with drug ${i + 1}.\n\n- Item ${i} one.\n- Item ${i} two with a target of ${i * 3} mmHg.\n`;
const older = Array.from({ length: 300 }, (_, i) => section(i, 10 + i)).join("\n");
const newer = Array.from({ length: 300 }, (_, i) => section(i, i % 10 ? 10 + i : 20 + i)).join("\n");
({ app, page, errors, t } = await launch("en", { "long-2025.md": newer, "long-2024.md": older }));
try {
  await learning(page, t);
  // Folding the 50 kB page itself is the fold view's own cost (fold-view-desktop); only the edition is measured here.
  await rich(page).focus();
  await page.keyboard.press("Control+Shift+H");
  await expect(fold(page, t)).toBeVisible({ timeout: 30_000 });
  await settle(page);
  // Playwright's waits run on the page's thread (locator engine, injected poller); here each check is one evaluate, 150 ms apart.
  const until = async (predicate, arg) => {
    for (const start = Date.now(); !await page.evaluate(predicate, arg);) {
      assert.ok(Date.now() - start < 30_000, `timed out: ${predicate}`);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  };
  const quiet = () => until(() => !document.querySelector(".fold-edition-body[data-pending], .fold-edition-body[data-stale]"));
  await watchWork(page);
  await page.keyboard.press("e");
  await until(() => !!document.querySelector(".fold-edition-pick [aria-selected='true']"));
  await page.keyboard.press("Enter");
  await until(() => document.querySelectorAll(".fold-edition-card").length === 30);
  await quiet();
  for (const [key, name] of [["1", "full"], ["2", "brief"], ["4", "takeaway"], ["5", "topic"], ["3", "key"]]) {
    await page.keyboard.press(key);
    await until(stop => document.querySelector(".fold-view")?.getAttribute("data-stop") === stop, name);
    await quiet();
  }
  const work = await readWork(page);
  console.log("long tasks:", JSON.stringify(work.detail));
  assertWorkBudget({ work: work.events, longTasks: work.longTasks, gesture: "edition on a 50 kB pair", minimum: 0, p95: 16, longest: stableHost() ? 50 : 500 });
  assert.deepEqual(errors, []);
} finally { await app.close(); }
console.log("PASS: Nueva edición picks the earlier edition by keyboard, shows only changed units with numbers old → new, new never-dos and dropped lines, local stops, card keys, editor reveal, EN/ES light/dark evidence, worker keeps the page under budget.");
