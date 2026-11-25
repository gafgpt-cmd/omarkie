// G17 time scrub: the journal is append-only and every record carries an HLC whose `t`
// is the wall clock at the write. Scrubbing is a read: pick every record whose clock is at
// or before the chosen time, replay, and show that state. Nothing is ever rewritten.
import { parseClock, replayJournalText, visibleMagnets } from "./glass-core.mjs";

const finite = value => typeof value === "number" && Number.isFinite(value);

export function parseScrubTime(value) {
  if (typeof value === "number" && finite(value)) return Math.round(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    if (!Number.isFinite(number)) return null;
    // Epoch seconds are ten digits; epoch milliseconds are thirteen.
    return Math.round(number < 1e11 ? number * 1000 : number);
  }
  const stamp = Date.parse(text);
  return Number.isFinite(stamp) ? stamp : null;
}

export function linesOf(source) {
  if (Array.isArray(source)) return source;
  return String(source ?? "").split("\n").map(line => line.replace(/\r$/, ""));
}

// Every state-changing record in clock order: one point per distinct wall-clock millisecond,
// which is what the scrub slider steps through.
export function journalTimeline(source) {
  const lines = linesOf(source);
  const seen = new Set(), points = new Map();
  let from = null, to = null, events = 0, invalid = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    let record;
    try { record = JSON.parse(line); } catch { invalid += 1; continue; }
    if (!record || typeof record !== "object" || Array.isArray(record)) { invalid += 1; continue; }
    if (!["set", "del", "delete", "restore"].includes(record.op)) continue;
    const clock = parseClock(record.hlc);
    if (!clock) { invalid += 1; continue; }
    const at = clock.t, entry = points.get(at) ?? { at, events: 0, kinds: [] };
    entry.events += 1;
    if (typeof record.field === "string" && record.field === "kind" && typeof record.value === "string" &&
        !entry.kinds.includes(record.value) && entry.kinds.length < 12) entry.kinds.push(record.value);
    points.set(at, entry);
    events += 1;
    if (from === null || at < from) from = at;
    if (to === null || at > to) to = at;
  }
  const ordered = [...points.values()].sort((left, right) => left.at - right.at);
  return { points: ordered, from, to, events, invalid, count: ordered.length };
}

// The glass as it stood at `at`: records after the chosen clock never happened.
export function magnetsAt(source, at) {
  const lines = linesOf(source);
  const kept = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== "object") continue;
    const clock = parseClock(record.hlc);
    if (!clock || clock.t > at) continue;
    kept.push(line);
  }
  const replay = replayJournalText(kept.length ? `${kept.join("\n")}\n` : "");
  return { magnets: visibleMagnets(replay.magnets), at, lines: kept.length, invalid: replay.invalid };
}
