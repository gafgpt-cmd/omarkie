// Estudio engine (design §5.1-5.2, OM-114): the per-chunk check of an Estudio reply and the deterministic merge of
// checked chunk sheets into one sheet. No model call merges: dedupe, caps and order are code, so the same chunk
// sheets give the same sheet whatever order they arrive in.

import { NUMBER_GAP, checkFormat, checkLine, checkPins, countWords } from "./fold-check.mjs";
import {
  ESTUDIO_BLOCKS, ESTUDIO_FORMAT, ESTUDIO_LIMITS, ESTUDIO_REPLY_SCHEMA, ESTUDIO_VERSION,
  anchorQuote, estudioEvidence, estudioShapeProblems, evidenceFits, jsonSchemaProblems,
} from "./fold-format.mjs";

const L = ESTUDIO_LIMITS;
const SEMANTIC = ["negation", "restriction", "condition", "uncertainty", "scope", "attribution"];
const SCHEMA = ESTUDIO_REPLY_SCHEMA.properties;
const DUPLICATE = 0.8;

/** Every quotable element of some units: each unit and each cell of a table unit, with its place in reading order. */
export function estudioElements(units) {
  const elements = new Map();
  units.forEach((unit, index) => {
    elements.set(unit.elementId, { text: unit.text, unitId: unit.elementId, order: index });
    const cells = unit.cells ?? [];
    const headerRow = Math.min(...cells.map(cell => cell.row));
    cells.forEach((cell, at) => elements.set(cell.elementId, { text: cell.text, unitId: unit.elementId, order: index + (at + 1) / (cells.length + 1), row: cell.row, header: cell.row === headerRow }));
  });
  return elements;
}

const evidenceOf = value => estudioEvidence(value).flatMap(([, entries]) => entries);
const overlaps = (a, b) => a.elementId === b.elementId && a.start < b.end && b.start < a.end;
const evidenceKey = entry => `${entry.elementId}\u0001${entry.start}\u0001${entry.end}`;
const unionEvidence = (...lists) => [...new Map(lists.flat().map(entry => [evidenceKey(entry), entry])).values()];

const TEXT_SKIP = new Set(["evidence", "elementId", "quote", "id", "from", "to", "kind"]);
// The words of an item: every text field, ids and quotes left out.
function wordsOf(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach(item => wordsOf(item, out));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) if (!TEXT_SKIP.has(key)) wordsOf(item, out);
  return out;
}
const textOf = value => wordsOf(value).filter(Boolean).join("; ");

const folded = text => String(text ?? "").normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function grams(text) {
  const source = ` ${folded(text)} `, counts = new Map();
  for (let index = 0; index + 3 <= source.length; index++) counts.set(source.slice(index, index + 3), (counts.get(source.slice(index, index + 3)) ?? 0) + 1);
  return counts;
}
/** Dice coefficient of character 3-grams, accents and case folded: 1 is the same words. */
export function dice(a, b) {
  const left = grams(a), right = grams(b);
  let shared = 0, total = 0;
  for (const count of left.values()) total += count;
  for (const [gram, count] of right) { total += count; shared += Math.min(count, left.get(gram) ?? 0); }
  return total ? (2 * shared) / total : 1;
}

/** Two items say the same thing: they quote overlapping words of one element and their words nearly match. */
export const sameItem = (a, b) => evidenceOf(a).some(entry => evidenceOf(b).some(other => overlaps(entry, other))) && dice(textOf(a), textOf(b)) > DUPLICATE;

// --- the chunk check ---

// One grounded line kind: the fields read as one line for payload, the field held to a word cap.
const FLAT = Object.freeze({
  oneLiner: { fields: ["text"], long: ["text", L.oneLinerWords] },
  caso: { fields: ["entity", "text"], long: ["text", L.lineWords] },
  numeros: { fields: ["label", "value", "unit", "consequence"], long: ["consequence", L.lineWords] },
  bullets: { fields: ["text"], long: ["text", L.lineWords] },
  nunca: { fields: ["text", "why"], long: ["text", L.lineWords] },
  buzzwords: { fields: ["term", "concept"], long: ["concept", L.lineWords] },
  cards: { fields: ["q", "a"], long: ["a", L.lineWords] },
  // A gap says what the note does not: it can hold no payload to keep, only numbers and format to check.
  gaps: { fields: ["text"], long: ["text", L.lineWords], plain: true },
  // A table row reads as one line (label plus cells): its payload is checked there, not per cell.
  cell: { fields: ["text"], plain: true },
  node: { fields: ["text"] },
  letter: { fields: ["text"] },
});
const ITEM_SCHEMA = Object.freeze({
  oneLiner: { ...SCHEMA.oneLiner, type: "object" },
  bullets: SCHEMA.bloques.items.properties.bullets.items,
  ...Object.fromEntries(["caso", "numeros", "nunca", "buzzwords", "cards", "gaps"].map(block => [block, SCHEMA[block].items])),
});

