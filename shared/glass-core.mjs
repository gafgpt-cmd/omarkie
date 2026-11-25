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

export function isNewer(hlc, device, current) {
  if (!current) return true;
  const left = parseClock(hlc), right = parseClock(current.hlc);
  if (!left) return false;
  if (!right) return true;
  if (left.t !== right.t) return left.t > right.t;
  if (left.c !== right.c) return left.c > right.c;
  return String(device ?? "") > String(current.device ?? "");
}

const conflictLine = /^(?:<<<<<<<|=======|>>>>>>>)/;

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
  const magnets = new Map(), unknown = [];
  const seen = new Set();
  let invalid = 0, duplicates = 0;
  const clocks = [];
  for (const line of lines) {
    if (!line.trim() || conflictLine.test(line)) { if (line.trim()) invalid += 1; continue; }
    if (seen.has(line)) { duplicates += 1; continue; }
    seen.add(line);
    let record;
    try { record = JSON.parse(line); } catch { invalid += 1; continue; }
    if (!record || typeof record !== "object" || Array.isArray(record)) { invalid += 1; continue; }
    if (record.op !== "set" && record.op !== "del" && record.op !== "delete") {
      if (parseClock(record.hlc)) clocks.push(record.hlc);
      unknown.push(record);
      continue;
    }
    if (typeof record.magnetId !== "string" || !record.magnetId || record.magnetId.length > 200) { invalid += 1; continue; }
    const hlc = record.hlc, device = typeof record.device === "string" ? record.device : "";
    if (!parseClock(hlc)) { invalid += 1; continue; }
    clocks.push(hlc);
    if (record.op === "delete") {
      const magnet = magnetOf(magnets, record.magnetId);
      if (isNewer(hlc, device, magnet.deleted)) magnet.deleted = { hlc, device };
      continue;
    }
    if (typeof record.field !== "string" || !record.field || record.field.length > 200) { invalid += 1; continue; }
    const magnet = magnetOf(magnets, record.magnetId);
    const current = magnet.fields.get(record.field);
    if (!isNewer(hlc, device, current)) continue;
    magnet.fields.set(record.field, record.op === "del"
      ? { value: null, removed: true, hlc, device }
      : { value: record.value, removed: false, hlc, device });
  }
  return { magnets, lines, unknown, invalid, duplicates, incomplete: incomplete.length, clocks };
}

function magnetOf(magnets, id) {
  let magnet = magnets.get(id);
  if (!magnet) { magnet = { id, fields: new Map(), deleted: null }; magnets.set(id, magnet); }
  return magnet;
}

export function magnetView(magnet) {
  const fields = {};
  for (const [field, entry] of magnet.fields) if (!entry.removed) fields[field] = entry.value;
  return { id: magnet.id, fields, kind: fields.kind ?? null, deleted: !!magnet.deleted };
}

export function visibleMagnets(magnets) {
  return [...magnets.values()].filter(magnet => !magnet.deleted).map(magnetView);
}

export function replayNotesText(text) {
  const { lines, incomplete } = parseJournalText(text);
  const byId = new Map();
  const seen = new Set();
  let invalid = 0, unknown = 0;
  for (const line of lines) {
    if (!line.trim() || conflictLine.test(line)) { if (line.trim()) invalid += 1; continue; }
    if (seen.has(line)) continue;
    seen.add(line);
    let record;
    try { record = JSON.parse(line); } catch { invalid += 1; continue; }
    if (!record || typeof record !== "object") { invalid += 1; continue; }
    if (record.op === "note" && typeof record.id === "string" && typeof record.path === "string") {
      byId.set(record.id, { id: record.id, path: record.path, title: record.title, fingerprint: record.fingerprint,
        hlc: record.hlc, device: record.device });
    } else if (record.op === "folder" && typeof record.from === "string" && typeof record.to === "string") {
      for (const note of byId.values())
        if (note.path === record.from || note.path.startsWith(`${record.from}/`))
          note.path = `${record.to}${note.path.slice(record.from.length)}`;
    } else if (record.op === "move" && typeof record.id === "string" && typeof record.to === "string") {
      const note = byId.get(record.id);
      if (note) {
        note.path = record.to;
        if (typeof record.title === "string" && record.title) note.title = record.title;
        if (record.fingerprint && typeof record.fingerprint === "object") note.fingerprint = record.fingerprint;
      }
    } else unknown += 1;
  }
  return { notes: byId, invalid, unknown, incomplete: incomplete.length };
}
