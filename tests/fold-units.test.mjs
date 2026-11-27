import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { FOLD_FORMAT, FOLD_VERSION, foldProblems, isFold, isFoldLine } from "../shared/fold-format.mjs";
import { LOCAL_LEVELS, words } from "../shared/fold-text.mjs";
import {
  enforceMonotonic, extractUnits, foldDocument, foldDocumentLadder, foldUnit,
  isMonotonic, rawClassOf, sha256, toFoldUnit, unitHash,
} from "../shared/fold-units.mjs";

const FIXTURE_9_TABLE_ONLY_ES = `## Dosis máximas de anestésicos locales

| Fármaco | Sin adrenalina | Con adrenalina | Inicio |
| --- | --- | --- | --- |
| Lidocaína | 4,5 mg/kg | 7 mg/kg | Rápido |
| Bupivacaína | 2 mg/kg | 2,5 mg/kg | Intermedio |
| Ropivacaína | 3 mg/kg | 3 mg/kg | Intermedio |
| Mepivacaína | 4,5 mg/kg | 7 mg/kg | Rápido |
`;

const FIXTURE_ADHF_EN = `---
title: ADHF ward guide
tags:
  - cardiology
---

## Definition and diagnosis

Acute decompensated heart failure is rapid congestion or hypoperfusion at rest. Dyspnoea, orthopnoea, and elevated JVP form the bedside triad. Reassess perfusion and congestion within the first hour.

BNP >100 pg/mL supports the diagnosis in acute dyspnoea. Obesity lowers BNP, whereas renal failure raises it.

## Initial assessment

![ADHF haemodynamic profiles](profiles.png)

Classify patients into warm-wet, cold-wet, warm-dry, or cold-dry within 60 min. Measure arterial lactate, potassium, magnesium, and creatinine immediately.

- Check airway and oxygen saturation first. Titrate oxygen if SpO2 <90%.
  - Avoid routine oxygen when SpO2 >=90%.
- Start IV furosemide 40 mg if diuretic-naive. Reassess urine output at 2 h.

## Numbers to remember

| Parameter | Threshold | Action |
| --- | --- | --- |
| BNP | >100 pg/mL | Supports diagnosis |
| Furosemide | 40 mg IV | Diuretic-naive start |
| Urine Na 6 h | <50 mmol/L | Escalate diuretic |
| Potassium | 4.0 mmol/L | Supplement if low |

## Acid-base check

$$ \\text{Expected } PaCO_2 = 1.5 \\times [HCO_3^-] + 8 \\pm 2 $$

> [!warning] Never do
> Never administer IV fluid boluses for hypotension with pulmonary congestion. Do not stop beta-blockers abruptly unless in cardiogenic shock.

\`\`\`ts
const doseMg = 40;
const checkAtHours = 2;
const reassess = (urineMl: number) => urineMl < 150 ? doseMg * 2 : doseMg;
console.log(reassess(90));
console.log(checkAtHours);
console.log("done");
console.log("line 7");
console.log("line 8");
\`\`\`
`;

const FIXTURE_CLINICAL_ES = `## Nota de evolución

El Dr. García y la Sra. López evaluaron al paciente a las 08:00. Presenta TA 105/65 mmHg, FC 98 lpm y SpO2 94% con gafas nasales a 2 L/min. Sin signos de hipoperfusión periférica.

Se mantiene furosemida 40 mg i.v. cada 8 h. Si la diuresis a las 6 h es <100 mL/h, añadir tiazida. ¡Nunca administrar cristaloides en bolo si persiste congestión!

## Laboratorio

| Prueba | Resultado | Referencia |
| --- | --- | --- |
| Creatinina | 1,4 mg/dL | 0,7-1,2 mg/dL |
| Potasio | 3,6 mmol/L | 3,5-5,0 mmol/L |
| Lactato | 1,2 mmol/L | <2,0 mmol/L |

## Plan

1. Controlar balance hídrico estricto. Pesar diariamente en ayunas.
2. Reponer potasio por vía oral. Repetir ionograma en 6 h.
   - Vigilar función renal si aumenta creatinina >0,3 mg/dL.
3. Revisar ecocardiograma ![[eco-basal.png]] antes del alta.
`;

