// Deterministic Markdown fold tests: upstream TextFold suite plus ES/EN sentence cutting and accounting.
// Adapted from TextFold (Apache-2.0, Xia Chen) `plugins/pi-textfold/tests/fold.test.ts` at 7dedb2d.
// Changed: ported from vitest to `node:test`, added ES/EN sentence-cut, Omarkie local level id,
// frontmatter, and ellipsis accounting coverage. See third-party/textfold/PORTED.md.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  LOCAL_LEVELS, MIN_HIDDEN, MIN_WORDS,
  blocks, firstSentence, fold, sentences, words, worthFolding,
} from "../shared/fold-text.mjs";

const REPLY = `The bug was in the cache key, and it is fixed. Two requests for the same paper shared one key.

## What changed
The key now includes the language. That makes each translation its own entry. Old entries stay valid.

- Updated \`store.key()\` to take a language. It falls back to English.
- Added a test for two languages.

\`\`\`python
def key(pid, lang="en"):
    return f"{pid}:{lang}"
\`\`\`

## What to check
Run the tests once. They take about a minute, e.g. on a laptop.`;

describe("sentences (upstream)", () => {
  test("a first sentence ends at a stop and a space, never inside code or after an abbreviation", () => {
    assert.equal(firstSentence("It works. Then more.").head, "It works.");
    assert.equal(firstSentence("Use e.g. this one. Next.").head, "Use e.g. this one.");
    assert.equal(firstSentence("Call `a.b()` first. Then go.").head, "Call `a.b()` first.");
    assert.equal(firstSentence("Version 3.5 is out. Upgrade.").head, "Version 3.5 is out.");
    assert.equal(firstSentence("**It is fixed.** The rest.").head, "**It is fixed.**");
    assert.equal(firstSentence("One sentence only").more, false);
  });

  test("a Chinese stop ends a sentence without a space", () => {
    assert.equal(
      firstSentence("缓存键有问题，已经修好。同一篇论文的两次请求共用了一个键。").head,
      "缓存键有问题，已经修好。",
    );
  });
});

describe("folding (upstream)", () => {
  test("the blocks of a reply", () => {
    assert.deepEqual(
      blocks(REPLY).map(b => b.kind),
      ["para", "heading", "para", "list", "code", "heading", "para"],
    );
  });

  test("Full is the reply as written", () => {
    assert.equal(fold(REPLY, 1).text, REPLY);
  });

  test("Brief keeps two sentences a paragraph and short code", () => {
    const t = fold(REPLY, 2).text;
    assert.ok(t.includes("The key now includes the language. That makes each translation its own entry. …"));
    assert.ok(!t.includes("Old entries stay valid."));
    assert.ok(t.includes('def key(pid, lang="en"):'));
  });

  test("Points keeps one sentence a paragraph and item, and short code", () => {
    const t = fold(REPLY, 3).text;
    assert.ok(t.includes("The bug was in the cache key, and it is fixed. …"));
    assert.ok(t.includes("- Updated `store.key()` to take a language. …"));
    assert.ok(t.includes('def key(pid, lang="en"):'));
  });

  test("Outline keeps the headings and the first sentence under each", () => {
    const t = fold(REPLY, 4).text;
    assert.equal(
      t,
      "The bug was in the cache key, and it is fixed. …\n\n## What changed\n\nThe key now includes the language. …\n\n## What to check\n\nRun the tests once. …",
    );
  });

  test("Gist is the reply's first sentence", () => {
    assert.equal(fold(REPLY, 5).text, "The bug was in the cache key, and it is fixed. …");
  });

  test("a table straight after a paragraph is its own block", () => {
    const md = "The options compare like this.\n| Option | Cost |\n| --- | --- |\n| A | free |\n| B | 5/mo |";
    assert.deepEqual(blocks(md).map(b => b.kind), ["para", "table"]);
  });

  test("a table without leading pipes is a table, not a paragraph joined into one line", () => {
    const md = "Option | Cost\n:-- | --:\nA | free\nB | 5/mo";
    assert.deepEqual(blocks(md), [{ kind: "table", lines: md.split("\n") }]);
    assert.deepEqual(blocks("A heading\n---").map(b => b.kind), ["para"]);
  });

  test("each level shows fewer words", () => {
    const counts = [1, 2, 3, 4, 5].map(n => fold(REPLY, n).shown);
    for (let i = 1; i < counts.length; i++) assert.ok(counts[i] < counts[i - 1], `level ${i + 1} should shrink`);
    assert.equal(words("缓存键 cache key"), 5);
  });

  test("Outline of a reply without headings is Points, not Gist", () => {
    const unheaded = [
      "The first paragraph states its point. It adds a detail or two.",
      "The second paragraph has a point of its own. It also explains it.",
      "The third paragraph closes the reply. Nothing else follows it.",
    ].join("\n\n");
    assert.equal(fold(unheaded, 4).text, fold(unheaded, 3).text);
    assert.ok(fold(unheaded, 4).text.includes("The second paragraph has a point of its own. …"));
    assert.equal(fold(unheaded, 5).text, "The first paragraph states its point. …");
  });
});

