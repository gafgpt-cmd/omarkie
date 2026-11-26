import assert from "node:assert/strict";
import { test } from "node:test";
import { journalTimeline, magnetsAt, parseScrubTime } from "../shared/glass-scrub.mjs";

const clock = (t, counter = 0) => `${t.toString(16)}-${counter}`;
const set = (magnetId, field, value, t, counter = 0) => JSON.stringify({ op: "set", magnetId, field, value, hlc: clock(t, counter), device: "device-a" });
const journal = [
  set("m-a", "kind", "sticky", 1000, 0),
  set("m-a", "text", "first", 1000, 1),
  set("m-b", "kind", "ink", 2000),
  set("m-a", "text", "second", 3000),
  JSON.stringify({ op: "delete", magnetId: "m-a", hlc: clock(4000), device: "device-a" }),
  "{not json}",
  set("m-a", "text", "ignored", 9999),
].join("\n") + "\n";

test("timeline groups events by wall-clock millisecond in order", () => {
  const result = journalTimeline(journal);
  assert.deepEqual(result.points.map(point => point.at), [1000, 2000, 3000, 4000, 9999]);
  assert.equal(result.points[0].events, 2);
  assert.deepEqual(result.points[0].kinds, ["sticky"]);
  assert.deepEqual(result.points[1].kinds, ["ink"]);
  assert.equal(result.from, 1000);
  assert.equal(result.to, 9999);
  assert.equal(result.events, 6);
  assert.equal(result.count, 5);
  assert.equal(result.invalid, 1);
});

test("scrub at a moment only replays records at or before it", () => {
  const early = magnetsAt(journal, 1000);
  assert.equal(early.magnets.length, 1);
  assert.equal(early.magnets[0].id, "m-a");
  assert.equal(early.magnets[0].fields.text, "first");

  const later = magnetsAt(journal, 3000);
  assert.deepEqual(later.magnets.map(magnet => magnet.id).sort(), ["m-a", "m-b"]);
  assert.equal(later.magnets.find(magnet => magnet.id === "m-a").fields.text, "second");
});

test("scrub stops before a delete, then the delete removes the mark", () => {
  assert.equal(magnetsAt(journal, 3999).magnets.some(magnet => magnet.id === "m-a"), true);
  assert.equal(magnetsAt(journal, 4000).magnets.some(magnet => magnet.id === "m-a"), false);
});

test("scrub never rewrites the journal", () => {
  const before = journal;
  magnetsAt(journal, 2000);
  journalTimeline(journal);
  assert.equal(journal, before);
});

test("parseScrubTime accepts ISO, epoch seconds and epoch milliseconds", () => {
  assert.equal(parseScrubTime("1970-01-01T00:00:01.000Z"), 1000);
  assert.equal(parseScrubTime("1000"), 1_000_000);
  assert.equal(parseScrubTime(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(parseScrubTime("not a time"), null);
  assert.equal(parseScrubTime(""), null);
});
