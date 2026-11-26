// The tail probe runs before every append, while git sync may be rewriting the same journal.
// A file that shrank under the probe must end the walk (nothing can be decided), never spin and
// never conclude that the whole journal is a torn tail.
import assert from "node:assert/strict";
import { mkdtemp, open, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { lastCompleteOffset } from "../electron/glass-service.mjs";

const scratch = () => mkdtemp(path.join(os.tmpdir(), "omarkie-tail-"));

test("a journal whose last line is complete reports its size", async () => {
  const file = path.join(await scratch(), "journal.jsonl");
  await writeFile(file, "one\ntwo\n");
  const handle = await open(file, "r");
  try { assert.equal(await lastCompleteOffset(handle, 8), 8); } finally { await handle.close(); }
});

test("a torn tail reports the offset after the last newline", async () => {
  const file = path.join(await scratch(), "journal.jsonl");
  await writeFile(file, "one\ntwo\nhalf a li");
  const handle = await open(file, "r");
  try { assert.equal(await lastCompleteOffset(handle, 17), 8); } finally { await handle.close(); }
});

test("a journal rewritten shorter under the probe returns null instead of spinning", { timeout: 5_000 }, async () => {
  const file = path.join(await scratch(), "journal.jsonl");
  await writeFile(file, `${"a".repeat(100_000)}\n${"b".repeat(99_999)}`);
  const handle = await open(file, "r");
  const shrinker = await open(file, "r+");
  try {
    // The size the probe was given no longer matches the file it reads.
    await truncate(file, 50);
    assert.equal(await lastCompleteOffset(handle, 200_000), null);
  } finally { await handle.close(); await shrinker.close(); }
});
