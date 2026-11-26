import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { GlassService } from "../electron/glass-service.mjs";
import { markdownElements } from "../shared/element-model.mjs";
import { latestSwaps, replaySwaps } from "../shared/element-swap.mjs";

const scratch = [];
after(async () => { for (const root of scratch) await rm(root, { recursive: true, force: true }); });

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function vault(files = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-writes-"));
  scratch.push(home);
  const root = path.join(home, "vault"), appData = path.join(home, "app-data");
  await mkdir(root, { recursive: true });
  await mkdir(appData, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  const service = await new GlassService({ root, appData, device: "test-device" }).open();
  return { home, root, appData, service };
}

const rewrite = text => ({ id: "cand-1", kind: "rewrite", title: "Clearer cue", source: "tutor", sourceLabel: "the Tutor",
  licence: { code: "tutor", attribution: "Tutor", required: false }, text });

test("latestSwaps reads journal ISO times and keeps the newest swap per element", () => {
  const lines = [
    { op: "swap", swapId: "sw-aaaaaa", element: { id: "paragraph-1" }, mode: "replace", at: "2026-11-25T10:00:00.000Z" },
    { op: "swap", swapId: "sw-bbbbbb", element: { id: "paragraph-1" }, mode: "cover", at: "2026-11-25T10:05:00.000Z" },
  ];
  const { applied } = replaySwaps(lines.map(line => JSON.stringify(line)).join("\n"));
  assert.equal(latestSwaps(applied)[0].swapId, "sw-bbbbbb", "the later ISO time wins");
});

test("latestSwaps lists the last change of the note first", () => {
  const lines = [
    { op: "swap", swapId: "sw-aaaaaa", element: { id: "paragraph-1" }, mode: "cover", at: "2026-11-25T10:00:00.000Z" },
    { op: "swap", swapId: "sw-bbbbbb", element: { id: "heading-1" }, mode: "cover", at: "2026-11-25T10:09:00.000Z" },
  ];
  const { applied } = replaySwaps(lines.map(line => JSON.stringify(line)).join("\n"));
  assert.deepEqual(latestSwaps(applied).map(entry => entry.swapId), ["sw-bbbbbb", "sw-aaaaaa"]);
});

test("replacing a table cell keeps the row and moves its footnote after the table", async () => {
  const source = "| Dose | Unit |\n| --- | --- |\n| 1 Gy | J/kg |\n";
  const { root, service } = await vault({ "table.md": source });
  const cell = markdownElements(source).find(element => element.kind === "table-cell" && element.text === "1 Gy");
  assert.ok(cell, "the cell is an element");
  const result = await service.request({ action: "swap-apply", note: "table.md", element: cell.id, mode: "replace", approved: true,
    candidate: rewrite("1 gray") });
  try {
    assert.equal(result.applied, true);
    const after = await readFile(path.join(root, "table.md"), "utf8");
    const lines = after.split("\n");
    assert.equal(lines[0], "| Dose | Unit |");
    assert.match(lines[2], /^\| 1 gray\[\^swap-[a-z0-9]+\] \| J\/kg \|$/, "the swapped cell stays one inline cell");
    assert.equal(lines[3], "", "the footnote starts a new block");
    assert.match(lines[4], /^\[\^swap-[a-z0-9]+\]: /, "the definition follows the table");
    const cells = markdownElements(after).filter(element => element.kind === "table-cell");
    assert.equal(cells.length, 4, "the table still has its four cells");
    assert.ok(cells.some(element => element.text === "J/kg"), "the neighbouring cell survives");
  } finally { await service.close(); }
});

test("a note saved while a picture candidate downloads is not reverted", async () => {
  const source = "Para one.\n\nSecond paragraph with the swap target.\n";
  const { root, service } = await vault({ "race.md": source });
  const element = markdownElements(source).find(row => row.text.startsWith("Second"));
  let fetched = false;
  const server = createServer(async (_request, response) => {
    fetched = true;
    // The editor saves while the candidate is in flight.
    await writeFile(path.join(root, "race.md"), `${source}\nConcurrent edit made by the editor.\n`);
    response.writeHead(200, { "content-type": "image/png" });
    response.end(png);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  // The download allow-list takes its extra host from the configured picture source.
  const previous = process.env.OMARKIE_SWAP_OPENVERSE;
  process.env.OMARKIE_SWAP_OPENVERSE = `http://127.0.0.1:${port}/`;
  try {
    const result = await service.request({ action: "swap-apply", note: "race.md", element: element.id, mode: "replace", approved: true,
      candidate: { id: "cand-2", kind: "find", title: "dot.png", source: "vault", sourceLabel: "your vault", width: 640, height: 480,
        licence: { code: "own", required: false }, downloadUrl: `http://127.0.0.1:${port}/dot.png` } });
    assert.equal(fetched, true, "the download happened before the write check");
    assert.equal(result.stale, true, "the stale note is reported instead of overwritten");
    const after = await readFile(path.join(root, "race.md"), "utf8");
    assert.match(after, /Concurrent edit made by the editor\./, "the concurrent save survives");
    assert.doesNotMatch(after, /\[\^swap-/, "nothing was written");
    assert.equal((await readdir(root)).includes("dot.png"), false, "no attachment was left behind");
  } finally {
    if (previous === undefined) delete process.env.OMARKIE_SWAP_OPENVERSE;
    else process.env.OMARKIE_SWAP_OPENVERSE = previous;
    server.close();
    await service.close();
  }
});

test("a clip cannot claim a saved note outside the vault", async () => {
  const { home, root, service } = await vault({ "note.md": "Para target text.\n" });
  await writeFile(path.join(home, "outside.md"), "outside words\n");
  try {
    await service.request({ action: "add", note: "note.md", magnet: "m-clip",
      fields: { kind: "clip", text: "Clipped words", notePath: "../outside.md",
        anchor: { landmarks: [{ kind: "block", block: "Para target text.", headings: [] }] } } });
    const saved = await service.request({ action: "clip-save", note: "note.md", magnet: "m-clip" });
    assert.equal(saved.created, true, "the forged path is not treated as an existing saved note");
    assert.equal(saved.path, "Clipped words.md");
    assert.match(await readFile(path.join(root, "Clipped words.md"), "utf8"), /Clipped words/);
  } finally { await service.close(); }
});

test("frontmatter is metadata, not a paragraph an agent can rewrite", () => {
  const source = "---\ntype: Reference\ntitle: Lecture\n---\n\n# Head\n\nBody text.\n";
  const elements = markdownElements(source);
  assert.deepEqual(elements.map(element => element.kind), ["heading", "paragraph"]);
  assert.equal(elements.some(element => element.markdown.startsWith("---")), false);
});
