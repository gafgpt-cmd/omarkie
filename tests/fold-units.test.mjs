import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { FOLD_FORMAT, FOLD_VERSION, foldProblems, isFold, isFoldLine } from "../shared/fold-format.mjs";
import { LOCAL_LEVELS, words } from "../shared/fold-text.mjs";
import {
  enforceMonotonic, extractUnits, foldDocument, foldDocumentLadder, foldUnit,
  isMonotonic, rawClassOf, sha256, toFoldUnit, unitHash,
} from "../shared/fold-units.mjs";
import { createMarkdown } from "../shared/markdown.mjs";

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

  test("inline media inside lists, quotes, callouts, and html blocks survives every stop without code false positives", () => {
    const clinical = foldDocumentLadder(FIXTURE_CLINICAL_ES);
    for (const { id } of LOCAL_LEVELS) {
      const count = clinical.stops[id].text.split("![[eco-basal.png]]").length - 1;
      assert.equal(count, 1, `expected ![[eco-basal.png]] once at ${id}`);
    }

    const md = [
      "## Section",
      "",
      "Lead sentence keeps the section slot. Extra detail.",
      "",
      "- First item. Second sentence has ![ListImg](list.png) and `![Fake](fake.png)`.",
      "  - Child item with ![[child-embed.png]].",
      "",
      "> Quote first sentence. Quote second sentence with ![QuoteImg](quote.png).",
      "",
      "> [!warning] Alert",
      "> Callout first sentence. Callout second sentence with ![CalloutImg](callout.png).",
      "",
      "<figure><img src=\"scan.png\" alt=\"Basal scan\"><figcaption>Scan</figcaption></figure>",
    ].join("\n");
    const ladder = foldDocumentLadder(md);
    for (const { id } of LOCAL_LEVELS) {
      const out = ladder.stops[id].text;
      assert.equal(out.split("![ListImg](list.png)").length - 1, 1, `list image count at ${id}`);
      assert.equal(out.split("![[child-embed.png]]").length - 1, 1, `child embed count at ${id}`);
      assert.equal(out.split("![QuoteImg](quote.png)").length - 1, 1, `quote image count at ${id}`);
      assert.equal(out.split("![CalloutImg](callout.png)").length - 1, 1, `callout image count at ${id}`);
      assert.equal(out.split("<img src=\"scan.png\" alt=\"Basal scan\">").length - 1, 1, `html img count at ${id}`);
      if (id === "takeaway" || id === "topic") {
        assert.equal(out.includes("![Fake](fake.png)"), false, `inline-code media leaked at ${id}`);
      }
    }
  });

  test("nested raw blocks inside lists, quotes, and callouts survive without mangling or dropping", () => {
    const nested = foldDocumentLadder(FIXTURE_NESTED_EDGE);
    assert.ok(nested.stops.brief.text.includes("const hidden = 1;"));
    assert.ok(nested.stops.key.text.includes("const hidden = 1;"));
    assert.ok(nested.stops.topic.text.includes("`⋯ 2 lines of code`"));
    assert.ok(nested.stops.brief.text.includes("> | Quoted | Table |\n> | --- | --- |\n> | x | y |"));
    assert.ok(nested.stops.key.text.includes("> | Quoted | Table |\n> | --- | --- |\n> | x | y |"));
    assert.ok(nested.stops.topic.text.includes("> | Quoted | Table |\n> | --- | --- |"));
    assert.equal(nested.stops.topic.text.includes("> | x | y |"), false);

    const headed = [
      "## Protocol",
      "",
      "Lead clinical sentence. Secondary note.",
      "",
      "- Step one. Secondary detail.",
      "  ```js",
      "  const dose = 40;",
      "  const repeat = 2;",
      "  ```",
      "",
      "> [!note] Reference",
      "> Summary line one. Summary line two.",
      ">",
      "> | Drug | Dose |",
      "> | --- | --- |",
      "> | A | 1 mg |",
      "> | B | 2 mg |",
      ">",
      "> $$ E = mc^2 $$",
    ].join("\n");
    const ladder = foldDocumentLadder(headed);
    assert.ok(ladder.stops.brief.text.includes("const dose = 40;"));
    assert.ok(ladder.stops.key.text.includes("const dose = 40;"));
    assert.ok(ladder.stops.takeaway.text.includes("`⋯ 2 lines of code`"));
    assert.ok(ladder.stops.topic.text.includes("`⋯ 2 lines of code`"));

    for (const { id } of LOCAL_LEVELS) {
      assert.ok(ladder.stops[id].text.includes("$$ E = mc^2 $$"), `callout math missing at ${id}`);
      assert.ok(ladder.stops[id].text.includes("> | Drug | Dose |\n> | --- | --- |"), `callout table header missing at ${id}`);
    }
    assert.ok(ladder.stops.takeaway.text.includes("> | A | 1 mg |"));
    assert.equal(ladder.stops.takeaway.text.includes("> | B | 2 mg |"), false);
    assert.equal(ladder.stops.topic.text.includes("> | A | 1 mg |"), false);
  });

  test("multiline inline image in a paragraph is preserved once without duplication", () => {
    const md = "## Media\n\nSee ![Alt](img.png\n\"Title\") here. Second sentence.\n\nSecond paragraph without images.\n";
    const ladder = foldDocumentLadder(md);
    for (const id of ["brief", "key", "takeaway", "topic"]) {
      const normalized = ladder.stops[id].text.replace(/\s+/g, " ");
      const count = normalized.split("![Alt](img.png \"Title\")").length - 1;
      assert.equal(count, 1, `expected multiline image once at ${id}, got ${count}`);
    }
  });

  test("marker-line code, multiline math, and tables in lists and quotes do not swallow later items", () => {
    const listCode = [
      "- ```js",
      "  const fake = \"![Fake](fake.png)\";",
      "  ```",
      "- Next item. Extra detail with ![Real](real.png).",
    ].join("\n");
    const listCodeLadder = foldDocumentLadder(listCode);
    assert.equal(listCodeLadder.units[0].inlineMedia.map(m => m.markdown).includes("![Real](real.png)"), true);
    assert.equal(listCodeLadder.units[0].inlineMedia.some(m => m.markdown.includes("Fake")), false);
    assert.ok(listCodeLadder.stops.brief.text.includes("- Next item."));
    assert.ok(listCodeLadder.stops.key.text.includes("- Next item."));
    assert.ok(listCodeLadder.stops.topic.text.includes("`⋯ 1 lines of code`"));
    assert.ok(listCodeLadder.stops.topic.text.includes("![Real](real.png)"));
    assert.equal(listCodeLadder.stops.topic.text.includes("![Fake](fake.png)"), false);
    assert.equal(isMonotonic(listCodeLadder.byUnit[0].stops), true);

    const listMath = [
      "- $$",
      "  E = mc^2",
      "  $$",
      "- Next math item. Second sentence.",
    ].join("\n");
    const listMathLadder = foldDocumentLadder(listMath);
    for (const { id } of LOCAL_LEVELS) {
      assert.ok(listMathLadder.stops[id].text.includes("E = mc^2"), `math missing at ${id}`);
      assert.ok(listMathLadder.stops[id].text.includes("Next math item."), `next item missing at ${id}`);
    }
    assert.equal(isMonotonic(listMathLadder.byUnit[0].stops), true);

    const listTable = [
      "- | A | B |",
      "  | --- | --- |",
      "  | 1 | 2 |",
      "  | 3 | 4 |",
      "- Next table item. Second sentence.",
    ].join("\n");
    const listTableLadder = foldDocumentLadder(listTable);
    assert.ok(listTableLadder.stops.brief.text.includes("| 3 | 4 |"));
    assert.ok(listTableLadder.stops.brief.text.includes("- Next table item."));
    assert.ok(listTableLadder.stops.topic.text.includes("| A | B |"));
    assert.ok(listTableLadder.stops.topic.text.includes("Next table item."));
    assert.equal(listTableLadder.stops.topic.text.includes("| 3 | 4 |"), false);
    assert.equal(isMonotonic(listTableLadder.byUnit[0].stops), true);

    const quotedList = [
      "> - ```js",
      ">   const fake = \"![Fake](fake.png)\";",
      ">   ```",
      "> - Quoted item. Second sentence with ![Real](real.png).",
      "",
      "> [!note] Formula",
      "> - $$",
      ">   E = mc^2",
      ">   $$",
      "> - Callout item. Extra detail.",
    ].join("\n");
    const quotedLadder = foldDocumentLadder(quotedList);
    assert.equal(quotedLadder.units[0].inlineMedia.some(m => m.markdown.includes("Fake")), false);
    assert.equal(quotedLadder.units[0].inlineMedia.some(m => m.markdown === "![Real](real.png)"), true);
    assert.ok(quotedLadder.stops.brief.text.includes("Quoted item."));
    assert.ok(quotedLadder.stops.key.text.includes("Quoted item."));
    assert.ok(quotedLadder.stops.topic.text.includes("`⋯ 1 lines of code`"));
    assert.ok(quotedLadder.stops.topic.text.includes("![Real](real.png)"));
    assert.equal(quotedLadder.stops.topic.text.includes("![Fake](fake.png)"), false);
    assert.ok(quotedLadder.stops.brief.text.includes("Callout item."));
    assert.ok(quotedLadder.stops.topic.text.includes("E = mc^2"));
    for (const item of quotedLadder.byUnit) assert.equal(isMonotonic(item.stops), true);
  });

  test("quoted multiline markdown images and HTML img tags normalize cleanly without truncation or duplication", () => {
    const md = [
      "## Imaging",
      "",
      "> First sentence. Second has ![Scan](scan.png",
      "> \"Basal\") and <img src=\"scan.png\"",
      "> alt=\"Basal\">.",
      "",
      "> [!warning] Alert",
      "> Callout lead. Second has ![AlertScan](alert.png",
      "> \"Peak\") and <img src=\"alert.png\"",
      "> alt=\"Peak\">.",
    ].join("\n");
    const ladder = foldDocumentLadder(md);
    const quoteUnit = ladder.units.find(u => u.kind === "quote");
    const calloutUnit = ladder.units.find(u => u.kind === "callout");
    assert.deepEqual(
      quoteUnit.inlineMedia.map(m => m.markdown),
      ["![Scan](scan.png \"Basal\")", "<img src=\"scan.png\" alt=\"Basal\">"],
    );
    assert.deepEqual(
      calloutUnit.inlineMedia.map(m => m.markdown),
      ["![AlertScan](alert.png \"Peak\")", "<img src=\"alert.png\" alt=\"Peak\">"],
    );

    for (const id of ["brief", "key", "takeaway", "topic"]) {
      const out = ladder.stops[id].text;
      assert.equal(out.split("![Scan](scan.png \"Basal\")").length - 1, 1, `quote md image count at ${id}`);
      assert.equal(out.split("<img src=\"scan.png\" alt=\"Basal\">").length - 1, 1, `quote html img count at ${id}`);
      assert.equal(out.split("![AlertScan](alert.png \"Peak\")").length - 1, 1, `callout md image count at ${id}`);
      assert.equal(out.split("<img src=\"alert.png\" alt=\"Peak\">").length - 1, 1, `callout html img count at ${id}`);
      assert.equal(out.includes("<img src=\"scan.png\"\n>"), false, `truncated quote html img at ${id}`);
      assert.equal(out.includes("![Scan](scan.png\n>"), false, `broken quote md image at ${id}`);
      assert.equal(out.includes("![AlertScan](alert.png\n>"), false, `broken callout md image at ${id}`);
    }
    for (const item of ladder.byUnit) assert.equal(isMonotonic(item.stops), true);
  });

  test("marker-line fenced code in lists folds monotonically without clobbering stops back to full", () => {
    const cases = [
      [
        "- ```js",
        "  const x = 1;",
        "  ```",
        "- Administer IV furosemide 40 mg if diuretic-naive. Reassess urine output at 2 h.",
      ].join("\n"),
      [
        "- ```",
        "  ```",
        "- Administer IV furosemide 40 mg if diuretic-naive. Reassess urine output at 2 h.",
      ].join("\n"),
      [
        "10. ```js",
        "    const x = 1;",
        "    ```",
        "11. Administer IV furosemide 40 mg if diuretic-naive. Reassess urine output at 2 h.",
      ].join("\n"),
      [
        "> - ```js",
        ">   const x = 1;",
        ">   ```",
        "> - Administer IV furosemide 40 mg if diuretic-naive. Reassess urine output at 2 h. Monitor serum potassium closely.",
      ].join("\n"),
    ];

    for (const md of cases) {
      const ladder = foldDocumentLadder(md);
      assert.deepEqual(ladder.byUnit[0].violations, []);
      assert.equal(isMonotonic(ladder.byUnit[0].stops), true);
      if (ladder.units[0].kind === "quote") {
        // Blockquotes keep 2 sentences at Brief and 1 at Key.
        assert.equal(ladder.stops.brief.text.includes("Monitor serum potassium closely."), false);
      } else {
        assert.equal(ladder.stops.brief.text.includes("Reassess urine output at 2 h."), false);
      }
      assert.equal(ladder.stops.key.text.includes("Reassess urine output at 2 h."), false);
      assert.ok(ladder.stops.brief.text.includes("Administer IV furosemide 40 mg if diuretic-naive."));
      assert.ok(ladder.stops.topic.text.includes("Administer IV furosemide 40 mg if diuretic-naive."));
      assert.equal(ladder.stops.topic.text.includes("const x = 1;"), false);
      assert.match(ladder.stops.topic.text, /`⋯ \d+ lines of code`/);
    }
  });

  test("wide marker-line and nested raw blocks never turn into CommonMark indented code blocks", () => {
    const parser = createMarkdown();
    const cases = [
      {
        name: "2-digit ordered table",
        md: "10. | Drug | Dose |\n    | --- | --- |\n    | Lidocaine | 4.5 mg/kg |\n11. Reassess.",
        expectedToken: "table_open",
      },
      {
        name: "nested marker table",
        md: "- - | A | B |\n    | --- | --- |\n    | 1 | 2 |\n- Next.",
        expectedToken: "table_open",
      },
      {
        name: "indented bullet table",
        md: "  - | A | B |\n    | --- | --- |\n    | 1 | 2 |\n  - Next.",
        expectedToken: "table_open",
      },
      {
        name: "2-digit ordered math",
        md: "10. $$\n    E = mc^2\n    $$\n11. Reassess.",
        expectedToken: "math_block",
      },
      {
        name: "2-digit ordered fence",
        md: "10. ```js\n    const x = 1;\n    ```\n11. Reassess.",
        expectedToken: "fence",
      },
      {
        name: "indented child table past active content column",
        md: "- Outer item.\n  - - | A | B |\n      | --- | --- |\n      | 1 | 2 |",
        expectedToken: "table_open",
      },
      {
        name: "outdented raw block followed by wide marker raw block",
        md: "- Outer item.\n  - Inner item.\n    10. Deep item.\n- | A | B |\n  | --- | --- |\n  | 1 | 2 |\n- - - | C | D |\n      | --- | --- |\n      | 3 | 4 |",
        expectedToken: "table_open",
      },
    ];

    for (const { name, md, expectedToken } of cases) {
      const ladder = foldDocumentLadder(md);
      for (const stopId of ["brief", "key"]) {
        const tokens = parser.parse(ladder.stops[stopId].text, {});
        assert.equal(
          tokens.some(t => t.type === "code_block"),
          false,
          `${name} turned into indented code_block at ${stopId}:\n${ladder.stops[stopId].text}`,
        );
        assert.equal(
          tokens.some(t => t.type === expectedToken),
          true,
          `${name} missing ${expectedToken} at ${stopId}:\n${ladder.stops[stopId].text}`,
        );
      }
      for (const item of ladder.byUnit) assert.equal(isMonotonic(item.stops), true);
    }
  });

  test("HTML img tags with > inside single- or double-quoted attributes are preserved intact", () => {
    const md = [
      "## Biomarkers",
      "",
      "Lead clinical sentence. Extra detail.",
      "",
      "<figure><img src=\"bnp.png\" alt=\"BNP >100 pg/mL\"><figcaption>Threshold</figcaption></figure>",
      "",
      "<figure><img src='spo2.png' alt='SpO2 >=90%'><figcaption>Oxygen</figcaption></figure>",
      "",
      "> Quote lead. Second sentence has <img src=\"map.png\"",
      "> alt=\"MAP >65 mmHg\">.",
    ].join("\n");
    const ladder = foldDocumentLadder(md);
    for (const { id } of LOCAL_LEVELS) {
      const out = ladder.stops[id].text;
      assert.equal(out.split("<img src=\"bnp.png\" alt=\"BNP >100 pg/mL\">").length - 1, 1, `double-quoted > img at ${id}`);
      assert.equal(out.split("<img src='spo2.png' alt='SpO2 >=90%'>").length - 1, 1, `single-quoted > img at ${id}`);
      if (id !== "full") {
        assert.equal(out.split("<img src=\"map.png\" alt=\"MAP >65 mmHg\">").length - 1, 1, `quoted multiline > img at ${id}`);
      }
      assert.equal(out.includes("alt=\"BNP >\n"), false, `truncated double-quoted img at ${id}`);
      assert.equal(out.includes("alt='SpO2 >\n"), false, `truncated single-quoted img at ${id}`);
    }
    for (const item of ladder.byUnit) assert.equal(isMonotonic(item.stops), true);
  });

  test("tight nested blockquotes preserve tables, math, and fenced code and skip fake media inside code", () => {
    const md = [
      "## Dosing",
      "",
      "Lead clinical sentence occupies the first-in-section slot. Extra detail.",
      "",
      ">>| Drug | Dose |",
      ">>| --- | --- |",
      ">>| Lidocaine | 4.5 mg/kg |",
      ">>| Bupivacaine | 2 mg/kg |",
      "",
      ">>$$ E = mc^2 $$",
      "",
      ">>```js",
      ">>const fake = \"![Fake](fake.png)\";",
      ">>```",
      "",
      "- List item with nested tight quote code.",
      "  >>```js",
      "  >>const listFake = \"![ListFake](listfake.png)\";",
      "  >>```",
      "  - Child with ![Real](real.png).",
    ].join("\n");
    const ladder = foldDocumentLadder(md);
    for (const { id } of LOCAL_LEVELS) {
      const out = ladder.stops[id].text;
      assert.ok(out.includes("| Drug | Dose |"), `tight quote table header missing at ${id}`);
      assert.ok(out.includes("$$ E = mc^2 $$"), `tight quote math missing at ${id}`);
      assert.ok(out.includes("![Real](real.png)"), `real inline image missing at ${id}`);
    }
    assert.ok(ladder.stops.brief.text.includes("const fake ="));
    assert.ok(ladder.stops.brief.text.includes("const listFake ="));
    assert.ok(ladder.stops.key.text.includes("const fake ="));
    assert.ok(ladder.stops.key.text.includes("const listFake ="));
    assert.ok(ladder.stops.takeaway.text.includes("| Lidocaine | 4.5 mg/kg |"));
    assert.equal(ladder.stops.takeaway.text.includes("| Bupivacaine | 2 mg/kg |"), false);
    assert.equal(ladder.stops.topic.text.includes("| Lidocaine | 4.5 mg/kg |"), false);
    assert.equal(ladder.stops.takeaway.text.split("`⋯ 1 lines of code`").length - 1, 2);
    assert.equal(ladder.stops.topic.text.split("`⋯ 1 lines of code`").length - 1, 2);
    assert.equal(ladder.stops.topic.text.includes("![Fake](fake.png)"), false);
    assert.equal(ladder.stops.topic.text.includes("![ListFake](listfake.png)"), false);
    for (const item of ladder.byUnit) assert.equal(isMonotonic(item.stops), true);
  });

  test("quoted raw blocks inside lists survive at all stops without flattening or monotonic clobber", () => {
    const parser = createMarkdown();
    const listQuotedCode = [
      "- Check snippet:",
      "  > ```js",
      "  > const dose = 40;",
      "  > const interval = 8;",
      "  > ```",
      "- Administer IV furosemide 40 mg. Reassess urine output at 2 h.",
    ].join("\n");
    const codeLadder = foldDocumentLadder(listQuotedCode);
    assert.deepEqual(codeLadder.byUnit[0].violations, []);
    assert.equal(isMonotonic(codeLadder.byUnit[0].stops), true);
    assert.equal(codeLadder.stops.brief.text.includes("Reassess urine output at 2 h."), false);
    assert.equal(codeLadder.stops.key.text.includes("Reassess urine output at 2 h."), false);
    assert.ok(codeLadder.stops.brief.text.includes("> ```js"));
    assert.ok(codeLadder.stops.brief.text.includes("> const dose = 40;"));
    // Unheaded document treats Takeaway as Key (short code stays verbatim), while Topic folds it.
    assert.equal(codeLadder.stops.takeaway.text, codeLadder.stops.key.text);
    assert.ok(codeLadder.stops.topic.text.includes("> `⋯ 2 lines of code`"));
    assert.equal(codeLadder.stops.topic.text.includes("const dose = 40;"), false);
    const headedCodeLadder = foldDocumentLadder(`## Dosing\n\n${listQuotedCode}`);
    assert.deepEqual(headedCodeLadder.byUnit[1].violations, []);
    assert.ok(headedCodeLadder.stops.takeaway.text.includes("> `⋯ 2 lines of code`"));
    assert.ok(headedCodeLadder.stops.topic.text.includes("> `⋯ 2 lines of code`"));
    assert.equal(headedCodeLadder.stops.takeaway.text.includes("const dose = 40;"), false);
    for (const stopId of ["brief", "key"]) {
      const tokens = parser.parse(codeLadder.stops[stopId].text, {});
      assert.equal(tokens.some(t => t.type === "blockquote_open"), true);
      assert.equal(tokens.some(t => t.type === "fence"), true);
      assert.equal(tokens.some(t => t.type === "code_block"), false);
    }

    const listQuotedTableMath = [
      "## Dosing",
      "",
      "Lead clinical sentence keeps the section slot. Extra detail.",
      "",
      "- Reference table:",
      "  > | Drug | Dose |",
      "  > | --- | --- |",
      "  > | Lidocaine | 4.5 mg/kg |",
      "  > | Bupivacaine | 2 mg/kg |",
      "- Formula check:",
      "  > $$ E = mc^2 $$",
    ].join("\n");
    const tmLadder = foldDocumentLadder(listQuotedTableMath);
    for (const item of tmLadder.byUnit) {
      assert.deepEqual(item.violations, []);
      assert.equal(isMonotonic(item.stops), true);
    }
    for (const { id } of LOCAL_LEVELS) {
      assert.ok(tmLadder.stops[id].text.includes("| Drug | Dose |"), `list quoted table missing at ${id}`);
      assert.ok(tmLadder.stops[id].text.includes("$$ E = mc^2 $$"), `list quoted math missing at ${id}`);
    }
    assert.ok(tmLadder.stops.takeaway.text.includes("> | Lidocaine | 4.5 mg/kg |"));
    assert.equal(tmLadder.stops.takeaway.text.includes("Bupivacaine"), false);
    assert.equal(tmLadder.stops.topic.text.includes("Lidocaine"), false);

    const markerQuoted = [
      "- > ```js",
      "  > const fake = \"![Fake](fake.png)\";",
      "  > ```",
      "- > | A | B |",
      "  > | --- | --- |",
      "  > | 1 | 2 |",
      "  > | 3 | 4 |",
      "- > $$",
      "  > PaCO_2 = 1.5 \\times HCO_3^- + 8",
      "  > $$",
      "- Administer IV furosemide 40 mg. Reassess urine output with ![Real](real.png).",
    ].join("\n");
    const mqLadder = foldDocumentLadder(markerQuoted);
    assert.deepEqual(mqLadder.byUnit[0].violations, []);
    assert.equal(isMonotonic(mqLadder.byUnit[0].stops), true);
    assert.equal(mqLadder.units[0].inlineMedia.some(m => m.markdown.includes("Fake")), false);
    assert.equal(mqLadder.units[0].inlineMedia.some(m => m.markdown === "![Real](real.png)"), true);
    assert.equal(mqLadder.stops.brief.text.includes("Reassess urine output"), false);
    assert.ok(mqLadder.stops.brief.text.includes("Administer IV furosemide 40 mg."));
    assert.ok(mqLadder.stops.topic.text.includes("> `⋯ 1 lines of code`"));
    assert.ok(mqLadder.stops.topic.text.includes("> | A | B |"));
    assert.equal(mqLadder.stops.topic.text.includes("| 3 | 4 |"), false);
    assert.ok(mqLadder.stops.topic.text.includes("PaCO_2 = 1.5"));
    assert.ok(mqLadder.stops.topic.text.includes("![Real](real.png)"));
    assert.equal(mqLadder.stops.topic.text.includes("![Fake](fake.png)"), false);
    for (const stopId of ["brief", "key"]) {
      const tokens = parser.parse(mqLadder.stops[stopId].text, {});
      assert.equal(tokens.some(t => t.type === "fence"), true);
      assert.equal(tokens.some(t => t.type === "table_open"), true);
      assert.equal(tokens.some(t => t.type === "math_block"), true);
      assert.equal(tokens.some(t => t.type === "code_block"), false);
    }
  });

  test("quote and callout nested > - > raw blocks and unclosed inner quotes do not leak or swallow", () => {
    const quotedNestedCode = [
      "> - > ```js",
      ">   > const fake = \"![Fake](fake.png)\";",
      ">   > ```",
      "> - Administer IV furosemide 40 mg. Reassess urine output with ![Real](real.png).",
    ].join("\n");
    const codeLadder = foldDocumentLadder(quotedNestedCode);
    assert.deepEqual(codeLadder.byUnit[0].violations, []);
    assert.equal(isMonotonic(codeLadder.byUnit[0].stops), true);
    assert.equal(codeLadder.units[0].inlineMedia.some(m => m.markdown.includes("Fake")), false);
    assert.equal(codeLadder.units[0].inlineMedia.some(m => m.markdown === "![Real](real.png)"), true);
    assert.ok(codeLadder.stops.brief.text.includes("Administer IV furosemide 40 mg."));
    assert.ok(codeLadder.stops.topic.text.includes("Administer IV furosemide 40 mg."));
    assert.ok(codeLadder.stops.topic.text.includes("`⋯ 1 lines of code`"));
    assert.ok(codeLadder.stops.topic.text.includes("![Real](real.png)"));
    assert.equal(codeLadder.stops.topic.text.includes("![Fake](fake.png)"), false);
    assert.equal(codeLadder.stops.topic.text.includes("const fake"), false);

    const calloutNested = [
      "> [!note] Protocol",
      "> - > $$",
      ">   > E = mc^2",
      ">   > $$",
      "> - > | A | B |",
      ">   > | --- | --- |",
      ">   > | 1 | 2 |",
      ">   > | 3 | 4 |",
      "> - Callout follow-up sentence. Extra detail.",
    ].join("\n");
    const calloutLadder = foldDocumentLadder(calloutNested);
    assert.deepEqual(calloutLadder.byUnit[0].violations, []);
    assert.equal(isMonotonic(calloutLadder.byUnit[0].stops), true);
    assert.ok(calloutLadder.stops.topic.text.includes("E = mc^2"));
    assert.ok(calloutLadder.stops.topic.text.includes("> | A | B |"));
    assert.equal(calloutLadder.stops.topic.text.includes("| 3 | 4 |"), false);
    assert.ok(calloutLadder.stops.topic.text.includes("Callout follow-up sentence."));

    const rawOnlyNestedQuote = [
      "## Dosing",
      "",
      "> - > ```js",
      ">   > const x = 1;",
      ">   > ```",
      "",
      "Real clinical takeaway sentence. Extra detail.",
    ].join("\n");
    const slotLadder = foldDocumentLadder(rawOnlyNestedQuote);
    assert.ok(slotLadder.stops.takeaway.text.includes("Real clinical takeaway sentence."));
    assert.ok(slotLadder.stops.topic.text.includes("Real clinical takeaway sentence."));
    assert.ok(slotLadder.stops.topic.text.includes("`⋯ 1 lines of code`"));

    const unclosedInnerQuote = [
      "> > ```js",
      "> > const x = 1;",
      ">",
      "> Outside clinical sentence. Second sentence.",
    ].join("\n");
    const unclosedLadder = foldDocumentLadder(unclosedInnerQuote);
    assert.deepEqual(unclosedLadder.byUnit[0].violations, []);
    assert.equal(isMonotonic(unclosedLadder.byUnit[0].stops), true);
    assert.ok(unclosedLadder.stops.topic.text.includes("Outside clinical sentence."));
    assert.ok(unclosedLadder.stops.topic.text.includes("`⋯ 1 lines of code`"));
  });

  test("adjacent raw blocks in lists stay separated and tables stop before nested blockquote rows", () => {
    const parser = createMarkdown();
    const twoTablesInList = [
      "- First regimen:",
      "  | Drug | Dose |",
      "  | --- | --- |",
      "  | Lidocaine | 4.5 mg/kg |",
      "- Second regimen:",
      "  | Drug | Dose |",
      "  | --- | --- |",
      "  | Bupivacaine | 2 mg/kg |",
    ].join("\n");
    const twoLadder = foldDocumentLadder(twoTablesInList);
    for (const stopId of ["brief", "key", "takeaway", "topic"]) {
      const tokens = parser.parse(twoLadder.stops[stopId].text, {});
      assert.equal(
        tokens.filter(t => t.type === "table_open").length,
        2,
        `expected 2 distinct tables at ${stopId}:\n${twoLadder.stops[stopId].text}`,
      );
    }

    const consecutiveMarkerTables = [
      "- | A | B |",
      "  | --- | --- |",
      "  | 1 | 2 |",
      "- | C | D |",
      "  | --- | --- |",
      "  | 3 | 4 |",
    ].join("\n");
    const markerLadder = foldDocumentLadder(consecutiveMarkerTables);
    for (const stopId of ["brief", "key", "takeaway", "topic"]) {
      const tokens = parser.parse(markerLadder.stops[stopId].text, {});
      assert.equal(
        tokens.filter(t => t.type === "table_open").length,
        2,
        `expected 2 distinct marker tables at ${stopId}:\n${markerLadder.stops[stopId].text}`,
      );
    }

    const tableFollowedByQuotedTable = [
      "- | Drug | Dose |",
      "  | --- | --- |",
      "  | Lidocaine | 4.5 mg/kg |",
      "  > | Quoted | Table |",
      "  > | --- | --- |",
      "  > | Bupivacaine | 2 mg/kg |",
    ].join("\n");
    const listQuoteTableLadder = foldDocumentLadder(tableFollowedByQuotedTable);
    for (const stopId of ["brief", "key", "takeaway", "topic"]) {
      const out = listQuoteTableLadder.stops[stopId].text;
      assert.ok(out.includes("| Drug | Dose |"), `outer table missing at ${stopId}`);
      assert.ok(out.includes("| Quoted | Table |"), `quoted table swallowed at ${stopId}`);
      const tokens = parser.parse(out, {});
      assert.equal(tokens.filter(t => t.type === "table_open").length, 2, `expected 2 tables at ${stopId}:\n${out}`);
    }

    const outerQuoteFollowedByInnerQuoteTable = [
      "> | A | B |",
      "> | --- | --- |",
      "> | 1 | 2 |",
      "> > | C | D |",
      "> > | --- | --- |",
      "> > | 3 | 4 |",
    ].join("\n");
    const nestedQuoteTableLadder = foldDocumentLadder(outerQuoteFollowedByInnerQuoteTable);
    for (const stopId of ["brief", "key", "takeaway", "topic"]) {
      const out = nestedQuoteTableLadder.stops[stopId].text;
      assert.ok(out.includes("| A | B |"), `outer quoted table missing at ${stopId}`);
      assert.ok(out.includes("| C | D |"), `inner quoted table swallowed at ${stopId}`);
      const tokens = parser.parse(out, {});
      assert.equal(tokens.filter(t => t.type === "table_open").length, 2, `expected 2 quoted tables at ${stopId}:\n${out}`);
    }
  });

  test("unclosed short fences and multiline math blocks self-close at folded stops without swallowing content", () => {
    const parser = createMarkdown();
    const nestedQuoteTable = [
      "## Dosing",
      "",
      "> > ```js",
      "> > const x = 1;",
      ">",
      "> | Drug | Dose |",
      "> | --- | --- |",
      "> | Lidocaine | 4.5 mg/kg |",
      "> | Bupivacaine | 2 mg/kg |",
    ].join("\n");
    const quoteTableLadder = foldDocumentLadder(nestedQuoteTable);
    for (const item of quoteTableLadder.byUnit) {
      assert.deepEqual(item.violations, []);
      assert.equal(isMonotonic(item.stops), true);
    }
    for (const stopId of ["brief", "key"]) {
      const tokens = parser.parse(quoteTableLadder.stops[stopId].text, {});
      assert.equal(tokens.some(t => t.type === "fence"), true, `fence missing at ${stopId}`);
      assert.equal(tokens.some(t => t.type === "table_open"), true, `table swallowed at ${stopId}`);
    }
    assert.ok(quoteTableLadder.stops.takeaway.text.includes("`⋯ 1 lines of code`"));
    assert.ok(quoteTableLadder.stops.takeaway.text.includes("| Lidocaine | 4.5 mg/kg |"));
    assert.equal(quoteTableLadder.stops.takeaway.text.includes("Bupivacaine"), false);
    assert.ok(quoteTableLadder.stops.topic.text.includes("`⋯ 1 lines of code`"));
    assert.ok(quoteTableLadder.stops.topic.text.includes("| Drug | Dose |"));
    assert.equal(quoteTableLadder.stops.topic.text.includes("Lidocaine"), false);

    const quoteMediaAfterUnclosedFence = [
      "> Lead sentence. Second has ![Scan](scan.png).",
      ">",
      "> > ```js",
      "> > const x = 1;",
    ].join("\n");
    const quoteMediaLadder = foldDocumentLadder(quoteMediaAfterUnclosedFence);
    assert.deepEqual(quoteMediaLadder.byUnit[0].violations, []);
    for (const stopId of ["brief", "key", "takeaway", "topic"]) {
      const tokens = parser.parse(quoteMediaLadder.stops[stopId].text, {});
      const inlineTokens = tokens.filter(t => t.type === "inline").flatMap(t => t.children ?? []);
      assert.equal(
        inlineTokens.some(t => t.type === "image"),
        true,
        `inline image trapped inside unclosed fence at ${stopId}:\n${quoteMediaLadder.stops[stopId].text}`,
      );
    }

    const listMarkerUnclosedBeforeHeading = [
      "- ```js",
      "  const x = 1;",
      "",
      "## Next section",
      "",
      "Administer furosemide 40 mg IV.",
    ].join("\n");
    const nextSecLadder = foldDocumentLadder(listMarkerUnclosedBeforeHeading);
    for (const stopId of ["brief", "key"]) {
      const tokens = parser.parse(nextSecLadder.stops[stopId].text, {});
      assert.equal(tokens.some(t => t.type === "fence"), true, `fence missing at ${stopId}`);
      assert.equal(tokens.some(t => t.type === "heading_open"), true, `heading swallowed at ${stopId}`);
    }

    const unclosedMathBeforeTable = [
      "> > $$",
      "> > E = mc^2",
      ">",
      "> | Drug | Dose |",
      "> | --- | --- |",
      "> | A | 1 mg |",
    ].join("\n");
    const mathLadder = foldDocumentLadder(unclosedMathBeforeTable);
    for (const stopId of ["brief", "key", "takeaway", "topic"]) {
      const tokens = parser.parse(mathLadder.stops[stopId].text, {});
      assert.equal(tokens.some(t => t.type === "math_block"), true, `math_block missing at ${stopId}`);
      assert.equal(tokens.some(t => t.type === "table_open"), true, `table missing after unclosed math at ${stopId}`);
    }
  });

  test("fallback piped Obsidian embeds stay separated from trailing list tables", () => {
    const parser = createMarkdown();
    const md = [
      "- First regimen. Second sentence has ![[scan.png|Basal]].",
      "  | Drug | Dose |",
      "  | --- | --- |",
      "  | Lidocaine | 4.5 mg/kg |",
    ].join("\n");
    const ladder = foldDocumentLadder(md);
    for (const stopId of ["brief", "key", "takeaway", "topic"]) {
      const out = ladder.stops[stopId].text;
      assert.ok(out.includes("![[scan.png|Basal]]"), `embed missing at ${stopId}`);
      const tokens = parser.parse(out, {});
      assert.equal(tokens.filter(t => t.type === "table_open").length, 1, `table count at ${stopId}`);
      const inlineTokens = tokens.filter(t => t.type === "inline").flatMap(t => t.children ?? []);
      assert.equal(
        inlineTokens.some(t => t.type === "wiki_embed"),
        true,
        `embed swallowed into table row at ${stopId}:\n${out}`,
      );
    }
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

  test("enforceMonotonic and isMonotonic reject invalid FoldLine attribution or missing evidence", () => {
    const invalidLines = [
      { text: "missing by field" },
      { by: "assistant", text: "unknown attribution" },
      { by: "model", text: "missing evidence" },
      { by: "model", text: "empty evidence", evidence: [] },
      { by: "model", text: "malformed evidence", evidence: [{ elementId: "paragraph-ab12cd34" }] },
      { by: "author", text: "   " },
    ];
    for (const bad of invalidLines) {
      assert.throws(() => enforceMonotonic({ brief: bad }), TypeError);
      assert.throws(() => isMonotonic({ brief: bad }), TypeError);
      assert.throws(
        () => isMonotonic({ brief: "Short.", key: "Longer than brief here.", takeaway: bad }),
        TypeError,
      );
    }
  });

  test("whole-document shown stays monotonic and matches summed unit counts even with unclosed fences", () => {
    const md = [
      "## Section 1",
      "",
      "Lead clinical sentence here.",
      "",
      "<div>",
      "```",
      "unclosed fence inside html block",
      "</div>",
      "",
      "## Section 2",
      "",
      "Second section clinical guidance with several important words.",
    ].join("\n");
    const ladder = foldDocumentLadder(md);
    const order = LOCAL_LEVELS.map(entry => entry.id);
    assert.equal(ladder.total, ladder.stops.full.shown);
    for (const id of order) {
      const sum = ladder.stops[id].entries.reduce((acc, entry) => acc + entry.words, 0);
      assert.equal(ladder.stops[id].shown, sum, `shown must equal sum of entry words at ${id}`);
    }
    for (let i = 1; i < order.length; i++) {
      assert.ok(
        ladder.stops[order[i]].shown <= ladder.stops[order[i - 1]].shown,
        `${order[i]}(${ladder.stops[order[i]].shown}) > ${order[i - 1]}(${ladder.stops[order[i - 1]].shown})`,
      );
    }
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

    const unheadedWithRaw = [
      "First sentence. Second sentence.",
      "",
      "| Drug | Dose |",
      "| --- | --- |",
      "| A | 1 mg |",
      "| B | 2 mg |",
      "",
      "```sh",
      "echo one",
      "echo two",
      "```",
    ].join("\n");
    const rawLadder = foldDocumentLadder(unheadedWithRaw);
    assert.equal(rawLadder.stops.takeaway.text, rawLadder.stops.key.text);
    assert.ok(rawLadder.stops.takeaway.text.includes("| B | 2 mg |"));
    assert.ok(rawLadder.stops.takeaway.text.includes("echo two"));
  });

  test("standalone foldUnit defaults hasHeadings to true so takeaway applies section rules", () => {
    const [para, list] = extractUnits("First sentence. Second sentence.\n\n- Item one. Extra.\n- Item two.\n");
    assert.equal(foldUnit(para, "takeaway", { isFirstInSection: false }), "");
    assert.equal(foldUnit(list, "takeaway"), "Item one. …");
  });

  test("art paragraphs, HTML comments, and raw-only quotes do not steal the first-prose slot", () => {
    const artDoc = [
      "## Art section",
      "",
      "`+---+`  ",
      "`| A |`  ",
      "`+---+`",
      "",
      "Real clinical takeaway sentence. Extra detail.",
    ].join("\n");
    const artLadder = foldDocumentLadder(artDoc);
    assert.ok(artLadder.stops.takeaway.text.includes("Real clinical takeaway sentence."));
    assert.ok(artLadder.stops.topic.text.includes("Real clinical takeaway sentence."));

    const commentDoc = [
      "<!-- internal draft note -->",
      "",
      "## Clinical note",
      "",
      "<!-- section comment -->",
      "",
      "Administer furosemide 40 mg IV. Monitor urine output.",
    ].join("\n");
    const commentLadder = foldDocumentLadder(commentDoc);
    assert.equal(commentLadder.stops.takeaway.text.includes("<!--"), false);
    assert.equal(commentLadder.stops.topic.text.includes("<!--"), false);
    assert.ok(commentLadder.stops.takeaway.text.includes("Administer furosemide 40 mg IV."));
    assert.ok(commentLadder.stops.topic.text.includes("Administer furosemide 40 mg IV."));

    const rawQuoteDoc = [
      "## Dosing",
      "",
      "> | Drug | Dose |",
      "> | --- | --- |",
      "> | Lidocaine | 4.5 mg/kg |",
      "",
      "Check maximum safe dose before infiltration. Reassess after 15 min.",
    ].join("\n");
    const rawQuoteLadder = foldDocumentLadder(rawQuoteDoc);
    assert.ok(rawQuoteLadder.stops.takeaway.text.includes("Check maximum safe dose before infiltration."));
    assert.ok(rawQuoteLadder.stops.topic.text.includes("Check maximum safe dose before infiltration."));
    assert.ok(rawQuoteLadder.stops.topic.text.includes("> | Drug | Dose |"));
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
