import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FoldService } from "../electron/fold-service.mjs";
import { planChunks } from "../shared/fold-cache.mjs";
import { checkFormat } from "../shared/fold-check.mjs";
import { isFold } from "../shared/fold-format.mjs";
import { firstSentence } from "../shared/fold-text.mjs";
import { extractUnits, foldDocumentLadder } from "../shared/fold-units.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/fold/", import.meta.url));
const fixtures = readdirSync(FIXTURES).filter(name => /^\d{2}-/.test(name)).sort()
  .map(id => ({ id, markdown: readFileSync(`${FIXTURES}${id}/input.md`, "utf8") }));
const fixture = prefix => fixtures.find(item => item.id.startsWith(prefix));
const ROUTE = Object.freeze({ route: "agent", agent: "opencode", model: "deepseek-v4.1-flash", outLang: "en" });
const NOTE = "fold0note";
const roots = [];
after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));

async function store() {
  const root = await mkdtemp(path.join(tmpdir(), "omarkie-fold-"));
  roots.push(root);
  return root;
}

const quoteLine = (unit, text) => {
  const start = unit.text.indexOf(text);
  assert.ok(start >= 0, `${text} not in ${unit.elementId}`);
  return { by: "model", text, evidence: [{ elementId: unit.elementId, quote: text, sentence: 0, start, end: start + text.length }] };
};
const firstLine = unit => quoteLine(unit, firstSentence(unit.text).head.trim());

// A faithful synthetic model: every line is the unit's first sentence, quoted as its own evidence.
function faithful(request) {
  const units = request.chunk.units;
  return {
    written: units.filter(unit => !unit.raw && unit.kind !== "heading" && unit.text.trim())
      .map(unit => ({ elementId: unit.elementId, role: "context", key: firstLine(unit), takeaway: firstLine(unit), topic: firstLine(unit) })),
    sections: units.filter(unit => unit.kind === "heading").map(unit => ({ elementId: unit.elementId, takeaway: firstLine(unit), topic: firstLine(unit) })),
  };
}

function runner(reply = faithful) {
  const calls = [];
  return { calls, versions: () => ({ promptVersion: 1, schemaVersion: 1 }), run: request => { calls.push(request); return reply(request, calls.length); } };
}

function service(storeDir, model, options = {}) {
  const fold = new FoldService({ storeDir, runner: model, ...options });
  const events = [];
  fold.on("progress", event => events.push(event));
  return { fold, events };
}

const chunkFiles = async root => (await readdir(path.join(root, "folds", (await readdir(path.join(root, "folds")))[0], "chunks"))).sort();
const noteDir = async root => path.join(root, "folds", (await readdir(path.join(root, "folds")))[0]);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("a run writes one cache file per chunk, streams in queue order and never holds more than two calls", async () => {
  const root = await store();
  const { markdown } = fixture("12-");
  let inFlight = 0, peak = 0;
  const model = runner(async request => {
    inFlight++; peak = Math.max(peak, inFlight);
    // Later chunks answer first: the stream must still leave in queue order.
    await new Promise(resolve => setTimeout(resolve, 40 - (request.chunk.units.length % 5) * 8));
    inFlight--;
    return faithful(request);
  });
  const { fold, events } = service(root, model);
  const result = await fold.run({ noteId: NOTE, title: "Physiology", markdown, ...ROUTE }).done;
  const chunks = planChunks(extractUnits(markdown), { ...ROUTE, slot: "ladder", promptVersion: 1, schemaVersion: 1 });
  assert.equal(result.state, "done");
  assert.equal(model.calls.length, chunks.length);
  assert.ok(peak <= 2 && peak >= 1, `peak ${peak}`);
  const streamed = events.filter(event => event.phase === "chunk");
  assert.deepEqual(streamed.map(event => event.index), chunks.map((_, index) => index));
  assert.deepEqual(streamed.map(event => event.chunk.key), chunks.map(chunk => chunk.key));
  assert.deepEqual(streamed.map(event => event.done), chunks.map((_, index) => index + 1));
  assert.deepEqual(events.map(event => event.phase), ["start", ...chunks.map(() => "chunk"), "done"]);
  assert.deepEqual(await chunkFiles(root), chunks.map(chunk => `${chunk.key}.json`).sort());
  const saved = JSON.parse(await readFile(path.join(await noteDir(root), "fold.json"), "utf8"));
  assert.ok(isFold(saved));
  assert.match(path.basename(await noteDir(root)), / ~fold0note$/);
});

