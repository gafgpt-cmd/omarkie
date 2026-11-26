// Glass storage core: names, hybrid logical clock, journal and note replay.
// No file system here; electron/glass-service.mjs owns disk, this module stays testable.

export const glassVersion = 1;
// Anchors are additive: version 1 is a single block landmark, 2 is the six-tier stack.
export const anchorVersion = 2;
const anchorKinds = new Set(["block", "fingerprint", "quote", "heading", "neighbours", "position", "spot"]);

export function validAnchor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { version, landmarks } = value;
  if (version !== undefined && version !== 1 && version !== 2) return false;
  if (!Array.isArray(landmarks) || !landmarks.length || landmarks.length > 12) return false;
  return landmarks.every(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !anchorKinds.has(item.kind)) return false;
    if (item.kind === "block") return typeof item.block === "string" && item.block.length <= 262_144
      && Array.isArray(item.headings) && item.headings.length <= 12 && item.headings.every(heading => typeof heading === "string" && heading.length <= 512);
    const value = item.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    switch (item.kind) {
      case "fingerprint": return typeof value.tag === "string" && value.tag.length <= 64 && typeof value.hash === "string" && value.hash.length <= 64;
      case "quote": return typeof value.exact === "string" && value.exact.length <= 262_144
        && typeof value.prefix === "string" && value.prefix.length <= 256 && typeof value.suffix === "string" && value.suffix.length <= 256;
      case "heading": return Array.isArray(value.path) && value.path.length <= 12 && value.path.every(heading => typeof heading === "string" && heading.length <= 512);
      case "neighbours": return (value.before === undefined || typeof value.before === "string") && (value.after === undefined || typeof value.after === "string");
      case "position": return [value.line, value.char, value.word, value.percent].every(number => typeof number === "number" && Number.isFinite(number));
      case "spot": return [value.x, value.y, value.px, value.py].every(number => typeof number === "number" && Number.isFinite(number));
      default: return false;
    }
  });
}
export const nameByteLimit = 120;
// Sticky paper colours: six, shape-cued by a corner mark so colour is never the only signal.
export const stickyColors = ["yellow", "rose", "blue", "green", "violet", "slate"];
const reserved = new Set(["con", "prn", "aux", "nul",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(unit => [`com${unit}`, `lpt${unit}`])]);
const forbidden = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;

export function truncateBytes(text, limit) {
  let bytes = 0, end = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character);
    if (bytes + width > limit) break;
    bytes += width;
    end += character.length;
  }
  return text.slice(0, end);
}

// Strictest of Windows and exFAT, on every drive; the id, not this name, decides identity.
export function sanitizeTitle(value) {
  let name = String(value ?? "").normalize("NFC").replace(forbidden, "-").replace(/\s+/g, " ").trim();
  name = name.replace(/^\.+/, "").replace(/[. ]+$/, "").trim();
  if (!name || name === "." || name === "..") name = "note";
  if (reserved.has(name.split(".")[0].replace(/[ .]+$/, "").toLowerCase())) name = `_${name}`;
  return truncateBytes(name, nameByteLimit) || "note";
}

export function glassFileName(title, id) {
  if (!/^[a-z0-9]{4,32}$/.test(id)) throw new Error("Invalid glass note id.");
  const suffix = ` ~${id}.jsonl`;
  return `${truncateBytes(sanitizeTitle(title), nameByteLimit - Buffer.byteLength(suffix)) || "note"}${suffix}`;
}

export function newMagnetId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const clockPattern = /^([0-9a-f]{1,16})-([0-9a-f]{1,8})$/;

export function parseClock(value) {
  const match = clockPattern.exec(String(value ?? ""));
  return match ? { t: Number.parseInt(match[1], 16), c: Number.parseInt(match[2], 16) } : null;
}