function semanticLoss(text, evidence) {
  const result = checkLine(text, evidence);
  const failed = SEMANTIC.filter(cls => result.checks[cls] === "fail");
  return failed.length ? (result.retryTokens.length ? result.retryTokens : failed) : null;
}

// An arrow label names a branch; its nodes carry the payload, so a label may add none of its own.
function addedPayload(text, evidence) {
  const added = checkLine(text, evidence).findings.filter(finding => SEMANTIC.includes(finding.class) && finding.extra?.length).flatMap(finding => finding.extra);
  return added.length ? [...new Set(added)] : null;
}

// Numbers no quote holds become the visible gap "—?"; the field keeps every other word.
const grounded = (text, evidence) => (text ? checkLine(text, evidence).text : text);
const markup = (...texts) => texts.some(text => typeof text === "string" && text && !checkFormat(text).ok);

/**
 * Checks one line item: `{ item }` passes (invented numbers gapped), `{ lost, item }` dropped payload words,
 * `{ long, item }` runs over its word cap, `{ drop }` cannot stand (bad shape, quote, markup).
 */
function checkItem(kind, item, fits, schema = ITEM_SCHEMA[kind]) {
  if (schema && jsonSchemaProblems(schema, item, kind).length) return { drop: "schema" };
  if (!item.evidence.every(fits)) return { drop: "evidence" };
  const spec = FLAT[kind];
  if (markup(...spec.fields.map(field => item[field]))) return { drop: "format" };
  const fixed = { ...item };
  for (const field of spec.fields) if (field !== "value" && field !== "unit") fixed[field] = grounded(item[field], item.evidence);
  if (kind === "numeros" && checkLine(`${item.value} ${item.unit}`.trim(), item.evidence).checks.number === "fail") fixed.value = NUMBER_GAP;
  if (!spec.plain) {
    const lost = semanticLoss(spec.fields.map(field => item[field]).filter(Boolean).join("; "), item.evidence);
    if (lost) return { lost, item: fixed };
  }
  if (spec.long && countWords(fixed[spec.long[0]]) > spec.long[1]) return { long: spec.long[1], item: fixed };
  return { item: fixed };
}

// Reads `parts` (results of checkItem) of one nested item: any drop drops it, any loss retries it.
const nested = parts => ({
  drop: parts.some(part => part.drop),
  lost: parts.some(part => part.lost) ? [...new Set(parts.flatMap(part => part.lost ?? []))] : null,
});

/**
 * Checks one reply against the chunk's elements: the passing items as a sheet, the items to retry (each with its
 * sheet fragment, its lost words or word cap), and the items dropped with the evidence they quoted.
 */
