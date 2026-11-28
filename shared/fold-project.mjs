// Glass projection for the Fold view: where every mark sits at each local stop.
// Marks are projected, never copied: a mark rides its own line while that line shows,
// otherwise it is counted at the line that absorbed it ("fuera del pliegue"). Pure ESM.

const STOP_COUNT = 5;

/** Letters and digits only, lower-cased: rendered text and its Markdown source compare equal. */
export function squash(text) {
  return String(text ?? "").normalize("NFC").toLowerCase()
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Indexes of the sentences a quote covers, in order. A quote shorter than two letters pins nothing. */
export function quoteSentences(list, quote) {
  const needle = squash(quote);
  if (needle.length < 2) return [];
  const offsets = [];
  let joined = "";
  for (const sentence of list) { offsets.push(joined.length); joined += squash(sentence); }
  const at = joined.indexOf(needle);
  if (at < 0) return [];
  const end = at + needle.length, hit = [];
  for (let index = 0; index < list.length; index++) {
    const from = offsets[index], to = index + 1 < list.length ? offsets[index + 1] : joined.length;
    if (to > from && from < end && to > at) hit.push(index);
  }
  return hit;
}

/** The unit holding a source line: the last unit starting at or before it whose span reaches it. */
export function unitAtLine(units, line) {
  if (typeof line !== "number") return -1;
  let found = -1;
  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    if (unit.line > line) break;
    if (line <= (unit.endLine ?? unit.line)) found = index;
  }
  return found;
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

/**
 * Where each mark shows for one layout.
 * units: [{ line, endLine, sectionId }]; present[i]: unit i shows.
 * marks: [{ id, kind: "highlight" | "ink" | "sticky" | "magnet", line: number | null }]
 * shown(mark, unit): whether a highlight's own words show; other kinds ride their unit.
 */
export function projectAt(units, marks, present, shown = () => true) {
  // The line that absorbs a dropped unit: the nearest shown line above it, else the first below.
  const absorbing = index => {
    for (let at = index; at >= 0; at--) if (present[at]) return at;
    for (let at = index + 1; at < units.length; at++) if (present[at]) return at;
    return -1;
  };
  const deckHost = new Map();
  const deckOf = index => {
    const section = units[index].sectionId ?? null;
    if (!deckHost.has(section)) deckHost.set(section, units.findIndex((unit, at) => present[at] && (unit.sectionId ?? null) === section));
    return deckHost.get(section);
  };
  const own = new Map(), out = new Map(), decks = new Map(), words = new Map(), orphans = [];
  let count = 0;
  for (const mark of marks) {
    const index = unitAtLine(units, mark.line);
    if (index < 0) { orphans.push(mark); continue; }
    if (mark.kind === "sticky") { push(words, absorbing(index), mark); count += 1; continue; }
    const visible = present[index] && (mark.kind !== "highlight" || shown(mark, index));
    if (!visible) { push(out, absorbing(index), mark); continue; }
    count += 1;
    if (mark.kind === "magnet") push(decks, deckOf(index), mark);
    else push(own, index, mark);
  }
  return { own, out, decks, words, orphans, ticks: { shown: count, total: marks.length } };
}

/** projectAt for each local stop. units carry `present: boolean[5]`; shown(mark, unit, stop). */
export function projectMarks(units, marks, shown = () => true) {
  const stops = [];
  for (let stop = 0; stop < STOP_COUNT; stop++)
    stops.push(projectAt(units, marks, units.map(unit => unit.present[stop] === true), (mark, unit) => shown(mark, unit, stop)));
  return stops;
}
