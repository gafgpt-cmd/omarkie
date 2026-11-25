import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CHECK_CLASSES, FOLD_FORMAT, FOLD_VERSION, LEVELS, LEVEL_IDS, ROLES,
  evidenceFits, foldProblems, isAuthorText, isEvidence, isFold, isFoldLine, isLevelId, isRole, isWrittenText, levelOf,
} from "../shared/fold-format.mjs";

const unitText = "Intravenous furosemide 40 mg is the starting dose for a patient not on diuretics.";
const hash = "a".repeat(64);
const evidence = { elementId: "paragraph-ab12cd34", quote: "furosemide 40 mg", sentence: 0, start: 12, end: 28 };
const written = text => ({ by: "model", text, evidence: [{ ...evidence }] });

function ladder() {
  return {
    format: FOLD_FORMAT,
    version: FOLD_VERSION,
    meta: {
      slot: "ladder", route: "agent", agent: "opencode", model: "fixture-model",
      promptVersion: 1, schemaVersion: 1, outLang: "es", created: "2026-11-26T10:00:00Z",
    },
    units: [
      { elementId: "heading-11aa22bb", kind: "heading", line: 1, endLine: 1, hash, raw: null },
      { elementId: "paragraph-ab12cd34", kind: "paragraph", line: 3, endLine: 3, hash, raw: null },
      { elementId: "table-33cc44dd", kind: "table", line: 5, endLine: 9, hash, raw: "table" },
    ],
    written: [{
      elementId: "paragraph-ab12cd34", role: "dose",
      key: written("Start IV furosemide 40 mg if diuretic-naive; reassess at 2 h."),
      takeaway: written("Start IV furosemide 40 mg if diuretic-naive."),
      topic: written("IV furosemide"),
      checks: { negation: "pass", number: "pass", condition: "pass" },
    }],
    sections: [{ elementId: "heading-11aa22bb", takeaway: written("Decongest first."), topic: { by: "author", text: "Treatment" } }],
    estudio: null,
  };
}

test("LEVELS run Full to Estudio, digits 1-6, one entry per stop", () => {
  assert.deepEqual(LEVEL_IDS, ["full", "brief", "key", "takeaway", "topic", "estudio"]);
  assert.deepEqual(LEVELS.map(level => level.digit), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(LEVEL_IDS).size, LEVELS.length);
  assert.ok(Object.isFrozen(LEVELS) && LEVELS.every(Object.isFrozen));
  assert.throws(() => { LEVELS[0].id = "x"; }, TypeError);
});

test("Full and Brief hold the author's words; Key, Takeaway, Topic and Estudio are model stops", () => {
  assert.deepEqual(LEVELS.filter(level => level.words === "author").map(level => level.id), ["full", "brief"]);
  assert.deepEqual(LEVELS.filter(level => level.words === "model").map(level => level.id), ["key", "takeaway", "topic", "estudio"]);
});

test("every stop but Estudio has a local fold and sits in the shrinking size ladder", () => {
  assert.deepEqual(LEVELS.filter(level => level.local).map(level => level.id), ["full", "brief", "key", "takeaway", "topic"]);
  assert.deepEqual(LEVELS.filter(level => level.nested).map(level => level.id), ["full", "brief", "key", "takeaway", "topic"]);
  assert.equal(levelOf("full").slot, null);
  assert.deepEqual(LEVELS.filter(level => level.slot === "ladder").map(level => level.id), ["brief", "key", "takeaway", "topic"]);
  assert.equal(levelOf("estudio").slot, "estudio");
});

test("level ids are words, never L0-L5 (Reading Layers own those)", () => {
  for (const id of ["L0", "L3", "points", "gist", "", null, 3]) assert.equal(isLevelId(id), false, String(id));
  assert.equal(levelOf("L3"), null);
  assert.equal(levelOf("takeaway").digit, 4);
  assert.equal(isLevelId("estudio"), true);
});

test("roles are clinical and check classes cover the payload-loss list", () => {
  assert.equal(isRole("red_flag"), true);
  assert.equal(isRole("result"), false);
  assert.equal(ROLES.includes("context"), true);
  assert.deepEqual(CHECK_CLASSES, ["negation", "restriction", "condition", "uncertainty", "number", "scope", "attribution", "pins", "monotonic", "format"]);
});

test("author text and written text never mix: a model line needs evidence, an author line carries none", () => {
  assert.equal(isAuthorText({ by: "author", text: "Treatment" }), true);
  assert.equal(isWrittenText({ by: "author", text: "Treatment" }), false);
  assert.equal(isWrittenText(written("Start IV furosemide.")), true);
  assert.equal(isAuthorText(written("Start IV furosemide.")), false);
  assert.equal(isWrittenText({ by: "model", text: "Start IV furosemide.", evidence: [] }), false);
  assert.equal(isWrittenText({ by: "model", text: "Start IV furosemide." }), false);
  assert.equal(isAuthorText({ by: "author", text: "Treatment", evidence: [evidence] }), false);
  for (const value of [null, "text", { text: "x" }, { by: "ai", text: "x" }, { by: "author", text: "  " }]) assert.equal(isFoldLine(value), false, JSON.stringify(value));
});

