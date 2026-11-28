// Fold format `omarkie/fold` v1: the stops, whose words a line holds, and guards for stored fold records.
// Adapted from TextFold (Apache-2.0, Xia Chen) `textfold/ladder.py` and `docs/format.md` at 7dedb2d.
// Changed: six stops with Estudio, clinical roles, per-line evidence with element ids and offsets, check results,
// slot and route of each record; levels ordered as the slider reads (Full first). See third-party/textfold/PORTED.md.

import { languages } from "./languages.mjs";

export const FOLD_FORMAT = "omarkie/fold";
export const FOLD_VERSION = 1;

// Slider order. `words`: whose words the stop shows once a model wrote it. `local`: the deterministic fold fills it.
// `nested`: in the size ladder, never longer than the stop before it. `slot`: the model slot that writes it.
const level = (id, digit, words, local, nested, slot) => Object.freeze({ id, digit, words, local, nested, slot });
export const LEVELS = Object.freeze([
  level("full", 1, "author", true, true, null),
  level("brief", 2, "author", true, true, "ladder"),
  level("key", 3, "model", true, true, "ladder"),
  level("takeaway", 4, "model", true, true, "ladder"),
  level("topic", 5, "model", true, true, "ladder"),
  level("estudio", 6, "model", false, false, "estudio"),
]);
export const LEVEL_IDS = Object.freeze(LEVELS.map(entry => entry.id));

export const ROLES = Object.freeze([
  "definition", "mechanism", "presentation", "diagnosis", "treatment", "dose", "monitoring", "pitfall", "red_flag", "prognosis", "context",
]);
export const CHECK_CLASSES = Object.freeze([
  "negation", "restriction", "condition", "uncertainty", "number", "scope", "attribution", "pins", "monotonic", "format",
]);
export const RAW_CLASSES = Object.freeze(["table", "code", "math", "image"]);
export const SLOTS = Object.freeze(["ladder", "estudio"]);
export const ROUTES = Object.freeze(["agent", "payload"]);
export const AGENTS = Object.freeze(["claude", "codex", "opencode"]);

const languageCodes = new Set(languages.map(([code]) => code));
const hashPattern = /^[0-9a-f]{64}$/;
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = value => typeof value === "string" && value.trim().length > 0;
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isLanguage = value => typeof value === "string" && languageCodes.has(value);
const oneOf = list => value => list.includes(value);

export const isLevelId = oneOf(LEVEL_IDS);
export const isRole = oneOf(ROLES);
export const levelOf = id => LEVELS.find(entry => entry.id === id) ?? null;

