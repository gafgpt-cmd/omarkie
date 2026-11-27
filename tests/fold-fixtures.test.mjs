import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  HOST_PATH_LEAK,
  TEXTFOLD_FORMAT,
  TEXTFOLD_LEVELS,
  TEXTFOLD_VERSION,
  TEXTFOLD_WRITTEN,
  checkFixtureRecording,
  loadManifest,
  parseArgs,
  recordAllFixtures,
  validateTextfoldDoc,
} from "../scripts/record-textfold-fixtures.mjs";

const execFileAsync = promisify(execFile);
const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/fold", import.meta.url));
const RECORDER_CLI = fileURLToPath(new URL("../scripts/record-textfold-fixtures.mjs", import.meta.url));

const normalizeSpace = text => text.replace(/\s+/g, " ").trim();
const countWords = text => text.trim().split(/\s+/).filter(Boolean).length;

function extractCardsSection(markdown) {
  const start = markdown.match(/^## (Tarjetas|Cards)\r?\n/m);
  if (!start || start.index === undefined) return null;
  const afterHeading = markdown.slice(start.index + start[0].length);
  const nextHeading = afterHeading.search(/^## /m);
  const body = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  const lines = body
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith("- "));
  return { heading: start[1], lines };
}

function stripNonFlowSections(markdown) {
  const kept = [];
  let skipping = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^## /.test(line)) {
      skipping = /^## (?:Tarjetas|Cards|Buzzword\b)/.test(line);
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

function extractMathSpans(markdown) {
  const spans = [];
  const blockStripped = markdown.replace(/\$\$([\s\S]*?)\$\$/g, (_, body) => {
    spans.push(body);
    return "";
  });
  for (const match of blockStripped.matchAll(/(?<!\\)\$([^\s$\n](?:[^$\n]*?[^\s$\n])?)\$/g)) {
    spans.push(match[1]);
  }
  return spans;
}

function hasMarkdownTable(markdown) {
  return /^\|.+\|\r?\n\|(?:\s*:?-{3,}:?\s*\|)+/m.test(markdown);
}

function maxProseParagraphLines(markdown) {
  let maxRun = 0;
  let run = 0;
  let inMath = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "$$") {
      inMath = !inMath;
      run = 0;
      continue;
    }
    if (inMath || !line || /^(?:#|\||- |\* |\d+\. |>|\$\$)/.test(line)) {
      run = 0;
      continue;
    }
    run += 1;
    if (run > maxRun) maxRun = run;
  }
  return maxRun;
}

test("manifest covers all 14 synthetic ES/EN fixtures and matches directories on disk", async () => {
  const manifest = await loadManifest(FIXTURES_DIR);
  assert.equal(manifest.format, "omarkie/fold-eval-manifest");
  assert.equal(manifest.version, 1);
  assert.equal(manifest.syntheticOnly, true);
  assert.equal(manifest.fixtures.length, 14);

  const numbers = manifest.fixtures.map(entry => entry.number);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(new Set(manifest.fixtures.map(entry => entry.id)).size, 14);

  const enCount = manifest.fixtures.filter(entry => entry.lang === "en").length;
  const esCount = manifest.fixtures.filter(entry => entry.lang === "es").length;
  assert.equal(enCount, 7);
  assert.equal(esCount, 7);

  const entries = await readdir(FIXTURES_DIR, { withFileTypes: true });
  const diskDirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const manifestIds = manifest.fixtures.map(entry => entry.id).sort();
  assert.deepEqual(diskDirs, manifestIds);
});

test("every fixture ships input.md, must-keep.json, expected-estudio.md and valid textfold.json grounded in source", async () => {
  const manifest = await loadManifest(FIXTURES_DIR);

  for (const entry of manifest.fixtures) {
    const dir = path.join(FIXTURES_DIR, entry.id);
    const [input, mustKeepRaw, estudio, textfoldRaw] = await Promise.all([
      readFile(path.join(dir, "input.md"), "utf8"),
      readFile(path.join(dir, "must-keep.json"), "utf8"),
      readFile(path.join(dir, "expected-estudio.md"), "utf8"),
      readFile(path.join(dir, "textfold.json"), "utf8"),
    ]);

    assert.ok(input.trim().length > 0, `${entry.id}: input.md must be non-empty`);
    assert.ok(estudio.trim().length > 0, `${entry.id}: expected-estudio.md must be non-empty`);

    // Must-keep oracle validation and source grounding.
    const mustKeep = JSON.parse(mustKeepRaw);
    assert.equal(mustKeep.id, entry.id, `${entry.id}: must-keep id mismatch`);
    assert.equal(mustKeep.number, entry.number, `${entry.id}: must-keep number mismatch`);
    assert.equal(mustKeep.lang, entry.lang, `${entry.id}: must-keep lang mismatch`);
    assert.equal(mustKeep.genre, entry.genre, `${entry.id}: must-keep genre mismatch`);
    assert.equal(mustKeep.synthetic, true, `${entry.id}: fixture must declare synthetic: true`);
    assert.ok(Array.isArray(mustKeep.numbers) && mustKeep.numbers.length >= 3, `${entry.id}: expected >=3 must-keep numbers`);
    assert.ok(Array.isArray(mustKeep.negations) && mustKeep.negations.length >= 3, `${entry.id}: expected >=3 must-keep negations`);
    assert.ok(Array.isArray(mustKeep.conditions) && mustKeep.conditions.length >= 2, `${entry.id}: expected >=2 must-keep conditions`);
    assert.ok(Array.isArray(mustKeep.highYield) && mustKeep.highYield.length >= 4, `${entry.id}: expected >=4 highYield facts`);
    assert.ok(Array.isArray(mustKeep.forbidden), `${entry.id}: forbidden must be an array`);

    const normalizedInput = normalizeSpace(input);
    for (const item of mustKeep.numbers) {
      assert.ok(item.value && item.unit && item.context && item.source, `${entry.id}: incomplete number entry`);
      assert.ok(normalizedInput.includes(normalizeSpace(item.source)), `${entry.id}: number source missing in input.md: ${item.source}`);
    }
    for (const item of mustKeep.negations) {
      assert.ok(item.token && item.phrase && item.rule, `${entry.id}: incomplete negation entry`);
      assert.ok(normalizedInput.includes(normalizeSpace(item.phrase)), `${entry.id}: negation phrase missing in input.md: ${item.phrase}`);
    }
    for (const item of mustKeep.conditions) {
      assert.ok(item.token && item.phrase && item.rule, `${entry.id}: incomplete condition entry`);
      assert.ok(normalizedInput.includes(normalizeSpace(item.phrase)), `${entry.id}: condition phrase missing in input.md: ${item.phrase}`);
    }
    for (const item of mustKeep.highYield) {
      assert.ok(item.fact && (item.stars === 1 || item.stars === 2), `${entry.id}: invalid highYield entry`);
    }

    // Expected Estudio sheet quality bar (fold-design.md §5.1 / §5.3).
    assert.ok(estudio.includes("★"), `${entry.id}: expected-estudio.md must mark high-yield facts with ★`);
    assert.ok(/==[^=\n]+==/.test(estudio), `${entry.id}: expected-estudio.md must highlight decisive values with ==...==`);
    assert.ok(maxProseParagraphLines(estudio) <= 2, `${entry.id}: expected-estudio.md must have no prose paragraph >2 lines`);
    assert.doesNotMatch(estudio, /\]\(|<a\b|<img\b|https?:\/\//i, `${entry.id}: expected-estudio.md must contain no links or HTML`);

    const cards = extractCardsSection(estudio);
    assert.ok(cards, `${entry.id}: expected-estudio.md must include ## Tarjetas or ## Cards`);
    assert.equal(cards.heading, entry.lang === "es" ? "Tarjetas" : "Cards", `${entry.id}: cards heading must match note language`);
    assert.ok(cards.lines.length >= 5 && cards.lines.length <= 10, `${entry.id}: expected 5-10 cards, got ${cards.lines.length}`);
    for (const cardLine of cards.lines) {
      assert.ok(cardLine.includes("→"), `${entry.id}: card must use Q → A format: ${cardLine}`);
    }

    if (mustKeep.structure.expectTable || mustKeep.structure.expectNumbersTable) {
      assert.equal(hasMarkdownTable(estudio), true, `${entry.id}: expected Markdown table in expected-estudio.md`);
    }
    if (mustKeep.structure.expectFlow) {
      assert.ok(stripNonFlowSections(estudio).includes("→"), `${entry.id}: expected → flow outside Cards/Buzzword sections in expected-estudio.md`);
    }
    if (mustKeep.structure.expectNever) {
      assert.ok(estudio.includes("⚠"), `${entry.id}: expected ⚠ never-do block in expected-estudio.md`);
    }
    if (mustKeep.structure.expectMnemonic) {
      assert.match(estudio, /Mnemonic|Mnemotecnia/i, `${entry.id}: expected labelled mnemonic in expected-estudio.md`);
    }
    for (const forbidden of mustKeep.forbidden) {
      assert.ok(!estudio.toLowerCase().includes(forbidden.toLowerCase()), `${entry.id}: forbidden string appeared in expected-estudio.md: ${forbidden}`);
    }

    for (const tex of extractMathSpans(estudio)) {
      assert.ok(!tex.includes("=="), `${entry.id}: highlight markers must not appear inside TeX math: ${tex}`);
    }

    // Recorded TextFold baseline validation.
    const textfold = JSON.parse(textfoldRaw);
    assert.deepEqual(validateTextfoldDoc(textfold), [], `${entry.id}: textfold.json validation failed`);
    assert.equal(textfold.format, TEXTFOLD_FORMAT);
    assert.equal(textfold.version, TEXTFOLD_VERSION);
    assert.deepEqual(textfold.levels, TEXTFOLD_LEVELS);
    assert.deepEqual(textfold.written, TEXTFOLD_WRITTEN);
    assert.equal(textfold.source.label, "input.md");
    assert.match(textfold.provenance.made_with, /^TextFold /);

    // No host path leaks across any committed fixture artifact.
    for (const [name, body] of [["input.md", input], ["must-keep.json", mustKeepRaw], ["expected-estudio.md", estudio], ["textfold.json", textfoldRaw]]) {
      assert.doesNotMatch(body, HOST_PATH_LEAK, `${entry.id}/${name} leaks a host user path`);
    }
  }
});

test("fixture-specific stress contracts hold (math, table-only D5 baseline, negation density, OCR, 10k perf, legal scope, injection)", async () => {
  // Fixture 6: display math blocks and highlighted formulas without == inside TeX.
  const f6 = await readFile(path.join(FIXTURES_DIR, "06-acid-base", "input.md"), "utf8");
  const f6Estudio = await readFile(path.join(FIXTURES_DIR, "06-acid-base", "expected-estudio.md"), "utf8");
  assert.ok((f6.match(/^\$\$$/gm) || []).length >= 6, "fixture 6 should include multiple display math blocks");
  const f6Math = extractMathSpans(f6Estudio);
  assert.ok(f6Math.length >= 4, "fixture 6 expected-estudio should include inline and display TeX formulas");
  for (const tex of f6Math) {
    assert.ok(!tex.includes("=="), `fixture 6 TeX math must not contain == highlight markers: ${tex}`);
  }

  // Fixture 9: table-only section exists in input.md and TextFold drops its units (D5 baseline).
  const f9Input = await readFile(path.join(FIXTURES_DIR, "09-anestesia-regional-dosis", "input.md"), "utf8");
  const f9MustKeep = JSON.parse(await readFile(path.join(FIXTURES_DIR, "09-anestesia-regional-dosis", "must-keep.json"), "utf8"));
  const f9Textfold = JSON.parse(await readFile(path.join(FIXTURES_DIR, "09-anestesia-regional-dosis", "textfold.json"), "utf8"));
  assert.deepEqual(f9MustKeep.structure.tableOnlySections, ["Dosis máximas recomendadas"]);
  assert.match(f9Input, /## Dosis máximas recomendadas\r?\n\r?\n\|/);
  const tableOnlySection = f9Textfold.sections.find(section => section.title === "Dosis máximas recomendadas");
  assert.ok(tableOnlySection, "fixture 9 textfold.json must include the table-only section heading");
  assert.equal(tableOnlySection.units.length, 0, "TextFold baseline drops table-only section units (D5 motivation)");

  // Fixture 10: negation/condition torture density.
  const f10MustKeep = JSON.parse(await readFile(path.join(FIXTURES_DIR, "10-sepsis-negation-torture", "must-keep.json"), "utf8"));
  assert.ok(f10MustKeep.negations.length >= 8, "fixture 10 must stress dense negation rules");
  assert.ok(f10MustKeep.conditions.length >= 6, "fixture 10 must stress dense condition/restriction rules");

  // Fixture 11: OCR pipe-soup input rebuilt into a clean table in expected-estudio.md.
  const f11Input = await readFile(path.join(FIXTURES_DIR, "11-ocr-messy-chapter", "input.md"), "utf8");
  const f11Estudio = await readFile(path.join(FIXTURES_DIR, "11-ocr-messy-chapter", "expected-estudio.md"), "utf8");
  assert.equal(hasMarkdownTable(f11Input), false, "fixture 11 input should be pipe-soup without valid GFM separator");
  assert.ok(f11Input.includes(" | "), "fixture 11 input should contain pipe-soup rows");
  assert.equal(hasMarkdownTable(f11Estudio), true, "fixture 11 expected-estudio must rebuild a valid Markdown table");

  // Fixture 12: 10k-word chapter.
  const f12Input = await readFile(path.join(FIXTURES_DIR, "12-physiology-chapter-10k", "input.md"), "utf8");
  const f12Textfold = JSON.parse(await readFile(path.join(FIXTURES_DIR, "12-physiology-chapter-10k", "textfold.json"), "utf8"));
  assert.ok(countWords(f12Input) >= 10_000, `fixture 12 should be >=10,000 words, got ${countWords(f12Input)}`);
  assert.ok(f12Textfold.sections.length >= 10, "fixture 12 should span >=10 sections for chunking stress");

  // Fixture 13: non-medical legal scope.
  const f13MustKeep = JSON.parse(await readFile(path.join(FIXTURES_DIR, "13-contrato-arrendamiento", "must-keep.json"), "utf8"));
  assert.equal(f13MustKeep.genre, "legal");

  // Fixture 14: prompt injection present in input, absent in expected-estudio.md.
  const f14Input = await readFile(path.join(FIXTURES_DIR, "14-prompt-injection", "input.md"), "utf8");
  const f14MustKeep = JSON.parse(await readFile(path.join(FIXTURES_DIR, "14-prompt-injection", "must-keep.json"), "utf8"));
  assert.ok(f14MustKeep.forbidden.length >= 5, "fixture 14 must list forbidden injection strings");
  assert.match(f14Input, /Ignore previous instructions/i);
  assert.ok(f14Input.includes("https://evil.example/exfil"));
});

test("recorder --check passes on the committed golden eval set", async () => {
  const results = await recordAllFixtures({ fixturesDir: FIXTURES_DIR, check: true });
  assert.equal(results.length, 14);
  for (const item of results) {
    assert.equal(item.ok, true, `${item.id}: ${item.problems.join("; ")}`);
  }

  const { stdout } = await execFileAsync(process.execPath, [RECORDER_CLI, "--fixtures-dir", FIXTURES_DIR, "--check"]);
  assert.match(stdout, /OK 01-adhf-ward-guide/);
  assert.match(stdout, /OK 14-prompt-injection/);
});

test("recorder CLI records local/model runs atomically, enforces isolation, and rejects invalid output", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "omarkie-fold-recorder-test-"));
  try {
    const tempFixtures = path.join(scratch, "fixtures");
    await mkdir(path.join(tempFixtures, "01-sample"), { recursive: true });
    await writeFile(
      path.join(tempFixtures, "manifest.json"),
      JSON.stringify({
        format: "omarkie/fold-eval-manifest",
        version: 1,
        syntheticOnly: true,
        fixtures: [{ number: 1, id: "01-sample", lang: "en", genre: "clinical", title: "Sample", stresses: ["unit"] }],
      }),
      "utf8",
    );
    await writeFile(path.join(tempFixtures, "01-sample", "input.md"), "# Sample\n\n## Intro\n\nFirst sentence. Second sentence.\n", "utf8");

    const stubLog = path.join(scratch, "stub-invocations.jsonl");
    const stubPython = path.join(scratch, "stub-python.mjs");
    await writeFile(
      stubPython,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const mode = process.env.STUB_BEHAVIOR || "ok";
appendFileSync(${JSON.stringify(stubLog)}, JSON.stringify({
  args,
  noModels: process.env.TEXTFOLD_NO_MODELS ?? null,
  hasDataDir: Boolean(process.env.TEXTFOLD_DATA),
  inputBase: path.basename(args[3] || ""),
}) + "\\n");

if (mode === "invalid-json") {
  process.stdout.write("{not valid json");
  process.exit(0);
}
const doc = {
  format: "textfold/doc",
  version: 0,
  id: "md-sample-12345678",
  lang: "en",
  title: "Sample",
  authors: [],
  date: "",
  source: {
    kind: "markdown",
    url: mode === "path-leak" ? "/home/alice/secret/input.md" : "",
    snapshot: "",
    label: path.basename(args[3] || "input.md"),
    license: "",
  },
  levels: ["topic", "takeaway", "key", "brief", "full"],
  written: ["topic", "takeaway", "key"],
  provenance: {
    made_with: "TextFold 0.10.57",
    exported: "2026-11-27T00:00:00Z",
    ai_generated: !args.includes("--no-generate"),
    model: args.includes("--no-generate") ? "" : "stub-model",
    levels_made: args.includes("--no-generate") ? "" : "2026-11-27T00:00:00",
    local: args.includes("--no-generate"),
  },
  sections: [{
    id: "sec-intro",
    num: "",
    title: "Intro",
    depth: 1,
    takeaway: "",
    topic: "",
    units: [{
      id: "p-11112222",
      kind: "paragraph",
      role: "context",
      full: "First sentence. Second sentence.",
      sentences: ["First sentence.", "Second sentence."],
      brief: ["First sentence."],
      evidence: [0],
      key: "First sentence.",
      takeaway: "First sentence",
      topic: "First sentence",
    }],
  }],
  links: [],
};
process.stdout.write(JSON.stringify(doc));
`,
      "utf8",
    );
    await chmod(stubPython, 0o755);

    // 1. Missing recording fails --check with numeric counts.
    const missingCheck = await checkFixtureRecording(path.join(tempFixtures, "01-sample"));
    assert.equal(missingCheck.ok, false);
    assert.equal(missingCheck.sections, 0);
    assert.equal(missingCheck.units, 0);

    // 2. Dry run does not invoke Python or write textfold.json.
    const dryRun = await execFileAsync(process.execPath, [RECORDER_CLI, "--fixtures-dir", tempFixtures, "--fixture", "01", "--dry-run"]);
    assert.match(dryRun.stdout, /dry-run 01-sample/);

    // 3. Record in local mode: sets TEXTFOLD_NO_MODELS=1, --no-generate, isolated TEXTFOLD_DATA, stages input.md.
    const localRun = await execFileAsync(process.execPath, [
      RECORDER_CLI, "--fixtures-dir", tempFixtures, "--python", stubPython, "--mode", "local",
    ]);
    assert.match(localRun.stdout, /recorded 01-sample: 1 sections, 1 units/);
    const localJson = JSON.parse(await readFile(path.join(tempFixtures, "01-sample", "textfold.json"), "utf8"));
    assert.equal(localJson.provenance.local, true);
    assert.equal(localJson.provenance.ai_generated, false);
    assert.equal(localJson.source.label, "input.md");

    // 4. Record in model mode: omits --no-generate and unsets TEXTFOLD_NO_MODELS.
    await execFileAsync(process.execPath, [
      RECORDER_CLI, "--fixtures-dir", tempFixtures, "--python", stubPython, "--mode", "model",
    ], { env: { ...process.env, TEXTFOLD_NO_MODELS: "1" } });
    const modelJson = JSON.parse(await readFile(path.join(tempFixtures, "01-sample", "textfold.json"), "utf8"));
    assert.equal(modelJson.provenance.local, false);
    assert.equal(modelJson.provenance.ai_generated, true);
    assert.equal(modelJson.provenance.model, "stub-model");

    // 5. Invalid JSON or host path leak fails non-zero and preserves the prior valid textfold.json atomically.
    const before = await readFile(path.join(tempFixtures, "01-sample", "textfold.json"), "utf8");
    for (const badMode of ["invalid-json", "path-leak"]) {
      await assert.rejects(
        execFileAsync(process.execPath, [
          RECORDER_CLI, "--fixtures-dir", tempFixtures, "--python", stubPython, "--mode", "local",
        ], { env: { ...process.env, STUB_BEHAVIOR: badMode } }),
      );
      assert.equal(await readFile(path.join(tempFixtures, "01-sample", "textfold.json"), "utf8"), before);
    }

    const invocations = (await readFile(stubLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(invocations.length, 4);
    assert.equal(invocations[0].noModels, "1");
    assert.equal(invocations[0].hasDataDir, true);
    assert.equal(invocations[0].inputBase, "input.md");
    assert.ok(invocations[0].args.includes("--no-generate"));
    assert.equal(invocations[1].noModels, null);
    assert.ok(!invocations[1].args.includes("--no-generate"));

    // 6. --check fails non-zero when a recorded file is corrupted, invalid JSON, or JSON null, always reporting numeric counts.
    for (const badPayload of [JSON.stringify({ format: "wrong" }), "{broken json", "null"]) {
      await writeFile(path.join(tempFixtures, "01-sample", "textfold.json"), badPayload, "utf8");
      const checked = await checkFixtureRecording(path.join(tempFixtures, "01-sample"));
      assert.equal(checked.ok, false);
      assert.equal(checked.sections, 0);
      assert.equal(checked.units, 0);
      await assert.rejects(
        execFileAsync(process.execPath, [RECORDER_CLI, "--fixtures-dir", tempFixtures, "--check"]),
        error => {
          assert.match(error.stdout, /FAIL 01-sample \(0 sections, 0 units\)/);
          assert.ok(!error.stdout.includes("undefined"));
          return true;
        },
      );
    }

    // 7. Partial/unmatched fixture selector fails instead of being silently ignored.
    await assert.rejects(
      execFileAsync(process.execPath, [RECORDER_CLI, "--fixtures-dir", tempFixtures, "--fixture", "01,99", "--dry-run"]),
      error => /Unknown fixture selector\(s\): 99/.test(error.stderr),
    );
    await assert.rejects(
      recordAllFixtures({ fixturesDir: tempFixtures, fixtures: ["01", "02-typo"], check: true }),
      /Unknown fixture selector\(s\): 02-typo/,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("validateTextfoldDoc and parseArgs reject malformed inputs with specific reasons", () => {
  assert.match(validateTextfoldDoc(null).join("\n"), /expected a JSON object/);
  const makeValidDoc = () => ({
    format: TEXTFOLD_FORMAT,
    version: TEXTFOLD_VERSION,
    id: "md-x",
    lang: "en",
    title: "X",
    authors: [],
    date: "",
    source: { kind: "markdown", url: "", snapshot: "", label: "input.md", license: "" },
    levels: [...TEXTFOLD_LEVELS],
    written: [...TEXTFOLD_WRITTEN],
    provenance: { made_with: "TextFold 0.10.57", exported: "2026-11-27T00:00:00Z", ai_generated: false, model: "", levels_made: "", local: true },
    sections: [{
      id: "s1", num: "", title: "S1", depth: 1, takeaway: "", topic: "",
      units: [{
        id: "p1", kind: "paragraph", role: "context",
        full: "One.", sentences: ["One."], brief: ["One."], evidence: [0],
        key: "One.", takeaway: "One", topic: "One",
      }],
    }],
    links: [],
  });
  assert.deepEqual(validateTextfoldDoc(makeValidDoc()), []);

  const badBrief = makeValidDoc();
  badBrief.sections[0].units[0].brief = ["Wrong."];
  assert.match(validateTextfoldDoc(badBrief).join("\n"), /brief: must match sentences indexed by evidence/);

  const commaLevels = makeValidDoc();
  commaLevels.levels = ["topic,takeaway", "key", "brief", "full"];
  commaLevels.written = ["topic,takeaway", "key"];
  const commaProblems = validateTextfoldDoc(commaLevels).join("\n");
  assert.match(commaProblems, /doc\.levels/);
  assert.match(commaProblems, /doc\.written/);

  for (const badDate of ["2026-99-99T99:99:99Z", "2026-02-30T00:00:00Z", "2026-11-27T00:00:00+25:00"]) {
    const badExport = makeValidDoc();
    badExport.provenance.exported = badDate;
    assert.match(validateTextfoldDoc(badExport).join("\n"), /doc\.provenance\.exported/);
  }

  for (const leakUrl of ["file:///home/alice/input.md", "file:///Users/alice/input.md", "file:///C:/Users/alice/input.md"]) {
    const leaky = makeValidDoc();
    leaky.source.url = leakUrl;
    assert.match(validateTextfoldDoc(leaky).join("\n"), /host-specific user path/);
  }

  const parsed = parseArgs(["--fixture", "01,02", "--fixture", "14-prompt-injection", "--mode", "model", "--check"]);
  assert.deepEqual(parsed.fixtures, ["01", "02", "14-prompt-injection"]);
  assert.equal(parsed.mode, "model");
  assert.equal(parsed.check, true);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--timeout-ms", "0"]), /Invalid --timeout-ms/);
  assert.throws(() => parseArgs(["--timeout-ms", "0.5"]), /Invalid --timeout-ms/);
  assert.throws(() => parseArgs(["--timeout-ms", "1.5"]), /Invalid --timeout-ms/);
  assert.throws(() => parseArgs(["--mode", "bogus", "--dry-run"]), /Invalid mode/);
  assert.throws(() => parseArgs(["--mode", "bogus", "--check"]), /Invalid mode/);
  assert.throws(() => parseArgs(["--fixture", ","]), /Invalid --fixture/);
});