function checkReply(reply, elements) {
  const anchor = value => (Array.isArray(value) ? value.map(anchor)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === "evidence" && Array.isArray(item) ? item.map(entry => anchorQuote(entry, elements.get(entry?.elementId)?.text)) : anchor(item)]))
      : value);
  const fits = entry => evidenceFits(elements.get(entry?.elementId)?.text, entry);
  const sheet = { oneLiner: null, ...Object.fromEntries(ESTUDIO_BLOCKS.map(block => [block, []])) };
  const pending = [], dropped = [];
  const drop = (block, value) => {
    const evidence = unionEvidence(evidenceOf(value).filter(fits));
    if (evidence.length) dropped.push({ block, evidence });
  };
  const hold = (block, fragment, result) => pending.push({
    block, fragment, reason: result.lost ? "lost" : "long",
    retry: { block, text: textOf(fragment), ...(result.lost ? { lost: result.lost } : { words: result.long }) },
  });
  const flat = (block, item, place, fragment) => {
    const result = checkItem(block, item, fits);
    if (result.drop) return drop(block, item);
    if (result.lost || result.long) return hold(block, fragment(result.item), result);
    place(result.item);
  };
  const value = anchor(reply ?? {});
  const list = block => (Array.isArray(value[block]) ? value[block] : []);
  if (value.oneLiner) flat("oneLiner", value.oneLiner, item => { sheet.oneLiner = item; }, item => ({ oneLiner: item }));
  for (const block of ["caso", "numeros", "nunca", "buzzwords", "cards", "gaps"]) {
    for (const item of list(block)) flat(block, item, kept => sheet[block].push(kept), kept => ({ [block]: [kept] }));
  }
  for (const bloque of list("bloques")) {
    if (jsonSchemaProblems({ ...SCHEMA.bloques.items, properties: { ...SCHEMA.bloques.items.properties, bullets: { type: "array" } } }, bloque, "bloque").length) {
      drop("bloques", bloque);
      continue;
    }
    const kept = { kind: bloque.kind, bullets: [] };
    for (const bullet of bloque.bullets) flat("bullets", bullet, item => kept.bullets.push(item), item => ({ bloques: [{ kind: bloque.kind, bullets: [item] }] }));
    if (kept.bullets.length) sheet.bloques.push(kept);
  }
  const whole = (block, item, check) => {
    if (jsonSchemaProblems(SCHEMA[block].items, item, block).length || estudioShapeProblems({ [block]: [item] }).length) return drop(block, item);
    const result = check(item);
    if (result.drop || (result.item && estudioShapeProblems({ [block]: [result.item] }).length)) return drop(block, item);
    if (result.lost) return hold(block, { [block]: [result.item] }, result);
    if (result.item) sheet[block].push(result.item);
  };
  for (const table of list("vs")) {
    whole("vs", table, () => {
      if (markup(table.title, ...table.columns)) return { drop: true };
      const evidence = evidenceOf(table);
      // A header or row label copies the source table's header row or its row's first cell, which no value quotes:
      // the whole cells of those source rows ground them too.
      const sourceCells = test => [...elements].filter(([, element]) => element.row !== undefined && test(element))
        .map(([elementId, element]) => ({ elementId, quote: element.text, start: 0, end: element.text.length }));
      const sourceRows = entries => new Set(entries.map(entry => elements.get(entry.elementId)).filter(element => element?.row !== undefined)
        .map(element => `${element.unitId}\u0001${element.row}`));
      const rows = [];
      for (const row of table.rows) {
        const cells = row.cells.map(cell => checkItem("cell", cell, fits, null));
        const verdict = nested(cells);
        if (verdict.drop || markup(row.label)) { drop("vs", row); continue; }
        const own = sourceRows(evidenceOf(row));
        const rowEvidence = [...evidenceOf(row), ...sourceCells(element => own.has(`${element.unitId}\u0001${element.row}`))];
        const fixed = { ...row, label: grounded(row.label, rowEvidence), cells: cells.map(cell => cell.item) };
        const lost = semanticLoss([row.label, ...row.cells.map(cell => cell.text)].filter(Boolean).join("; "), rowEvidence);
        if (lost) hold("vs", { vs: [{ ...table, rows: [fixed] }] }, { lost });
        else rows.push(fixed);
      }
      const tablesOf = new Set(evidence.map(entry => elements.get(entry.elementId)?.unitId));
      const headers = sourceCells(element => element.header && tablesOf.has(element.unitId));
      return { item: rows.length ? { title: grounded(table.title, evidence), columns: table.columns.map(column => grounded(column, [...evidence, ...headers])), rows } : null };
    });
  }
  for (const flow of list("flujo")) {
    whole("flujo", flow, () => {
      if (markup(flow.title, ...flow.edges.map(edge => edge.label))) return { drop: true };
      const nodes = flow.nodes.map(node => checkItem("node", node, fits, null));
      const verdict = nested(nodes);
      if (verdict.drop) return { drop: true };
      const byId = new Map(flow.nodes.map(node => [node.id, node]));
      const edges = flow.edges.map(edge => {
        if (!edge.label) return { edge };
        const evidence = [...byId.get(edge.from).evidence, ...byId.get(edge.to).evidence];
        return { edge: { ...edge, label: grounded(edge.label, evidence) }, lost: addedPayload(edge.label, evidence) };
      });
      const lost = verdict.lost || edges.some(edge => edge.lost) ? [...new Set([...(verdict.lost ?? []), ...edges.flatMap(edge => edge.lost ?? [])])] : null;
      return { lost, item: { title: grounded(flow.title, evidenceOf(flow)), nodes: nodes.map(node => node.item), edges: edges.map(edge => edge.edge) } };
    });
  }
  for (const mnemonic of list("mnemonics")) {
    whole("mnemonics", mnemonic, () => {
      if (markup(mnemonic.label, mnemonic.word, ...mnemonic.items.map(item => item.letter))) return { drop: true };
      const items = mnemonic.items.map(item => checkItem("letter", item, fits, null));
      const verdict = nested(items);
      return verdict.drop ? { drop: true } : { lost: verdict.lost, item: { ...mnemonic, items: items.map(item => item.item) } };
    });
  }
  return { sheet, pending, dropped };
}

