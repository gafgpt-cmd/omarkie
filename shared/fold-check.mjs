// Payload-loss checker for `omarkie/fold` v1 (fold-design.md §4.4).
// Pure, deterministic checks on model lines vs evidence quotes across 7 ES/EN payload classes
// plus Glass pins, size-ladder monotonicity, and format/injection stripping.

import {
  CHECK_CLASSES,
  evidenceFits,
  isAuthorText,
  isEvidence,
} from "./fold-format.mjs";

export const PAYLOAD_CLASSES = Object.freeze([
  "negation",
  "restriction",
  "condition",
  "uncertainty",
  "number",
  "scope",
  "attribution",
]);

export const NUMBER_GAP = "—?";

const BOUND_L = "(?<![\\p{L}\\p{N}_])";
const BOUND_R = "(?![\\p{L}\\p{N}_])";
const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phraseAlt = list =>
  [...list].sort((a, b) => b.length - a.length).map(item => escapeRe(item).replace(/\\ /g, "\\s+")).join("|");
const wordRegex = (list, flags = "giu") => new RegExp(`${BOUND_L}(?:${phraseAlt(list)})${BOUND_R}`, flags);

function foldAscii(text) {
  return String(text ?? "").normalize("NFC").normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

function normalizeSpace(text) {
  return String(text ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function countWords(text) {
  if (typeof text !== "string") return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  let count = 0;
  for (const token of trimmed.split(/\s+/u)) {
    if (/[\p{L}\p{N}]/u.test(token)) count += 1;
  }
  return count;
}

function lineText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.text === "string") return value.text;
  return "";
}

function collectMatches(text, regex) {
  const results = [];
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    results.push({ raw: match[0], index: match.index, end: match.index + match[0].length, groups: match });
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  return results;
}

// --- 1. Negation lexicons (ES + EN) ---
const NEGATION_PLAIN = [
  // Multi-word English first
  "do not", "does not", "did not", "must not", "should not", "will not", "would not", "could not", "can not", "may not",
  // Contractions (ASCII and curly apostrophe handled via normalization below)
  "don't", "doesn't", "didn't", "won't", "wouldn't", "can't", "couldn't", "shouldn't", "mustn't",
  "isn't", "aren't", "wasn't", "weren't", "haven't", "hasn't", "hadn't", "needn't", "shan't",
  // Single-word EN
  "cannot", "never", "without", "neither", "nor", "none", "avoid", "prohibit", "prohibited", "forbid", "forbidden", "absence", "not", "no",
  // ES
  "nunca", "jamás", "ningún", "ninguno", "ninguna", "ningunos", "ningunas", "tampoco", "sin",
  "evitar", "evite", "evítese", "prohibido", "prohibida", "prohibidos", "prohibidas", "prohíbe", "ausencia", "ni",
];
const NEGATION_EXCEPTION = [
  "salvo", "excepto", "excluyendo", "exceptuando",
  "except", "excluding",
];
const NEGATION_PLAIN_RE = new RegExp(
  `${BOUND_L}(?:${phraseAlt(NEGATION_PLAIN)}|non-[\\p{L}]+)${BOUND_R}`,
  "giu",
);
const NEGATION_EXCEPTION_RE = wordRegex(NEGATION_EXCEPTION);
const CONTRAINDICATION_RE = new RegExp(
  `${BOUND_L}(?:contraindicad[\\p{L}]*|contraindicaci[oó]n(?:es)?|contraindicat[\\p{L}]*)${BOUND_R}`,
  "giu",
);

function extractNegation(text, suppressedSpans = []) {
  const normalized = text.replace(/’/g, "'");
  const isSuppressed = m => suppressedSpans.some(([s, e]) => m.index >= s && m.end <= e);
  const out = [];
  for (const m of collectMatches(normalized, CONTRAINDICATION_RE)) {
    out.push({ raw: m.raw, kind: "contraindication", index: m.index });
  }
  for (const m of collectMatches(normalized, NEGATION_PLAIN_RE)) {
    if (isSuppressed(m)) continue;
    out.push({ raw: m.raw, kind: "negation", index: m.index });
  }
  for (const m of collectMatches(normalized, NEGATION_EXCEPTION_RE)) {
    if (isSuppressed(m)) continue;
    out.push({ raw: m.raw, kind: "exception", index: m.index });
  }
  out.sort((a, b) => a.index - b.index);
  return out.map(({ raw, kind }) => ({ raw, kind }));
}

// --- 2. Restriction lexicons (ES + EN) ---
const RESTRICTION_EXCLUSIVITY = [
  "tan solo", "tan sólo", "únicamente", "exclusivamente", "solamente", "solo", "sólo", "estrictamente",
  "exclusively", "solely", "only", "strictly",
];
const RESTRICTION_UNIVERSALITY = [
  "en todos los casos", "invariablemente", "obligatoriamente",
  "in all cases", "every time", "invariably", "mandatory", "always",
];
const RESTRICTION_EXCL_RE = wordRegex(RESTRICTION_EXCLUSIVITY);
// Exclude "siempre que" / "siempre y cuando" (those are conditionals, not universality).
const RESTRICTION_UNIV_RE = new RegExp(
  `${BOUND_L}(?:${phraseAlt(RESTRICTION_UNIVERSALITY)}|siempre(?!\\s+(?:que|y\\s+cuando)${BOUND_R}))${BOUND_R}`,
  "giu",
);

function extractRestriction(text) {
  const out = [];
  for (const m of collectMatches(text, RESTRICTION_EXCL_RE)) {
    out.push({ raw: m.raw, kind: "exclusivity", index: m.index });
  }
  for (const m of collectMatches(text, RESTRICTION_UNIV_RE)) {
    out.push({ raw: m.raw, kind: "universality", index: m.index });
  }
  out.sort((a, b) => a.index - b.index);
  return out.map(({ raw, kind }) => ({ raw, kind }));
}

// --- 3. Condition lexicons (ES + EN) ---
const CONDITION_NEGATIVE = [
  "a menos que", "salvo que", "salvo si", "salvo cuando", "excepto si", "excepto cuando", "en ausencia de", "si no",
  "in the absence of", "except if", "except when", "if not", "unless",
];
const CONDITION_POSITIVE = [
  "siempre y cuando", "siempre que", "en caso de que", "en caso de", "con tal de que", "en presencia de", "cuando", "mientras", "si",
  "in the presence of", "provided that", "as long as", "in case of", "in case", "whenever", "only if", "even if", "when", "if",
];
const CONDITION_NEG_RE = wordRegex(CONDITION_NEGATIVE);
const CONDITION_POS_RE = wordRegex(CONDITION_POSITIVE);

function extractConditionWithSpans(text) {
  const negMatches = collectMatches(text, CONDITION_NEG_RE);
  const posMatches = collectMatches(text, CONDITION_POS_RE).filter(pos =>
    !negMatches.some(neg => pos.index >= neg.index && pos.end <= neg.end),
  );
  const out = [
    ...negMatches.map(m => ({ raw: m.raw, kind: "negative_conditional", index: m.index, end: m.end })),
    ...posMatches.map(m => ({ raw: m.raw, kind: "conditional", index: m.index, end: m.end })),
  ];
  out.sort((a, b) => a.index - b.index);
  return out;
}

// --- 4. Uncertainty / frequency lexicons (ES + EN) ---
const UNCERTAINTY_LOW = [
  "poco frecuente", "en ocasiones", "a veces", "excepcionalmente", "excepcional", "raramente", "infrecuentes", "infrecuente",
  "ocasionalmente", "ocasionales", "ocasional", "improbable", "raros", "raras", "raro", "rara",
  "infrequently", "infrequent", "occasionally", "occasional", "sometimes", "uncommon", "unlikely", "rarely", "rare", "seldom",
];
const UNCERTAINTY_MID = [
  "aproximadamente", "potencialmente", "posiblemente", "posibilidad", "posibles", "posible", "potenciales", "potencial",
  "podrían", "podría", "pueden", "puede", "tal vez", "quizás", "quizá", "sugieren", "sugiere", "apoyan", "apoya",
  "orienta", "sospechoso", "sospecha", "aprox",
  "approximately", "potentially", "possibly", "possible", "potential", "suspected", "suggests", "suggest",
  "supports", "support", "roughly", "perhaps", "approx", "might", "could", "maybe", "may", "can",
];
const UNCERTAINTY_HIGH = [
  "por lo general", "en general", "frecuentemente", "habitualmente", "probablemente", "generalmente", "típicamente",
  "comúnmente", "a menudo", "frecuentes", "frecuente", "habituales", "habitual", "probables", "probable",
  "comunes", "común", "típico", "típica", "suelen", "suele",
  "frequently", "frequent", "commonly", "common", "usually", "typically", "generally", "probably", "probable",
  "likely", "often", "tends", "tend",
];
const UNCERTAINTY_CERTAINTY = [
  "con seguridad", "con certeza", "definitivamente", "invariablemente", "inevitablemente", "seguramente",
  "confirman", "confirma", "demuestran", "demuestra", "garantizan", "garantiza", "inevitable",
  "definitely", "invariably", "inevitably", "certainly", "guarantees", "guarantee", "confirms", "confirm",
  "proves", "prove", "always", "inevitable",
];
const UNCERTAINTY_LOW_RE = wordRegex(UNCERTAINTY_LOW);
const UNCERTAINTY_MID_RE = wordRegex(UNCERTAINTY_MID);
const UNCERTAINTY_HIGH_RE = wordRegex(UNCERTAINTY_HIGH);
const UNCERTAINTY_CERT_RE = new RegExp(
  `${BOUND_L}(?:${phraseAlt(UNCERTAINTY_CERTAINTY)}|siempre(?!\\s+(?:que|y\\s+cuando)${BOUND_R}))${BOUND_R}`,
  "giu",
);
const NEGATED_MODAL_PREFIX_RE = new RegExp(`${BOUND_L}(?:no|not|nunca|never|jamás)\\s+$`, "iu");

function extractUncertainty(text) {
  const out = [];
  const lowMatches = collectMatches(text, UNCERTAINTY_LOW_RE);
  const midMatches = collectMatches(text, UNCERTAINTY_MID_RE);
  const highMatches = collectMatches(text, UNCERTAINTY_HIGH_RE);
  const certMatches = collectMatches(text, UNCERTAINTY_CERT_RE);

  const isNegatedBefore = index => NEGATED_MODAL_PREFIX_RE.test(text.slice(Math.max(0, index - 16), index));

  for (const m of lowMatches) {
    if (isNegatedBefore(m.index)) continue;
    out.push({ raw: m.raw, tier: "low", index: m.index, end: m.end });
  }
  for (const m of midMatches) {
    if (isNegatedBefore(m.index)) continue;
    if (/^(?:can|could|may)$/iu.test(m.raw) && /^(?:\s+not|['’]t)(?![\p{L}\p{N}_])/iu.test(text.slice(m.end))) continue;
    out.push({ raw: m.raw, tier: "mid", index: m.index, end: m.end });
  }
  for (const m of highMatches) {
    // Avoid "frecuente" inside "poco frecuente"
    if (lowMatches.some(low => m.index >= low.index && m.end <= low.end)) continue;
    if (isNegatedBefore(m.index)) continue;
    out.push({ raw: m.raw, tier: "high", index: m.index, end: m.end });
  }
  for (const m of certMatches) {
    if (isNegatedBefore(m.index)) continue;
    out.push({ raw: m.raw, tier: "certainty", index: m.index, end: m.end });
  }
  out.sort((a, b) => a.index - b.index);
  return out.map(({ raw, tier }) => ({ raw, tier }));
}

// --- 5. Number + unit + direction extraction (ES + EN) ---
const UNIT_CANONICAL = new Map([
  // Pressure / vitals
  ["mmhg", "mmHg"],
  ["cmh2o", "cmH2O"],
  ["kpa", "kPa"],
  ["bpm", "bpm"],
  ["lpm", "lpm"],
  // Simple mass / volume / molar / activity / area
  ["mcg", "mcg"],
  ["µg", "mcg"],
  ["μg", "mcg"],
  ["ug", "mcg"],
  ["mg", "mg"],
  ["kg", "kg"],
  ["ng", "ng"],
  ["pg", "pg"],
  ["g", "g"],
  ["ml", "mL"],
  ["dl", "dL"],
  ["µl", "mcL"],
  ["μl", "mcL"],
  ["ul", "mcL"],
  ["l", "L"],
  ["mmol", "mmol"],
  ["µmol", "mcmol"],
  ["μmol", "mcmol"],
  ["umol", "mcmol"],
  ["mol", "mol"],
  ["meq", "mEq"],
  ["mosm", "mOsm"],
  ["ui", "UI"],
  ["iu", "UI"],
  ["u", "U"],
  ["1.73m²", "1.73m2"],
  ["1.73m2", "1.73m2"],
  ["m²", "m2"],
  ["m2", "m2"],
  // Percent
  ["%", "%"],
  ["‰", "‰"],
  // Time
  ["ms", "ms"],
  ["minutos", "min"],
  ["minuto", "min"],
  ["minutes", "min"],
  ["minute", "min"],
  ["mins", "min"],
  ["min", "min"],
  ["segundos", "s"],
  ["segundo", "s"],
  ["seconds", "s"],
  ["second", "s"],
  ["secs", "s"],
  ["sec", "s"],
  ["seg", "s"],
  ["s", "s"],
  ["horas", "h"],
  ["hora", "h"],
  ["hours", "h"],
  ["hour", "h"],
  ["hrs", "h"],
  ["hr", "h"],
  ["h", "h"],
  ["días", "d"],
  ["día", "d"],
  ["dias", "d"],
  ["dia", "d"],
  ["days", "d"],
  ["day", "d"],
  ["d", "d"],
  ["semanas", "wk"],
  ["semana", "wk"],
  ["weeks", "wk"],
  ["week", "wk"],
  ["wks", "wk"],
  ["wk", "wk"],
  ["sem", "wk"],
  ["meses", "mo"],
  ["mes", "mo"],
  ["months", "mo"],
  ["month", "mo"],
  ["mo", "mo"],
  ["años", "yr"],
  ["año", "yr"],
  ["years", "yr"],
  ["year", "yr"],
  ["yrs", "yr"],
  ["yr", "yr"],
  // Currency / temperature / length / data
  ["€", "€"],
  ["eur", "€"],
  ["$", "$"],
  ["usd", "$"],
  ["£", "£"],
  ["°c", "°C"],
  ["°f", "°F"],
  ["cm", "cm"],
  ["mm", "mm"],
  ["km", "km"],
  ["m", "m"],
  ["kcal", "kcal"],
  ["kj", "kJ"],
  ["j", "J"],
  ["ghz", "GHz"],
  ["mhz", "MHz"],
  ["khz", "kHz"],
  ["hz", "Hz"],
  ["gb", "GB"],
  ["mb", "MB"],
  ["kb", "KB"],
]);

const UNIT_KEYS_SORTED = [...UNIT_CANONICAL.keys()].sort((a, b) => b.length - a.length);
const SYMBOL_UNITS = new Set(["%", "‰", "€", "$", "£", "°c", "°f"]);
const WORD_UNIT_ALT = UNIT_KEYS_SORTED.filter(u => !SYMBOL_UNITS.has(u)).map(escapeRe).join("|");
const SYMBOL_UNIT_ALT = UNIT_KEYS_SORTED.filter(u => SYMBOL_UNITS.has(u)).map(escapeRe).join("|");
const COMPOUND_DENOM = "(?:(?:\\d+(?:\\.\\d+)?)?[\\p{L}µμ][\\p{L}\\p{N}µμ²³]*)";
const UNIT_END_GUARD = "(?![\\p{L}\\p{N}_])(?!\\/[\\p{L}µμ])";
const UNIT_ALT = `(?:(?:${WORD_UNIT_ALT})(?:\\/${COMPOUND_DENOM})*${UNIT_END_GUARD}|[\\p{L}µμ][\\p{L}\\p{N}µμ²³]*\\/(?:${WORD_UNIT_ALT})(?:\\/${COMPOUND_DENOM})*${UNIT_END_GUARD}|(?:${SYMBOL_UNIT_ALT})(?:(?:\\/${COMPOUND_DENOM})+${UNIT_END_GUARD})?|\\/(?:${WORD_UNIT_ALT})(?:\\/${COMPOUND_DENOM})*${UNIT_END_GUARD})`;

function canonicalizeUnitPart(part) {
  if (!part) return "";
  const direct = UNIT_CANONICAL.get(part.toLowerCase());
  if (direct !== undefined) return direct;
  const scaled = part.match(/^(\d+(?:\.\d+)?)(.+)$/);
  if (scaled) {
    const unitMapped = UNIT_CANONICAL.get(scaled[2].toLowerCase());
    if (unitMapped !== undefined) return `${scaled[1]}${unitMapped}`;
  }
  return part.replace(/²/g, "2").replace(/µ|μ/g, "mc");
}

function canonicalizeUnit(rawUnit) {
  if (!rawUnit) return null;
  const trimmed = rawUnit.trim();
  const direct = UNIT_CANONICAL.get(trimmed.toLowerCase());
  if (direct !== undefined) return direct;
  if (trimmed.includes("/")) {
    return trimmed.split("/").map(canonicalizeUnitPart).join("/");
  }
  return trimmed;
}

const VERBAL_DIRECTIONS = [
  // Negated >= -> <
  ["not greater than or equal to", "<"],
  ["no mayor o igual que", "<"],
  ["no igual o mayor que", "<"],
  ["no mayor o igual a", "<"],
  ["no igual o mayor a", "<"],
  ["no como mínimo", "<"],
  ["no al menos", "<"],
  ["not at least", "<"],
  // Negated <= -> >
  ["not less than or equal to", ">"],
  ["no menor o igual que", ">"],
  ["no igual o menor que", ">"],
  ["no menor o igual a", ">"],
  ["no igual o menor a", ">"],
  ["no como máximo", ">"],
  ["not at most", ">"],
  // Negated < -> >=
  ["no por debajo de", "≥"],
  ["not fewer than", "≥"],
  ["no fewer than", "≥"],
  ["not less than", "≥"],
  ["no less than", "≥"],
  ["no inferior a", "≥"],
  ["no menor que", "≥"],
  ["no menor de", "≥"],
  ["no menos de", "≥"],
  ["not below", "≥"],
  ["not under", "≥"],
  // Negated > -> <=
  ["no por encima de", "≤"],
  ["not greater than", "≤"],
  ["no greater than", "≤"],
  ["not more than", "≤"],
  ["no more than", "≤"],
  ["no superior a", "≤"],
  ["no mayor que", "≤"],
  ["no mayor de", "≤"],
  ["no más de", "≤"],
  ["not above", "≤"],
  ["not over", "≤"],
  // >=
  ["greater than or equal to", "≥"],
  ["mayor o igual que", "≥"],
  ["igual o mayor que", "≥"],
  ["mayor o igual a", "≥"],
  ["igual o mayor a", "≥"],
  ["como mínimo", "≥"],
  ["al menos", "≥"],
  ["at least", "≥"],
  // <=
  ["less than or equal to", "≤"],
  ["menor o igual que", "≤"],
  ["igual o menor que", "≤"],
  ["menor o igual a", "≤"],
  ["igual o menor a", "≤"],
  ["como máximo", "≤"],
  ["at most", "≤"],
  ["up to", "≤"],
  ["hasta", "≤"],
  // >
  ["por encima de", ">"],
  ["greater than", ">"],
  ["more than", ">"],
  ["superior a", ">"],
  ["mayor que", ">"],
  ["mayor de", ">"],
  ["más de", ">"],
  ["above", ">"],
  ["over", ">"],
  // <
  ["por debajo de", "<"],
  ["inferior a", "<"],
  ["fewer than", "<"],
  ["less than", "<"],
  ["menor que", "<"],
  ["menor de", "<"],
  ["menos de", "<"],
  ["below", "<"],
  ["under", "<"],
];

const VERBAL_DIRECTIONS_SORTED = [...VERBAL_DIRECTIONS].sort((a, b) => b[0].length - a[0].length);
const VERBAL_DIR_RE = new RegExp(
  `${BOUND_L}(${VERBAL_DIRECTIONS_SORTED.map(([phrase]) => escapeRe(phrase).replace(/\\ /g, "\\s+")).join("|")})\\s+$`,
  "iu",
);
const VERBAL_DIR_MAP = new Map(VERBAL_DIRECTIONS.map(([phrase, dir]) => [phrase.replace(/\s+/g, " "), dir]));

const TRAILING_DIR_RE = new RegExp(`^\\s+(?:(max|máx|máximo|maximum)|(min|mín|mínimo|minimum))${BOUND_R}`, "iu");

function normalizeSymDirection(sym) {
  if (!sym) return null;
  if (sym === ">=") return "≥";
  if (sym === "<=") return "≤";
  if (sym === ">" || sym === "<" || sym === "≥" || sym === "≤" || sym === "↑" || sym === "↓") return sym;
  return null;
}

function parseNumberValue(raw) {
  let clean = raw.trim();
  let sign = 1;
  if (clean.startsWith("-") || clean.startsWith("−")) {
    sign = -1;
    clean = clean.slice(1);
  }
  if (clean.includes(",") && clean.includes(".")) {
    const lastComma = clean.lastIndexOf(",");
    const lastDot = clean.lastIndexOf(".");
    if (lastComma > lastDot) return sign * Number(clean.replace(/\./g, "").replace(",", "."));
    return sign * Number(clean.replace(/,/g, ""));
  }
  if (clean.includes(",")) {
    if (/^[1-9]\d{0,2}(?:,\d{3})+$/.test(clean)) return sign * Number(clean.replace(/,/g, ""));
    return sign * Number(clean.replace(",", "."));
  }
  if (clean.includes(".") && /^[1-9]\d{0,2}(?:\.\d{3}){2,}$/.test(clean)) {
    return sign * Number(clean.replace(/\./g, ""));
  }
  return sign * Number(clean);
}

// Matches optional symbolic comparator, optional prefix currency, number (and optional range end), optional unit.
const NUM_PART = "\\d+(?:[.,]\\d+)*";
const SIGNED_NUM_PART = `[-−]?${NUM_PART}`;
const NUMBER_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_-])(?:(>=|<=|[><≥≤↑↓])\\s*)?([€$£])?(${SIGNED_NUM_PART})(?:(\\s*(?:–|—|-)\\s*|\\s+(?:to|a)\\s+)(${SIGNED_NUM_PART})(?!-\\d))?(?:\\s*(${UNIT_ALT}))?`,
  "giu",
);
const ES_RANGE_A_PREFIX_RE = /(?:^|[^\p{L}\p{N}_])(?:de|desde)\s+$/iu;
const VERSION_PREFIX_RE = new RegExp(`${BOUND_L}(?:version|versión|edition|edición)\\s+$`, "iu");
const BETWEEN_RANGE_RE = new RegExp(
  `${BOUND_L}(?:entre|between)\\s+(${SIGNED_NUM_PART})\\s+(?:y|and)\\s+(${SIGNED_NUM_PART})(?:\\s*(${UNIT_ALT}))?`,
  "giu",
);

const SPELLED_NUMBERS = new Map([
  ["un", 1], ["una", 1], ["uno", 1], ["primer", 1], ["primero", 1], ["primera", 1],
  ["dos", 2], ["tres", 3], ["cuatro", 4], ["cinco", 5], ["seis", 6], ["siete", 7], ["ocho", 8], ["nueve", 9], ["diez", 10],
  ["once", 11], ["doce", 12], ["quince", 15], ["veinte", 20], ["treinta", 30],
  ["one", 1], ["first", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10],
  ["eleven", 11], ["twelve", 12], ["fifteen", 15], ["twenty", 20], ["thirty", 30],
]);
const SPELLED_UNIT_RE = new RegExp(
  `${BOUND_L}(${phraseAlt([...SPELLED_NUMBERS.keys()])})\\s+(${UNIT_ALT})`,
  "giu",
);

function extractNumbers(text, { includeSpelled = false } = {}) {
  const tokens = [];
  const usedSpans = [];

  // First extract explicit "entre X y Y" / "between X and Y" ranges so their endpoints aren't split.
  for (const m of collectMatches(text, BETWEEN_RANGE_RE)) {
    const low = parseNumberValue(m.groups[1]);
    const high = parseNumberValue(m.groups[2]);
    if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
    const rawUnit = m.groups[3] ?? null;
    tokens.push({
      raw: m.raw.trim(),
      value: low,
      high,
      unit: canonicalizeUnit(rawUnit),
      rawUnit,
      direction: null,
      start: m.index,
      end: m.end,
    });
    usedSpans.push([m.index, m.end]);
  }

  NUMBER_RE.lastIndex = 0;
  let match;
  while ((match = NUMBER_RE.exec(text)) !== null) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    if (match[0].length === 0) {
      NUMBER_RE.lastIndex += 1;
      continue;
    }
    const enclosing = usedSpans.find(([s, e]) => matchStart >= s && matchStart < e);
    if (enclosing) {
      NUMBER_RE.lastIndex = enclosing[1];
      continue;
    }
    // Skip version numbers owned by scope ("version 2.4", "edición 3").
    if (!match[1] && !match[2] && VERSION_PREFIX_RE.test(text.slice(Math.max(0, matchStart - 20), matchStart))) {
      continue;
    }
    const symDir = normalizeSymDirection(match[1]);
    const prefixCurrency = match[2] ?? null;
    const lowRaw = match[3];
    const rangeSep = match[4] ?? null;
    const highRaw = match[5] ?? null;
    let rawUnit = match[6] ?? prefixCurrency;

    const low = parseNumberValue(lowRaw);
    let high = highRaw !== null ? parseNumberValue(highRaw) : undefined;
    let start = matchStart;
    let end = matchEnd;

    if (!Number.isFinite(low)) continue;

    const isBareSpanishA = rangeSep !== null
      && /^\s+a\s+$/iu.test(rangeSep)
      && !ES_RANGE_A_PREFIX_RE.test(text.slice(Math.max(0, matchStart - 16), matchStart));

    if (high !== undefined && (!Number.isFinite(high) || high < low || isBareSpanishA)) {
      high = undefined;
      rawUnit = prefixCurrency;
      const firstEnd = matchStart + match[0].indexOf(lowRaw) + lowRaw.length;
      end = firstEnd;
      NUMBER_RE.lastIndex = firstEnd;
    }

    // Check verbal direction immediately preceding the number (only when no symbolic comparator).
    let direction = symDir;
    if (!direction) {
      const beforeStart = Math.max(0, start - 48);
      const before = text.slice(beforeStart, start);
      const verbal = before.match(VERBAL_DIR_RE);
      if (verbal) {
        const key = verbal[1].toLowerCase().replace(/\s+/g, " ");
        const mapped = VERBAL_DIR_MAP.get(key) ?? null;
        if (mapped) {
          direction = mapped;
          start = beforeStart + verbal.index;
        }
      }
    }
    if (!direction) {
      const after = text.slice(end, end + 16);
      const trailing = after.match(TRAILING_DIR_RE);
      if (trailing) {
        direction = trailing[1] ? "≤" : "≥";
        end += trailing[0].length;
      }
    }

    tokens.push({
      raw: text.slice(start, end).trim(),
      value: low,
      ...(high !== undefined ? { high } : {}),
      unit: canonicalizeUnit(rawUnit),
      rawUnit,
      direction,
      start,
      end,
    });
  }

  if (includeSpelled) {
    for (const m of collectMatches(text, SPELLED_UNIT_RE)) {
      const val = SPELLED_NUMBERS.get(m.groups[1].toLowerCase());
      if (val === undefined) continue;
      const rawUnit = m.groups[2];
      let start = m.index;
      let direction = null;
      const beforeStart = Math.max(0, start - 48);
      const before = text.slice(beforeStart, start);
      const verbal = before.match(VERBAL_DIR_RE);
      if (verbal) {
        const mapped = VERBAL_DIR_MAP.get(verbal[1].toLowerCase().replace(/\s+/g, " ")) ?? null;
        if (mapped) {
          direction = mapped;
          start = beforeStart + verbal.index;
        }
      }
      tokens.push({
        raw: text.slice(start, m.end).trim(),
        value: val,
        unit: canonicalizeUnit(rawUnit),
        rawUnit,
        direction,
        start,
        end: m.end,
        spelled: true,
      });
    }
  }

  tokens.sort((a, b) => a.start - b.start);
  return tokens;
}

// --- 6. Scope lexicons (ES + EN) ---
const SCOPE_GROUPS = [
  // Population / clinical subgroups
  { kind: "population", canonical: "pregnancy", terms: ["embarazo", "embarazada", "embarazadas", "gestación", "gestante", "gestantes", "pregnancy", "pregnant", "gestation", "gestational"] },
  { kind: "population", canonical: "lactation", terms: ["lactancia", "lactation", "breastfeeding"] },
  { kind: "population", canonical: "pediatric", terms: ["pediatría", "pediátrico", "pediátrica", "pediátricos", "pediátricas", "niños", "niño", "niña", "niñas", "infantil", "infantiles", "pediatrics", "pediatric", "paediatrics", "paediatric", "children", "child"] },
  { kind: "population", canonical: "neonatal", terms: ["neonatos", "neonato", "neonatal", "lactantes", "lactante", "neonates", "neonate", "infants", "infant"] },
  { kind: "population", canonical: "elderly", terms: ["adultos mayores", "adulto mayor", "geriátrico", "geriátrica", "ancianos", "anciano", "ancianas", "anciana", "older adults", "elderly", "geriatric"] },
  { kind: "population", canonical: "renal", terms: ["insuficiencia renal", "enfermedad renal crónica", "enfermedad renal", "hemodiálisis", "diálisis", "nefrópatas", "nefrópata", "renal", "hemodialysis", "dialysis", "kidney"] },
  { kind: "population", canonical: "hepatic", terms: ["insuficiencia hepática", "hepáticos", "hepáticas", "hepático", "hepática", "cirrosis", "liver failure", "cirrhosis", "hepatic", "liver"] },
  { kind: "population", canonical: "immunocompromised", terms: ["inmunocomprometidos", "inmunocomprometido", "inmunodeprimidos", "inmunodeprimido", "immunocompromised", "immunosuppressed"] },
  { kind: "population", canonical: "obesity", terms: ["obesidad", "obesos", "obeso", "obesa", "obesity", "obese"] },
  { kind: "population", canonical: "diabetic", terms: ["diabéticos", "diabético", "diabética", "diabetes", "diabetic"] },
  { kind: "population", canonical: "adult", terms: ["adultos", "adulto", "adults", "adult"] },
  // Legal / contract parties
  { kind: "party", canonical: "tenant", terms: ["arrendatario", "arrendataria", "inquilino", "inquilina", "tenant", "lessee"] },
  { kind: "party", canonical: "landlord", terms: ["arrendador", "arrendadora", "propietario", "propietaria", "landlord", "lessor"] },
  { kind: "party", canonical: "buyer", terms: ["comprador", "compradora", "buyer", "purchaser"] },
  { kind: "party", canonical: "seller", terms: ["vendedor", "vendedora", "seller", "vendor"] },
  { kind: "party", canonical: "employer", terms: ["empleador", "empleadora", "employer"] },
  { kind: "party", canonical: "employee", terms: ["trabajador", "trabajadora", "empleado", "empleada", "employee"] },
  { kind: "party", canonical: "borrower", terms: ["deudor", "deudora", "prestatario", "borrower"] },
  { kind: "party", canonical: "lender", terms: ["acreedor", "acreedora", "prestamista", "lender"] },
  // Jurisdictions & platforms (case-insensitive safe names)
  { kind: "jurisdiction", canonical: "spain", terms: ["españa", "spain"] },
  { kind: "jurisdiction", canonical: "eu", terms: ["unión europea", "european union", "europeo", "europea", "european"] },
  { kind: "jurisdiction", canonical: "us", terms: ["estados unidos", "united states", "ee.uu.", "eeuu", "u.s.a.", "u.s.", "usa"] },
  { kind: "jurisdiction", canonical: "uk", terms: ["reino unido", "united kingdom"] },
  { kind: "jurisdiction", canonical: "linux", terms: ["linux"] },
  { kind: "jurisdiction", canonical: "macos", terms: ["macos"] },
  { kind: "jurisdiction", canonical: "windows", terms: ["windows"] },
  { kind: "jurisdiction", canonical: "ios", terms: ["ios"] },
  { kind: "jurisdiction", canonical: "android", terms: ["android"] },
];

// Case-sensitive uppercase scope acronyms (prevents "us" pronoun or lowercase collisions).
const SCOPE_ACRONYMS = [
  { kind: "population", canonical: "renal", terms: ["CKD", "ERC", "ESRD", "AKI", "IRA"] },
  { kind: "jurisdiction", canonical: "eu", terms: ["EU", "UE"] },
  { kind: "jurisdiction", canonical: "us", terms: ["US"] },
  { kind: "jurisdiction", canonical: "uk", terms: ["UK"] },
];

const SCOPE_COMPILED = [
  ...SCOPE_GROUPS.map(g => ({ ...g, re: wordRegex(g.terms, "giu") })),
  ...SCOPE_ACRONYMS.map(g => ({ ...g, re: wordRegex(g.terms, "gu") })),
];
const VERSION_SCOPE_RE = new RegExp(
  `${BOUND_L}(?:v(\\d+(?:\\.\\d+)*)|(?:version|versión|edition|edición)\\s+(\\d+(?:\\.\\d+)*))${BOUND_R}`,
  "giu",
);

function extractScope(text) {
  const candidates = [];
  for (const group of SCOPE_COMPILED) {
    for (const m of collectMatches(text, group.re)) {
      candidates.push({ raw: m.raw, canonical: group.canonical, kind: group.kind, index: m.index, end: m.end });
    }
  }
  candidates.sort((a, b) => (b.end - b.index) - (a.end - a.index) || a.index - b.index);
  const acceptedSpans = [];
  const out = [];
  const seen = new Set();
  for (const cand of candidates) {
    if (acceptedSpans.some(([s, e]) => cand.index < e && cand.end > s)) continue;
    acceptedSpans.push([cand.index, cand.end]);
    if (seen.has(cand.canonical)) continue;
    seen.add(cand.canonical);
    out.push({ raw: cand.raw, canonical: cand.canonical, kind: cand.kind, index: cand.index });
  }
  for (const m of collectMatches(text, VERSION_SCOPE_RE)) {
    const ver = m.groups[1] ?? m.groups[2];
    const canonical = `version:${ver}`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ raw: m.raw, canonical, kind: "version", index: m.index });
  }
  out.sort((a, b) => a.index - b.index);
  return out.map(({ raw, canonical, kind }) => ({ raw, canonical, kind }));
}

// --- 7. Attribution lexicons (ES + EN) ---
const GUIDELINE_BODIES = [
  "AHA/ACC", "ACC/AHA", "ESC/ESAIC", "ADA/EASD", "ATS/ERS",
  "ESC", "AHA", "ACC", "ESAIC", "ASA", "NICE", "WHO", "OMS", "CDC", "FDA", "EMA", "AEMPS",
  "IDSA", "SSC", "KDIGO", "ADA", "EASD", "GOLD", "GINA", "BTS", "ATS", "ERS",
  "ACLS", "ATLS", "PALS", "ILCOR", "SEPAR", "SEMICYUC", "SEDAR", "SEMFYC", "SEMI", "SEC",
  "USPSTF", "NCCN", "ESMO", "ASCO", "EAN", "AAN", "GRADE", "PRISMA", "CONSORT",
  "Cochrane", "UpToDate", "First Aid",
];
const GUIDELINE_RE = wordRegex(GUIDELINE_BODIES, "gu");
const ET_AL_RE = new RegExp(
  `${BOUND_L}([\\p{Lu}][\\p{L}'’\\-]+)\\s+et\\s+al\\.?(?:\\s*\\(?(\\d{4})\\)?)?`,
  "gu",
);
const TWO_AUTHOR_RE = new RegExp(
  `${BOUND_L}([\\p{Lu}][\\p{L}'’\\-]+)\\s+(?:and|y|&)\\s+([\\p{Lu}][\\p{L}'’\\-]+)\\s*\\((\\d{4})\\)`,
  "gu",
);
const NAMED_GUIDELINE_RE = new RegExp(
  `${BOUND_L}(?:guías?|guidelines?|consenso|consensus|ensayo|estudio|trial|study)\\s+(?:de\\s+(?:la\\s+|los\\s+)?)?([A-Za-z][A-Za-z0-9/-]{1,})${BOUND_R}`,
  "giu",
);
const ACRONYM_SOURCE_RE = /^[A-Z][A-Z0-9/-]{1,}$/;
const ATTRIBUTION_CUES = [
  "de acuerdo con", "conforme a", "reportado por", "descrito por", "propuesto por", "citado por",
  "según", "afirma", "sostiene", "opina",
  "according to", "reported by", "described by", "proposed by", "cited by", "as per", "claims", "argues",
];
const ATTRIBUTION_CUE_RE = wordRegex(ATTRIBUTION_CUES, "giu");
// Match "per <guideline/protocol/author/...>" but NEVER "per kg", "per day", "per hour", "per cent".
const PER_ATTRIBUTION_RE = new RegExp(
  `${BOUND_L}(?:[Pp]er|PER)\\s+(?:(?:[Tt]he|THE)\\s+)?(?:[Gg]uidelines?|[Pp]rotocol|[Pp]olicy|[Aa]uthors?|[Ss]tudy|[Tt]rial|[Mm]anufacturer|[Cc]onsensus|[A-Z]{2,})${BOUND_R}`,
  "gu",
);

function extractAttribution(text) {
  const out = [];
  const seen = new Set();

  for (const m of collectMatches(text, ET_AL_RE)) {
    const surname = foldAscii(m.groups[1]);
    const canonical = `${surname} et al`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ raw: m.raw, canonical, kind: "source", index: m.index });
  }
  for (const m of collectMatches(text, TWO_AUTHOR_RE)) {
    const canonical = `${foldAscii(m.groups[1])} & ${foldAscii(m.groups[2])}`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ raw: m.raw, canonical, kind: "source", index: m.index });
  }
  for (const m of collectMatches(text, GUIDELINE_RE)) {
    const canonical = m.raw.toUpperCase();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ raw: m.raw, canonical, kind: "source", index: m.index });
  }
  for (const m of collectMatches(text, NAMED_GUIDELINE_RE)) {
    if (!ACRONYM_SOURCE_RE.test(m.groups[1])) continue;
    const canonical = m.groups[1].toUpperCase();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ raw: m.raw, canonical, kind: "source", index: m.index });
  }
  for (const m of collectMatches(text, ATTRIBUTION_CUE_RE)) {
    const canonical = `cue:${foldAscii(m.raw)}`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ raw: m.raw, canonical, kind: "cue", index: m.index });
  }
  for (const m of collectMatches(text, PER_ATTRIBUTION_RE)) {
    const canonical = `cue:${foldAscii(m.raw)}`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ raw: m.raw, canonical, kind: "cue", index: m.index });
  }

  out.sort((a, b) => a.index - b.index);
  return out.map(({ raw, canonical, kind }) => ({ raw, canonical, kind }));
}