describe("tables and code (upstream)", () => {
  const table = ["| Option | Cost |", "| --- | --- |", ...Array.from({ length: 10 }, (_, i) => `| ${i} | ${i}/mo |`)].join("\n");
  const md = `The options compare like this. The cheapest is not the best.\n\n${table}\n\nPick the second one. It is the best value.`;

  test("a table is whole at Brief and Points, and gone at Gist", () => {
    assert.ok(fold(md, 2).text.includes(table));
    assert.ok(fold(md, 3).text.includes(table));
    // no headings: Outline reads as Points, so the table is still part of the skeleton
    assert.equal(fold(md, 4).text, fold(md, 3).text);
    assert.ok(!fold(md, 5).text.includes("| Option"));
  });

  test("code over Brief's 6 lines folds to its line at Brief and Points", () => {
    const code = ["```sh", ...Array.from({ length: 10 }, (_, i) => `echo ${i}`), "```"].join("\n");
    const long = `Run this to see it. It prints ten lines.\n\n${code}`;
    assert.ok(fold(long, 2).text.includes("`⋯ 10 lines of code`"));
    assert.ok(fold(long, 3).text.includes("`⋯ 10 lines of code`"));
    assert.ok(!fold(long, 3).text.includes("echo 9"));
  });
});

describe("the gate (upstream)", () => {
  const long = Array.from({ length: 12 }, (_, i) => `Sentence ${i} has a few words in it.`).join(" ");

  test("a reply under 80 words is never folded", () => {
    assert.equal(MIN_WORDS, 80);
    assert.equal(MIN_HIDDEN, 0.25);
    assert.equal(worthFolding(REPLY, fold(REPLY, 5).text), false);
  });

  test("a long reply is folded when the fold hides a quarter of it or more", () => {
    assert.equal(worthFolding(long, fold(long, 3).text), true);
    assert.equal(worthFolding(long, long.slice(0, Math.round(long.length * 0.8))), false);
  });

  test("Chinese counts by reading effort, not by character", () => {
    assert.equal(worthFolding("缓".repeat(140), "缓"), true);
    assert.equal(worthFolding("缓".repeat(120), "缓"), false);
  });
});

describe("drawings (upstream)", () => {
  const art = [
    "`┌────┐    ┌──────────┐    ┌────────┐`  ",
    "`│ Pi ├───▶│ TextFold ├───▶│ Screen │`  ",
    "`└────┘    └──────────┘    └────────┘`",
  ].join("\n");
  const md = `The reply goes through three steps. Each one changes it.\n\n${art}\n\nThe fold is the second step. It runs after the drawing.`;

  test("a drawing is one block, kept row by row at Brief and Points, and gone at Gist", () => {
    assert.deepEqual(blocks(md).map(b => b.kind), ["para", "art", "para"]);
    assert.ok(fold(md, 2).text.includes(art));
    assert.ok(fold(md, 3).text.includes(art));
    assert.equal(fold(md, 4).text, fold(md, 3).text);
    assert.ok(!fold(md, 5).text.includes("TextFold ├"));
  });

  test("a paragraph of one code span is still a paragraph", () => {
    assert.deepEqual(blocks("`npm test`").map(b => b.kind), ["para"]);
  });
});

