import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkPins } from "../shared/fold-check.mjs";
import { factsOf, foldEdition } from "../shared/fold-edition.mjs";
import { isMonotonic } from "../shared/fold-units.mjs";

const fixture = name => readFileSync(new URL(`./fixtures/fold-edition/${name}.md`, import.meta.url), "utf8");
const STOPS = ["full", "brief", "key", "takeaway", "topic"];
const fact = (change, factClass) => change.facts.find(item => item.class === factClass);
const heading = (edition, title) => edition.changes.filter(change => (change.new ?? change.old).headings.at(-1) === title);

for (const [language, old, next, section, pitfalls, gone, fresh] of [
  ["en", "ahf-2023", "ahf-2025", "Treatment", "Pitfalls", "Discharge", "Monitoring"],
  ["es", "ica-2023", "ica-2025", "Tratamiento", "Errores frecuentes", "Alta", "Monitorización"],
]) {
  const edition = foldEdition(fixture(old), fixture(next));

  test(`${language}: unchanged sections stay out, every edit shows once`, () => {
    assert.deepEqual(edition.counts, { added: 2, removed: 2, changed: 5, unchanged: 6, moved: 0 });
    assert.ok(edition.changes.every(change => !/Diagn/.test((change.new ?? change.old).headings.at(-1) ?? "")), "the untouched diagnosis section is not shown");
  });

  test(`${language}: numbers read old → new, years are not doses`, () => {
    const [dose] = heading(edition, section).filter(change => change.new.kind === "paragraph");
    assert.deepEqual(dose.facts.filter(item => item.class === "number").map(item => [item.old, item.new]), [
      ["40 mg", "80 mg"], [language === "en" ? "6 hours" : "6 horas", language === "en" ? "2 hours" : "2 horas"], [language === "en" ? "24 hours" : "24 horas", language === "en" ? "6 hours" : "6 horas"],
    ]);
    assert.ok(!edition.changes[0].facts.some(item => item.class === "number"), "Edition 2023 → 2025 is no number change");
    const table = edition.changes.find(change => change.new?.raw === "table");
    assert.deepEqual([fact(table, "number").old, fact(table, "number").new], ["40 mg", "80 mg"]);
    assert.match(table.new.stops.takeaway, /\| 80 mg IV \|/, "the changed row survives Takeaway");
    assert.doesNotMatch(table.new.stops.takeaway, /pg\/mL/, "unchanged rows fold away");
  });

  test(`${language}: a new never-do is named and pinned through Takeaway`, () => {
    const [change] = heading(edition, pitfalls);
    assert.equal(change.kind, "changed");
    const line = language === "en" ? "Never stop beta blockers abruptly unless there is cardiogenic shock." : "Nunca suspender bruscamente los betabloqueantes salvo shock cardiogénico.";
    assert.equal(fact(change, "condition").change, "added");
    assert.deepEqual(fact(change, "negation"), { class: "negation", change: "added", old: null, new: line });
    for (const stop of ["full", "brief", "key", "takeaway"]) assert.equal(checkPins(change.new.stops[stop], [line]).ok, true, `${stop} keeps the new never-do`);
    assert.equal(change.new.stops.topic, "", "Topic leaves only the facts");
  });

  test(`${language}: a dropped recommendation and a dropped section show from the old edition`, () => {
    const list = edition.changes.find(change => change.new?.kind === "list");
    assert.equal(list.sentences.removed, 1);
    assert.match(list.old.stops.key, /morphine|morfina/);
    const removed = heading(edition, gone);
    assert.deepEqual(removed.map(change => [change.kind, change.new]), [["removed", null], ["removed", null]]);
    assert.deepEqual(fact(removed[1], "number"), { class: "number", change: "removed", old: language === "en" ? "2 weeks" : "2 semanas", new: null });
    assert.match(removed[1].old.stops.takeaway, /2 (weeks|semanas)/);
    assert.deepEqual(heading(edition, fresh).map(change => change.kind), ["added", "added"]);
  });

  test(`${language}: every shown side keeps a monotonic ladder`, () => {
    for (const change of edition.changes) for (const side of [change.old, change.new]) if (side) assert.ok(isMonotonic(side.stops), side.elementId);
    for (let i = 1; i < STOPS.length; i++) assert.ok(edition.shown[STOPS[i]] <= edition.shown[STOPS[i - 1]], STOPS[i]);
    assert.ok(edition.shown.full < edition.total, "the edition view is shorter than the new text");
  });
}

test("moved and reformatted units are not changes", () => {
  const a = "# Plan\n\nStart oxygen when saturation is under 90%.\n\nCall the senior early.\n\nWeigh daily.\n";
  const b = "# Plan\n\nCall the senior early.\n\nStart **oxygen** when saturation is under 90%.\n\nWeigh daily.\n";
  const edition = foldEdition(a, b);
  assert.deepEqual(edition.changes, []);
  assert.deepEqual([edition.counts.unchanged, edition.counts.moved], [4, 1]);
  assert.deepEqual(foldEdition(a, a.replace("Call the senior", "Call the *senior*")).changes, [], "reformatted in place");
});

test("a symbol edit is an edit: > becomes ≥", () => {
  const edition = foldEdition("# T\n\nTreat when lactate > 2 mmol/L.\n", "# T\n\nTreat when lactate ≥ 2 mmol/L.\n");
  assert.equal(edition.counts.changed, 1);
  assert.deepEqual(fact(edition.changes[0], "number"), { class: "number", change: "changed", old: "> 2 mmol/L", new: "≥ 2 mmol/L" });
});

test("lifted never-do and changed hedge read as such", () => {
  assert.deepEqual(factsOf("Give it daily. Do not restart the drug before day 5.", "Give it daily. Restart the drug on day 5.").find(item => item.class === "negation"),
    { class: "negation", change: "removed", old: "Do not restart the drug before day 5.", new: null });
  assert.deepEqual(factsOf("This may help.", "This probably helps.").find(item => item.class === "uncertainty"), { class: "uncertainty", change: "changed", old: "may", new: "probably" });
});

test("reader pins on the new edition hold through Takeaway", () => {
  const a = "# T\n\nFirst line stays. Second line stays. Third line changes to 5 mg.\n";
  const b = "# T\n\nFirst line stays. Second line stays. Third line changes to 10 mg.\n";
  const [change] = foldEdition(a, b, { pins: [{ line: 3, quote: "Second line stays." }] }).changes;
  assert.match(change.new.stops.takeaway, /Second line stays\./);
  assert.match(change.new.stops.takeaway, /10 mg/);
});

test("a 60 kB edition pair folds in seconds, not minutes", () => {
  const section = (i, dose) => `## Section ${i}\n\nPatient group ${i} receives drug ${i} at ${dose} mg twice daily. Review renal function every ${i % 7 + 1} days. Do not combine drug ${i} with drug ${i + 1}.\n\n- Item ${i} one.\n- Item ${i} two with a target of ${i * 3} mmHg.\n`;
  const old = Array.from({ length: 300 }, (_, i) => section(i, 10 + i)).join("\n");
  const next = Array.from({ length: 300 }, (_, i) => section(i, i % 10 ? 10 + i : 20 + i)).join("\n");
  foldEdition(old.slice(0, 2000), next.slice(0, 2000));
  const start = performance.now();
  const edition = foldEdition(old, next);
  const elapsed = performance.now() - start;
  assert.equal(edition.counts.changed, 30);
  assert.ok(elapsed < 4000, `${elapsed.toFixed(0)} ms`);
});