export function extractPayload(text, options = {}) {
  const value = typeof text === "string" ? text.normalize("NFC") : "";
  const condition = extractConditionWithSpans(value);
  const number = extractNumbers(value, { includeSpelled: Boolean(options.includeSpelled) });
  const numbersForSuppression = options.includeSpelled ? number : extractNumbers(value, { includeSpelled: true });
  const suppressedNegSpans = [
    ...condition.filter(c => c.kind === "negative_conditional").map(c => [c.index, c.end]),
    ...numbersForSuppression.filter(n => n.direction !== null).map(n => [n.start, n.end]),
  ];
  return {
    negation: extractNegation(value, suppressedNegSpans),
    restriction: extractRestriction(value),
    condition: condition.map(({ raw, kind }) => ({ raw, kind })),
    uncertainty: extractUncertainty(value),
    number,
    scope: extractScope(value),
    attribution: extractAttribution(value),
  };
}

// --- Format / injection check ---
const MD_IMAGE_RE = /!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g;
const MD_LINK_RE = /\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g;
const STRAY_MD_LINK_RE = /\]\(/g;
const SCRIPT_STYLE_BLOCK_RE = /<(script|style)\b[^>]*>(?:[\s\S]*?<\/\1\s*>|[\s\S]*$)/gi;
const BLOCK_HTML_TAG_RE = /<\/?(?:br|p|div|li|ul|ol|tr|td|th|table|hr|h[1-6]|img|iframe|svg|object|embed|form|input|blockquote|pre|video|audio|details|marquee|dialog|section|article|header|footer|nav|aside|main)\b(?:[\s/][^<>]*)?\/?>/gi;
const HTML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:[\s/][^<>]*)?\/?>/g;
const UNCLOSED_DANGEROUS_TAG_RE = /<\/?(?:(?:a|img|script|iframe|svg|object|embed|style|link|meta|form|input|body|html|video|audio|details|marquee|source|track|base|textarea|select|button|dialog|math|template|frameset|frame|applet|noscript)\b[^<>]*|[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^<>]*=[^<>]*|\/[^<>]*))/gi;
const URL_SCHEME_RE = /\b(?:(?:https?|ftp|file):\/\/|(?:javascript|vbscript|data):)(?:[^\s<>]*[^\s<>.,;:!?])?/gi;
const FENCE_LINE_RE = /(?:^|\n)[ \t]*(?:```+|~~~+)[^\n]*/g;
const INLINE_FENCE_RE = /```+|~~~/g;

export function checkFormat(text) {
  const source = typeof text === "string" ? text : "";
  const reasons = [];
  let sanitized = source;

  const mark = (code, match) => {
    reasons.push({ code, raw: match });
  };

  for (let pass = 0; pass < 10; pass += 1) {
    const prev = sanitized;

    sanitized = sanitized.replace(MD_IMAGE_RE, (m, alt) => (mark("markdown_link", m), alt));
    sanitized = sanitized.replace(MD_LINK_RE, (m, label) => (mark("markdown_link", m), label));
    sanitized = sanitized.replace(STRAY_MD_LINK_RE, m => (mark("markdown_link", m), " "));
    sanitized = sanitized.replace(SCRIPT_STYLE_BLOCK_RE, m => (mark("html", m), " "));
    sanitized = sanitized.replace(BLOCK_HTML_TAG_RE, m => (mark("html", m), " "));
    sanitized = sanitized.replace(HTML_TAG_RE, m => (mark("html", m), ""));
    sanitized = sanitized.replace(URL_SCHEME_RE, m => (mark("url", m), " "));
    sanitized = sanitized.replace(FENCE_LINE_RE, m => (mark("fence", m.trim()), "\n"));
    sanitized = sanitized.replace(INLINE_FENCE_RE, m => (mark("fence", m), " "));

    if (sanitized !== prev) continue;

    sanitized = sanitized.replace(UNCLOSED_DANGEROUS_TAG_RE, m => (mark("html", m), " "));
    if (sanitized === prev) break;
  }

  sanitized = normalizeSpace(sanitized);

  if (!reasons.length) {
    return { ok: true, status: "pass", findings: [], sanitized: source };
  }
  const extra = [...new Set(reasons.map(r => r.raw))];
  const findings = [{
    class: "format",
    code: "unsafe_format",
    message: `Stripped disallowed format/injection markup: ${extra.join(", ")}`,
    extra,
    action: "strip",
  }];
  return { ok: false, status: "fail", findings, sanitized };
}

// --- Per-class semantic comparisons ---
function compareNegation(lineTokens, evTokens, lineCond, evCond, action) {
  const evPlain = evTokens.filter(t => t.kind === "negation" || t.kind === "contraindication");
  const linePlain = lineTokens.filter(t => t.kind === "negation" || t.kind === "contraindication");
  const evExc = evTokens.filter(t => t.kind === "exception");
  const lineExc = lineTokens.filter(t => t.kind === "exception");
  const lineHasNegCond = lineCond.some(c => c.kind === "negative_conditional");

  const findings = [];
  if (evPlain.length > 0 && linePlain.length === 0) {
    const missing = [...new Set(evPlain.map(t => t.raw))];
    findings.push({
      class: "negation",
      code: "dropped_negation",
      message: `Negation polarity dropped; missing: ${missing.join(", ")}`,
      missing,
      action,
    });
  } else if (evPlain.length === 0 && linePlain.length > 0) {
    const extra = [...new Set(linePlain.map(t => t.raw))];
    findings.push({
      class: "negation",
      code: "invented_negation",
      message: `Negation polarity introduced without evidence: ${extra.join(", ")}`,
      extra,
      action,
    });
  }

  if (evExc.length > 0 && lineExc.length === 0 && !lineHasNegCond) {
    const missing = [...new Set(evExc.map(t => t.raw))];
    findings.push({
      class: "negation",
      code: "dropped_exception",
      message: `Exception token dropped; missing: ${missing.join(", ")}`,
      missing,
      action,
    });
  }
  return findings;
}

function compareRestriction(lineTokens, evTokens, action) {
  const findings = [];
  for (const kind of ["exclusivity", "universality"]) {
    const evKind = evTokens.filter(t => t.kind === kind);
    const lineKind = lineTokens.filter(t => t.kind === kind);
    if (evKind.length > 0 && lineKind.length === 0) {
      const missing = [...new Set(evKind.map(t => t.raw))];
      findings.push({
        class: "restriction",
        code: "dropped_restriction",
        message: `Restriction (${kind}) dropped; missing: ${missing.join(", ")}`,
        missing,
        action,
      });
    }
  }
  return findings;
}

function compareCondition(lineTokens, evTokens, lineNeg, action) {
  const findings = [];
  const evNeg = evTokens.filter(t => t.kind === "negative_conditional");
  const lineNegCond = lineTokens.filter(t => t.kind === "negative_conditional");
  const lineHasException = lineNeg.some(t => t.kind === "exception");

  if (evNeg.length > 0 && lineNegCond.length === 0 && !lineHasException) {
    const missing = [...new Set(evNeg.map(t => t.raw))];
    findings.push({
      class: "condition",
      code: "dropped_negative_condition",
      message: `Negative condition dropped or inverted; missing: ${missing.join(", ")}`,
      missing,
      action,
    });
  }

  const evPos = evTokens.filter(t => t.kind === "conditional");
  const linePos = lineTokens.filter(t => t.kind === "conditional");
  if (evPos.length > 0 && linePos.length === 0) {
    const missing = [...new Set(evPos.map(t => t.raw))];
    findings.push({
      class: "condition",
      code: "dropped_condition",
      message: `Condition dropped; missing: ${missing.join(", ")}`,
      missing,
      action,
    });
  }
  return findings;
}

function compareUncertainty(lineTokens, evTokens, action) {
  const evHedges = evTokens.filter(t => t.tier !== "certainty");
  if (!evHedges.length) return [];

  const lineHedges = lineTokens.filter(t => t.tier !== "certainty");
  const evCert = evTokens.filter(t => t.tier === "certainty");
  const lineCert = lineTokens.filter(t => t.tier === "certainty");
  const findings = [];

  if (lineCert.length > 0 && evCert.length === 0) {
    const missing = [...new Set(evHedges.map(t => t.raw))];
    const extra = [...new Set(lineCert.map(t => t.raw))];
    findings.push({
      class: "uncertainty",
      code: "upgraded_to_certainty",
      message: `Uncertainty (${missing.join(", ")}) upgraded to certainty (${extra.join(", ")})`,
      missing,
      extra,
      action,
    });
    return findings;
  }

  if (lineHedges.length === 0) {
    const missing = [...new Set(evHedges.map(t => t.raw))];
    findings.push({
      class: "uncertainty",
      code: "dropped_uncertainty",
      message: `Uncertainty/frequency dropped (upgraded to certainty); missing: ${missing.join(", ")}`,
      missing,
      action,
    });
    return findings;
  }

  const evTiers = new Set(evHedges.map(t => t.tier));
  const lineTiers = new Set(lineHedges.map(t => t.tier));

  if (evTiers.has("low") && !evTiers.has("high") && lineTiers.has("high") && !lineTiers.has("low")) {
    findings.push({
      class: "uncertainty",
      code: "upgraded_frequency",
      message: `Low frequency upgraded to high frequency`,
      missing: [...new Set(evHedges.filter(t => t.tier === "low").map(t => t.raw))],
      extra: [...new Set(lineHedges.filter(t => t.tier === "high").map(t => t.raw))],
      action,
    });
  } else if (evTiers.has("mid") && !evTiers.has("high") && lineTiers.has("high") && !lineTiers.has("mid")) {
    findings.push({
      class: "uncertainty",
      code: "upgraded_frequency",
      message: `Possibility upgraded to high frequency`,
      missing: [...new Set(evHedges.filter(t => t.tier === "mid").map(t => t.raw))],
      extra: [...new Set(lineHedges.filter(t => t.tier === "high").map(t => t.raw))],
      action,
    });
  } else if (evTiers.has("high") && !evTiers.has("low") && lineTiers.has("low") && !lineTiers.has("high")) {
    findings.push({
      class: "uncertainty",
      code: "inverted_frequency",
      message: `High frequency downgraded to rare`,
      missing: [...new Set(evHedges.filter(t => t.tier === "high").map(t => t.raw))],
      extra: [...new Set(lineHedges.filter(t => t.tier === "low").map(t => t.raw))],
      action,
    });
  }
  return findings;
}

function numberMatches(lineNum, evNums) {
  if (lineNum.high !== undefined) {
    const exactRange = evNums.some(
      e => e.high !== undefined && e.value === lineNum.value && e.high === lineNum.high && e.unit === lineNum.unit && e.direction === lineNum.direction,
    );
    if (exactRange) return { ok: true };
    // Allow range composed from two evidence numbers sharing the same unit (when un-directed).
    if (lineNum.direction === null) {
      const hasLow = evNums.some(e => e.high === undefined && e.value === lineNum.value && e.unit === lineNum.unit);
      const hasHigh = evNums.some(e => e.high === undefined && e.value === lineNum.high && e.unit === lineNum.unit);
      if (hasLow && hasHigh) return { ok: true };
    }
    const sameRangeVals = evNums.filter(e => e.high !== undefined && e.value === lineNum.value && e.high === lineNum.high);
    if (sameRangeVals.some(e => e.unit === lineNum.unit)) return { ok: false, code: "direction_mismatch" };
    if (sameRangeVals.length > 0) return { ok: false, code: "unit_mismatch" };
    return { ok: false, code: "invented_number" };
  }

  const exact = evNums.some(
    e => e.high === undefined && e.value === lineNum.value && e.unit === lineNum.unit && e.direction === lineNum.direction,
  );
  if (exact) return { ok: true };

  const sameVal = evNums.filter(e => e.high === undefined && e.value === lineNum.value);
  if (sameVal.some(e => e.unit === lineNum.unit)) return { ok: false, code: "direction_mismatch" };
  if (sameVal.length > 0) return { ok: false, code: "unit_mismatch" };
  return { ok: false, code: "invented_number" };
}

function compareNumbers(text, lineNums, evNums) {
  const badSpans = [];
  const findings = [];
  for (const num of lineNums) {
    const verdict = numberMatches(num, evNums);
    if (verdict.ok) continue;
    badSpans.push(num);
    findings.push({
      class: "number",
      code: verdict.code,
      message: `Number "${num.raw}" not grounded in evidence (${verdict.code})`,
      extra: [num.raw],
      action: "gap",
    });
  }
  if (!badSpans.length) return { findings, sanitized: text };

  // Replace offending spans right-to-left with the visible gap marker "—?".
  let sanitized = text;
  for (const span of [...badSpans].sort((a, b) => b.start - a.start)) {
    sanitized = sanitized.slice(0, span.start) + NUMBER_GAP + sanitized.slice(span.end);
  }
  return { findings, sanitized };
}

function compareScope(lineTokens, evTokens, action) {
  const lineSet = new Set(lineTokens.map(t => t.canonical));
  const missing = [];
  for (const ev of evTokens) {
    if (!lineSet.has(ev.canonical)) missing.push(ev.raw);
  }
  if (!missing.length) return [];
  return [{
    class: "scope",
    code: "dropped_scope",
    message: `Scope dropped; missing: ${missing.join(", ")}`,
    missing,
    action,
  }];
}

function compareAttribution(lineTokens, evTokens, action, lineStr = "") {
  const evSources = evTokens.filter(t => t.kind === "source");
  const lineSources = new Set(lineTokens.filter(t => t.kind === "source").map(t => t.canonical));

  if (evSources.length > 0) {
    const missing = evSources
      .filter(s => {
        if (lineSources.has(s.canonical)) return false;
        if (lineStr && ACRONYM_SOURCE_RE.test(s.canonical)) {
          return !new RegExp(`${BOUND_L}${escapeRe(s.canonical)}${BOUND_R}`, "u").test(lineStr);
        }
        return true;
      })
      .map(s => s.raw);
    if (!missing.length) return [];
    return [{
      class: "attribution",
      code: "dropped_attribution",
      message: `Attribution source dropped; missing: ${missing.join(", ")}`,
      missing,
      action,
    }];
  }

  const evCues = evTokens.filter(t => t.kind === "cue");
  if (evCues.length > 0 && lineTokens.length === 0) {
    const missing = [...new Set(evCues.map(c => c.raw))];
    return [{
      class: "attribution",
      code: "dropped_attribution",
      message: `Attribution cue dropped; missing: ${missing.join(", ")}`,
      missing,
      action,
    }];
  }
  return [];
}

// --- 8. Glass pins check ---
const STOPWORDS = new Set([
  // ES
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "a", "en", "por", "para", "con", "que", "es", "son", "se", "su", "sus", "y", "o", "u", "como", "lo", "le", "les",
  // EN
  "the", "a", "an", "of", "to", "in", "for", "on", "at", "by", "with", "that", "this", "is", "are", "was", "were", "be", "been", "being", "as", "and", "or", "it", "its", "from",
]);

function significantTokens(text) {
  const folded = foldAscii(text);
  const words = folded.match(/[a-z0-9]+/g) ?? [];
  return words.filter(w => w.length > 1 && !STOPWORDS.has(w));
}

function pinQuote(pin) {
  if (typeof pin === "string") return pin;
  if (pin && typeof pin === "object") {
    if (typeof pin.quote === "string") return pin.quote;
    if (typeof pin.text === "string") return pin.text;
  }
  return "";
}

const CLAUSE_SPLIT_RE = /(?:[;!?\n]+|(?<!\bal)\.(?=\s|$))/u;
const SUBCLAUSE_INTRO_RE = new RegExp(
  `${BOUND_L}(?:a\\s+menos\\s+que|salvo\\s+que|salvo\\s+si|salvo\\s+cuando|excepto\\s+si|excepto\\s+cuando|except\\s+if|except\\s+when|unless|salvo|excepto|except)${BOUND_R}`,
  "iu",
);

function buildDirectPinRegex(normPin) {
  let prefix = "";
  if (/^\d/.test(normPin)) prefix = "(?<![\\p{L}\\p{N}_.\\-−])";
  else if (/^[\p{L}\p{N}_]/u.test(normPin)) prefix = BOUND_L;

  let suffix = "";
  if (/\d$/.test(normPin)) suffix = "(?![\\p{L}\\p{N}_/])(?!\\.\\d)";
  else if (/[\p{L}\p{N}_%]$/u.test(normPin)) suffix = "(?![\\p{L}\\p{N}_/])";

  return new RegExp(`${prefix}${escapeRe(normPin)}${suffix}`, "u");
}

function pinCoveredInClause(clauseStr, normPin, pinDirectRe, pinPayload, pinWords) {
  const normClause = normalizeSpace(foldAscii(clauseStr));
  if (!normClause) return false;

  const clausePayload = extractPayload(clauseStr, { includeSpelled: true });
  const pinPlainNeg = pinPayload.negation.filter(t => t.kind === "negation" || t.kind === "contraindication");
  const clausePlainNeg = clausePayload.negation.filter(t => t.kind === "negation" || t.kind === "contraindication");
  const numbersOk = () =>
    pinPayload.number.filter(n => !n.spelled).every(num => numberMatches(num, clausePayload.number).ok);

  const directMatch = pinDirectRe.exec(normClause);
  if (directMatch) {
    if (!numbersOk()) return false;
    if (pinPlainNeg.length > 0) return clausePlainNeg.length > 0;
    if (clausePlainNeg.length === 0) return true;
    const matchStart = directMatch.index;
    const beforeAndMatch = normClause.slice(0, matchStart + directMatch[0].length);
    const intro = SUBCLAUSE_INTRO_RE.exec(beforeAndMatch);
    if (intro && intro.index <= matchStart) {
      const subClause = normClause.slice(intro.index);
      const subNeg = extractPayload(subClause, { includeSpelled: true }).negation
        .filter(t => t.kind === "negation" || t.kind === "contraindication");
      if (subNeg.length === 0) return true;
    }
    return false;
  }

  if (pinWords.length < 3) return false;

  const clauseWords = new Set(significantTokens(clauseStr));
  let hits = 0;
  for (const w of pinWords) {
    if (clauseWords.has(w)) hits += 1;
  }
  if (hits / pinWords.length < 0.65) return false;

  if (compareNegation(clausePayload.negation, pinPayload.negation, clausePayload.condition, pinPayload.condition, "out_of_fold").length > 0) {
    return false;
  }
  return numbersOk();
}

function pinCoveredInLine(lineStr, quote) {
  const quoteClauses = String(quote ?? "").split(CLAUSE_SPLIT_RE).map(s => s.trim()).filter(Boolean);
  if (!quoteClauses.length) return true;

  const pinText = quoteClauses.length === 1 ? quoteClauses[0] : String(quote);
  const normPin = normalizeSpace(foldAscii(pinText));
  if (!normPin) return true;

  const pinDirectRe = buildDirectPinRegex(normPin);
  const pinPayload = extractPayload(pinText, { includeSpelled: true });
  const pinWords = significantTokens(pinText);

  if (quoteClauses.length > 1) {
    return pinCoveredInClause(lineStr, normPin, pinDirectRe, pinPayload, pinWords);
  }
  const lineClauses = String(lineStr ?? "").split(CLAUSE_SPLIT_RE).map(s => s.trim()).filter(Boolean);
  for (const clause of lineClauses) {
    if (pinCoveredInClause(clause, normPin, pinDirectRe, pinPayload, pinWords)) return true;
  }
  return false;
}

export function checkPins(line, pins = []) {
  const list = Array.isArray(pins) ? pins : [];
  if (!list.length) return { ok: true, status: "pass", covered: [], outOfFold: [], findings: [] };

  const text = lineText(line);
  const covered = [];
  const outOfFold = [];
  for (const pin of list) {
    const quote = pinQuote(pin);
    if (pinCoveredInLine(text, quote)) covered.push(pin);
    else outOfFold.push(pin);
  }
  if (!outOfFold.length) return { ok: true, status: "pass", covered, outOfFold, findings: [] };

  const missing = outOfFold.map(pinQuote).filter(Boolean);
  const findings = [{
    class: "pins",
    code: "pin_out_of_fold",
    message: `Pinned source text missing from stop; move to fuera del pliegue`,
    missing,
    action: "out_of_fold",
  }];
  return { ok: false, status: "fail", covered, outOfFold, findings };
}

// --- 9. Monotonic size-ladder guard ---
export function checkMonotonic(stops) {
  const input = stops && typeof stops === "object" ? stops : {};
  const counts = {
    ...(input.full !== undefined ? { full: countWords(lineText(input.full)) } : {}),
    ...(input.brief !== undefined ? { brief: countWords(lineText(input.brief)) } : {}),
    key: countWords(lineText(input.key)),
    takeaway: countWords(lineText(input.takeaway)),
    topic: countWords(lineText(input.topic)),
  };

  const outStops = {
    ...(input.brief !== undefined ? { brief: input.brief } : {}),
    key: input.key,
    takeaway: input.takeaway,
    topic: input.topic,
  };
  const demoted = [];
  const findings = [];

  if (input.full !== undefined && input.brief !== undefined && counts.brief > counts.full) {
    outStops.brief = input.full;
    demoted.push("brief");
    findings.push({
      class: "monotonic",
      code: "over_lower_stop",
      message: `brief (${counts.brief} words) exceeds full (${counts.full} words); showing full`,
      action: "demote",
    });
  }

  const keyBoundStop = outStops.brief !== undefined ? outStops.brief : input.full;
  const keyBoundName = outStops.brief !== undefined ? "brief" : "full";
  if (keyBoundStop !== undefined) {
    const keyBoundWords = countWords(lineText(keyBoundStop));
    if (counts.key > keyBoundWords) {
      outStops.key = keyBoundStop;
      demoted.push("key");
      findings.push({
        class: "monotonic",
        code: "over_lower_stop",
        message: `key (${counts.key} words) exceeds ${keyBoundName} (${keyBoundWords} words); showing ${keyBoundName}`,
        action: "demote",
      });
    }
  }

  const effectiveKeyWords = countWords(lineText(outStops.key));
  if (counts.takeaway > effectiveKeyWords) {
    outStops.takeaway = outStops.key;
    demoted.push("takeaway");
    findings.push({
      class: "monotonic",
      code: "over_lower_stop",
      message: `takeaway (${counts.takeaway} words) exceeds key (${effectiveKeyWords} words); showing key`,
      action: "demote",
    });
  }

  const effectiveTakeawayWords = countWords(lineText(outStops.takeaway));
  if (counts.topic > effectiveTakeawayWords) {
    outStops.topic = outStops.takeaway;
    demoted.push("topic");
    findings.push({
      class: "monotonic",
      code: "over_lower_stop",
      message: `topic (${counts.topic} words) exceeds takeaway (${effectiveTakeawayWords} words); showing takeaway`,
      action: "demote",
    });
  }

  return {
    ok: findings.length === 0,
    status: findings.length === 0 ? "pass" : "fail",
    stops: outStops,
    counts,
    demoted,
    findings,
  };
}

// --- Evidence grounding helper ---
export function validateEvidence(unitText, evidenceList) {
  if (typeof unitText !== "string") return { ok: false, problems: ["unitText must be a string"] };
  const list = Array.isArray(evidenceList) ? evidenceList : [];
  if (!list.length) return { ok: false, problems: ["model line requires at least one evidence entry"] };

  const nfcUnit = unitText.normalize("NFC");
  const nfdUnit = unitText.normalize("NFD");
  const problems = [];
  for (let i = 0; i < list.length; i += 1) {
    const ev = list[i];
    if (!isEvidence(ev)) {
      problems.push(`evidence[${i}]: invalid evidence shape`);
      continue;
    }
    const fitsExact = evidenceFits(unitText, ev);
    const fitsNfc = !fitsExact
      && ev.quote === ev.quote.normalize("NFC")
      && nfcUnit.slice(ev.start, ev.end) === ev.quote;
    const fitsNfd = !fitsExact && !fitsNfc
      && ev.quote === ev.quote.normalize("NFD")
      && nfdUnit.slice(ev.start, ev.end) === ev.quote;
    if (!fitsExact && !fitsNfc && !fitsNfd) {
      problems.push(`evidence[${i}]: quote does not match unit text at offsets ${ev.start}..${ev.end}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// --- Main line checker ---
function normalizeEvidenceQuotes(line, evidence) {
  if (typeof evidence === "string") return [evidence];
  if (Array.isArray(evidence)) {
    return evidence.map(item => (typeof item === "string" ? item : item?.quote ?? "")).filter(Boolean);
  }
  if (line && typeof line === "object" && Array.isArray(line.evidence)) {
    return line.evidence.map(e => (typeof e?.quote === "string" ? e.quote : "")).filter(Boolean);
  }
  return [];
}

function toAuthorLine(brief, fallbackText) {
  if (isAuthorText(brief)) return brief;
  if (typeof brief === "string" && brief.trim()) return { by: "author", text: brief };
  if (typeof fallbackText === "string" && fallbackText.trim()) return { by: "author", text: fallbackText };
  return { by: "author", text: NUMBER_GAP };
}

export function checkLine(line, evidence, options = {}) {
  const { unitText, brief, pins, retryAvailable = true } = options;

  // Author lines pass payload checks directly; still check pins if supplied.
  if (isAuthorText(line)) {
    const pinRes = checkPins(line.text, pins);
    const checks = {};
    for (const cls of PAYLOAD_CLASSES) checks[cls] = "pass";
    checks.format = "pass";
    checks.pins = pinRes.status;
    return {
      ok: pinRes.ok,
      checks,
      findings: pinRes.findings,
      text: line.text,
      resolved: line,
      fallback: null,
      warning: false,
      retryTokens: [],
      outOfFold: pinRes.outOfFold,
      evidenceValid: true,
    };
  }

  const isPlainString = typeof line === "string";
  const isModelObj = line !== null && typeof line === "object" && !Array.isArray(line) && line.by === "model";
  const isMalformedObj = !isPlainString && !isModelObj;

  const rawText = lineText(line);
  const semanticAction = retryAvailable ? "retry" : "fallback_brief";

  let evidenceValid = true;
  if (isMalformedObj) {
    evidenceValid = false;
  } else if (isModelObj) {
    if (typeof unitText === "string") {
      evidenceValid = validateEvidence(unitText, line.evidence).ok;
    } else {
      evidenceValid = Array.isArray(line.evidence) && line.evidence.length > 0 && line.evidence.every(isEvidence);
    }
  }

  // 2. Format / injection check first.
  const formatRes = checkFormat(rawText);
  let workingText = formatRes.sanitized;

  // 3. Extract payload tokens from sanitized line and combined evidence quotes.
  const quotes = normalizeEvidenceQuotes(line, evidence);
  const evidenceText = quotes.join("\n");
  const linePayload = extractPayload(workingText, { includeSpelled: false });
  const evPayload = extractPayload(evidenceText, { includeSpelled: true });

  const findings = [...formatRes.findings];
  const classFindings = {
    negation: compareNegation(linePayload.negation, evPayload.negation, linePayload.condition, evPayload.condition, semanticAction),
    restriction: compareRestriction(linePayload.restriction, evPayload.restriction, semanticAction),
    condition: compareCondition(linePayload.condition, evPayload.condition, linePayload.negation, semanticAction),
    uncertainty: compareUncertainty(linePayload.uncertainty, evPayload.uncertainty, semanticAction),
    scope: compareScope(linePayload.scope, evPayload.scope, semanticAction),
    attribution: compareAttribution(linePayload.attribution, evPayload.attribution, semanticAction, workingText),
  };

  const numRes = compareNumbers(workingText, linePayload.number, evPayload.number);
  workingText = numRes.sanitized;
  classFindings.number = numRes.findings;

  for (const cls of PAYLOAD_CLASSES) {
    findings.push(...classFindings[cls]);
  }

  // 4. Glass pins check on working text.
  const pinRes = checkPins(workingText, pins);
  findings.push(...pinRes.findings);

  const checks = {
    negation: classFindings.negation.length ? "fail" : "pass",
    restriction: classFindings.restriction.length ? "fail" : "pass",
    condition: classFindings.condition.length ? "fail" : "pass",
    uncertainty: classFindings.uncertainty.length ? "fail" : "pass",
    number: classFindings.number.length ? "fail" : "pass",
    scope: classFindings.scope.length ? "fail" : "pass",
    attribution: classFindings.attribution.length ? "fail" : "pass",
    pins: pinRes.status,
    format: formatRes.status,
  };

  const semanticFailed =
    checks.negation === "fail" ||
    checks.restriction === "fail" ||
    checks.condition === "fail" ||
    checks.uncertainty === "fail" ||
    checks.scope === "fail" ||
    checks.attribution === "fail";

  const retryTokens = [];
  if (semanticFailed) {
    for (const f of findings) {
      if (f.action === "retry" || f.action === "fallback_brief") {
        for (const tok of f.missing ?? []) retryTokens.push(tok);
        for (const tok of f.extra ?? []) retryTokens.push(tok);
      }
    }
  }
  const uniqueRetryTokens = [...new Set(retryTokens)];

  const mustFallbackToBrief = (!evidenceValid) || (!workingText.trim()) || (semanticFailed && !retryAvailable);
  const safeUnitFallback = typeof unitText === "string" ? unitText.trim() : "";
  const safeFallbackText = evidenceValid
    ? (evidenceText.trim() || safeUnitFallback)
    : safeUnitFallback;
  let resolved;
  let fallback = null;
  let warning = !formatRes.ok || checks.number === "fail" || !evidenceValid;

  if (mustFallbackToBrief) {
    resolved = toAuthorLine(brief, safeFallbackText);
    fallback = "brief";
    warning = true;
  } else if (isModelObj) {
    resolved = { by: "model", text: workingText, evidence: line.evidence };
  } else {
    resolved = toAuthorLine(undefined, workingText.trim());
  }

  return {
    ok: evidenceValid && findings.length === 0 && Boolean(workingText.trim()),
    checks,
    findings,
    text: workingText,
    resolved,
    fallback,
    warning,
    retryTokens: uniqueRetryTokens,
    outOfFold: pinRes.outOfFold,
    evidenceValid,
  };
}

// --- Full WrittenUnit validator + checker + monotonic guard ---
export function checkWrittenUnit(unit, options = {}) {
  const { unitText, brief, full, pins, retryAvailable = true } = options;
  const briefLine = brief !== undefined ? toAuthorLine(brief, "") : undefined;
  const fullLine = full !== undefined ? (typeof full === "string" ? toAuthorLine(full, "") : full) : undefined;
  const stops = {};
  const allFindings = [];
  const combinedChecks = {};

  for (const cls of CHECK_CLASSES) combinedChecks[cls] = "pass";

  for (const stopName of ["key", "takeaway", "topic"]) {
    const line = unit[stopName];
    const res = checkLine(line, undefined, { unitText, brief: briefLine, pins, retryAvailable });
    stops[stopName] = res;
    allFindings.push(...res.findings);
    for (const [cls, status] of Object.entries(res.checks)) {
      if (status === "fail") combinedChecks[cls] = "fail";
    }
  }

  const monoRes = checkMonotonic({
    ...(fullLine !== undefined ? { full: fullLine } : {}),
    ...(briefLine !== undefined ? { brief: briefLine } : {}),
    key: stops.key.resolved,
    takeaway: stops.takeaway.resolved,
    topic: stops.topic.resolved,
  });
  combinedChecks.monotonic = monoRes.status;
  allFindings.push(...monoRes.findings);

  const checkedUnit = {
    elementId: unit.elementId,
    role: unit.role,
    key: monoRes.stops.key,
    takeaway: monoRes.stops.takeaway,
    topic: monoRes.stops.topic,
    checks: combinedChecks,
  };

  return {
    ok: allFindings.length === 0 && stops.key.evidenceValid && stops.takeaway.evidenceValid && stops.topic.evidenceValid,
    checks: combinedChecks,
    stops,
    monotonic: monoRes,
    findings: allFindings,
    unit: checkedUnit,
    warning: stops.key.warning || stops.takeaway.warning || stops.topic.warning,
  };
}