test("a one-word edit re-runs exactly one chunk; the other chunks cost 0 calls", async () => {
  const root = await store();
  const { markdown } = fixture("12-");
  const model = runner();
  const { fold, events } = service(root, model);
  await fold.run({ noteId: NOTE, title: "Physiology", markdown, ...ROUTE }).done;
  const first = model.calls.length;
  const target = extractUnits(markdown).filter(unit => unit.kind === "paragraph")[20];
  const edited = markdown.slice(0, target.from) + target.markdown.replace(/\b(\p{L}{5,})\b/u, "$1s") + markdown.slice(target.to);

  const stale = await fold.get({ noteId: NOTE, title: "Physiology", markdown: edited });
  assert.equal(stale.stale, 1);
  const staleChunk = stale.chunks.find(chunk => chunk.state === "stale");
  const kept = stale.fold.written.filter(entry => staleChunk.unitIds.includes(entry.elementId));
  assert.ok(kept.length >= 1, "unchanged units of the stale chunk keep their old lines");
  assert.ok(!stale.fold.written.some(entry => entry.elementId === target.elementId));

  events.length = 0;
  const second = await fold.run({ noteId: NOTE, title: "Physiology", markdown: edited, ...ROUTE }).done;
  assert.equal(model.calls.length - first, 1);
  assert.equal(second.calls, 1);
  assert.deepEqual(model.calls.at(-1).chunk.key, staleChunk.key);
  assert.equal(events.find(event => event.phase === "start").cached, stale.chunks.length - 1);
  const fresh = await fold.get({ noteId: NOTE, title: "Physiology", markdown: edited });
  assert.equal(fresh.stale, 0);
  assert.ok(isFold(fresh.fold));
  assert.equal((await chunkFiles(root)).length, fresh.chunks.length, "the replaced chunk file is pruned");
  assert.equal((await fold.run({ noteId: NOTE, title: "Physiology", markdown: edited, ...ROUTE }).done).calls, 0);
});

test("the visible chunk runs first and a section-limited run only touches that section", async () => {
  const root = await store();
  const { markdown } = fixture("12-");
  const model = runner();
  const { fold } = service(root, model, { concurrency: 1 });
  const chunks = planChunks(extractUnits(markdown), { ...ROUTE, slot: "ladder", promptVersion: 1, schemaVersion: 1 });
  await fold.run({ noteId: NOTE, title: "P", markdown, ...ROUTE, sections: [chunks[4].sectionIds[0]] }).done;
  assert.deepEqual(model.calls.map(call => call.chunk.key), [chunks[4].key]);
  await fold.run({ noteId: NOTE, title: "P", markdown, ...ROUTE, visible: chunks[7].unitIds[1] }).done;
  assert.deepEqual(model.calls.slice(1).map(call => call.chunk.key), [chunks[7], ...chunks.filter((_, index) => index !== 7 && index !== 4)].map(chunk => chunk.key));
});

test("cancel keeps finished chunks, writes nothing for answers that land after it, and the next run does the rest", async () => {
  const root = await store();
  const { markdown } = fixture("12-");
  const late = deferred();
  const model = runner(async (request, call) => {
    if (call === 1) return faithful(request);
    await late.promise; // ignores the abort signal on purpose: its answer arrives after the cancel
    return faithful(request);
  });
  const { fold, events } = service(root, model);
  const { done } = fold.run({ noteId: NOTE, title: "P", markdown, ...ROUTE });
  while (!events.some(event => event.phase === "chunk")) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fold.cancel({ noteId: NOTE }), true);
  const result = await done;
  assert.equal(result.state, "cancelled");
  assert.equal(result.written, 1);
  late.resolve();
  await new Promise(resolve => setTimeout(resolve, 30));
  const files = await chunkFiles(root);
  assert.equal(files.length, 1);
  assert.ok(files.every(name => /^[0-9a-f]{64}\.json$/.test(name)), "no temp or partial entry");
  assert.deepEqual(events.map(event => event.phase), ["start", "chunk", "cancelled"]);
  const kept = await fold.get({ noteId: NOTE, title: "P", markdown });
  assert.equal(kept.chunks.filter(chunk => chunk.state === "written").length, 1);
  assert.ok(isFold(kept.fold));

  const before = model.calls.length;
  const rest = await fold.run({ noteId: NOTE, title: "P", markdown, ...ROUTE }).done;
  assert.equal(rest.state, "done");
  assert.equal(model.calls.length - before, kept.chunks.length - 1);
});