const FIXTURE_UNHEADED_ES = `Primera frase del protocolo sin títulos. Segunda frase explicativa. Tercera frase de cierre.

Segundo párrafo con detalles de dosis: administrar 2,5 mg/kg i.v. en bolo lento. Repetir si persiste rigidez muscular.

![Curva de capnografía](etco2.png)

Tercer párrafo con ![Monitor](monitor.png) en la segunda frase. La primera frase no tiene imagen. La segunda frase incluye ![Monitor](monitor.png) y una alerta clínica.
`;

const FIXTURE_SEPSIS_NEGATION_EN = `## Sepsis bundle

Do not delay broad-spectrum antibiotics beyond 1 h in septic shock. Never give starch colloids. Only start vasopressors after assessing volume responsiveness, unless MAP <65 mmHg persists.

> Lactate >2 mmol/L warrants repeat measurement within 2 h. Failure to clear lactate predicts higher mortality.

---

### Follow-up

Reassess fluid balance every 4 h. Stop fluids immediately if lung ultrasound shows diffuse B-lines.
`;

const FIXTURE_NESTED_EDGE = `> - Item inside blockquote one. Extra sentence.
> - Item inside blockquote two.

- Outer item with fenced code. Second sentence.
  \`\`\`js
  const hidden = 1;
  const hidden2 = 2;
  \`\`\`
  - Nested child item. Another detail.
- Second outer item.

| A | B |
| --- | --- |
| 1 | 2 |

> | Quoted | Table |
> | --- | --- |
> | x | y |
`;

const ALL_FIXTURES = [
  ["fixture-9-table-only-es", FIXTURE_9_TABLE_ONLY_ES],
  ["fixture-adhf-en", FIXTURE_ADHF_EN],
  ["fixture-clinical-es", FIXTURE_CLINICAL_ES],
  ["fixture-unheaded-es", FIXTURE_UNHEADED_ES],
  ["fixture-sepsis-negation-en", FIXTURE_SEPSIS_NEGATION_EN],
  ["fixture-nested-edge", FIXTURE_NESTED_EDGE],
];

describe("sha256 and unitHash", () => {
  test("pure sha256 matches node:crypto across block boundaries and Unicode", () => {
    const samples = [
      "",
      "a",
      "abc",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(63),
      "a".repeat(64),
      "a".repeat(65),
      "a".repeat(127),
      "a".repeat(128),
      "a".repeat(129),
      "Dosis: 4,5 mg/kg — Lidocaína · 缓存键 · 🏥",
      FIXTURE_ADHF_EN.repeat(8),
    ];
    for (const sample of samples) {
      const expected = createHash("sha256").update(sample, "utf8").digest("hex");
      assert.equal(sha256(sample), expected, `mismatch for len=${sample.length}`);
    }
  });

  test("unitHash normalizes EOL and NFC, is sensitive to clinical edits, and stays stable across line shifts", () => {
    const lf = unitHash("paragraph", "Furosemida 40 mg i.v.\nSegunda línea.");
    const crlf = unitHash("paragraph", "Furosemida 40 mg i.v.\r\nSegunda línea.");
    const nfd = unitHash("paragraph", "Furosemida 40 mg i.v.\nSegunda li\u0301nea.");
    assert.match(lf, /^[0-9a-f]{64}$/);
    assert.equal(lf, crlf);
    assert.equal(lf, nfd);

    // Distinct clinically meaningful changes must produce distinct hashes.
    assert.notEqual(unitHash("paragraph", "Furosemida 40 mg."), unitHash("paragraph", "Furosemida 80 mg."));
    assert.notEqual(unitHash("paragraph", "si responde"), unitHash("paragraph", "sí responde"));
    assert.notEqual(unitHash("paragraph", "Texto"), unitHash("heading", "Texto"));

    // Editing another paragraph above shifts line numbers without changing unchanged units' hashes.
    const before = extractUnits(FIXTURE_ADHF_EN);
    const edited = FIXTURE_ADHF_EN.replace("Acute decompensated heart failure", "Updated acute heart failure\n\nInserted paragraph.");
    const after = extractUnits(edited);
    const tableBefore = before.find(u => u.raw === "table");
    const tableAfter = after.find(u => u.raw === "table");
    assert.ok(tableBefore && tableAfter);
    assert.ok(tableAfter.line > tableBefore.line, "line numbers shifted");
    assert.equal(tableAfter.elementId, tableBefore.elementId);
    assert.equal(tableAfter.hash, tableBefore.hash);
  });
});

