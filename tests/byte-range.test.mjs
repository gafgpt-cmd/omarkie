import assert from "node:assert/strict";
import test from "node:test";
import { byteRange } from "../electron/byte-range.mjs";

test("a media range request maps to one inclusive span of the file", () => {
  assert.deepEqual(byteRange("bytes=0-", 1_000), { start: 0, end: 999 });
  assert.deepEqual(byteRange("bytes=200-299", 1_000), { start: 200, end: 299 });
  assert.deepEqual(byteRange("bytes=900-5000", 1_000), { start: 900, end: 999 });
  assert.deepEqual(byteRange("bytes=-100", 1_000), { start: 900, end: 999 });
  assert.deepEqual(byteRange("bytes=-5000", 1_000), { start: 0, end: 999 });
});

test("past the end is unsatisfiable; anything else serves the whole file", () => {
  assert.equal(byteRange("bytes=1000-", 1_000), null);
  assert.equal(byteRange("bytes=500-400", 1_000), null);
  assert.equal(byteRange("bytes=0-", 0), null);
  for (const header of [null, "", "bytes=-", "bytes=0-1,5-6", "items=0-1"]) assert.equal(byteRange(header, 1_000), undefined, String(header));
});