// Each check collects problems as "path: reason"; an empty list means valid.
function keys(value, path, allowed, problems) {
  if (!isObject(value)) return problems.push(`${path}: expected an object`), false;
  for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${path}.${key}: unknown field`);
  return true;
}
const need = (ok, path, reason, problems) => ok || problems.push(`${path}: ${reason}`);

function evidenceProblems(value, path, problems) {
  if (!keys(value, path, ["elementId", "quote", "sentence", "start", "end"], problems)) return;
  need(isText(value.elementId), `${path}.elementId`, "expected an element id", problems);
  need(isText(value.quote), `${path}.quote`, "expected the quoted source words", problems);
  need(isCount(value.sentence), `${path}.sentence`, "expected a sentence index", problems);
  need(isCount(value.start), `${path}.start`, "expected an offset", problems);
  need(isCount(value.end) && value.end > value.start, `${path}.end`, "expected an offset after start", problems);
  if (typeof value.quote === "string" && isCount(value.start) && isCount(value.end)) {
    need(value.end - value.start === value.quote.length, `${path}.quote`, "length must equal end - start", problems);
  }
}

function lineProblems(value, path, problems) {
  if (!isObject(value)) return problems.push(`${path}: expected a line`);
  if (value.by === "author") {
    if (keys(value, path, ["by", "text"], problems)) need(isText(value.text), `${path}.text`, "expected text", problems);
    return;
  }
  if (value.by !== "model") return problems.push(`${path}.by: expected "author" or "model"`);
  if (!keys(value, path, ["by", "text", "evidence"], problems)) return;
  need(isText(value.text), `${path}.text`, "expected text", problems);
  if (!Array.isArray(value.evidence) || !value.evidence.length) return problems.push(`${path}.evidence: a model line needs evidence`);
  value.evidence.forEach((entry, index) => evidenceProblems(entry, `${path}.evidence[${index}]`, problems));
}

function unitProblems(value, path, problems) {
  if (!keys(value, path, ["elementId", "kind", "line", "endLine", "hash", "raw"], problems)) return;
  need(isText(value.elementId), `${path}.elementId`, "expected an element id", problems);
  need(isText(value.kind), `${path}.kind`, "expected an element kind", problems);
  need(Number.isSafeInteger(value.line) && value.line >= 1, `${path}.line`, "expected a line number", problems);
  need(Number.isSafeInteger(value.endLine) && value.endLine >= value.line, `${path}.endLine`, "expected a line at or after line", problems);
  need(typeof value.hash === "string" && hashPattern.test(value.hash), `${path}.hash`, "expected a sha256 hex digest", problems);
  need(value.raw === null || RAW_CLASSES.includes(value.raw), `${path}.raw`, "expected a raw-block class or null", problems);
}

function checksProblems(value, path, problems) {
  if (!keys(value, path, CHECK_CLASSES, problems)) return;
  for (const [name, result] of Object.entries(value)) need(result === "pass" || result === "fail", `${path}.${name}`, `expected "pass" or "fail"`, problems);
}

function writtenProblems(value, path, problems) {
  if (!keys(value, path, ["elementId", "role", "key", "takeaway", "topic", "checks"], problems)) return;
  need(isText(value.elementId), `${path}.elementId`, "expected an element id", problems);
  need(isRole(value.role), `${path}.role`, "expected a role", problems);
  for (const stop of ["key", "takeaway", "topic"]) lineProblems(value[stop], `${path}.${stop}`, problems);
  checksProblems(value.checks, `${path}.checks`, problems);
}

function sectionProblems(value, path, problems) {
  if (!keys(value, path, ["elementId", "takeaway", "topic"], problems)) return;
  need(isText(value.elementId), `${path}.elementId`, "expected a heading element id", problems);
  for (const stop of ["takeaway", "topic"]) lineProblems(value[stop], `${path}.${stop}`, problems);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function metaProblems(value, path, problems) {
  if (!keys(value, path, ["slot", "route", "agent", "model", "promptVersion", "schemaVersion", "outLang", "created"], problems)) return;
  need(SLOTS.includes(value.slot), `${path}.slot`, "expected a slot", problems);
  need(ROUTES.includes(value.route), `${path}.route`, "expected a route", problems);
  if (value.route === "agent") need(AGENTS.includes(value.agent), `${path}.agent`, "an agent route names its agent", problems);
  else need(value.agent === undefined, `${path}.agent`, "only an agent route names an agent", problems);
  need(isText(value.model), `${path}.model`, "expected a model", problems);
  need(Number.isSafeInteger(value.promptVersion) && value.promptVersion >= 1, `${path}.promptVersion`, "expected a version", problems);
  need(Number.isSafeInteger(value.schemaVersion) && value.schemaVersion >= 1, `${path}.schemaVersion`, "expected a version", problems);
  need(isLanguage(value.outLang), `${path}.outLang`, "expected a supported language", problems);
  need(typeof value.created === "string" && ISO_DATE.test(value.created) && !Number.isNaN(Date.parse(value.created)), `${path}.created`, "expected an ISO date", problems);
}

const listed = (value, path, check, problems) => Array.isArray(value)
  ? value.forEach((entry, index) => check(entry, `${path}[${index}]`, problems))
  : problems.push(`${path}: expected a list`);

// A fold record: `fold.json` and each `chunks/<key>.json` share this shape; a chunk holds a subset of units.
export function foldProblems(value) {
  const problems = [];
  if (!keys(value, "fold", ["format", "version", "meta", "units", "written", "sections", "estudio"], problems)) return problems;
  need(value.format === FOLD_FORMAT, "fold.format", `expected "${FOLD_FORMAT}"`, problems);
  need(value.version === FOLD_VERSION, "fold.version", `expected ${FOLD_VERSION}`, problems);
  metaProblems(value.meta, "fold.meta", problems);
  listed(value.units, "fold.units", unitProblems, problems);
  listed(value.written, "fold.written", writtenProblems, problems);
  listed(value.sections, "fold.sections", sectionProblems, problems);
  if (value.meta?.slot === "estudio") problems.push(...estudioProblems(value.estudio, "fold.estudio"));
  else need(value.estudio === null || isObject(value.estudio), "fold.estudio", "expected an object or null", problems);
  if (problems.length) return problems;
  const units = new Map();
  for (const unit of value.units) {
    need(!units.has(unit.elementId), "fold.units", `duplicate unit ${unit.elementId}`, problems);
    units.set(unit.elementId, unit);
  }
  for (const entry of value.written) need(units.has(entry.elementId), "fold.written", `${entry.elementId} is not a unit`, problems);
  for (const entry of value.sections) need(units.get(entry.elementId)?.kind === "heading", "fold.sections", `${entry.elementId} is not a heading unit`, problems);
  if (value.meta.slot === "ladder") need(value.estudio === null, "fold.estudio", "a ladder record holds no Estudio sheet", problems);
  else need(!value.written.length && !value.sections.length, "fold.written", "an Estudio record holds no ladder lines", problems);
  return problems;
}

// --- Estudio sheet `omarkie/fold-estudio` v1 (design §5.1-5.2) ---

export const ESTUDIO_FORMAT = "omarkie/fold-estudio";
export const ESTUDIO_VERSION = 1;
// Blocks in reading order; each holds a list. `oneLiner` is the one item that may be null.
export const ESTUDIO_BLOCKS = Object.freeze(["caso", "vs", "numeros", "flujo", "bloques", "nunca", "buzzwords", "mnemonics", "cards", "gaps"]);
export const BLOQUE_KINDS = Object.freeze(["mechanism", "dx", "tx", "monitoring", "pitfall", "prognosis"]);
export const ESTUDIO_LIMITS = Object.freeze({
  oneLinerWords: 25, lineWords: 30, vs: 3, vsRows: 7, vsColumns: 5, numeros: 10, flujo: 2, flujoNodes: 10,
  bloques: 6, bullets: 6, nunca: 8, buzzwords: 6, mnemonics: 2, cards: 10, caso: 6, gaps: 10,
});

const TYPE_OK = Object.freeze({
  object: isObject,
  array: Array.isArray,
  string: value => typeof value === "string",
  integer: Number.isSafeInteger,
  boolean: value => typeof value === "boolean",
  null: value => value === null,
});
const TYPE_NAME = Object.freeze({ object: "an object", array: "a list", string: "text", integer: "an integer", boolean: "true or false", null: "null" });

/**
 * Problems of `value` against the JSON Schema (2020-12) subset Fold schemas use, as "path: reason". `oneOf` picks its
 * branch by the property every branch pins with `const`, so a problem names the shape the value meant.
 */
export function jsonSchemaProblems(schema, value, path, problems = []) {
  if (schema.oneOf) {
    const tag = Object.keys(schema.oneOf[0].properties).find(key => schema.oneOf.every(branch => "const" in (branch.properties?.[key] ?? {})));
    const branch = schema.oneOf.find(option => isObject(value) && value[tag] === option.properties[tag].const);
    if (branch) return jsonSchemaProblems(branch, value, path, problems);
    problems.push(`${path}.${tag}: expected one of ${schema.oneOf.map(option => JSON.stringify(option.properties[tag].const)).join(", ")}`);
    return problems;
  }
  if ("const" in schema && value !== schema.const) return problems.push(`${path}: expected ${JSON.stringify(schema.const)}`), problems;
  if (schema.enum && !schema.enum.includes(value)) return problems.push(`${path}: expected one of ${schema.enum.join(", ")}`), problems;
  const types = schema.type === undefined ? [] : [].concat(schema.type);
  if (types.length && !types.some(type => TYPE_OK[type](value))) return problems.push(`${path}: expected ${types.map(type => TYPE_NAME[type]).join(" or ")}`), problems;
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0)) problems.push(`${path}: expected text`);
    if (value.length > (schema.maxLength ?? Infinity)) problems.push(`${path}: longer than ${schema.maxLength} characters`);
  }
  if (Number.isSafeInteger(value) && value < (schema.minimum ?? -Infinity)) problems.push(`${path}: expected at least ${schema.minimum}`);
  if (Number.isSafeInteger(value) && value > (schema.maximum ?? Infinity)) problems.push(`${path}: expected at most ${schema.maximum}`);
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0)) problems.push(`${path}: expected at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((item, index) => jsonSchemaProblems(schema.items, item, `${path}[${index}]`, problems));
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) problems.push(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) jsonSchemaProblems(schema.properties[key], item, `${path}.${key}`, problems);
      else if (schema.additionalProperties === false) problems.push(`${path}.${key}: unknown field`);
    }
  }
  return problems;
}