describe("extractUnits from element-model", () => {
  test("extracts non-overlapping top-level units, excludes sub-elements, dividers, and frontmatter", () => {
    const units = extractUnits(FIXTURE_ADHF_EN);
    const kinds = units.map(u => u.kind);
    assert.deepEqual(kinds, [
      "heading", "paragraph", "paragraph",
      "heading", "image", "paragraph", "list",
      "heading", "table",
      "heading", "formula", "callout", "code",
    ]);

    // Non-overlapping in source order and exact source slices.
    for (let i = 0; i < units.length; i++) {
      assert.equal(FIXTURE_ADHF_EN.slice(units[i].from, units[i].to), units[i].markdown);
      if (i > 0) assert.ok(units[i].from >= units[i - 1].to, `unit ${i} overlaps previous`);
    }

    // Sub-elements and dividers never appear as top-level fold units.
    assert.equal(units.some(u => u.kind === "list-item" || u.kind === "table-cell" || u.kind === "divider"), false);
    assert.equal(units.some(u => u.markdown.includes("title: ADHF")), false);

    // Section grouping points each unit to its enclosing heading elementId.
    const headings = units.filter(u => u.kind === "heading");
    assert.equal(units[1].sectionId, headings[0].elementId);
    assert.equal(units[4].sectionId, headings[1].elementId);
    assert.equal(units[8].sectionId, headings[2].elementId);
    assert.equal(units[12].sectionId, headings[3].elementId);
  });

  test("maps raw-block classes and metadata accurately", () => {
    assert.equal(rawClassOf("table"), "table");
    assert.equal(rawClassOf("code"), "code");
    assert.equal(rawClassOf("formula"), "math");
    assert.equal(rawClassOf("image"), "image");
    assert.equal(rawClassOf("embed"), "image");
    assert.equal(rawClassOf("paragraph"), null);
    assert.equal(rawClassOf("heading"), null);
    assert.equal(rawClassOf(null), null);

    const units = extractUnits(FIXTURE_ADHF_EN);
    const table = units.find(u => u.kind === "table");
    const code = units.find(u => u.kind === "code");
    const formula = units.find(u => u.kind === "formula");
    const image = units.find(u => u.kind === "image");
    assert.deepEqual(table.rawMeta, { class: "table", rows: 4, columns: 3 });
    assert.deepEqual(code.rawMeta, { class: "code", lines: 8, language: "ts" });
    assert.deepEqual(formula.rawMeta, { class: "math" });
    assert.deepEqual(image.rawMeta, { class: "image", kind: "image", alt: "ADHF haemodynamic profiles" });
  });

  test("handles nested lists, lists inside blockquotes, and tables inside blockquotes without duplication", () => {
    const units = extractUnits(FIXTURE_NESTED_EDGE);
    assert.deepEqual(units.map(u => u.kind), ["quote", "list", "table", "quote"]);
    for (let i = 1; i < units.length; i++) {
      assert.ok(units[i].from >= units[i - 1].to, `unit ${i} must not overlap`);
    }
  });

  test("toFoldUnit produces schema-valid FoldUnit records for shared/fold-format.mjs", () => {
    const units = extractUnits(FIXTURE_ADHF_EN).map(toFoldUnit);
    const record = {
      format: FOLD_FORMAT,
      version: FOLD_VERSION,
      meta: {
        slot: "ladder",
        route: "agent",
        agent: "opencode",
        model: "test-model",
        promptVersion: 1,
        schemaVersion: 1,
        outLang: "en",
        created: "2026-11-27T12:00:00Z",
      },
      units,
      written: [],
      sections: [],
      estudio: null,
    };
    assert.deepEqual(foldProblems(record), []);
    assert.equal(isFold(record), true);
  });

  test("extractUnits handles empty and whitespace-only markdown", () => {
    assert.deepEqual(extractUnits(""), []);
    assert.deepEqual(extractUnits("   \n\n  "), []);
    assert.deepEqual(extractUnits("---\n"), []);
  });
});

