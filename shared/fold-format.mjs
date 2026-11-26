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
  need(value.estudio === null || isObject(value.estudio), "fold.estudio", "expected an object or null", problems);
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