const deepFreeze = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

const schemaText = { type: "string", minLength: 1 };
const schemaOptional = { type: "string" };
const schemaId = { type: "string", minLength: 1, maxLength: 256 };
const schemaStars = { type: "integer", enum: [0, 1, 2] };
const record = (properties, optional = []) => ({
  type: "object", additionalProperties: false, required: Object.keys(properties).filter(key => !optional.includes(key)), properties,
});
const list = items => ({ type: "array", items });

/**
 * The Estudio sheet schema around one evidence shape: the model reply quotes (`elementId` + `quote`, offsets
 * optional); the stored sheet holds anchored evidence and the checker's tally.
 */
export function estudioSchema(evidence, { stored }) {
  const grounded = properties => record({ ...properties, evidence: { type: "array", minItems: 1, items: evidence } });
  const sheet = {
    oneLiner: { ...grounded({ text: schemaText, stars: schemaStars }), type: ["object", "null"] },
    caso: list(grounded({ entity: schemaText, text: schemaText, stars: schemaStars })),
    vs: list(record({
      title: schemaText,
      columns: { type: "array", minItems: 1, items: schemaText },
      rows: { type: "array", minItems: 2, items: record({ label: schemaText, stars: schemaStars, cells: { type: "array", minItems: 1, items: grounded({ text: schemaText }) } }) },
    })),
    numeros: list(grounded({ label: schemaText, value: schemaText, unit: schemaOptional, consequence: schemaText, decisive: { type: "boolean" }, stars: schemaStars })),
    flujo: list(record({
      title: schemaText,
      nodes: { type: "array", minItems: 2, items: grounded({ id: schemaId, text: schemaText }) },
      edges: { type: "array", minItems: 1, items: record({ from: schemaId, to: schemaId, label: schemaOptional }, ["label"]) },
    })),
    bloques: list(record({ kind: { enum: [...BLOQUE_KINDS] }, bullets: { type: "array", minItems: 1, items: grounded({ text: schemaText, stars: schemaStars }) } })),
    nunca: list(grounded({ text: schemaText, why: schemaOptional, stars: schemaStars })),
    buzzwords: list(grounded({ term: schemaText, concept: schemaText })),
    mnemonics: list(record({ label: schemaText, word: schemaText, items: { type: "array", minItems: 2, items: grounded({ letter: schemaText, text: schemaText }) } })),
    cards: list(grounded({ q: schemaText, a: schemaText })),
    gaps: list(grounded({ text: schemaText })),
  };
  if (!stored) return deepFreeze(record(sheet));
  const dropped = record({ block: { enum: ["oneLiner", ...ESTUDIO_BLOCKS] }, evidence: { type: "array", minItems: 1, items: evidence } });
  const count = { type: "integer", minimum: 0 };
  return deepFreeze(record({
    format: { const: ESTUDIO_FORMAT }, version: { const: ESTUDIO_VERSION }, ...sheet,
    checks: record({ lines: count, gapped: count, long: count, dropped: list(dropped) }),
  }));
}

