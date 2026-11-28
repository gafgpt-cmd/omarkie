import assert from "node:assert/strict";
import { test } from "node:test";
import { isRedFlag } from "../shared/fold-check.mjs";
import { keptPayload, markPins, readChoice, redFlags, setKeep, stripGroups } from "../shared/fold-strip.mjs";
import { extractUnits, foldDocumentLadder, unitSentences } from "../shared/fold-units.mjs";

// Synthetic ward note: a paragraph that folds, a list and a callout that carry red flags.
const NOTE = `# Ward night

Give the loading dose slowly over one full hour and watch the arterial pressure closely every fifteen minutes during the infusion. Stop the infusion if the systolic pressure falls below 90 mmHg for two readings. Recheck the potassium after the dose, record it in the chart, and call the senior if it keeps falling.

- Never mix the infusion with calcium in the same line.
- Flush the line with saline before and after each dose.

> [!warning] Pitfalls
> Avoid boluses in frail patients. Use the pump for every dose.
`;
const STOP_PIN = { line: 3, quote: "Stop the infusion if the systolic pressure falls below 90 mmHg for two readings." };

test("red flags are prohibitions and contraindications, not every negation", () => {
  for (const text of ["Do not give fluids before the echo.", "Never mix the infusion with calcium.", "Avoid boluses in frail patients.",
    "No administrar junto con calcio.", "Nunca suspender los betabloqueantes de golpe.", "The drug should not be given in pregnancy."])
    assert.equal(isRedFlag(text), true, text);
  for (const text of ["The drug does not cross the placenta.", "Patients without fever recover sooner.", "No hay datos en niños.", "Recheck the potassium after the dose."])
    assert.equal(isRedFlag(text), false, text);
});

test("clinician red flags: contraindications, do-not-use, avoid, dose limits and warnings in EN and ES", () => {
  const flagged = {
    en: ["Ketorolac is contraindicated in renal failure.", "Pregnancy is a contraindication to warfarin.", "Do not use in children under 12.",
      "Patients with asthma: do not use propranolol.", "Avoid NSAIDs after bariatric surgery.", "Maximum dose 4 g per day.",
      "The daily dose should not exceed 4 g.", "Not to exceed 3 doses in 24 hours.", "Warning: risk of serotonin syndrome.",
      "Fluoroquinolones carry a black box warning for tendon rupture."],
    es: ["El ketorolaco está contraindicado en la insuficiencia renal.", "La metformina está contraindicada si el filtrado es bajo.",
      "El embarazo es una contraindicación absoluta.", "No usar en menores de 12 años.", "Evitar los AINE tras cirugía bariátrica.",
      "Evítese en ancianos frágiles.", "Dosis máxima 4 g al día.", "No superar 3 dosis en 24 horas.", "No exceder la dosis diaria.",
      "Advertencia: riesgo de síndrome serotoninérgico.", "Lleva advertencia de recuadro negro por rotura tendinosa."],
  };
  for (const text of [...flagged.en, ...flagged.es]) assert.equal(isRedFlag(text), true, text);
  for (const text of ["No contraindications in pregnancy.", "The drug is not contraindicated in renal failure.", "There are no known contraindications.",
    "Sin contraindicaciones en el embarazo.", "No está contraindicado en la insuficiencia renal.", "The early warning score stays at 2.",
    "La dosis se ajusta al peso.", "El fármaco no atraviesa la placenta."])
    assert.equal(isRedFlag(text), false, text);
});

test("sentences come out of lists item by item and out of callouts without their header", () => {
  const units = extractUnits(NOTE);
  assert.deepEqual(units.map(unitSentences), [
    [],
    [
      "Give the loading dose slowly over one full hour and watch the arterial pressure closely every fifteen minutes during the infusion.",
      STOP_PIN.quote,
      "Recheck the potassium after the dose, record it in the chart, and call the senior if it keeps falling.",
    ],
    ["Never mix the infusion with calcium in the same line.", "Flush the line with saline before and after each dose."],
    ["Avoid boluses in frail patients.", "Use the pump for every dose."],
  ]);
  assert.deepEqual(redFlags(units), [
    { line: 5, quote: "Never mix the infusion with calcium in the same line." },
    { line: 8, quote: "Avoid boluses in frail patients." },
  ]);
});

test("a ladder from pre-extracted units matches one from the text, and pinned units carry their plain stops", () => {
  const units = extractUnits(NOTE), pins = [STOP_PIN];
  const given = foldDocumentLadder(NOTE, { pins, units }), parsed = foldDocumentLadder(NOTE, { pins });
  assert.deepEqual(given.byUnit.map(entry => [entry.stops, entry.pinned]), parsed.byUnit.map(entry => [entry.stops, entry.pinned]));
  const pinned = given.byUnit[1], plain = foldDocumentLadder(NOTE, { units }).byUnit[1];
  assert.deepEqual(pinned.pinned, ["key", "takeaway"]);
  assert.deepEqual(pinned.plain, plain.stops);
  assert.equal(given.byUnit[2].plain, undefined);
});

test("a stored choice keeps only the reader's overrides of the suggestion", () => {
  assert.deepEqual(readChoice("{broken"), { seen: false, keep: {} });
  assert.deepEqual(readChoice(JSON.stringify({ seen: true, keep: { highlight: true, navigation: true, ink: "yes", bogus: false } })), { seen: true, keep: { navigation: true } });
  const choice = setKeep({ seen: true, keep: {} }, ["redflag", "navigation"], false);
  assert.deepEqual(choice.keep, { redflag: false });
  assert.deepEqual(setKeep(choice, ["redflag"], true).keep, {});
});

test("marks pin by group: labels and arrows fold unless kept, stickies and unplaced marks never pin", () => {
  const marks = [
    { kind: "highlight", line: 3, quote: STOP_PIN.quote },
    { kind: "ink", line: 5 },
    { kind: "magnet", type: "label", line: 8 },
    { kind: "magnet", type: "card", line: 8 },
    { kind: "sticky", line: 3 },
    { kind: "magnet", type: "comment", line: null },
  ];
  assert.deepEqual(markPins(marks, { seen: true, keep: {} }), [STOP_PIN, { line: 5 }, { line: 8 }]);
  assert.deepEqual(markPins(marks, { seen: true, keep: { navigation: true, highlight: false } }), [{ line: 5 }, { line: 8 }, { line: 8 }]);
  assert.deepEqual(stripGroups(marks, [{ line: 5, quote: "x" }]),
    [{ group: "highlight", count: 1 }, { group: "ink", count: 1 }, { group: "card", count: 1 }, { group: "navigation", count: 1 }, { group: "redflag", count: 1 }]);
});

test("a highlight pin reports the payload class its plain stop would drop", () => {
  const ladder = foldDocumentLadder(NOTE, { pins: [STOP_PIN] });
  assert.deepEqual([...keptPayload(ladder, [STOP_PIN])], [[1, { key: "condition", takeaway: "condition" }]]);
  assert.deepEqual([...keptPayload(ladder, [{ line: 3 }])], []);
});
