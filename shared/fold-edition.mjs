// Nueva edición (fold-design.md §9.5): fold two editions of one text and keep only what changed.
// Units align by content hash, so unchanged and moved units drop out; the rest pair by word overlap
// inside each gap. Changed sentences are pinned, so every local stop still shows them, and the
// payload checker names what changed: numbers old → new, new never-dos, dropped lines.
// Pure ESM, deterministic, no model.

import { extractPayload } from "./fold-check.mjs";
import { commonPairs } from "./fold-morph.mjs";
import { LOCAL_LEVELS, firstSentence, words } from "./fold-text.mjs";
import { extractUnits, foldDocumentLadder, isHiddenUnit } from "./fold-units.mjs";

const STOP_IDS = LOCAL_LEVELS.map(level => level.id);
// Two units (or two sentences) are one edited line from this word overlap (Dice) up.
const UNIT_MATCH = 0.5, SENTENCE_MATCH = 0.4;
// Above this many candidate pairs in one gap, pairing looks only this far ahead.
const PAIR_TABLE = 250_000, PAIR_WINDOW = 40;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const DELIMITER = /^[\s|:-]*-[\s|:-]*$/;

export const FACT_CLASSES = Object.freeze(["number", "negation", "condition", "restriction", "uncertainty", "scope", "attribution"]);

/** Comparable text: Markdown emphasis and link targets gone, spaces folded, lower case. Symbols stay: `>` vs `≥` is an edit. */
export function sentenceKey(text) {
  return String(text ?? "").normalize("NFC").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~=]+/g, "")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

const wordSet = text => new Set(sentenceKey(text).match(/[\p{L}\p{N}]+/gu) ?? []);

function dice(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const word of small) if (large.has(word)) shared++;
  return 2 * shared / (a.size + b.size);
}

function sentencesOf(text) {
  const list = [];
  for (let rest = text.trim(); rest;) {
    const cut = firstSentence(rest);
    if (cut.head.trim()) list.push(cut.head.trim());
    rest = cut.rest.trim();
  }
  return list;
}