const STORED_EVIDENCE = record({
  elementId: schemaText, quote: schemaText, sentence: { type: "integer", minimum: 0 }, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 },
});
export const ESTUDIO_SHEET_SCHEMA = estudioSchema(STORED_EVIDENCE, { stored: true });
// A reply quotes; offsets are optional because the checker places each quote itself.
export const ESTUDIO_REPLY_EVIDENCE = record({
  elementId: schemaId, quote: schemaText, sentence: { type: "integer", minimum: 0 }, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 },
}, ["sentence", "start", "end"]);
export const ESTUDIO_REPLY_SCHEMA = estudioSchema(ESTUDIO_REPLY_EVIDENCE, { stored: false });

const sentenceEnd = /[.!?…。！？](?=\s|$)/gu;
const sentenceIndex = (text, start) => (text.slice(0, start).match(sentenceEnd) ?? []).length;

/**
 * Places one quoted evidence span at its real offsets in `text`: models quote well and count offsets badly. A quote
 * found nowhere comes back unchanged, so the checker rejects it.
 */
export function anchorQuote(entry, text) {
  if (typeof text !== "string" || !isObject(entry) || typeof entry.quote !== "string" || !entry.quote) return entry;
  if (Number.isSafeInteger(entry.start) && text.slice(entry.start, entry.end) === entry.quote) {
    return { elementId: entry.elementId, quote: entry.quote, sentence: sentenceIndex(text, entry.start), start: entry.start, end: entry.end };
  }
  // The checker accepts a quote at the same offsets in the exact, NFC or NFD text.
  for (const form of [null, "NFC", "NFD"]) {
    const source = form ? text.normalize(form) : text, quote = form ? entry.quote.normalize(form) : entry.quote;
    const start = source.indexOf(quote);
    if (start >= 0) return { elementId: entry.elementId, quote, sentence: sentenceIndex(source, start), start, end: start + quote.length };
  }
  return entry;
}

