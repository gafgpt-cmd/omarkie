// Fold chunking and content-hash cache keys (design §4.3). Pure ESM (Node + browser): no disk, network, or clock.
// A chunk is the unit of one model call and one cache file: ≤ CHUNK_LIMIT units, a section below the limit is never split.

import { FOLD_FORMAT, FOLD_VERSION } from "./fold-format.mjs";
import { sha256, toFoldUnit } from "./fold-units.mjs";

export const CHUNK_LIMIT = 12;
export const CHUNK_KEY_VERSION = 1;
const KEY_TAG = "omarkie/fold-chunk";
const KEY_FIELDS = ["schemaVersion", "promptVersion", "slot", "route", "agent", "model", "outLang"];
const LADDER_STOPS = ["key", "takeaway", "topic"];

// Boundaries come from headings only, so editing body text never moves a chunk edge. One heading in four (by
// content hash) opens a new chunk: an inserted or deleted unit re-packs at most up to the next such heading.
const opensChunk = heading => parseInt(heading.hash.slice(0, 8), 16) % 4 === 0;

function sectionsOf(units) {
  const sections = [];
  let current = null;
  for (const unit of units) {
    if (unit.kind === "heading" || !current) sections.push(current = []);
    current.push(unit);
  }
  return sections;
}

/**
 * Splits document-ordered units into chunks. A section is a heading plus everything up to the next heading
 * (or the units before the first heading). Sections pack together up to the limit; a section over the limit
 * becomes its own run of full slices and never shares a chunk.
 */
export function chunkUnits(units, limit = CHUNK_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Chunk limit must be a positive integer.");
  const groups = [];
  let open = null;
  for (const section of sectionsOf(units)) {
    if (section.length > limit) {
      for (let start = 0; start < section.length; start += limit) groups.push(section.slice(start, start + limit));
      open = null;
      continue;
    }
    const anchored = section[0].kind === "heading" && opensChunk(section[0]);
    if (!open || anchored || open.length + section.length > limit) groups.push(open = []);
    open.push(...section);
  }
  return groups.map((group, index) => ({
    index,
    unitIds: group.map(unit => unit.elementId),
    sectionIds: group.filter(unit => unit.kind === "heading").map(unit => unit.elementId),
    hashes: group.map(unit => unit.hash),
  }));
}