describe("ES and EN sentence cut", () => {
  test("Spanish abbreviations (Dr., Sra., aprox., p. ej., Dra., Prof., Núm., Pág.) never split mid-sentence", () => {
    assert.deepEqual(
      firstSentence("El Dr. García y la Sra. López evaluaron al paciente. Luego indicaron reposo."),
      { head: "El Dr. García y la Sra. López evaluaron al paciente.", more: true, rest: "Luego indicaron reposo." },
    );
    assert.deepEqual(
      firstSentence("La dosis es aprox. 40 mg, p. ej. en pacientes sin diurético previo. Reevaluar a las 2 h."),
      { head: "La dosis es aprox. 40 mg, p. ej. en pacientes sin diurético previo.", more: true, rest: "Reevaluar a las 2 h." },
    );
    assert.equal(
      firstSentence("La Dra. Ruiz citó la Pág. 12 y el Núm. 4 del protocolo. Confirmar antes del alta.").head,
      "La Dra. Ruiz citó la Pág. 12 y el Núm. 4 del protocolo.",
    );
    assert.equal(
      firstSentence("Ver p.ej. la tabla de dosis. Siguiente paso.").head,
      "Ver p.ej. la tabla de dosis.",
    );
  });

  test("English abbreviations (Prof., St., Mrs., Fig., Eq., No. 5, et al.) stay intact without swallowing real words", () => {
    assert.equal(
      firstSentence("Prof. Smith at St. Jude Hospital cited Fig. 2 and No. 5. Then he stopped.").head,
      "Prof. Smith at St. Jude Hospital cited Fig. 2 and No. 5.",
    );
    assert.equal(
      firstSentence("As shown by García et al. in 2024, perfusion matters. Check lactate.").head,
      "As shown by García et al. in 2024, perfusion matters.",
    );
    // Real words ("no.", "art.", "mar.") end sentences when not followed by a reference number.
    assert.deepEqual(
      firstSentence("La respuesta es no. Evaluar la perfusión."),
      { head: "La respuesta es no.", more: true, rest: "Evaluar la perfusión." },
    );
    assert.deepEqual(
      firstSentence("The answer is no. Check perfusion."),
      { head: "The answer is no.", more: true, rest: "Check perfusion." },
    );
    assert.equal(firstSentence("Ver Art. 14 del contrato. Firmar abajo.").head, "Ver Art. 14 del contrato.");
    assert.equal(firstSentence("She studies art. Next term begins soon.").head, "She studies art.");
  });

  test("Spanish inverted punctuation ¿¡ and guillemets «» cut cleanly without breaking inside spans", () => {
    assert.deepEqual(
      firstSentence("¿Cuándo iniciar furosemida? Dentro de la primera hora."),
      { head: "¿Cuándo iniciar furosemida?", more: true, rest: "Dentro de la primera hora." },
    );
    assert.deepEqual(
      firstSentence("¡Nunca administrar fluidos si hay congestión! Evaluar el perfil primero."),
      { head: "¡Nunca administrar fluidos si hay congestión!", more: true, rest: "Evaluar el perfil primero." },
    );
    assert.deepEqual(
      firstSentence("¿Fiebre?¿Disnea?"),
      { head: "¿Fiebre?", more: true, rest: "¿Disnea?" },
    );
    assert.deepEqual(
      firstSentence("¿Administrar 40 mg. o esperar? Decidir en la primera hora."),
      { head: "¿Administrar 40 mg. o esperar?", more: true, rest: "Decidir en la primera hora." },
    );
    assert.deepEqual(
      firstSentence("«Sin dantroleno, nunca inducir.» Revisar el carro de parada."),
      { head: "«Sin dantroleno, nunca inducir.»", more: true, rest: "Revisar el carro de parada." },
    );
    assert.deepEqual(
      firstSentence("En un paciente congestivo, ¿se deben dar líquidos? No. Reevaluar."),
      { head: "En un paciente congestivo, ¿se deben dar líquidos?", more: true, rest: "No. Reevaluar." },
    );
    assert.deepEqual(
      firstSentence("Tomar A, B, etc. ¿Qué sigue?"),
      { head: "Tomar A, B, etc.", more: true, rest: "¿Qué sigue?" },
    );
  });

  test("decimals (1,2 and 3.5) and units stay intact mid-sentence while still cutting at sentence end", () => {
    assert.deepEqual(
      firstSentence("Infusión de 1,2 mg/kg/h. durante 6 h. Vigilar FC."),
      { head: "Infusión de 1,2 mg/kg/h. durante 6 h.", more: true, rest: "Vigilar FC." },
    );
    assert.deepEqual(
      firstSentence("Administrar 40 mg. cada 8 h. Reevaluar en 2 h."),
      { head: "Administrar 40 mg. cada 8 h.", more: true, rest: "Reevaluar en 2 h." },
    );
    assert.deepEqual(
      firstSentence("Start IV furosemide 40 mg. Reassess at 2 h."),
      { head: "Start IV furosemide 40 mg.", more: true, rest: "Reassess at 2 h." },
    );
    assert.deepEqual(
      firstSentence("Esperar 20 min. antes de repetir la dosis. Registrar TA."),
      { head: "Esperar 20 min. antes de repetir la dosis.", more: true, rest: "Registrar TA." },
    );
    assert.deepEqual(
      firstSentence("Dosis inicial de 2,5 mg/kg i.v. en bolo lento. Repetir si persiste."),
      { head: "Dosis inicial de 2,5 mg/kg i.v. en bolo lento.", more: true, rest: "Repetir si persiste." },
    );
    assert.deepEqual(
      firstSentence("Administrar 40 mg i.v. Repetir a las 6 h."),
      { head: "Administrar 40 mg i.v.", more: true, rest: "Repetir a las 6 h." },
    );
    assert.deepEqual(
      firstSentence("Tomar 1,2 g. al día. Controlar en 7 d."),
      { head: "Tomar 1,2 g. al día.", more: true, rest: "Controlar en 7 d." },
    );
  });

  test("multi-backtick inline code spans, bold balancing, and mid-sentence ellipsis do not split early", () => {
    assert.deepEqual(
      firstSentence("Run ``a ` b. c`` first. Then check."),
      { head: "Run ``a ` b. c`` first.", more: true, rest: "Then check." },
    );
    assert.deepEqual(
      firstSentence("**First sentence. Second sentence.**"),
      { head: "**First sentence.**", more: true, rest: "Second sentence.**" },
    );
    assert.deepEqual(
      firstSentence("Call `**a` first. Next."),
      { head: "Call `**a` first.", more: true, rest: "Next." },
    );
    assert.deepEqual(
      firstSentence("Esperar... y luego reevaluar. Registrar el cambio."),
      { head: "Esperar... y luego reevaluar.", more: true, rest: "Registrar el cambio." },
    );
  });

  test("sentences() returns up to n sentences with accurate more flag", () => {
    const text = "Primera frase. Segunda frase. Tercera frase.";
    assert.deepEqual(sentences(text, 2), { text: "Primera frase. Segunda frase.", more: true });
    assert.deepEqual(sentences(text, 3), { text: "Primera frase. Segunda frase. Tercera frase.", more: false });
  });
});