// Fixed-width sort key: wall, then counter, then device. Legacy short clocks compare correctly
// without rewriting them, so a journal written by an older build keeps its bytes.
export function hlcKey(hlc, device) {
  const parsed = parseClock(hlc);
  if (!parsed) return null;
  return `${parsed.t.toString(16).padStart(16, "0")}-${parsed.c.toString(16).padStart(8, "0")}-${String(device ?? "")}`;
}

const opIdSource = ["device", "hlc", "op", "magnetId", "field"];

function fnv1a(text, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// Identity of one operation: device + HLC + op + magnet + field. Two lines with the same
// identity are the same write, so union merges and sync copies stay idempotent.
export function journalOpId(record = {}) {
  const text = opIdSource.map(key => `${key}\u0001${String(record[key] ?? "")}`).join("\u0000");
  return `${fnv1a(text, 0x811c9dc5)}${fnv1a(`${text}\u0002`, 0x9e3779b9)}`;
}

const opIdPattern = /^[A-Za-z0-9_-]{8,128}$/;

function opIdOf(record) {
  if (typeof record.opId === "string" && opIdPattern.test(record.opId)) return record.opId;
  return parseClock(record.hlc) ? journalOpId(record) : null;
}

// Key-order-independent payload, so a re-serialized duplicate is still a duplicate.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function payloadOf(record) {
  const { opId: _ignored, ...rest } = record;
  return canonicalJson(rest);
}

// One pass groups lines by op id. A repeated id with a different payload is quarantined whole:
// no copy is applied, because either could be the corrupted one and merge order is arbitrary.
function collectRecords(lines) {
  const entries = new Map(), plain = [], quarantined = [];
  const seenLines = new Set();
  let invalid = 0, duplicates = 0, order = 0;
  for (const line of lines) {
    const position = order++;
    if (!line.trim()) continue;
    if (conflictLine.test(line)) { invalid += 1; quarantined.push({ reason: "conflict-marker", line }); continue; }
    if (seenLines.has(line)) { duplicates += 1; continue; }
    seenLines.add(line);
    let record;
    try { record = JSON.parse(line); } catch { invalid += 1; quarantined.push({ reason: "unparsable", line }); continue; }
    if (!record || typeof record !== "object" || Array.isArray(record)) { invalid += 1; quarantined.push({ reason: "unparsable", line }); continue; }
    const id = opIdOf(record);
    if (!id) { plain.push({ record, line, order: position }); continue; }
    const entry = entries.get(id);
    if (!entry) { entries.set(id, { id, order: position, record, line, payloads: new Map([[payloadOf(record), line]]) }); continue; }
    const payload = payloadOf(record);
    if (entry.payloads.has(payload)) { duplicates += 1; continue; }
    entry.payloads.set(payload, line);
  }
  const records = [...plain];
  for (const entry of entries.values()) {
    if (entry.payloads.size > 1) {
      quarantined.push({ reason: "op-id-conflict", opId: entry.id, lines: [...entry.payloads.values()] });
      continue;
    }
    records.push({ record: entry.record, line: entry.line, order: entry.order });
  }
  records.sort((left, right) => left.order - right.order);
  return { records, quarantined, duplicates, invalid };
}

const secretKey = /(?:token|secret|password|passphrase|credential|oauth)/i;

// The vault syncs to every device and backup; a credential belongs in the OS keychain.
export function assertNoStoreSecrets(value, where = "Glass settings") {
  const visit = (node, trail) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((item, index) => visit(item, `${trail}[${index}]`)); return; }
    for (const [key, item] of Object.entries(node)) {
      if (secretKey.test(key)) throw new Error(`${where} must not store ${key}; secrets live in the OS keychain, never in the vault.`);
      visit(item, `${trail}.${key}`);
    }
  };
  visit(value, where);
}