const foldLetters = text => String(text ?? "").normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Rules of a sheet the schema cannot say: a vs row has one cell per column, a flow's edges join two of its own nodes
 * once, node ids are unique, and a mnemonic's word spells its items' letters one to one, each item starting with its
 * letter. Shared by the reply contract and the stored-sheet guard.
 */
export function estudioShapeProblems(sheet, path = "estudio") {
  const problems = [];
  (sheet.vs ?? []).forEach((table, index) => table.rows.forEach((row, at) => {
    if (row.cells.length !== table.columns.length) problems.push(`${path}.vs[${index}].rows[${at}].cells: expected ${table.columns.length} cell(s), one per column`);
  }));
  (sheet.flujo ?? []).forEach((flow, index) => {
    const ids = new Set();
    flow.nodes.forEach((node, at) => {
      if (ids.has(node.id)) problems.push(`${path}.flujo[${index}].nodes[${at}].id: ${node.id} is used twice`);
      ids.add(node.id);
    });
    const edges = new Set();
    flow.edges.forEach((edge, at) => {
      const where = `${path}.flujo[${index}].edges[${at}]`;
      if (!ids.has(edge.from) || !ids.has(edge.to)) problems.push(`${where}: joins a node id the flow does not have`);
      else if (edge.from === edge.to) problems.push(`${where}: an arrow joins two different nodes`);
      else if (edges.has(`${edge.from}\u0001${edge.to}`)) problems.push(`${where}: the same arrow twice`);
      edges.add(`${edge.from}\u0001${edge.to}`);
    });
  });
  (sheet.mnemonics ?? []).forEach((mnemonic, index) => {
    const letters = [...foldLetters(mnemonic.word)];
    const where = `${path}.mnemonics[${index}]`;
    if (letters.length !== mnemonic.items.length) return problems.push(`${where}.items: "${mnemonic.word}" needs one item per letter`);
    mnemonic.items.forEach((item, at) => {
      if (foldLetters(item.letter) !== letters[at]) problems.push(`${where}.items[${at}].letter: expected "${letters[at]}"`);
      else if (!foldLetters(item.text).startsWith(letters[at])) problems.push(`${where}.items[${at}].text: starts with its letter "${letters[at]}"`);
    });
  });
  return problems;
}

// Every evidence list in a sheet, with its path.
export function estudioEvidence(sheet, path = "estudio", out = []) {
  if (Array.isArray(sheet)) sheet.forEach((item, index) => estudioEvidence(item, `${path}[${index}]`, out));
  else if (isObject(sheet)) {
    for (const [key, item] of Object.entries(sheet)) {
      if (key === "evidence" && Array.isArray(item)) out.push([`${path}.evidence`, item]);
      else estudioEvidence(item, `${path}.${key}`, out);
    }
  }
  return out;
}

/** Problems of a stored Estudio sheet; empty means valid. */
export function estudioProblems(value, path = "estudio") {
  const problems = jsonSchemaProblems(ESTUDIO_SHEET_SCHEMA, value, path);
  if (problems.length) return problems;
  for (const [where, entries] of estudioEvidence(value, path)) entries.forEach((entry, index) => evidenceProblems(entry, `${where}[${index}]`, problems));
  problems.push(...estudioShapeProblems(value, path));
  return problems;
}

export const isEstudioSheet = value => estudioProblems(value).length === 0;

export const isFold = value => foldProblems(value).length === 0;
export const isAuthorText = value => isObject(value) && value.by === "author" && isFoldLine(value);
export const isWrittenText = value => isObject(value) && value.by === "model" && isFoldLine(value);
export function isFoldLine(value) {
  const problems = [];
  lineProblems(value, "line", problems);
  return problems.length === 0;
}
export function isEvidence(value) {
  const problems = [];
  evidenceProblems(value, "evidence", problems);
  return problems.length === 0;
}

// Stored evidence quotes the unit's text exactly at its UTF-16 offsets.
export const evidenceFits = (text, evidence) => isEvidence(evidence) && typeof text === "string" && text.slice(evidence.start, evidence.end) === evidence.quote;