/** A unit as comparable lines: sentences of prose (per list item), rows of a table, a raw block whole. */
export function unitPieces(unit) {
  const lines = unit.markdown.split("\n");
  if (unit.kind === "heading") return [unit.markdown.replace(/^\s*#+\s*/, "").replace(/\s+#+\s*$/, "").trim()].filter(Boolean);
  if (unit.raw === "table") return lines.map(line => line.trim()).filter(line => line && !DELIMITER.test(line));
  if (unit.raw) return [unit.markdown.trim()];
  const texts = [];
  if (unit.kind === "list") {
    for (const line of lines) {
      if (ITEM.test(line)) texts.push(line.replace(ITEM, ""));
      else if (line.trim() && texts.length) texts[texts.length - 1] += ` ${line.trim()}`;
    }
  } else texts.push(lines.map(line => line.replace(/^\s*(?:>\s?)+/, "").trim()).filter(Boolean).join(" "));
  return texts.flatMap(sentencesOf);
}

const groupOf = unit => unit.kind === "heading" ? "heading" : unit.raw ?? "prose";

// In-order pairing of two runs by score (>= floor), as a list of { old, new } steps, either side null when unpaired.
// Exact for small runs (max total score); past PAIR_TABLE cells each old line looks PAIR_WINDOW lines ahead.
function pairRuns(olds, news, score, floor) {
  const rows = olds.length, columns = news.length, steps = [];
  if (!rows || !columns) {
    for (const item of olds) steps.push({ old: item, new: null });
    for (const item of news) steps.push({ old: null, new: item });
    return steps;
  }
  if (rows * columns > PAIR_TABLE) {
    let cursor = 0;
    for (const item of olds) {
      let best = -1, bestScore = floor;
      for (let j = cursor; j < Math.min(columns, cursor + PAIR_WINDOW); j++) {
        const value = score(item, news[j]);
        if (value >= bestScore && (best < 0 || value > bestScore)) { best = j; bestScore = value; }
      }
      if (best < 0) { steps.push({ old: item, new: null }); continue; }
      for (; cursor < best; cursor++) steps.push({ old: null, new: news[cursor] });
      steps.push({ old: item, new: news[cursor++] });
    }
    for (; cursor < columns; cursor++) steps.push({ old: null, new: news[cursor] });
    return steps;
  }
  const width = columns + 1, scores = new Float64Array(rows * columns), best = new Float64Array((rows + 1) * width);
  for (let i = 0; i < rows; i++) for (let j = 0; j < columns; j++) { const value = score(olds[i], news[j]); scores[i * columns + j] = value >= floor ? value : -1; }
  for (let i = rows - 1; i >= 0; i--) for (let j = columns - 1; j >= 0; j--) {
    const pair = scores[i * columns + j];
    best[i * width + j] = Math.max(best[(i + 1) * width + j], best[i * width + j + 1], pair >= 0 ? pair + best[(i + 1) * width + j + 1] : -1);
  }
  let i = 0, j = 0;
  while (i < rows && j < columns) {
    const pair = scores[i * columns + j];
    if (pair >= 0 && best[i * width + j] === pair + best[(i + 1) * width + j + 1]) steps.push({ old: olds[i++], new: news[j++] });
    else if (best[(i + 1) * width + j] >= best[i * width + j + 1]) steps.push({ old: olds[i++], new: null });
    else steps.push({ old: null, new: news[j++] });
  }
  for (; i < rows; i++) steps.push({ old: olds[i], new: null });
  for (; j < columns; j++) steps.push({ old: null, new: news[j] });
  return steps;
}

// Equal keys anchor (LCS); every run between anchors pairs by word overlap.
function diffRuns(oldKeys, newKeys, score, floor) {
  const anchors = commonPairs(oldKeys, newKeys), steps = [];
  let lastOld = 0, lastNew = 0;
  for (const [o, n] of [...anchors, [oldKeys.length, newKeys.length]]) {
    const olds = [], news = [];
    for (let i = lastOld; i < o; i++) olds.push(i);
    for (let j = lastNew; j < n; j++) news.push(j);
    steps.push(...pairRuns(olds, news, score, floor));
    if (o < oldKeys.length) steps.push({ old: o, new: n, same: true });
    lastOld = o + 1; lastNew = n + 1;
  }
  return steps;
}

const isYear = number => number.unit === null && !number.direction && number.high === undefined && Number.isInteger(number.value) && number.value >= 1900 && number.value <= 2100;
const numberKey = number => `${number.direction ?? ""}${number.value}${number.high === undefined ? "" : `-${number.high}`} ${number.unit ?? ""}`;

// Multiset difference by key: what only `before` has, what only `after` has, in order.
function tokenDiff(before, after, key) {
  const counts = new Map();
  for (const item of after) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  const removed = [];
  for (const item of before) {
    const count = counts.get(key(item)) ?? 0;
    if (count) counts.set(key(item), count - 1); else removed.push(item);
  }
  const left = new Map();
  for (const item of before) left.set(key(item), (left.get(key(item)) ?? 0) + 1);
  const added = [];
  for (const item of after) {
    const count = left.get(key(item)) ?? 0;
    if (count) left.set(key(item), count - 1); else added.push(item);
  }
  return { removed, added };
}

const EMPTY = extractPayload("");
const plain = item => ({ key: item.raw.toLowerCase(), raw: item.raw });
const canonical = item => ({ key: item.canonical, raw: item.raw });
const CLAUSE_MAX = 160;

// The clauses the never-dos sit in, as plain text: the trigger word alone ("not") tells the reader nothing.
// Payload items carry no offsets, so each trigger is found in order after the one before it.
function clauses(text, items) {
  const value = text.normalize("NFC"), found = new Set();
  const stops = at => value[at] === "\n" || (/[.!?;]/.test(value[at]) && (at + 1 >= value.length || /\s/.test(value[at + 1])));
  let from = 0;
  for (const item of items) {
    let start = value.indexOf(item.raw, from);
    if (start < 0) start = Math.max(0, value.indexOf(item.raw));
    let end = start;
    from = start + item.raw.length;
    while (start > 0 && !stops(start - 1)) start--;
    while (end < value.length - 1 && !stops(end)) end++;
    const clause = value.slice(start, end + 1).replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~|]+/g, "")
      .replace(/^\s*(?:[-+>]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim();
    found.add(clause.length > CLAUSE_MAX ? `${clause.slice(0, CLAUSE_MAX - 1)}…` : clause);
  }
  return [...found].join(" · ");
}

/** What changed in payload terms between two versions of one line (either side null: the line is new or gone). */
export function factsOf(before, after) {
  const old = before ? extractPayload(before) : EMPTY, next = after ? extractPayload(after) : EMPTY, facts = [];
  const { removed: lostNumbers, added: newNumbers } = tokenDiff(old.number.filter(item => !isYear(item)), next.number.filter(item => !isYear(item)), numberKey);
  const unmatched = [...newNumbers];
  for (const item of lostNumbers) {
    const at = unmatched.findIndex(candidate => candidate.unit === item.unit);
    if (at < 0) { facts.push({ class: "number", change: "removed", old: item.raw, new: null }); continue; }
    facts.push({ class: "number", change: "changed", old: item.raw, new: unmatched[at].raw });
    unmatched.splice(at, 1);
  }
  for (const item of unmatched) facts.push({ class: "number", change: "added", old: null, new: item.raw });
  // A never-do is about how many prohibitions the line holds, not their wording.
  const never = payload => payload.negation.filter(item => item.kind !== "exception");
  const lostNever = never(old).length - never(next).length;
  if (lostNever < 0) facts.push({ class: "negation", change: "added", old: null, new: clauses(after, never(next)) });
  else if (lostNever > 0) facts.push({ class: "negation", change: "removed", old: clauses(before, never(old)), new: null });
  const lists = {
    condition: payload => [...payload.condition, ...payload.negation.filter(item => item.kind === "exception")].map(plain),
    restriction: payload => payload.restriction.map(plain),
    uncertainty: payload => payload.uncertainty.map(plain),
    scope: payload => payload.scope.map(canonical),
    attribution: payload => payload.attribution.filter(item => item.kind === "source").map(canonical),
  };
  for (const [name, list] of Object.entries(lists)) {
    const { removed, added } = tokenDiff(list(old), list(next), item => item.key);
    const pairs = Math.min(removed.length, added.length);
    for (let k = 0; k < pairs; k++) facts.push({ class: name, change: "changed", old: removed[k].raw, new: added[k].raw });
    for (const item of removed.slice(pairs)) facts.push({ class: name, change: "removed", old: item.raw, new: null });
    for (const item of added.slice(pairs)) facts.push({ class: name, change: "added", old: null, new: item.raw });
  }
  return facts;
}

function uniqueFacts(list) {
  const seen = new Set();
  return list.filter(fact => { const key = `${fact.class}\u0000${fact.change}\u0000${fact.old}\u0000${fact.new}`; return !seen.has(key) && seen.add(key); });
}

// Sentence-level diff of one edited unit: which lines changed, came, or went, and their payload facts.
function sentenceChanges(oldUnit, newUnit) {
  const olds = unitPieces(oldUnit), news = unitPieces(newUnit);
  const oldSets = olds.map(wordSet), newSets = news.map(wordSet);
  const steps = diffRuns(olds.map(sentenceKey), news.map(sentenceKey), (o, n) => dice(oldSets[o], newSets[n]), SENTENCE_MATCH);
  const result = { oldQuotes: [], newQuotes: [], facts: [], counts: { added: 0, removed: 0, changed: 0 } };
  for (const step of steps) {
    if (step.same) continue;
    const before = step.old === null ? null : olds[step.old], after = step.new === null ? null : news[step.new];
    if (before) result.oldQuotes.push(before);
    if (after) result.newQuotes.push(after);
    result.counts[before && after ? "changed" : after ? "added" : "removed"] += 1;
    result.facts.push(...factsOf(before, after));
  }
  return result;
}

// A unit that came or went whole: its facts, and the lines that carry them (else its first line) to pin.
function wholeChanges(unit, side) {
  const pieces = unitPieces(unit), facts = [], quotes = [];
  for (const piece of pieces) {
    const found = side === "new" ? factsOf(null, piece) : factsOf(piece, null);
    if (found.length) quotes.push(piece);
    facts.push(...found);
  }
  return { quotes, facts, count: pieces.length };
}

const sideOf = (unit, stops) => ({
  elementId: unit.elementId, kind: unit.kind, raw: unit.raw, line: unit.line, endLine: unit.endLine,
  sectionId: unit.sectionId, headings: unit.headings, stops,
});

// Pins do not reach raw blocks, so a folded table keeps its head row and its changed rows by hand.
function keepRows(unit, stops, quotes) {
  if (unit.raw !== "table" || !quotes.length) return;
  const lines = unit.markdown.split("\n"), wanted = new Set(quotes);
  const rows = lines.slice(2).filter(line => wanted.has(line.trim())), cut = [...lines.slice(0, 2), ...rows].join("\n");
  for (const stop of ["brief", "key", "takeaway"]) if (!rows.every(row => stops[stop].includes(row))) stops[stop] = cut;
}

/**
 * Folds `newMarkdown` against `oldMarkdown` and keeps only what changed, in reading order of the new edition
 * (a gone unit sits where it stood). Each change carries both sides' local stops, with its changed lines pinned
 * through Takeaway; at Topic a change with payload facts shows only those facts.
 * `options.pins` are the reader's own pins on the new edition (`{ line, quote? }`).
 */
export function foldEdition(oldMarkdown, newMarkdown, options = {}) {
  const oldSource = typeof oldMarkdown === "string" ? oldMarkdown : "", newSource = typeof newMarkdown === "string" ? newMarkdown : "";
  const oldUnits = extractUnits(oldSource), newUnits = extractUnits(newSource);
  const anchors = commonPairs(oldUnits.map(unit => unit.hash), newUnits.map(unit => unit.hash));
  const anchoredOld = new Uint8Array(oldUnits.length), anchoredNew = new Uint8Array(newUnits.length);
  for (const [o, n] of anchors) { anchoredOld[o] = 1; anchoredNew[n] = 1; }
  // Moved: the same unit elsewhere, formatting aside. Nothing in it changed, so it stays out.
  // Gap numbers tell a real move from a unit only reformatted where it stood.
  const gapOld = new Uint32Array(oldUnits.length), gapNew = new Uint32Array(newUnits.length);
  for (let gap = 0, i = 0, j = 0; gap <= anchors.length; gap++) {
    const [o, n] = anchors[gap] ?? [oldUnits.length, newUnits.length];
    for (; i <= o && i < oldUnits.length; i++) gapOld[i] = gap;
    for (; j <= n && j < newUnits.length; j++) gapNew[j] = gap;
  }
  const looseKey = unit => `${groupOf(unit)}\u0000${sentenceKey(unit.markdown)}`, loose = new Map();
  oldUnits.forEach((unit, index) => { if (!anchoredOld[index]) { const key = looseKey(unit), list = loose.get(key); if (list) list.push(index); else loose.set(key, [index]); } });
  let moved = 0, reformatted = 0;
  newUnits.forEach((unit, index) => {
    const list = anchoredNew[index] ? undefined : loose.get(looseKey(unit));
    if (!list?.length) return;
    const old = list.shift();
    anchoredOld[old] = 2; anchoredNew[index] = 2;
    if (gapOld[old] === gapNew[index]) reformatted += 1; else moved += 1;
  });
  const sets = new Map(), setOf = unit => { let set = sets.get(unit); if (!set) sets.set(unit, set = wordSet(unit.markdown)); return set; };
  const score = (o, n) => groupOf(oldUnits[o]) === groupOf(newUnits[n]) ? dice(setOf(oldUnits[o]), setOf(newUnits[n])) : 0;
  const steps = [];
  let lastOld = 0, lastNew = 0;
  for (const [o, n] of [...anchors, [oldUnits.length, newUnits.length]]) {
    const olds = [], news = [];
    for (let i = lastOld; i < o; i++) if (!anchoredOld[i] && !isHiddenUnit(oldUnits[i])) olds.push(i);
    for (let j = lastNew; j < n; j++) if (!anchoredNew[j] && !isHiddenUnit(newUnits[j])) news.push(j);
    steps.push(...pairRuns(olds, news, score, UNIT_MATCH));
    lastOld = o + 1; lastNew = n + 1;
  }
  const oldPins = [], newPins = [...(options.pins ?? [])], drafts = [];
  let unchanged = anchors.length + moved + reformatted;
  for (const step of steps) {
    const before = step.old === null ? null : oldUnits[step.old], after = step.new === null ? null : newUnits[step.new];
    if (before && after) {
      const diff = sentenceChanges(before, after);
      // Only formatting moved (emphasis, a link target, spacing): the reader learns nothing new.
      if (!diff.counts.added && !diff.counts.removed && !diff.counts.changed) { unchanged += 1; continue; }
      for (const quote of diff.oldQuotes) oldPins.push({ line: before.line, quote });
      for (const quote of diff.newQuotes) newPins.push({ line: after.line, quote });
      drafts.push({ kind: "changed", old: step.old, new: step.new, facts: uniqueFacts(diff.facts), sentences: diff.counts, oldQuotes: diff.oldQuotes, newQuotes: diff.newQuotes });
      continue;
    }
    const unit = before ?? after, side = before ? "old" : "new", whole = wholeChanges(unit, side);
    const pins = before ? oldPins : newPins;
    if (whole.quotes.length) for (const quote of whole.quotes) pins.push({ line: unit.line, quote });
    else pins.push({ line: unit.line });
    drafts.push({
      kind: before ? "removed" : "added", old: step.old, new: step.new, facts: uniqueFacts(whole.facts),
      sentences: { added: after ? whole.count : 0, removed: before ? whole.count : 0, changed: 0 },
      oldQuotes: before ? whole.quotes : [], newQuotes: after ? whole.quotes : [],
    });
  }
  const oldLadder = foldDocumentLadder(oldSource, { units: oldUnits, pins: oldPins });
  const newLadder = foldDocumentLadder(newSource, { units: newUnits, pins: newPins });
  const shown = Object.fromEntries(STOP_IDS.map(stop => [stop, 0]));
  const stopsOf = (units, ladder, index, quotes, factful) => {
    const stops = { ...ladder.byUnit[index].stops };
    keepRows(units[index], stops, quotes);
    stops.topic = factful ? "" : stops.takeaway;
    return stops;
  };
  const changes = drafts.map(draft => {
    const factful = draft.facts.length > 0;
    const old = draft.old === null ? null : sideOf(oldUnits[draft.old], stopsOf(oldUnits, oldLadder, draft.old, draft.oldQuotes, factful));
    const next = draft.new === null ? null : sideOf(newUnits[draft.new], stopsOf(newUnits, newLadder, draft.new, draft.newQuotes, factful));
    const main = next ?? old;
    for (const stop of STOP_IDS) shown[stop] += words(main.stops[stop]);
    return { kind: draft.kind, old, new: next, facts: draft.facts, sentences: draft.sentences };
  });
  const counts = { added: 0, removed: 0, changed: 0, unchanged, moved };
  for (const change of changes) counts[change.kind] += 1;
  return { changes, counts, total: newLadder.total, shown };
}
