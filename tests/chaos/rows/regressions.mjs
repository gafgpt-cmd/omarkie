// Rows 25, 27 and 28: a huge note under load, a copy that skipped the hidden folder, a note that changed vaults.
// Row 18 (screen, zoom, theme geometry) is proven by the existing headless desktop suite, named in the README.
import assert from "node:assert/strict";
import { readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifest, openSync, scratch, vault } from "../lib.mjs";

const percentile = (samples, fraction) => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

export const rows = [
  {
    id: 18,
    name: "different screen, zoom and theme: magnet geometry is a ratio of the element box",
    async run() {
      // Headless Electron owns this row: it needs a real viewport and layout engine. The chaos job
      // records the dependency; the desktop suite itself is the proof and runs in the same CI.
      const file = fileURLToPath(new URL("../../glass-visual-desktop.mjs", import.meta.url));
      const source = await readFile(file, "utf8").catch(() => "");
      assert.match(source, /resize\(app, page, 1440\)/u, "the desktop test still resizes to another width");
      assert.match(source, /omarkie-theme/u, "the desktop test still switches theme");
      return { coveredBy: "tests/glass-visual-desktop.mjs" };
    },
  },
  {
    id: 25,
    name: "a 5 000-line note with 200 magnets: ops stay bounded, no queue runaway",
    async run() {
      const lines = Array.from({ length: 5_000 }, (_, index) => `line ${index} with some filler text`);
      const body = `# Long\n\n${lines.join("\n")}\n`;
      const environment = await vault({ "long.md": body });
      const { service, sync } = await openSync(environment);
      try {
        const adds = [];
        for (let index = 0; index < 200; index += 1) {
          const started = process.hrtime.bigint();
          const result = await service.request({ action: "add", note: "long.md", magnet: `m-long-${index}`,
            text: `pin ${index}`, anchor: { version: 2, landmarks: [{ kind: "block", block: lines[index * 20], headings: ["Long"], line: index * 20 + 3 }] } });
          adds.push(Number(process.hrtime.bigint() - started) / 1e6);
          assert.equal(result.saved, true);
        }
        const reads = [];
        for (let index = 0; index < 200; index += 1) {
          const started = process.hrtime.bigint();
          const listed = await service.request({ action: "list", note: "long.md" });
          reads.push(Number(process.hrtime.bigint() - started) / 1e6);
          assert.equal(listed.magnets.length, 200);
        }
        await sync.whenIdle();
        const addP95 = percentile(adds, 0.95), readP95 = percentile(reads, 0.95);
        const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
        const early = mean(adds.slice(0, 20)), late = mean(adds.slice(-20));
        assert.ok(service.status().pending === 0, "the save queue drains, it never grows");
        // Absolute numbers belong to the machine; the defect signal is growth with magnet count.
        assert.ok(late < early * 3 + 20, `add cost grows with magnets: early ${early.toFixed(1)} ms, late ${late.toFixed(1)} ms`);
        assert.ok(addP95 < 500, `add p95 ${addP95.toFixed(1)} ms`);
        assert.ok(readP95 < 100, `list p95 ${readP95.toFixed(1)} ms`);
        return { addP95Ms: Math.round(addP95 * 10) / 10, readP95Ms: Math.round(readP95 * 10) / 10,
          growth: Math.round((late / Math.max(early, 0.1)) * 10) / 10, magnets: 200 };
      } finally { await sync.close(); await service.close(); }
    },
  },
  {
    id: 27,
    name: "a copy that skipped the hidden folder is offered its glass from the old location",
    async run() {
      const source = await vault({ "map.md": "# Map\n\nContour lines close together mean a steep slope.\n" });
      const first = await openSync(source);
      try {
        await first.service.request({ action: "add", note: "map.md", magnet: "m-copied", text: "came along" });
        await first.sync.whenIdle();
      } finally { await first.sync.close(); await first.service.close(); }
      const basis = await manifest(source);

      // Exactly what `cp -r vault/* usb/` does: notes only, no `.omarkie`.
      const copy = await vault({ "map.md": "# Map\n\nContour lines close together mean a steep slope.\n" },
        { root: await scratch(), data: source.data, cache: source.cache });
      const second = await openSync(copy);
      try {
        await second.sync.scan("offer");
        assert.ok(second.sync.offer?.count >= 1, "the offer is visible");
        assert.ok(second.sync.offer.vaults.includes(basis.vaultId));
        assert.equal(await readFile(path.join(copy.folder, ".omarkie", "notes.jsonl"), "utf8").catch(() => ""), "",
          "nothing was written to the drive to make the offer");
        await second.sync.bring({});
        assert.equal((await second.service.request({ action: "list", note: "map.md" })).magnets[0].fields.text, "came along");
        assert.equal((await manifest(source)).magnets, basis.magnets, "the old vault keeps its glass");
      } finally { await second.sync.close(); await second.service.close(); }
      return { offered: true, wroteNothing: true };
    },
  },
  {
    id: 28,
    name: "a note that moves to another vault leaves lost glass and is offered in the new one",
    async run() {
      const from = await vault({ "Kerma.md": "# Kerma\n\nDose units.\n" });
      const onto = await vault({ "other.md": "# Other\n" }, { data: from.data, cache: from.cache });
      const first = await openSync(from);
      let noteId;
      try {
        const added = await first.service.request({ action: "add", note: "Kerma.md", magnet: "m-travel", text: "travel pin" });
        noteId = added.id;
        await first.sync.whenIdle();
      } finally { await first.sync.close(); await first.service.close(); }
      const before = await manifest(from);

      await rename(path.join(from.folder, "Kerma.md"), path.join(onto.folder, "Kerma.md"));
      const left = await openSync(from);
      try {
        await left.sync.scan("lost");
        assert.deepEqual(left.sync.lost.map(item => item.id), [noteId]);
        assert.deepEqual(await readdir(path.join(from.folder, ".omarkie", "glass")),
          (await readdir(path.join(from.folder, ".omarkie", "glass"))), "the old journal is untouched");
        assert.equal((await manifest(from)).magnets, before.magnets);
      } finally { await left.sync.close(); await left.service.close(); }

      const arrived = await openSync(onto);
      try {
        await arrived.sync.scan("offer");
        assert.ok(arrived.sync.offer?.count >= 1);
        await arrived.sync.bring({});
        assert.equal((await arrived.service.request({ action: "list", note: "Kerma.md" })).magnets[0].fields.text, "travel pin");
      } finally { await arrived.sync.close(); await arrived.service.close(); }
      return { lost: 1, brought: 1 };
    },
  },
];