/**
 * Checks one Estudio chunk (design §4.6 classes on every item): `ask(retry)` returns a reply object, `retry` null
 * first, then the list of refused items. Every item must quote its own unit or table cell word for word. An invented
 * number becomes the gap "—?". An item that dropped payload, or runs over its word cap, is asked for once more by
 * name; payload still lost then drops it (never a fake), a long line stays and counts as long. Markup or a bad quote
 * drops the item. A dropped item keeps its evidence in `checks.dropped`, so the reader can open the source.
 */
export async function checkEstudioChunk(ask, { units, pins = [] }) {
  const elements = estudioElements(units);
  const first = checkReply(await ask(null), elements);
  const parts = [first.sheet], dropped = [...first.dropped];
  if (first.pending.length) {
    const second = checkReply(await ask(first.pending.map(entry => entry.retry)), elements);
    parts.push(second.sheet);
    dropped.push(...second.dropped);
    const answered = [...evidenceOf(second.sheet), ...second.pending.flatMap(entry => evidenceOf(entry.fragment))];
    // A refused item the retry answered (same quoted words) gives way to the answer; else a long line stays as it was.
    const settle = entry => (entry.reason === "long" ? parts.push(entry.fragment) : drop(entry));
    const drop = entry => dropped.push({ block: entry.block, evidence: unionEvidence(evidenceOf(entry.fragment)) });
    for (const entry of first.pending) if (!evidenceOf(entry.fragment).some(quote => answered.some(other => overlaps(quote, other)))) settle(entry);
    for (const entry of second.pending) settle(entry);
  }
  parts.push({ checks: { dropped } });
  const estudio = mergeEstudio(parts, { elements });
  return { estudio, retried: first.pending.length, outOfFold: estudioOutOfFold(estudio, pins) };
}

// --- the merge ---

const starsOf = value => Math.max(value.stars ?? 0, ...(value.rows ?? value.bullets ?? []).map(starsOf), 0);

// Folds later items into the first that says the same thing: higher stars win, evidence joins.
function dedupe(list, same) {
  const kept = [];
  for (const item of list) {
    const at = kept.findIndex(other => same(other, item));
    if (at < 0) kept.push(item);
    else if ("evidence" in item) kept[at] = { ...kept[at], ...("stars" in item ? { stars: Math.max(kept[at].stars, item.stars) } : {}), evidence: unionEvidence(kept[at].evidence, item.evidence) };
    else if ("stars" in item) kept[at] = { ...kept[at], stars: Math.max(kept[at].stars, item.stars) };
  }
  return kept;
}

// Keeps the `limit` most-starred items, ties in reading order, and shows them in reading order.
function capped(list, limit) {
  if (list.length <= limit) return list;
  const keep = new Set(list.map((item, index) => [starsOf(item), index]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, limit).map(([, index]) => index));
  return list.filter((_, index) => keep.has(index));
}

// One line per checked fact: what the badge counts and the length cap reads.
function sheetLines(sheet) {
  const lines = [];
  const flat = (kind, item) => lines.push({ item, long: FLAT[kind].long });
  if (sheet.oneLiner) flat("oneLiner", sheet.oneLiner);
  for (const block of ["caso", "numeros", "nunca", "buzzwords", "cards", "gaps"]) for (const item of sheet[block]) flat(block, item);
  for (const bloque of sheet.bloques) for (const item of bloque.bullets) flat("bullets", item);
  for (const table of sheet.vs) for (const row of table.rows) lines.push({ item: row });
  for (const flow of sheet.flujo) for (const node of flow.nodes) lines.push({ item: node });
  for (const mnemonic of sheet.mnemonics) for (const item of mnemonic.items) lines.push({ item });
  return lines;
}

/**
 * Merges checked sheets (chunk sheets, carried items, retry answers; any block may be missing) into one sheet.
 * With `elements` items sort into reading order by their first quote first, so the arrival order of chunks does not
 * matter. Duplicates (overlapping quotes of one element and 3-gram Dice > 0.8) fold into the first; caps keep the
 * most-starred items; the one-liner is the most-starred, the first on a tie.
 */