test("a new run for the same note supersedes the running one", async () => {
  const root = await store();
  const { markdown } = fixture("01-");
  const hold = deferred();
  const model = runner(async (request, call) => { if (call <= 2) await hold.promise; return faithful(request); });
  const { fold, events } = service(root, model);
  const first = fold.run({ noteId: NOTE, title: "A", markdown, ...ROUTE });
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = fold.run({ noteId: NOTE, title: "A", markdown, ...ROUTE });
  assert.equal((await first.done).state, "cancelled");
  hold.resolve();
  assert.equal((await second.done).state, "done");
  assert.ok(events.findIndex(event => event.runId === second.runId) > events.findIndex(event => event.runId === first.runId && event.phase === "cancelled"));
});

test("a crash in the middle of a cache write leaves no entry and the previous fold.json intact", async () => {
  const root = await store();
  const { markdown } = fixture("07-");
  const { fold } = service(root, runner());
  await fold.run({ noteId: NOTE, title: "Metformina", markdown, ...ROUTE }).done;
  const dir = await noteDir(root);
  const before = await readFile(path.join(dir, "fold.json"), "utf8");
  const target = extractUnits(markdown).find(unit => unit.kind === "paragraph");
  const edited = markdown.slice(0, target.from) + target.markdown.replace(/(\p{L}{5,})/u, "$1a") + markdown.slice(target.to);

  // The child dies (SIGKILL) after the temp file is synced and before the rename commits it.
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { FoldService } = await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../electron/fold-service.mjs", import.meta.url))).href)});
    const { atomicWrite } = await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../electron/store.mjs", import.meta.url))).href)});
    const { firstSentence } = await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../shared/fold-text.mjs", import.meta.url))).href)});
    const line = unit => { const text = firstSentence(unit.text).head.trim(); const start = unit.text.indexOf(text); return { by: "model", text, evidence: [{ elementId: unit.elementId, quote: text, sentence: 0, start, end: start + text.length }] }; };
    const runner = { versions: () => ({ promptVersion: 1, schemaVersion: 1 }), run: ({ chunk }) => ({ written: chunk.units.filter(unit => !unit.raw && unit.kind !== "heading").map(unit => ({ elementId: unit.elementId, role: "context", key: line(unit), takeaway: line(unit), topic: line(unit) })), sections: [] }) };
    const write = (file, data) => atomicWrite(file, data, () => process.kill(process.pid, "SIGKILL"));
    const fold = new FoldService({ storeDir: ${JSON.stringify(root)}, runner, write });
    await fold.run(${JSON.stringify({ noteId: NOTE, title: "Metformina", markdown: edited, ...ROUTE })}).done;
  `], { stdio: "inherit" });
  const [code, signal] = await once(child, "exit");
  // Windows has no signals: Node maps SIGKILL to TerminateProcess(handle, 1), so the child reports exit code 1.
  if (process.platform === "win32") assert.deepEqual([code, signal], [1, null]);
  else assert.equal(signal, "SIGKILL", `child exit ${code}`);

  assert.equal(await readFile(path.join(dir, "fold.json"), "utf8"), before);
  const names = await readdir(path.join(dir, "chunks"));
  assert.ok(names.some(name => name.endsWith(".tmp")), "the killed write left only its temp file");
  for (const name of names.filter(name => name.endsWith(".json"))) assert.ok(isFold(JSON.parse(await readFile(path.join(dir, "chunks", name), "utf8"))));

  const model = runner();
  const { fold: next } = service(root, model);
  const stale = await next.get({ noteId: NOTE, title: "Metformina", markdown: edited });
  assert.equal(stale.stale, 1);
  assert.equal((await next.run({ noteId: NOTE, title: "Metformina", markdown: edited, ...ROUTE }).done).calls, 1);
  assert.ok(!(await readdir(path.join(dir, "chunks"))).some(name => name.endsWith(".tmp")), "the next full run clears the leftover");
});

test("payload checker on the golden set: faithful lines pass every class, injected markup never survives", async () => {
  for (const { id, markdown } of fixtures) {
    const root = await store();
    const model = runner();
    const { fold } = service(root, model);
    const result = await fold.run({ noteId: NOTE, title: id, markdown, ...ROUTE, outLang: /^(01|04|06|08|12)-/.test(id) ? "en" : "es" }).done;
    assert.equal(result.errors, 0, id);
    const { fold: saved } = await fold.get({ noteId: NOTE, title: id, markdown });
    assert.ok(isFold(saved), id);
    assert.ok(saved.written.length > 0, id);
    for (const entry of saved.written) {
      const failed = Object.entries(entry.checks).filter(([, status]) => status === "fail").map(([name]) => name);
      if (id.startsWith("14-")) assert.ok(failed.every(name => name === "format"), `${id} ${entry.elementId}: ${failed}`);
      else assert.deepEqual(failed, [], `${id} ${entry.elementId}`);
      for (const stop of ["key", "takeaway", "topic"]) assert.ok(checkFormat(entry[stop].text).ok, `${id} ${entry.elementId} ${stop}`);
    }
    for (const raw of extractUnits(markdown).filter(unit => unit.raw)) assert.ok(!saved.written.some(entry => entry.elementId === raw.elementId), `${id}: raw ${raw.elementId}`);
  }
});

test("a dropped negation retries once naming the token, then falls back to the author's words with a warning", async () => {
  const { markdown } = fixture("10-");
  const target = extractUnits(markdown).find(unit => unit.text.includes("Do not use hydroxyethyl starches"));
  const source = "Do not use hydroxyethyl starches under any circumstance";
  const lossy = { by: "model", text: "Use hydroxyethyl starches under any circumstance", evidence: quoteLine(target, source).evidence };
  const reply = fixed => request => {
    const base = faithful(request);
    for (const entry of base.written) if (entry.elementId === target.elementId) entry.key = fixed ? quoteLine(target, source) : lossy;
    return base;
  };

  for (const fixed of [false, true]) {
    const root = await store();
    const model = runner((request, call) => reply(fixed && call > 1 && request.retry)(request));
    const { fold, events } = service(root, model);
    await fold.run({ noteId: NOTE, title: "Sepsis", markdown, ...ROUTE }).done;
    const retries = model.calls.filter(call => call.retry);
    assert.equal(retries.length, 1);
    assert.deepEqual(Object.keys(retries[0].retry), [target.elementId]);
    assert.ok(retries[0].retry[target.elementId].length > 0);
    const { fold: saved } = await fold.get({ noteId: NOTE, title: "Sepsis", markdown });
    const entry = saved.written.find(item => item.elementId === target.elementId);
    if (fixed) {
      assert.equal(entry.key.by, "model");
      assert.equal(entry.checks.negation, "pass");
    } else {
      assert.equal(entry.key.by, "author");
      assert.equal(entry.checks.negation, "fail");
      assert.ok(events.find(event => event.phase === "chunk" && event.written.some(item => item.elementId === target.elementId)).warnings >= 1);
    }
  }
});

test("replies outside the contract are dropped or restored to Brief words; a failing chunk reports without stopping the others", async () => {
  const root = await store();
  const { markdown } = fixture("09-");
  const ladder = foldDocumentLadder(markdown);
  const units = ladder.units;
  const brief = id => ladder.byUnit.find(item => item.unit.elementId === id).stops.brief;
  const table = units.find(unit => unit.raw === "table");
  const plan = planChunks(units, { ...ROUTE, outLang: "es", slot: "ladder", promptVersion: 1, schemaVersion: 1 });
  const failing = plan.find(chunk => !chunk.unitIds.includes(table.elementId) && chunk.unitIds.length > 1);
  const prose = units.filter(unit => unit.kind === "paragraph" && !failing.unitIds.includes(unit.elementId));
  assert.ok(table && failing && prose.length >= 2);
  const model = runner(request => {
    const base = faithful(request);
    const ids = request.chunk.units.map(unit => unit.elementId);
    if (request.chunk.key === failing.key) throw Object.assign(new Error("route down"), { code: "ROUTE_DOWN" });
    if (ids.includes(table.elementId)) base.written.push({ elementId: table.elementId, role: "dose", key: { by: "author", text: "x" }, takeaway: { by: "author", text: "x" }, topic: { by: "author", text: "x" } });
    base.written.push({ elementId: "paragraph-elsewhere", role: "context", key: { by: "author", text: "y" }, takeaway: { by: "author", text: "y" }, topic: { by: "author", text: "y" } });
    for (const entry of base.written) {
      if (entry.elementId === prose[0].elementId) entry.takeaway = { by: "author", text: "Invented author words." };
      if (entry.elementId === prose[1].elementId) entry.topic = { ...entry.topic, evidence: [{ ...entry.topic.evidence[0], start: entry.topic.evidence[0].start + 1, end: entry.topic.evidence[0].end + 1 }] };
    }
    return base;
  });
  const { fold, events } = service(root, model);
  const result = await fold.run({ noteId: NOTE, title: "Regional", markdown, ...ROUTE, outLang: "es" }).done;
  assert.equal(result.errors, 1);
  assert.equal(result.state, "done");
  const error = events.find(event => event.phase === "chunk" && event.state === "error");
  assert.deepEqual(error.error, { message: "route down", code: "ROUTE_DOWN" });
  assert.ok(!(await chunkFiles(root)).includes(`${failing.key}.json`));
  const view = await fold.get({ noteId: NOTE, title: "Regional", markdown });
  assert.ok(isFold(view.fold));
  const ids = view.fold.written.map(entry => entry.elementId);
  for (const id of [table.elementId, "paragraph-elsewhere"]) assert.ok(!ids.includes(id), id);
  const invented = view.fold.written.find(entry => entry.elementId === prose[0].elementId);
  assert.deepEqual(invented.takeaway, { by: "author", text: brief(prose[0].elementId) });
  assert.equal(invented.key.by, "model");
  const shifted = view.fold.written.find(entry => entry.elementId === prose[1].elementId);
  assert.deepEqual(shifted.topic, { by: "author", text: brief(prose[1].elementId) });
  assert.equal(view.chunks.find(chunk => chunk.key === failing.key).state, "stale");

  const empty = runner(() => ({ written: [{ elementId: "paragraph-elsewhere" }] }));
  const { fold: other, events: otherEvents } = service(await store(), empty);
  const nothing = await other.run({ noteId: NOTE, title: "Regional", markdown, ...ROUTE, outLang: "es" }).done;
  assert.equal(nothing.errors, plan.length - plan.filter(chunk => chunk.unitIds.every(id => units.find(unit => unit.elementId === id).raw)).length);
  assert.ok(otherEvents.filter(event => event.state === "error").every(event => event.error.code === "FOLD_INVALID"));
});

test("get before any run reports local chunks; bad requests are refused before any call", async () => {
  const root = await store();
  const model = runner();
  const { fold } = service(root, model);
  const view = await fold.get({ noteId: NOTE, title: "x", markdown: fixture("03-").markdown });
  assert.equal(view.fold, null);
  assert.ok(view.chunks.length > 0 && view.chunks.every(chunk => chunk.state === "local" && chunk.key === null));
  assert.throws(() => fold.run({ noteId: "../x", title: "x", markdown: "a", ...ROUTE }), /note id/);
  assert.throws(() => fold.run({ noteId: NOTE, title: "x", markdown: "a", ...ROUTE, outLang: "xx" }), /outLang/);
  assert.throws(() => fold.run({ noteId: NOTE, title: "x", markdown: "a", route: "agent", model: "m", outLang: "es" }), /agent/);
  assert.throws(() => fold.run({ noteId: NOTE, title: "x", markdown: "a", ...ROUTE, slot: "both" }), /slot/);
  assert.equal(model.calls.length, 0);
  assert.deepEqual(await readdir(root), []);
});

// A faithful synthetic Estudio model: one card per unit, its answer the unit's first words, quoted as its own evidence.
function studied(request) {
  const cards = request.chunk.units.filter(unit => !unit.raw && unit.kind !== "heading" && unit.text.trim()).map(unit => {
    const quote = unit.text.match(/^\S+(?:\s+\S+){0,11}/u)[0];
    return { q: "What does the note say?", a: quote, evidence: [{ elementId: unit.elementId, quote }] };
  });
  return { oneLiner: null, caso: [], vs: [], numeros: [], flujo: [], bloques: [], nunca: [], buzzwords: [], mnemonics: [], cards, gaps: [] };
}
const quotesUnit = (sheet, id) => sheet.cards.some(card => card.evidence.some(entry => entry.elementId === id));

test("an Estudio run caches its own chunks beside the ladder's, merges the sheet, and an edit re-runs one chunk", async () => {
  const root = await store();
  const { markdown } = fixture("12-");
  const ladder = runner(), estudio = runner(studied);
  const { fold } = service(root, ladder);
  await fold.run({ noteId: NOTE, title: "Physiology", markdown, ...ROUTE }).done;
  const ladderFiles = await chunkFiles(root);
  const { fold: study, events } = service(root, estudio);
  const result = await study.run({ noteId: NOTE, title: "Physiology", markdown, ...ROUTE, slot: "estudio" }).done;
  const dir = await noteDir(root);
  assert.equal(result.state, "done");
  assert.ok(estudio.calls.every(call => call.slot === "estudio" && call.chunk.units.every(unit => !("brief" in unit))));
  assert.equal((await readdir(path.join(dir, "estudio-chunks"))).length, estudio.calls.length);
  assert.deepEqual(await chunkFiles(root), ladderFiles, "an Estudio run never prunes the ladder cache");
  assert.equal((await fold.get({ noteId: NOTE, title: "Physiology", markdown })).stale, 0);
  assert.ok(events.filter(event => event.phase === "chunk").every(event => event.slot === "estudio" && event.estudio.format === "omarkie/fold-estudio"));

  const sheet = (await study.get({ noteId: NOTE, title: "Physiology", markdown, slot: "estudio" })).fold.estudio;
  assert.equal(sheet.cards.length, 10, "the merged sheet keeps its card cap");
  const first = sheet.cards[0].evidence[0].elementId;
  const target = extractUnits(markdown).find(unit => unit.elementId === first);
  const edited = markdown.slice(0, target.from) + target.markdown.replace(/\b(\p{L}{5,})\b/u, "$1s") + markdown.slice(target.to);
  const stale = await study.get({ noteId: NOTE, title: "Physiology", markdown: edited, slot: "estudio" });
  assert.equal(stale.stale, 1);
  const staleChunk = stale.chunks.find(chunk => chunk.state === "stale");
  assert.ok(!quotesUnit(stale.fold.estudio, first), "an item whose quote no longer fits leaves");
  assert.ok(staleChunk.unitIds.some(id => id !== first && quotesUnit(stale.fold.estudio, id)), "the stale chunk's other items stay");
  const before = estudio.calls.length;
  await study.run({ noteId: NOTE, title: "Physiology", markdown: edited, ...ROUTE, slot: "estudio" }).done;
  assert.deepEqual(estudio.calls.slice(before).map(call => call.chunk.key), [staleChunk.key]);
  assert.equal((await study.get({ noteId: NOTE, title: "Physiology", markdown: edited, slot: "estudio" })).stale, 0);
});

test("Estudio and ladder runs of one note run side by side; cancelling one slot leaves the other running", async () => {
  const root = await store();
  const { markdown } = fixture("01-");
  const hold = deferred();
  const model = runner(async request => { await hold.promise; return request.slot === "estudio" ? studied(request) : faithful(request); });
  const { fold } = service(root, model);
  const ladder = fold.run({ noteId: NOTE, title: "ADHF", markdown, ...ROUTE });
  const estudio = fold.run({ noteId: NOTE, title: "ADHF", markdown, ...ROUTE, slot: "estudio" });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fold.cancel({ noteId: NOTE, slot: "estudio" }), true);
  hold.resolve();
  assert.deepEqual([(await estudio.done).state, (await ladder.done).state], ["cancelled", "done"]);
  // A table reaches the Estudio model cell by cell, so a vs row can quote one cell.
  const study = await fold.run({ noteId: NOTE, title: "ADHF", markdown, ...ROUTE, slot: "estudio" }).done;
  assert.equal(study.state, "done");
  const table = model.calls.filter(call => call.slot === "estudio").flatMap(call => call.chunk.units).find(unit => unit.kind === "table");
  assert.ok(table.cells.some(cell => cell.text === ">100 pg/mL"));
});