describe("raw-block preservation rule (D5)", () => {
  test("fixture 9 (table-only ES section): table survives every local stop", () => {
    const ladder = foldDocumentLadder(FIXTURE_9_TABLE_ONLY_ES);
    for (const { id } of LOCAL_LEVELS) {
      const stop = ladder.stops[id];
      const tableEntry = stop.entries.find(e => e.raw === "table");
      assert.ok(tableEntry, `table unit missing at ${id}`);
      assert.equal(tableEntry.visible, true, `table hidden at ${id}`);
      assert.ok(tableEntry.text.includes("Fármaco"), `table header missing at ${id}`);
      assert.ok(stop.text.includes("| Fármaco |"), `document output missing table at ${id}`);
    }
    // Full, Brief, Key keep all 4 drug rows (Sketch A: shown in full at Key).
    for (const id of ["full", "brief", "key"]) {
      for (const drug of ["Lidocaína", "Bupivacaína", "Ropivacaína", "Mepivacaína"]) {
        assert.ok(ladder.stops[id].text.includes(drug), `${drug} missing at ${id}`);
      }
    }
    // Takeaway keeps header + delimiter + first data row; Topic keeps header + delimiter.
    assert.ok(ladder.stops.takeaway.text.includes("Lidocaína"));
    assert.ok(!ladder.stops.takeaway.text.includes("Mepivacaína"));
    assert.ok(ladder.stops.topic.text.includes("| Fármaco | Sin adrenalina | Con adrenalina | Inicio |"));
    assert.ok(!ladder.stops.topic.text.includes("Lidocaína"));
  });

  test("tables, code, math, standalone images, embeds, and inline images never vanish at any stop", () => {
    const ladder = foldDocumentLadder(FIXTURE_ADHF_EN);
    for (const { id } of LOCAL_LEVELS) {
      const stop = ladder.stops[id];
      for (const rawClass of ["table", "code", "math", "image"]) {
        const rawEntries = stop.entries.filter(e => e.raw === rawClass);
        assert.ok(rawEntries.length > 0, `expected raw=${rawClass} unit`);
        for (const entry of rawEntries) {
          assert.equal(entry.visible, true, `${rawClass} unit vanished at ${id}`);
          assert.ok(entry.text.trim().length > 0, `${rawClass} unit empty at ${id}`);
        }
      }
      // Formula and standalone image survive verbatim at every stop.
      assert.ok(stop.text.includes("PaCO_2"), `formula missing at ${id}`);
      assert.ok(stop.text.includes("![ADHF haemodynamic profiles](profiles.png)"), `image missing at ${id}`);
      // Long code (8 body lines) folds to placeholder below Full without vanishing.
      if (id !== "full") assert.ok(stop.text.includes("`⋯ 8 lines of code`"), `code placeholder missing at ${id}`);
    }

    // Inline image inside a later sentence of a non-first paragraph survives every stop.
    const unheaded = foldDocumentLadder(FIXTURE_UNHEADED_ES);
    for (const { id } of LOCAL_LEVELS) {
      assert.ok(unheaded.stops[id].text.includes("![Curva de capnografía](etco2.png)"), `standalone image missing at ${id}`);
      assert.ok(unheaded.stops[id].text.includes("![Monitor](monitor.png)"), `inline image missing at ${id}`);
    }

    // Standalone wiki embed survives every stop.
    const withEmbed = "## Tema\n\nPrimer párrafo. Segunda frase.\n\n![[Diagrama.png]]\n";
    const embedLadder = foldDocumentLadder(withEmbed);
    for (const { id } of LOCAL_LEVELS) {
      const embed = embedLadder.stops[id].entries.find(e => e.kind === "embed");
      assert.ok(embed && embed.raw === "image" && embed.visible, `embed vanished at ${id}`);
      assert.ok(embedLadder.stops[id].text.includes("![[Diagrama.png]]"), `embed text missing at ${id}`);
    }
  });

  test("short code stays verbatim at Brief and Key, folds cleanly at Takeaway and Topic", () => {
    const md = "## Script\n\nRun once. Check output.\n\n```sh\necho one\necho two\n```\n";
    const ladder = foldDocumentLadder(md);
    assert.ok(ladder.stops.brief.text.includes("echo two"));
    assert.ok(ladder.stops.key.text.includes("echo two"));
    assert.ok(ladder.stops.takeaway.text.includes("`⋯ 2 lines of code`"));
    assert.ok(ladder.stops.topic.text.includes("`⋯ 2 lines of code`"));

    const unclosed = "## Unclosed\n\n```js\nconst a = 1;\nconst b = 2;";
    const unclosedLadder = foldDocumentLadder(unclosed);
    assert.deepEqual(unclosedLadder.units[1].rawMeta, { class: "code", lines: 2, language: "js" });
    assert.ok(unclosedLadder.stops.topic.text.includes("`⋯ 2 lines of code`"));
  });

  test("duplicate inline images in later sentences are all preserved monotonically", () => {
    const md = "First sentence only. Second sentence has ![x](x.png) and ![x](x.png).\n\nSecond paragraph without images. Extra detail.";
    const ladder = foldDocumentLadder(md);
    for (const { id } of LOCAL_LEVELS) {
      const count = ladder.stops[id].text.split("![x](x.png)").length - 1;
      assert.equal(count, 2, `expected 2 inline images at ${id}`);
    }
    assert.equal(isMonotonic(ladder.byUnit[0].stops), true);
  });
});

