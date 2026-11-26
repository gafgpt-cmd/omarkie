import assert from "node:assert/strict";
import { test } from "node:test";
import { replayNotesText } from "../shared/glass-core.mjs";

// notes.jsonl is union-merged line by line, so the same set of records arrives in two orders.
// A note's path must not depend on which order the merge happened to produce.
const line = record => JSON.stringify(record);
const note = (id, path, hlc, device = "a") => line({ op: "note", id, path, title: path.replace(/\.md$/, ""), hlc, device });
const move = (id, to, hlc, device = "a") => line({ op: "move", id, to, hlc, device, title: to.replace(/\.md$/, "") });

const paths = text => Object.fromEntries([...replayNotesText(text).notes.values()].map(entry => [entry.id, entry.path]));

test("a stale note snapshot merged after a newer move cannot undo the move", () => {
  const ordered = `${note("n1", "Map.md", "10-0")}\n${move("n1", "Atlas.md", "12-0")}\n`;
  const merged = `${ordered}${note("n1", "Map.md", "11-0", "b")}\n`;
  assert.deepEqual(paths(merged), { n1: "Atlas.md" });
  assert.deepEqual(paths(ordered), { n1: "Atlas.md" }, "line order and clock order agree when there is nothing stale");
});

test("a stale note snapshot merged after a newer folder rename stays renamed", () => {
  const rename = line({ op: "folder", from: "old", to: "new", hlc: "20-0", device: "a" });
  const stale = note("n1", "old/Map.md", "15-0", "b");
  const fresh = note("n1", "old/Map.md", "5-0", "a");
  for (const text of [`${fresh}\n${rename}\n${stale}\n`, `${stale}\n${rename}\n${fresh}\n`, `${rename}\n${stale}\n${fresh}\n`])
    assert.deepEqual(paths(text), { n1: "new/Map.md" }, "every merge order lands on the renamed path");
});

test("the newest snapshot wins for the fingerprint as well as the path", () => {
  const older = line({ op: "note", id: "n1", path: "Map.md", hlc: "10-0", device: "a", fingerprint: { hash: "old", size: 1 } });
  const newer = line({ op: "move", id: "n1", to: "Map.md", hlc: "12-0", device: "a", title: "Map", fingerprint: { hash: "new", size: 2 } });
  const replay = replayNotesText(`${newer}\n${older}\n`);
  assert.equal(replay.notes.get("n1").fingerprint.hash, "new");
});

test("lines without a clock are never dropped", () => {
  const legacyNote = line({ op: "note", id: "n1", path: "Map.md", title: "Map" });
  const legacyMove = line({ op: "move", id: "n1", to: "Atlas.md", title: "Atlas" });
  for (const text of [`${legacyNote}\n${legacyMove}\n`, `${legacyMove}\n${legacyNote}\n`])
    assert.deepEqual(paths(text), { n1: "Atlas.md" });
});

test("an unknown op stays counted and never touches a note path", () => {
  const replay = replayNotesText(`${note("n1", "Map.md", "10-0")}\n${line({ op: "future", id: "n1", path: "Other.md", hlc: "30-0" })}\n`);
  assert.equal(replay.unknown, 1);
  assert.deepEqual(paths(`${note("n1", "Map.md", "10-0")}\n${line({ op: "future", id: "n1", path: "Other.md", hlc: "30-0" })}\n`), { n1: "Map.md" });
});