test("evidence is an exact slice of the unit's text at its offsets", () => {
  assert.equal(isEvidence(evidence), true);
  assert.equal(evidenceFits(unitText, evidence), true);
  assert.equal(evidenceFits(unitText, { ...evidence, start: 11, end: 27 }), false);
  assert.equal(isEvidence({ ...evidence, end: 27 }), false);
  assert.equal(isEvidence({ ...evidence, start: 28, end: 28, quote: "" }), false);
  assert.equal(isEvidence({ ...evidence, sentence: -1 }), false);
  assert.equal(isEvidence({ ...evidence, sentence: 0.5 }), false);
  assert.equal(isEvidence({ ...evidence, elementId: "" }), false);
  assert.equal(isEvidence({ ...evidence, url: "https://example.test" }), false);
  const accented = "Sin dantroleno: nunca.";
  assert.equal(evidenceFits(accented, { elementId: "p", quote: "nunca", sentence: 0, start: 16, end: 21 }), true);
});

test("a valid ladder record passes with no problems", () => {
  assert.deepEqual(foldProblems(ladder()), []);
  assert.equal(isFold(ladder()), true);
  const payload = ladder();
  payload.meta.route = "payload";
  delete payload.meta.agent;
  assert.equal(isFold(payload), true);
});

test("an Estudio record holds the sheet and no ladder lines", () => {
  const estudio = { ...ladder(), written: [], sections: [], estudio: { oneLiner: [] } };
  estudio.meta = { ...estudio.meta, slot: "estudio", agent: "claude", model: "sonnet", outLang: "en" };
  assert.equal(isFold(estudio), true);
  assert.match(foldProblems({ ...estudio, written: ladder().written }).join("\n"), /no ladder lines/);
  assert.match(foldProblems({ ...ladder(), estudio: {} }).join("\n"), /no Estudio sheet/);
});

test("the guard names each broken field by path", () => {
  const cases = [
    [value => { value.format = "textfold/doc"; }, /fold\.format/],
    [value => { value.version = 0; }, /fold\.version/],
    [value => { value.meta.route = "openai"; }, /fold\.meta\.route/],
    [value => { delete value.meta.agent; }, /fold\.meta\.agent: an agent route names its agent/],
    [value => { value.meta.route = "payload"; }, /fold\.meta\.agent: only an agent route/],
    [value => { value.meta.outLang = "fr"; }, /fold\.meta\.outLang/],
    [value => { value.meta.created = "yesterday"; }, /fold\.meta\.created/],
    [value => { value.meta.created = "Nov 26 2026"; }, /fold\.meta\.created/],
    [value => { value.meta.created = "2026"; }, /fold\.meta\.created/],
    [value => { value.meta.promptVersion = 0; }, /fold\.meta\.promptVersion/],
    [value => { value.meta.prompt = "raw prompt"; }, /fold\.meta\.prompt: unknown field/],
    [value => { value.units[1].hash = "sha256:abc"; }, /fold\.units\[1\]\.hash/],
    [value => { value.units[1].kind = ""; }, /fold\.units\[1\]\.kind/],
    [value => { value.units[1].endLine = 2; }, /fold\.units\[1\]\.endLine/],
    [value => { value.units[2].raw = "svg"; }, /fold\.units\[2\]\.raw/],
    [value => { value.written[0].role = "result"; }, /fold\.written\[0\]\.role/],
    [value => { value.written[0].key.evidence = []; }, /fold\.written\[0\]\.key\.evidence: a model line needs evidence/],
    [value => { value.written[0].takeaway.evidence[0].end = 99; }, /fold\.written\[0\]\.takeaway\.evidence\[0\]\.quote: length/],
    [value => { value.written[0].checks.number = "ok"; }, /fold\.written\[0\]\.checks\.number/],
    [value => { value.written[0].checks.vibes = "pass"; }, /fold\.written\[0\]\.checks\.vibes: unknown field/],
    [value => { value.written[0].reply = "raw reply"; }, /fold\.written\[0\]\.reply: unknown field/],
    [value => { value.written[0].elementId = "paragraph-missing"; }, /paragraph-missing is not a unit/],
    [value => { value.sections[0].elementId = "paragraph-ab12cd34"; }, /not a heading unit/],
    [value => { value.units.push({ ...value.units[1] }); }, /duplicate unit paragraph-ab12cd34/],
    [value => { value.units = {}; }, /fold\.units: expected a list/],
    [value => { value.estudio = []; }, /fold\.estudio/],
  ];
  for (const [mutate, pattern] of cases) {
    const value = ladder();
    mutate(value);
    const problems = foldProblems(value);
    assert.match(problems.join("\n"), pattern, String(mutate));
    assert.equal(isFold(value), false);
  }
  for (const value of [null, [], "fold", 1]) assert.deepEqual(foldProblems(value), ["fold: expected an object"]);
});

test("a record survives a JSON round trip unchanged", () => {
  const value = ladder();
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  assert.equal(isFold(JSON.parse(JSON.stringify(value))), true);
});

test("TextFold attribution ships with the ported format", async () => {
  const file = name => readFile(new URL(`../third-party/textfold/${name}`, import.meta.url), "utf8");
  assert.match(await file("LICENSE"), /Apache License\s+Version 2\.0, January 2004/);
  const notice = await file("NOTICE");
  assert.match(notice, /Copyright 2026 Xia Chen/);
  assert.match(notice, /https:\/\/github\.com\/chenxiachan\/textfold/);
  const ported = await file("PORTED.md");
  assert.match(ported, /7dedb2d678df575b620c9b7c07a41d21520eab94/);
  assert.match(ported, /shared\/fold-format\.mjs/);
});