describe("monotonic guard (D4)", () => {
  test("enforceMonotonic passes monotonically non-increasing ladders unchanged", () => {
    const stops = {
      full: "Start IV furosemide 40 mg if diuretic-naive. Reassess urine output at 2 h. Escalate if poor response.",
      brief: "Start IV furosemide 40 mg if diuretic-naive. Reassess urine output at 2 h.",
      key: "Start IV furosemide 40 mg if diuretic-naive.",
      takeaway: "IV furosemide 40 mg if naive.",
      topic: "IV furosemide",
    };
    assert.equal(isMonotonic(stops), true);
    const result = enforceMonotonic(stops);
    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.stops, stops);
  });

  test("enforces Key <= Brief (TextFold regression) and cascades across Takeaway and Topic", () => {
    const stops = {
      brief: "Start IV furosemide 40 mg.",
      key: "Initiate intravenous loop diuretic therapy with furosemide at a starting dose of 40 mg when diuretic-naive.",
      takeaway: "Start intravenous furosemide 40 mg in patients not taking chronic diuretics.",
      topic: "Start IV furosemide 40 mg in diuretic-naive patients now.",
    };
    assert.equal(isMonotonic(stops), false);
    const result = enforceMonotonic(stops);
    assert.equal(result.ok, false);
    assert.deepEqual(result.violations.map(v => [v.stop, v.previous]), [
      ["key", "brief"],
      ["takeaway", "brief"],
      ["topic", "brief"],
    ]);
    assert.equal(result.stops.key, stops.brief);
    assert.equal(result.stops.takeaway, stops.brief);
    assert.equal(result.stops.topic, stops.brief);
    assert.equal(isMonotonic(result.stops), true);
  });

  test("enforces monotonic guard on FoldLine records without mutating inputs or breaking schema", () => {
    const ev = { elementId: "paragraph-ab12cd34", quote: "furosemide 40 mg", sentence: 0, start: 12, end: 28 };
    const input = {
      brief: { by: "author", text: "Start IV furosemide 40 mg." },
      key: { by: "model", text: "Begin intravenous furosemide at 40 mg for every patient without prior diuretic exposure.", evidence: [ev] },
      takeaway: { by: "model", text: "IV furosemide 40 mg.", evidence: [ev] },
      topic: { by: "model", text: "Initiate IV furosemide 40 mg right away.", evidence: [ev] },
    };
    const result = enforceMonotonic(input);
    assert.equal(result.ok, false);
    // Key exceeded Brief -> falls back to Brief's AuthorText.
    assert.deepEqual(result.stops.key, { by: "author", text: "Start IV furosemide 40 mg." });
    // Takeaway (4 words) <= clamped Key (5 words) -> stays WrittenText.
    assert.equal(result.stops.takeaway.by, "model");
    assert.equal(result.stops.takeaway.text, "IV furosemide 40 mg.");
    // Topic (7 words) > Takeaway (4 words) -> falls back to Takeaway's WrittenText with cloned evidence.
    assert.deepEqual(result.stops.topic, result.stops.takeaway);
    assert.notEqual(result.stops.topic.evidence, result.stops.takeaway.evidence);
    assert.notEqual(result.stops.topic.evidence[0], ev);
    for (const id of ["brief", "key", "takeaway", "topic"]) {
      assert.equal(isFoldLine(result.stops[id]), true, `${id} must remain a valid FoldLine`);
    }
    // Original input untouched.
    assert.equal(input.key.by, "model");
    assert.equal(isMonotonic(result.stops), true);
  });

  test("size ladder is monotonically non-increasing per unit and per document on all fixtures", () => {
    const order = LOCAL_LEVELS.map(entry => entry.id);
    for (const [name, md] of ALL_FIXTURES) {
      const ladder = foldDocumentLadder(md);
      // Per-unit monotonicity.
      for (const item of ladder.byUnit) {
        assert.equal(isMonotonic(item.stops), true, `${name} unit ${item.unit.elementId} not monotonic`);
        for (let i = 1; i < order.length; i++) {
          const prev = item.words[order[i - 1]];
          const curr = item.words[order[i]];
          assert.ok(curr <= prev, `${name} unit ${item.unit.elementId}: ${order[i]}(${curr}) > ${order[i - 1]}(${prev})`);
        }
      }
      // Whole-document monotonicity.
      const docCounts = order.map(id => ladder.stops[id].shown);
      for (let i = 1; i < docCounts.length; i++) {
        assert.ok(
          docCounts[i] <= docCounts[i - 1],
          `${name} doc: ${order[i]}(${docCounts[i]}) > ${order[i - 1]}(${docCounts[i - 1]})`,
        );
      }
    }
  });
});