export function createClock(device, now = Date.now) {
  let t = 0, c = 0;
  let range = 0;
  return {
    device,
    next() {
      const wall = now();
      // A clock far behind observed peers never jumps; a clock far ahead keeps order.
      if (wall > t) { t = wall; c = 0; } else c += 1;
      range += 1;
      return `${t.toString(16)}-${c.toString(16)}`;
    },
    observe(value) {
      const seen = parseClock(value);
      if (!seen) return false;
      if (seen.t > t) { t = seen.t; c = seen.c; }
      else if (seen.t === t && seen.c > c) c = seen.c;
      return true;
    },
    get top() { return { t, c, range }; },
  };
}

// A peer's clock far ahead of this machine is not a fact about when a change happened.
export const clockSkewLimit = 5 * 60_000;

export function clockSkew(hlc, now = Date.now(), limit = clockSkewLimit) {
  const parsed = parseClock(hlc);
  if (!parsed) return { aheadMs: 0, behindMs: 0, unknown: true };
  const aheadMs = parsed.t - now;
  return { aheadMs: Math.max(0, aheadMs), behindMs: Math.max(0, -aheadMs), unknown: aheadMs > limit };
}

export function isNewer(hlc, device, current) {
  if (!current) return true;
  const left = hlcKey(hlc, device), right = hlcKey(current.hlc, current.device);
  if (!left) return false;
  if (!right) return true;
  return left > right;
}

export const conflictLine = /^(?:<<<<<<<|=======|>>>>>>>)/;

export function parseJournalText(text) {
  const lines = [], incomplete = [];
  if (!text) return { lines, incomplete };
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n", start);
    if (end < 0) break;
    lines.push(text.slice(start, end).replace(/\r$/, ""));
    start = end + 1;
  }
  if (start < text.length) incomplete.push(text.slice(start));
  return { lines, incomplete };
}

export function replayJournalText(text) {
  const { lines, incomplete } = parseJournalText(text);
  const { records, quarantined, duplicates, invalid: badLines } = collectRecords(lines);
  const magnets = new Map(), layers = new Map(), unknown = [];
  const clocks = [];
  let invalid = badLines;
  for (const { record, line } of records) {
    if (record.op === "layer") {
      if (typeof record.layer !== "string" || !record.layer || record.layer.length > 40) { invalid += 1; quarantined.push({ reason: "invalid-layer", line }); continue; }
      const hlc = record.hlc, device = typeof record.device === "string" ? record.device : "";
      if (!parseClock(hlc)) { invalid += 1; quarantined.push({ reason: "invalid-clock", line }); continue; }
      if (!["visible", "locked", "opacity"].includes(record.field)) { invalid += 1; quarantined.push({ reason: "invalid-layer", line }); continue; }
      clocks.push(hlc);
      let fields = layers.get(record.layer);
      if (!fields) { fields = new Map(); layers.set(record.layer, fields); }
      if (isNewer(hlc, device, fields.get(record.field))) fields.set(record.field, { value: record.value, hlc, device });
      continue;
    }
    if (record.op !== "set" && record.op !== "del" && record.op !== "delete" && record.op !== "restore") {
      if (parseClock(record.hlc)) clocks.push(record.hlc);
      unknown.push(record);
      continue;
    }
    if (typeof record.magnetId !== "string" || !record.magnetId || record.magnetId.length > 200) {
      invalid += 1; quarantined.push({ reason: "invalid-op", line }); continue;
    }
    const hlc = record.hlc, device = typeof record.device === "string" ? record.device : "";
    if (!parseClock(hlc)) { invalid += 1; quarantined.push({ reason: "invalid-clock", line }); continue; }
    clocks.push(hlc);
    // A tombstone keeps its clock after an undo, so a delete merged in later by an older
    // device can never resurrect it; the newest delete/restore event wins. A field set never
    // clears a tombstone: only an explicit restore does.
    if (record.op === "delete") {
      const magnet = magnetOf(magnets, record.magnetId);
      if (isNewer(hlc, device, magnet.deleted)) magnet.deleted = { hlc, device, active: true };
      continue;
    }
    if (record.op === "restore") {
      const magnet = magnetOf(magnets, record.magnetId);
      if (isNewer(hlc, device, magnet.deleted)) magnet.deleted = { hlc, device, active: false };
      continue;
    }
    if (typeof record.field !== "string" || !record.field || record.field.length > 200) {
      invalid += 1; quarantined.push({ reason: "invalid-field", line }); continue;
    }
    const magnet = magnetOf(magnets, record.magnetId);
    const current = magnet.fields.get(record.field);
    if (!isNewer(hlc, device, current)) continue;
    magnet.fields.set(record.field, record.op === "del"
      ? { value: null, removed: true, hlc, device }
      : { value: record.value, removed: false, hlc, device });
  }
  return { magnets, layers, lines, unknown, invalid, duplicates, incomplete: incomplete.length, clocks, quarantined };
}