describe("Omarkie levels, Unicode words, frontmatter, and … more accounting", () => {
  test("LOCAL_LEVELS exposes the five local Omarkie stops and fold() accepts level ids", () => {
    assert.deepEqual(LOCAL_LEVELS.map(entry => entry.id), ["full", "brief", "key", "takeaway", "topic"]);
    assert.equal(fold(REPLY, "full").text, fold(REPLY, 1).text);
    assert.equal(fold(REPLY, "brief").text, fold(REPLY, 2).text);
    assert.equal(fold(REPLY, "key").text, fold(REPLY, 3).text);
    assert.equal(fold(REPLY, "takeaway").text, fold(REPLY, 4).text);
    assert.equal(fold(REPLY, "topic").text, fold(REPLY, 5).text);
    assert.throws(() => fold(REPLY, "estudio"), RangeError);
    assert.throws(() => fold(REPLY, "L3"), RangeError);
    assert.throws(() => fold(REPLY, 6), RangeError);
  });

  test("words() keeps Spanish accents, decimals 1,2, and compound units as single tokens", () => {
    assert.equal(words("diagnóstico hipertensión niño único"), 4);
    assert.equal(words("Administrar 1,2 mg/kg en 20 min"), 6);
    assert.equal(words("BNP >100 pg/mL y 3.5 mmol/L"), 6);
  });

  test("synthetic code-fold markers do not inflate shown word count above total", () => {
    const code = ["```sh", ...Array.from({ length: 10 }, (_, i) => `echo ${i}`), "```"].join("\n");
    const md = `Run this command.\n\n${code}`;
    const folded = fold(md, "brief");
    assert.ok(folded.text.includes("`⋯ 10 lines of code`"));
    assert.equal(folded.total, 3);
    assert.equal(folded.shown, 3);
  });

  test("YAML frontmatter is skipped below Full so Topic never surfaces metadata keys", () => {
    const md = [
      "---",
      "title: ADHF ward guide",
      "tags:",
      "  - cardiology",
      "---",
      "",
      "## Definition",
      "ADHF is rapid congestion or hypoperfusion at rest. Reassess within 1 h.",
    ].join("\n");
    assert.equal(blocks(md)[0].kind, "frontmatter");
    assert.equal(fold(md, "full").text, md);
    assert.equal(fold(md, "topic").text, "ADHF is rapid congestion or hypoperfusion at rest. …");
    assert.ok(!fold(md, "brief").text.includes("title: ADHF"));
  });

  test("ellipsis marks dropped paragraphs and sub-items accurately at Takeaway, Key, and Topic", () => {
    const md = [
      "## Tratamiento",
      "Iniciar furosemida 40 mg i.v.",
      "",
      "Añadir tiazida si mala respuesta a las 6 h.",
      "",
      "## Seguimiento",
      "Solo una frase final.",
    ].join("\n");
    assert.equal(
      fold(md, "takeaway").text,
      "## Tratamiento\n\nIniciar furosemida 40 mg i.v. …\n\n## Seguimiento\n\nSolo una frase final.",
    );
    assert.equal(fold(md, "topic").text, "Iniciar furosemida 40 mg i.v. …");
    assert.equal(fold("Una sola frase.", "topic").text, "Una sola frase.");

    const nested = "- Primer punto.\n  - Subpunto oculto.\n- Segundo punto.";
    assert.equal(fold(nested, "key").text, "- Primer punto. …\n- Segundo punto.");
  });
});