/** Must-keep pins of one chunk as `[position in chunk, NFC quote]`, sorted: positional, so duplicate-text units cannot swap pins. */
export function chunkPins(chunk, pins = []) {
  const position = new Map(chunk.unitIds.map((id, index) => [id, index]));
  const seen = new Set();
  const out = [];
  for (const pin of pins) {
    const at = position.get(pin?.elementId);
    const quote = typeof pin?.quote === "string" ? pin.quote.normalize("NFC").trim() : "";
    if (at === undefined || !quote) continue;
    const id = `${at}\u0001${quote}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push([at, quote]);
  }
  return out.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

function settingsProblems(settings) {
  const problems = [];
  for (const field of KEY_FIELDS) {
    const value = settings?.[field];
    if (field === "agent") { if (value !== undefined && typeof value !== "string") problems.push("agent"); continue; }
    if (field.endsWith("Version") ? !(Number.isSafeInteger(value) && value >= 1) : !(typeof value === "string" && value)) problems.push(field);
  }
  return problems;
}

/** `sha256(schemaVersion, promptVersion, slot, route, agent, model, outLang, unitHashes[], pins[])` as canonical JSON. */
export function chunkKey(settings, hashes, pins = []) {
  const problems = settingsProblems(settings);
  if (problems.length) throw new TypeError(`Fold chunk key needs ${problems.join(", ")}.`);
  return sha256(JSON.stringify([
    KEY_TAG, CHUNK_KEY_VERSION,
    ...KEY_FIELDS.map(field => settings[field] ?? null),
    [...hashes], pins,
  ]));
}

/** Chunks with their cache keys for one note version, settings and pin set. */
export function planChunks(units, settings, pins = [], limit = CHUNK_LIMIT) {
  return chunkUnits(units, limit).map(chunk => {
    const chunkPinList = chunkPins(chunk, pins);
    return { ...chunk, pins: chunkPinList, key: chunkKey(settings, chunk.hashes, chunkPinList) };
  });
}

/** Queue order: the chunk holding `visibleId` first, the rest in document order. */
export function queueOrder(chunks, visibleId) {
  const first = visibleId ? chunks.findIndex(chunk => chunk.unitIds.includes(visibleId)) : -1;
  return first <= 0 ? [...chunks] : [chunks[first], ...chunks.slice(0, first), ...chunks.slice(first + 1)];
}

/** True when two fold metas name the same writer, so stored lines may be shown under the newer meta. */
export function sameWriter(a, b) {
  return Boolean(a && b) && KEY_FIELDS.every(field => (a[field] ?? null) === (b[field] ?? null));
}

// A cached record's unit ids may predate a duplicate-text ordinal shift; its key pins the hash sequence,
// so positions map record ids onto the current ids.
function remapRecord(record, chunk) {
  const ids = new Map(record.units.map((unit, index) => [unit.elementId, chunk.unitIds[index]]));
  const id = value => ids.get(value) ?? value;
  const line = value => value.by === "model"
    ? { ...value, evidence: value.evidence.map(entry => ({ ...entry, elementId: id(entry.elementId) })) }
    : value;
  return {
    written: record.written.map(entry => ({
      ...entry, elementId: id(entry.elementId),
      ...Object.fromEntries(LADDER_STOPS.map(stop => [stop, line(entry[stop])])),
    })),
    sections: record.sections.map(entry => ({ ...entry, elementId: id(entry.elementId), takeaway: line(entry.takeaway), topic: line(entry.topic) })),
  };
}

/** One ladder fold record; a cache file holds the chunk's units only, `fold.json` all of them (`foldProblems` accepts both). */
export function foldRecord(meta, units, written, sections) {
  return {
    format: FOLD_FORMAT,
    version: FOLD_VERSION,
    meta: { ...meta },
    units: units.map(toFoldUnit),
    written,
    sections,
    estudio: null,
  };
}

// An element id survives whitespace-only edits that can shift offsets: a carried line stays only while its quotes fit.
function quotesFit(line, textOf) {
  return line.by !== "model" || line.evidence.every(entry => {
    const text = textOf.get(entry.elementId);
    return typeof text === "string"
      && (text.slice(entry.start, entry.end) === entry.quote || text.normalize("NFC").slice(entry.start, entry.end) === entry.quote);
  });
}

/**
 * The note's ladder fold over the current units (`DocumentUnit`s): lines from each chunk's cache record when its key
 * is fresh, otherwise the previous fold's lines for units that still exist (stale, shown muted until re-run).
 */
export function assembleFold(meta, units, chunks, records, previous = null) {
  const carry = previous && sameWriter(previous.meta, meta) ? previous : null;
  const textOf = new Map(units.map(unit => [unit.elementId, unit.text]));
  const carriedWritten = new Map((carry?.written ?? [])
    .filter(entry => LADDER_STOPS.every(stop => quotesFit(entry[stop], textOf)))
    .map(entry => [entry.elementId, entry]));
  const carriedSections = new Map((carry?.sections ?? [])
    .filter(entry => quotesFit(entry.takeaway, textOf) && quotesFit(entry.topic, textOf))
    .map(entry => [entry.elementId, entry]));
  const written = [];
  const sections = [];
  for (const chunk of chunks) {
    const record = records.get(chunk.key);
    if (record) {
      const mapped = remapRecord(record, chunk);
      written.push(...mapped.written);
      sections.push(...mapped.sections);
      continue;
    }
    for (const id of chunk.unitIds) {
      if (carriedWritten.has(id)) written.push(carriedWritten.get(id));
      if (carriedSections.has(id)) sections.push(carriedSections.get(id));
    }
  }
  return foldRecord(meta, units, written, sections);
}
