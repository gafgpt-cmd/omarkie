// Pre-fold strip: which mark groups the fold keeps through Takeaway, suggested by local rules, chosen by the reader.
// Pure: the view renders it, persists the choice per note, and turns it into pins for the ladder.
import { extractPolarity, isRedFlag } from "./fold-check.mjs";
import { quoteSentences, unitAtLine } from "./fold-project.mjs";
import { unitSentences } from "./fold-units.mjs";

/** Mark groups in strip order. `redflag` is not a mark: unmarked sentences that carry a red flag. */
export const STRIP_GROUPS = Object.freeze(["highlight", "ink", "card", "magnet", "navigation", "redflag"]);
// Suggested: keep what the reader marked and every red flag; labels and arrows point the way, they are not facts.
const SUGGESTED = Object.freeze({ highlight: true, ink: true, card: true, magnet: true, navigation: false, redflag: true });
// Payload a pin may keep that the plain stop drops, most important first.
const KEPT_CLASSES = Object.freeze(["negation", "condition", "restriction", "number"]);
const NUMBER = /\d+(?:[.,]\d+)*/g;

/** The strip group a mark belongs to; stickies fold on their own ("your words") and belong to none. */
export function markGroup(mark) {
  if (mark.kind === "highlight" || mark.kind === "ink") return mark.kind;
  if (mark.kind !== "magnet") return null;
  if (mark.type === "card") return "card";
  return mark.type === "label" || mark.type === "arrow" ? "navigation" : "magnet";
}

/** Pins for every sentence that carries a red flag, as the fold splits sentences. */
export function redFlags(units) {
  const pins = [];
  for (const unit of units) for (const sentence of unitSentences(unit)) if (isRedFlag(sentence)) pins.push({ line: unit.line, quote: sentence });
  return pins;
}

/** Groups with something in them, in strip order: marks on a line, plus red flags. */
export function stripGroups(marks, flags) {
  const counts = new Map(STRIP_GROUPS.map(group => [group, 0]));
  for (const mark of marks) {
    const group = mark.line === null ? null : markGroup(mark);
    if (group) counts.set(group, counts.get(group) + 1);
  }
  counts.set("redflag", flags.length);
  return STRIP_GROUPS.flatMap(group => counts.get(group) ? [{ group, count: counts.get(group) }] : []);
}

/** A stored choice, checked: `seen` once the strip opened for this note, `keep` only where the reader overrode a suggestion. */
export function readChoice(raw) {
  let value = null;
  try { value = typeof raw === "string" ? JSON.parse(raw) : null; } catch { value = null; }
  const keep = {};
  if (value && typeof value.keep === "object" && value.keep) for (const group of STRIP_GROUPS) if (typeof value.keep[group] === "boolean" && value.keep[group] !== SUGGESTED[group]) keep[group] = value.keep[group];
  return { seen: value?.seen === true, keep };
}

export const suggested = group => SUGGESTED[group];
export const keeps = (choice, group) => choice.keep[group] ?? SUGGESTED[group];

/** The choice with these groups kept or let fold; a choice equal to the suggestion stores nothing. */
export function setKeep(choice, groups, value) {
  const keep = { ...choice.keep };
  for (const group of groups) if (value === SUGGESTED[group]) delete keep[group]; else keep[group] = value;
  return { ...choice, keep };
}

/** Pins from the marks of kept groups: a highlight keeps its words, any other mark its line's block. */
export function markPins(marks, choice) {
  const pins = [];
  for (const mark of marks) {
    const group = mark.line === null ? null : markGroup(mark);
    if (!group || !keeps(choice, group)) continue;
    if (mark.kind !== "highlight") pins.push({ line: mark.line });
    else if (mark.quote) pins.push({ line: mark.line, quote: mark.quote });
  }
  return pins;
}

// What the reader would lose, compared word for word: polarity tokens, and numbers as written.
function payloadKeys(text) {
  const polarity = extractPolarity(text), key = token => token.raw.toLowerCase().replace(/\s+/g, " ");
  return {
    negation: polarity.negation.map(key), condition: polarity.condition.map(key), restriction: polarity.restriction.map(key),
    number: text.match(NUMBER) ?? [],
  };
}

/** The first payload class in `evidence` that `plain` drops, or null. */
export function droppedPayload(plain, evidence) {
  const was = payloadKeys(evidence), now = payloadKeys(plain);
  for (const cls of KEPT_CLASSES) {
    const shown = new Set(now[cls]);
    if (was[cls].some(token => !shown.has(token))) return cls;
  }
  return null;
}

/** Per unit index, per stop a pin changed: the payload class the reader's quote pins keep that the plain stop drops. */
export function keptPayload(ladder, pins) {
  const quotes = new Map();
  for (const pin of pins) {
    if (!pin.quote) continue;
    const index = unitAtLine(ladder.units, pin.line);
    if (index >= 0) quotes.set(index, [...quotes.get(index) ?? [], pin.quote]);
  }
  const kept = new Map();
  for (const [index, list] of quotes) {
    const entry = ladder.byUnit[index];
    if (!entry?.plain || !entry.pinned.length) continue;
    const sentences = unitSentences(entry.unit), covered = new Set(list.flatMap(quote => quoteSentences(sentences, quote)));
    if (!covered.size) continue;
    const evidence = [...covered].sort((a, b) => a - b).map(at => sentences[at]).join(" ");
    const byStop = {};
    for (const stop of entry.pinned) { const cls = droppedPayload(entry.plain[stop], evidence); if (cls) byStop[stop] = cls; }
    if (Object.keys(byStop).length) kept.set(index, byStop);
  }
  return kept;
}