describe("foldDocument and edge cases", () => {
  test("foldDocument accepts level ids and digits, rejects non-local stops", () => {
    assert.equal(foldDocument(FIXTURE_ADHF_EN, "full").text, FIXTURE_ADHF_EN);
    assert.equal(foldDocument(FIXTURE_ADHF_EN, 1).text, FIXTURE_ADHF_EN);
    assert.equal(foldDocument(FIXTURE_ADHF_EN, "key").text, foldDocument(FIXTURE_ADHF_EN, 3).text);
    assert.equal(foldDocument(FIXTURE_ADHF_EN, "topic").text, foldDocument(FIXTURE_ADHF_EN, 5).text);
    assert.throws(() => foldDocument(FIXTURE_ADHF_EN, "estudio"), RangeError);
    assert.throws(() => foldDocument(FIXTURE_ADHF_EN, "L3"), RangeError);
    assert.throws(() => foldDocument(FIXTURE_ADHF_EN, 6), RangeError);
  });

  test("callout folding preserves [!type] header line and folds body sentences", () => {
    const md = "> [!warning] Never do\n> First rule sentence. Second rule sentence. Third rule sentence.\n";
    const [unit] = extractUnits(md);
    assert.equal(unit.kind, "callout");
    assert.equal(foldUnit(unit, "brief"), "> [!warning] Never do\n> First rule sentence. Second rule sentence. …");
    assert.equal(foldUnit(unit, "key"), "> [!warning] Never do\n> First rule sentence. …");
  });

  test("document without headings treats Takeaway as Key instead of collapsing to Topic", () => {
    const ladder = foldDocumentLadder(FIXTURE_UNHEADED_ES);
    assert.equal(ladder.stops.takeaway.text, ladder.stops.key.text);
    assert.ok(ladder.stops.takeaway.text.includes("Segundo párrafo"));
    assert.ok(!ladder.stops.topic.text.includes("Segundo párrafo"));
  });

  test("local unit ladder stays fast on a 1k-word clinical document", () => {
    const section = i => [
      `## Sección ${i + 1}: Manejo hemodinámico`,
      "El Dr. García y la Sra. López evaluaron al paciente con 1,2 mg/kg/h. durante 6 h., p. ej. con furosemida y nitratos. Reevaluar diuresis y presión arterial cada 30 min. ¿Persiste congestión pulmonar? Ajustar dosis según respuesta clínica.",
      "",
      "| Fármaco | Dosis | Nota |",
      "| --- | --- | --- |",
      "| Furosemida | 40 mg | Inicial |",
      "| Nitroglicerina | 10 mcg/min | Si TAS >110 |",
    ].join("\n");
    const doc = Array.from({ length: 24 }, (_, i) => section(i)).join("\n\n");
    assert.ok(words(doc) >= 1000, `expected >= 1000 words, got ${words(doc)}`);
    // Warm up once, then verify single-pass ladder stays well under budget.
    foldDocumentLadder(doc);
    const start = performance.now();
    const ladder = foldDocumentLadder(doc);
    const elapsed = performance.now() - start;
    assert.equal(ladder.units.length, 72);
    assert.ok(elapsed < 150, `foldDocumentLadder took ${elapsed.toFixed(2)} ms`);
  });
});
