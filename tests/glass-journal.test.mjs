import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertNoStoreSecrets, hlcKey, isNewer, journalOpId, replayJournalText, replayNotesText, visibleMagnets,
} from "../shared/glass-core.mjs";

const line = record => JSON.stringify(record);
const set = (value, hlc = "10-0", device = "a") => ({ op: "set", magnetId: "m", field: "text", value, hlc, device });
const removed = (hlc = "11-0", device = "a") => ({ op: "delete", magnetId: "m", hlc, device });
const restored = (hlc = "12-0", device = "a") => ({ op: "restore", magnetId: "m", hlc, device });

test("opId is deterministic from device, clock, op, magnet and field", () => {
  const record = set("one");
  const id = journalOpId(record);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id, journalOpId({ ...record }), "same values, same id");
  assert.notEqual(id, journalOpId({ ...record, device: "b" }));
  assert.notEqual(id, journalOpId({ ...record, hlc: "10-1" }));
  assert.notEqual(id, journalOpId({ ...record, op: "del" }));
  assert.notEqual(id, journalOpId({ ...record, magnetId: "n" }));
  assert.notEqual(id, journalOpId({ ...record, field: "color" }));
  assert.equal(id, journalOpId({ ...record, value: "two" }), "value is payload, not identity");
});

test("a re-serialized duplicate applies once and legacy lines derive the same id", () => {
  const replayed = replayJournalText([
    line(set("kept")),
    line({ value: "kept", device: "a", op: "set", magnetId: "m", field: "text", hlc: "10-0" }),
    " ",
  ].join("\n") + "\n");
  assert.equal(replayed.duplicates, 1);
  assert.equal(replayed.invalid, 0);
  assert.deepEqual(replayed.quarantined, []);
  assert.deepEqual(visibleMagnets(replayed.magnets).map(item => item.fields.text), ["kept"]);
});

test("a byte-identical duplicate applies once", () => {
  const record = line(set("kept"));
  const replayed = replayJournalText(`${record}\n${record}\n`);
  assert.equal(replayed.duplicates, 1);
  assert.deepEqual(visibleMagnets(replayed.magnets).map(item => item.fields.text), ["kept"]);
});

test("one opId with two payloads is quarantined whole and never applied", () => {
  const original = { ...set("original"), opId: "deadbeefdeadbeef" };
  const conflicting = { ...original, value: "changed" };
  const replayed = replayJournalText(`${line(original)}\n${line(conflicting)}\n`);
  assert.equal(replayed.quarantined.length, 1);
  assert.equal(replayed.quarantined[0].reason, "op-id-conflict");
  assert.equal(replayed.quarantined[0].opId, "deadbeefdeadbeef");
  assert.equal(replayed.quarantined[0].lines.length, 2);
  assert.equal(replayed.magnets.size, 0);
  assert.deepEqual(visibleMagnets([]), []);
});

test("a delete is not resurrected by a stale duplicate merged after it", () => {
  const stale = line(set("old"));
  const replayed = replayJournalText(`${stale}\n${line(removed())}\n${stale}\n`);
  assert.equal(replayed.duplicates, 1);
  assert.deepEqual(visibleMagnets(replayed.magnets), []);
  assert.equal(replayed.magnets.get("m").deleted.active, true);
});

test("edit versus delete keeps the tombstone; only a newer restore undoes it", () => {
  const edited = replayJournalText(`${line(set("base"))}\n${line(removed())}\n${line(set("later edit", "12-0"))}\n`);
  assert.deepEqual(visibleMagnets(edited.magnets), []);
  assert.equal(edited.magnets.get("m").deleted.active, true);

  const undone = replayJournalText(`${line(set("base"))}\n${line(removed())}\n${line(restored("13-0"))}\n${line(removed("12-5", "b"))}\n`);
  assert.deepEqual(visibleMagnets(undone.magnets).map(item => item.fields.text), ["base"]);
  assert.equal(undone.magnets.get("m").deleted.active, false);
});

test("HLC compares at fixed width, so a short legacy clock keeps its order", () => {
  assert.equal(hlcKey("a-0", "a"), "000000000000000a-00000000-a");
  assert.ok(hlcKey("a-0", "a") < hlcKey("10-0", "a"));
  assert.ok(hlcKey("10-0", "a") < hlcKey("10-0", "b"));
  assert.equal(hlcKey("nope", "a"), null);
  assert.equal(isNewer("10-0", "a", { hlc: "a-0", device: "a" }), true);
  assert.equal(isNewer("10-0", "a", { hlc: "10-0", device: "b" }), false);
});

test("an unparsable line is quarantined mid-file while later lines still load", () => {
  const replayed = replayJournalText(`${line(set("before"))}\n{"op":"set","magnetId":\n${line(set("after", "11-0"))}\n`);
  assert.equal(replayed.invalid, 1);
  assert.equal(replayed.quarantined.length, 1);
  assert.equal(replayed.quarantined[0].reason, "unparsable");
  assert.deepEqual(visibleMagnets(replayed.magnets).map(item => item.fields.text), ["after"]);
});

test("unknown operations stay unknown and keep their lines", () => {
  const future = { op: "future", magnetId: "x", value: 1, hlc: "20-0", device: "c" };
  const replayed = replayJournalText(`${line(future)}\n`);
  assert.equal(replayed.unknown.length, 1);
  assert.deepEqual(replayed.unknown[0], future);
  assert.deepEqual(replayed.quarantined, []);
});

test("notes.jsonl dedupes by opId and quarantines conflicting ids", () => {
  const note = { op: "note", id: "abc123", path: "Map.md", title: "Map", hlc: "10-0", device: "a" };
  const duplicate = replayNotesText(`${line(note)}\n${line({ ...note, title: "Map", path: "Map.md" })}\n`);
  assert.equal(duplicate.notes.size, 1);
  assert.equal(duplicate.duplicates, 1);

  const conflict = replayNotesText(`${line(note)}\n${line({ ...note, path: "Other.md" })}\n`);
  assert.equal(conflict.notes.size, 0);
  assert.equal(conflict.quarantined.length, 1);
  assert.equal(conflict.quarantined[0].reason, "op-id-conflict");
});

test("a credential is refused in glass settings and the vault", () => {
  assert.throws(() => assertNoStoreSecrets({ vaultId: "x", syncToken: "t" }), /keychain/u);
  assert.throws(() => assertNoStoreSecrets({ nested: { password: "t" } }), /keychain/u);
  assert.doesNotThrow(() => assertNoStoreSecrets({ version: 1, vaultId: "abc", mode: "inside" }));
});