function magnetOf(magnets, id) {
  let magnet = magnets.get(id);
  if (!magnet) { magnet = { id, fields: new Map(), deleted: null }; magnets.set(id, magnet); }
  return magnet;
}

export function magnetView(magnet) {
  const fields = {};
  for (const [field, entry] of magnet.fields) if (!entry.removed) fields[field] = entry.value;
  return { id: magnet.id, fields, kind: fields.kind ?? null, deleted: !!magnet.deleted?.active };
}

export function visibleMagnets(magnets) {
  return [...magnets.values()].filter(magnet => !magnet.deleted?.active).map(magnetView);
}

// notes.jsonl is union-merged by git and by the sync clients, so line order says nothing about
// age: a note snapshot from the other device can land after a newer move. A note's path is
// therefore decided by its newest clocked event, exactly as a magnet field is.
export function replayNotesText(text) {
  const { lines, incomplete } = parseJournalText(text);
  const { records, quarantined, duplicates, invalid: badLines } = collectRecords(lines);
  const byId = new Map(), clockOf = new Map(), pathEvents = [];
  let invalid = badLines, unknown = 0;
  const deviceOf = record => typeof record.device === "string" ? record.device : "";
  const claim = (id, hlc, device) => {
    if (!parseClock(hlc)) return true;
    const current = clockOf.get(id);
    if (current && !isNewer(hlc, device, current)) return false;
    clockOf.set(id, { hlc, device });
    return true;
  };
  for (const { record } of records) {
    if (record.op === "note" && typeof record.id === "string" && typeof record.path === "string") {
      if (!claim(record.id, record.hlc, deviceOf(record))) continue;
      byId.set(record.id, { id: record.id, path: record.path, title: record.title, fingerprint: record.fingerprint,
        hlc: record.hlc, device: record.device });
    } else if (record.op === "folder" && typeof record.from === "string" && typeof record.to === "string") {
      pathEvents.push(record);
    } else if (record.op === "move" && typeof record.id === "string" && typeof record.to === "string") {
      pathEvents.push(record);
    } else unknown += 1;
  }
  // A move of one note and a rename of a folder both claim paths. They apply in clock order once
  // every snapshot is known, so a merge that put the event before its note cannot lose it and a
  // rename still covers a note whose own line merged in after it.
  const keyOf = record => hlcKey(record.hlc, deviceOf(record)) ?? "";
  pathEvents.sort((left, right) => { const a = keyOf(left), b = keyOf(right); return a < b ? -1 : a > b ? 1 : 0; });
  for (const record of pathEvents) {
    if (record.op === "move") {
      const note = byId.get(record.id);
      if (note && claim(note.id, record.hlc, deviceOf(record))) {
        note.path = record.to;
        if (typeof record.title === "string" && record.title) note.title = record.title;
        if (record.fingerprint && typeof record.fingerprint === "object") note.fingerprint = record.fingerprint;
      }
      continue;
    }
    for (const note of byId.values())
      if ((note.path === record.from || note.path.startsWith(`${record.from}/`)) && claim(note.id, record.hlc, deviceOf(record)))
        note.path = `${record.to}${note.path.slice(record.from.length)}`;
  }
  return { notes: byId, invalid, unknown, incomplete: incomplete.length, duplicates, quarantined };
}
