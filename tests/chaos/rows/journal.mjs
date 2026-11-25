// Rows 1, 3 and 22: a process dies mid-save, the disk fills mid-line, a future build wrote an op we do not know.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { openService, sha256, spawnNode, vault } from "../lib.mjs";
import { parseJournalText, replayJournalText } from "../../../shared/glass-core.mjs";

const child = fileURLToPath(new URL("../child-save.mjs", import.meta.url));
const trials = () => Number(process.env.OMARKIE_CHAOS_KILL_TRIALS ?? 50);

async function killedTrial(delay) {
  const environment = await vault({ "map.md": "# Map\n\nContour lines close together mean a steep slope.\n" });
  const writer = await spawnNode(child, [environment.folder, environment.data, "map.md", "400"]);
  let ready = "";
  writer.stdout.on("data", chunk => { ready += chunk; });
  for (;;) {
    if (ready.includes("saved ")) break;
    if (writer.exitCode !== null) throw new Error(`writer exited before its first save: ${ready}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  await new Promise(resolve => setTimeout(resolve, delay));
  writer.kill("SIGKILL");
  await once(writer, "exit");
  const store = path.join(environment.folder, ".omarkie", "glass");
  const names = await readdir(store).catch(() => []);
  const journal = names.find(name => / \~[a-z0-9]{6}\.jsonl$/.test(name));
  const text = journal ? await readFile(path.join(store, journal), "utf8") : "";
  const replayed = replayJournalText(text);
  const torn = parseJournalText(text).incomplete.length;
  // A process that dies between process start and its first fsync leaves an empty journal; that is safe.
  assert.equal(replayed.invalid, 0, "no complete line may be unparsable");
  assert.deepEqual(replayed.quarantined, [], "no line may be quarantined");
  assert.ok(torn <= 1, `at most the tail may be partial, saw ${torn}`);
  if (text.length) assert.equal(replayed.incomplete, torn, "one tail, never a torn middle");
  return { lines: replayed.lines.length, torn, bytes: text.length };
}

export const rows = [
  {
    id: 1,
    name: "kill -9 mid-save, 50 trials: zero torn complete lines",
    async run() {
      const samples = [];
      for (let trial = 0; trial < trials(); trial += 1) samples.push(await killedTrial(10 + Math.floor(Math.random() * 80)));
      const wrote = samples.filter(sample => sample.lines > 0);
      assert.ok(wrote.length >= 1, "at least one trial saved an op before the kill");
      const partial = samples.filter(sample => sample.torn).length;
      return { trials: samples.length, savedOps: samples.reduce((sum, sample) => sum + sample.lines, 0),
        tornTrials: partial, tornCompleteLines: 0 };
    },
  },
  {
    id: 3,
    name: "short write is failure: no torn line, op queued, replayed when space returns",
    async run() {
      const environment = await vault({ "map.md": "# Map\n\nContour lines.\n" });
      const service = await openService(environment);
      try {
        const first = await service.request({ action: "add", note: "map.md", magnet: "m-short", text: "first" });
        const journal = path.join(environment.folder, ".omarkie", first.journal);
        const before = await readFile(journal, "utf8");
        // The study measured a 76-byte line with a 30-byte budget returning 30, exit 0, no exception.
        service.faults.write = async (handle, line) => {
          const bytes = Buffer.from(line, "utf8");
          const { bytesWritten } = await handle.write(bytes, 0, Math.min(30, bytes.length), null);
          return bytesWritten;
        };
        const second = await service.request({ action: "add", note: "map.md", magnet: "m-short-2", text: "second" });
        assert.equal(second.saved, false);
        assert.equal(service.status().error.code, "SHORT_WRITE");
        assert.ok(service.status().pending >= 1);
        assert.equal(await readFile(journal, "utf8"), before, "the short-written line was rolled back");
        service.faults.write = null;
        const flushed = await service.request({ action: "flush" });
        assert.equal(flushed.pending, 0);
        assert.equal(flushed.error, null);
        const lines = (await readFile(journal, "utf8")).trim().split("\n");
        for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
        assert.ok((await readFile(journal, "utf8")).endsWith("\n"));
        assert.equal(JSON.parse(lines.at(-1)).value, "second");
        return { rolledBack: true, replayed: true };
      } finally { await service.close(); }
    },
  },
  {
    id: 3.1,
    name: "a partial line left mid-file by an older build is quarantined, later lines still load",
    async run() {
      const environment = await vault({ "map.md": "# Map\n\nContour lines.\n" });
      const first = await openService(environment);
      const added = await first.request({ action: "add", note: "map.md", magnet: "m-keep", text: "kept" });
      const journal = path.join(environment.folder, ".omarkie", added.journal);
      const original = await readFile(journal, "utf8");
      await first.close();

      const good = JSON.stringify({ op: "set", magnetId: "m-keep", field: "color", value: "rose", hlc: "ff-0", device: "old" });
      const glued = `${JSON.stringify({ op: "set", magnetId: "m-glued", field: "text", value: "half", hlc: "100-0", device: "old" })}{"op":"set","magnetId":`
      await writeFile(journal, `${original.replace(/\n$/, "")}\n${glued}\n${good}\n`);

      const reopened = await openService(environment);
      try {
        const list = await reopened.request({ action: "list", note: "map.md" });
        assert.equal(list.magnets.find(magnet => magnet.id === "m-keep").fields.color, "rose");
        const text = await readFile(journal, "utf8");
        assert.equal(replayJournalText(text).invalid, 1, "the glued line is quarantined once");
        const next = await reopened.request({ action: "add", note: "map.md", magnet: "m-after", text: "after" });
        assert.equal(next.saved, true);
        const after = replayJournalText(await readFile(journal, "utf8"));
        assert.equal(after.invalid, 1, "nothing new is torn");
        assert.ok(after.magnets.has("m-after"));
        return { quarantined: 1, laterLinesLoaded: true };
      } finally { await reopened.close(); }
    },
  },
  {
    id: 22,
    name: "an op from a newer build stays byte-identical, known ops still load",
    async run() {
      const environment = await vault({ "map.md": "# Map\n\nContour lines.\n" });
      const service = await openService(environment);
      try {
        const added = await service.request({ action: "add", note: "map.md", magnet: "m-known", text: "known" });
        const journal = path.join(environment.folder, ".omarkie", added.journal);
        const future = JSON.stringify({ v: 99, op: "future", magnetId: "x", payload: { deep: [1, 2, 3] }, hlc: "ffffffff-0", device: "newer" });
        await writeFile(journal, `${await readFile(journal, "utf8")}${future}\n`);
        await service.close();

        const reopened = await openService(environment);
        try {
          const list = await reopened.request({ action: "list", note: "map.md" });
          assert.equal(list.unknownOps, 1);
          const before = sha256(await readFile(journal, "utf8"));
          await reopened.request({ action: "add", note: "map.md", magnet: "m-more", text: "more" });
          const after = (await readFile(journal, "utf8")).split("\n");
          assert.ok(after.includes(future), "the unknown line is byte-identical");
          const known = after.filter(line => line.trim() && line !== future);
          for (const line of known) assert.doesNotThrow(() => JSON.parse(line));
          assert.notEqual(sha256(await readFile(journal, "utf8")), before, "the new op was appended");
          return { unknownPreserved: true };
        } finally { await reopened.close(); }
      } finally { await service.close().catch(() => {}); }
    },
  },
];