export function mergeEstudio(sheets, { elements } = {}) {
  const parts = sheets.filter(Boolean);
  const place = value => {
    let best = [Infinity, Infinity];
    for (const entry of evidenceOf(value)) {
      const at = [elements.get(entry.elementId)?.order ?? Infinity, entry.start];
      if (at[0] < best[0] || (at[0] === best[0] && at[1] < best[1])) best = at;
    }
    return best;
  };
  const ordered = list => (elements
    ? list.map((item, index) => ({ item, index, at: place(item) })).sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.index - b.index).map(entry => entry.item)
    : list);
  const all = block => ordered(parts.flatMap(part => part[block] ?? []));
  const dropped = [...parts.flatMap(part => part.checks?.dropped ?? [])];
  const sameWords = (a, b) => folded(a) === folded(b);

  const tables = [];
  for (const table of all("vs")) {
    const match = tables.find(other => sameWords(other.columns.join("\u0001"), table.columns.join("\u0001")) && dice(other.title, table.title) > DUPLICATE);
    if (match) match.rows.push(...table.rows);
    else tables.push({ ...table, rows: [...table.rows] });
  }
  const vs = [];
  for (const table of tables) {
    const rows = capped(dedupe(table.rows, (a, b) => sameWords(a.label, b.label)), L.vsRows);
    if (rows.length >= 2) vs.push({ ...table, rows });
    else dropped.push({ block: "vs", evidence: unionEvidence(evidenceOf(rows)) });
  }
  const kinds = new Map();
  for (const bloque of all("bloques")) kinds.set(bloque.kind, [...(kinds.get(bloque.kind) ?? []), ...bloque.bullets]);

  const sheet = {
    format: ESTUDIO_FORMAT,
    version: ESTUDIO_VERSION,
    oneLiner: ordered(parts.map(part => part.oneLiner).filter(Boolean)).reduce((best, item) => (!best || item.stars > best.stars ? item : best), null),
    caso: capped(dedupe(all("caso"), (a, b) => sameWords(a.entity, b.entity) || sameItem(a, b)), L.caso),
    vs: capped(vs, L.vs),
    numeros: capped(dedupe(all("numeros"), sameItem), L.numeros),
    flujo: capped(dedupe(all("flujo"), sameItem), L.flujo),
    bloques: [...kinds].map(([kind, bullets]) => ({ kind, bullets: capped(dedupe(ordered(bullets), sameItem), L.bullets) })),
    nunca: capped(dedupe(all("nunca"), sameItem), L.nunca),
    buzzwords: capped(dedupe(all("buzzwords"), (a, b) => sameWords(a.term, b.term) || sameItem(a, b)), L.buzzwords),
    mnemonics: capped(dedupe(all("mnemonics"), (a, b) => sameWords(a.word, b.word)), L.mnemonics),
    cards: capped(dedupe(all("cards"), sameItem), L.cards),
    gaps: capped(dedupe(all("gaps"), sameItem), L.gaps),
  };
  const lines = sheetLines(sheet);
  sheet.checks = {
    lines: lines.length,
    gapped: lines.filter(line => wordsOf(line.item).some(text => text.includes(NUMBER_GAP))).length,
    long: lines.filter(line => line.long && countWords(line.item[line.long[0]]) > line.long[1]).length,
    dropped: [...new Map(dropped.filter(entry => entry.evidence.length).map(entry => [`${entry.block}\u0002${entry.evidence.map(evidenceKey).join("\u0002")}`, entry])).values()],
  };
  return sheet;
}

/**
 * The items of `sheet` whose every quote passes `keep` (a stale carry: quotes that still fit the note). A table keeps
 * its rows that pass; a flow or a mnemonic stays whole or goes. Merge the result to get a sheet.
 */
export function filterEstudio(sheet, keep) {
  const all = value => evidenceOf(value).every(keep);
  return {
    oneLiner: sheet.oneLiner && all(sheet.oneLiner) ? sheet.oneLiner : null,
    ...Object.fromEntries(["caso", "numeros", "nunca", "buzzwords", "cards", "gaps", "flujo", "mnemonics"].map(block => [block, sheet[block].filter(all)])),
    vs: sheet.vs.map(table => ({ ...table, rows: table.rows.filter(all) })).filter(table => table.rows.length >= 2),
    bloques: sheet.bloques.map(bloque => ({ ...bloque, bullets: bloque.bullets.filter(all) })).filter(bloque => bloque.bullets.length),
    checks: { dropped: sheet.checks.dropped.filter(all) },
  };
}

/** Pins no sheet line holds: the reader sees them as out of fold, never silently lost. */
export const estudioOutOfFold = (sheet, pins = []) => (pins.length ? checkPins(textOf(sheet), pins).outOfFold : []);
