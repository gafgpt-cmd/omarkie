// Fold service (design §4.1-4.3): the single writer of `<store>/folds/<note> ~<id>/` (`fold.json` + `chunks/<key>.json`).
// Chunks queue in document order (visible chunk first), run two at a time across notes, stream in queue order,
// and cancel without a partial cache entry. Model calls go through the injected runner; no route lives here.

import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { assembleFold, chunkUnits, foldRecord, planChunks, queueOrder, sameWriter } from "../shared/fold-cache.mjs";
import { checkLadderChunk } from "../shared/fold-check.mjs";
import { foldProblems } from "../shared/fold-format.mjs";
import { extractUnits, foldDocumentLadder, isHiddenUnit } from "../shared/fold-units.mjs";
import { glassFileName } from "../shared/glass-core.mjs";
import { atomicWrite } from "./store.mjs";

const SLOT = "ladder";
const STOPS = ["key", "takeaway", "topic"];
const noteIdPattern = /^[a-z0-9]{4,32}$/;
const chunkFile = /^([0-9a-f]{64})\.json$/;
const leftoverTemp = /^\..+\.tmp$/;

const abortError = () => Object.assign(new Error("Fold run cancelled."), { name: "AbortError", code: "FOLD_CANCELLED" });
const isAbort = error => error?.name === "AbortError";

// Calls in flight across every note; a slot is held until the runner settles, even after a cancel.
class Gate {
  constructor(limit) { this.limit = limit; this.busy = 0; this.waiting = []; }

  acquire(signal) {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.busy < this.limit) { this.busy++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const drop = () => { this.waiting.splice(this.waiting.indexOf(waiter), 1); reject(abortError()); };
      waiter.resolve = () => { signal.removeEventListener("abort", drop); resolve(); };
      signal.addEventListener("abort", drop, { once: true });
      this.waiting.push(waiter);
    });
  }

  release() {
    const next = this.waiting.shift();
    if (next) next.resolve();
    else this.busy--;
  }
}

function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const stop = () => reject(abortError());
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", stop); resolve(value); },
      error => { signal.removeEventListener("abort", stop); reject(error); },
    );
  });
}

export class FoldService extends EventEmitter {
  /**
   * @param {object} options
   * @param {string | (() => string | null)} options.storeDir Omarkie store (`.omarkie` or the app-data vault store).
   * @param {{ promptVersion: number, schemaVersion: number, run: (request: object) => Promise<object> }} options.runner
   * @param {(file: string, data: string) => Promise<void>} [options.write] atomic file write (tmp + fsync + rename).
   */
  constructor({ storeDir, runner, write = atomicWrite, concurrency = 2, now = () => new Date() }) {
    super();
    if (!runner || typeof runner.run !== "function") throw new TypeError("Fold service needs a runner.");
    this.storeDir = typeof storeDir === "function" ? storeDir : () => storeDir;
    this.runner = runner;
    this.write = write;
    this.now = now;
    this.gate = new Gate(concurrency);
    this.active = new Map();
    this.writes = new Map();
    this.tails = new Map();
    this.runs = 0;
  }

  /** Cached fold for the note as it is now: fresh chunks show written lines, edited chunks keep the old lines as stale.
   *  `noteId` null: the store does not know the note yet, so nothing is cached. */
  async get({ noteId, title, markdown, pins = [] }) {
    const units = extractUnits(markdown);
    const dir = noteId === null ? null : await this.#folder(noteId, title, false);
    const previous = dir ? await readFold(path.join(dir, "fold.json")) : null;
    const running = this.active.has(noteId);
    if (!previous) {
      const chunks = chunkUnits(units).map(chunk => ({ ...chunk, key: null }));
      return { noteId, fold: null, chunks: chunks.map(chunk => summary(chunk, "local")), stale: 0, running };
    }
    const meta = { ...previous.meta, ...this.#versions() };
    const chunks = planChunks(units, meta, pins);
    const records = await this.#records(dir, chunks, meta);
    const fold = assembleFold(meta, units, chunks, records, previous);
    const states = chunks.map(chunk => summary(chunk, records.has(chunk.key) ? "written" : "stale"));
    return { noteId, fold, chunks: states, stale: states.filter(chunk => chunk.state === "stale").length, running };
  }

  /**
   * Starts a ladder run. Only chunks without a fresh cache file call the runner; `sections` limits the run to the
   * chunks holding those heading ids. A second run for the same note cancels the first (finished chunks stay)
   * and starts once the first has settled, so `fold.json` never goes back to an older note version.
   * `connection` reaches the runner with each chunk (the route's endpoint); it is never written to the cache.
   */
  run({ noteId, title, markdown, route, agent, model, outLang, pins = [], sections = null, visible = null, connection = null }) {
    if (!noteIdPattern.test(String(noteId))) throw new TypeError("Invalid fold note id.");
    const meta = { slot: SLOT, route, ...(route === "agent" ? { agent } : {}), model, ...this.#versions(), outLang, created: this.now().toISOString() };
    const problems = foldProblems(foldRecord(meta, [], [], []));
    if (problems.length) throw new TypeError(`Invalid fold run: ${problems.join("; ")}`);
    this.cancel({ noteId });
    const runId = `${noteId}-${++this.runs}`;
    const controller = new AbortController();
    const prior = this.tails.get(noteId) ?? Promise.resolve();
    const done = prior.then(() => this.#execute({ runId, noteId, title, markdown, meta, pins, sections, visible, connection, signal: controller.signal }))
      .finally(() => { if (this.active.get(noteId)?.runId === runId) this.active.delete(noteId); });
    const tail = done.catch(() => {});
    this.tails.set(noteId, tail);
    tail.then(() => { if (this.tails.get(noteId) === tail) this.tails.delete(noteId); });
    this.active.set(noteId, { runId, controller, done });
    return { runId, done };
  }

  /** Stops the note's run: finished chunks stay cached, the rest stay local. */
  cancel({ noteId }) {
    const run = this.active.get(noteId);
    if (!run) return false;
    this.active.delete(noteId);
    run.controller.abort();
    return true;
  }

  async close() {
    for (const run of this.active.values()) run.controller.abort();
    this.active.clear();
    await Promise.allSettled([...this.tails.values()]);
  }

  #versions() {
    return { promptVersion: this.runner.promptVersion, schemaVersion: this.runner.schemaVersion };
  }

  async #execute({ runId, noteId, title, markdown, meta, pins, sections, visible, connection, signal }) {
    const ladder = foldDocumentLadder(markdown);
    const units = new Map(ladder.units.map(unit => [unit.elementId, unit]));
    const stops = new Map(ladder.byUnit.map(entry => [entry.unit.elementId, entry.stops]));
    const chunks = planChunks(ladder.units, meta, pins);
    const dir = await this.#folder(noteId, title, true);
    const previous = await readFold(path.join(dir, "fold.json"));
    const records = await this.#records(dir, chunks, meta);
    const wanted = Array.isArray(sections) ? new Set(sections) : null;
    const inWanted = chunk => !wanted || chunk.unitIds.some(id => wanted.has(units.get(id).sectionId));
    const queue = queueOrder(chunks.filter(chunk => !records.has(chunk.key) && inWanted(chunk)), visible);
    const tally = { calls: 0, ms: 0, written: 0, errors: 0 };
    const emit = event => this.emit("progress", { runId, noteId, ...event });
    const saveFold = () => this.#serial(dir, () => this.write(path.join(dir, "fold.json"), json(assembleFold(meta, ladder.units, chunks, records, previous))));
    if (signal.aborted) {
      emit({ phase: "cancelled", total: queue.length, ...tally });
      return { runId, state: "cancelled", ...tally };
    }

    emit({ phase: "start", total: queue.length, cached: records.size, chunks: queue.map(chunk => summary(chunk, "queued")) });
    if (!queue.length) {
      await saveFold();
      await this.#prune(dir, chunks);
      emit({ phase: "done", done: 0, total: 0, ...tally });
      return { runId, state: "done", ...tally };
    }

    // Replies may land out of order; events leave in queue order so sections fill top-down without jumps.
    const outcomes = new Array(queue.length);
    let released = 0;
    const release = () => {
      while (released < queue.length && outcomes[released]) {
        const outcome = outcomes[released++];
        if (outcome.state !== "cancelled") emit({ phase: "chunk", index: released - 1, done: released, total: queue.length, ...outcome, calls: tally.calls, ms: tally.ms });
      }
    };

    await Promise.all(queue.map(async (chunk, index) => {
      let outcome;
      try {
        const chunkUnits = chunk.unitIds.map(id => units.get(id));
        const reply = await this.#foldChunk({ noteId, meta, chunk, chunkUnits, stops, pins, connection, signal, tally });
        if (signal.aborted) throw abortError();
        const record = foldRecord({ ...meta, created: this.now().toISOString() }, chunkUnits, reply.written, reply.sections);
        const problems = foldProblems(record);
        if (problems.length) throw Object.assign(new Error(`Fold reply rejected: ${problems[0]}`), { code: "FOLD_INVALID" });
        await this.#serial(dir, () => this.write(path.join(dir, "chunks", `${chunk.key}.json`), json(record)));
        records.set(chunk.key, record);
        await saveFold();
        tally.written++;
        outcome = { state: "written", chunk: summary(chunk, "written"), written: record.written, sections: record.sections, warnings: reply.warnings };
      } catch (error) {
        if (isAbort(error) || signal.aborted) outcome = { state: "cancelled" };
        else {
          tally.errors++;
          outcome = { state: "error", chunk: summary(chunk, "error"), error: { message: error?.message ?? String(error), code: error?.code ?? "FOLD_FAILED" } };
        }
      }
      outcomes[index] = outcome;
      release();
    }));
    // A cancel leaves gaps; finished chunks behind a gap still report, in queue order.
    if (signal.aborted) {
      for (let index = released; index < queue.length; index++) {
        const outcome = outcomes[index];
        if (outcome.state !== "cancelled") emit({ phase: "chunk", index, done: index + 1, total: queue.length, ...outcome, calls: tally.calls, ms: tally.ms });
      }
      emit({ phase: "cancelled", total: queue.length, ...tally });
      return { runId, state: "cancelled", ...tally };
    }
    await this.#prune(dir, chunks);
    emit({ phase: "done", done: queue.length, total: queue.length, ...tally });
    return { runId, state: "done", ...tally };
  }

  async #call(request, signal, tally) {
    await this.gate.acquire(signal);
    const started = performance.now();
    let pending;
    try { pending = Promise.resolve(this.runner.run({ ...request, signal })); }
    catch (error) { pending = Promise.reject(error); }
    pending.then(() => {}, () => {}).finally(() => { tally.ms += Math.round(performance.now() - started); this.gate.release(); });
    tally.calls++;
    return untilAborted(pending, signal);
  }

  // One chunk: the shared ladder validator calls, validates, payload-checks, retries once naming the lost tokens,
  // then falls back to Brief words (shared/fold-check.mjs `checkLadderChunk`).
  async #foldChunk({ noteId, meta, chunk, chunkUnits: allUnits, stops, pins, connection, signal, tally }) {
    // HTML comments are invisible on the page: the model never sees them, so no line can quote or obey them.
    const chunkUnits = allUnits.filter(unit => !isHiddenUnit(unit));
    const chunkIds = new Set(chunkUnits.map(unit => unit.elementId));
    const chunkPins = pins.filter(pin => chunkIds.has(pin?.elementId) && typeof pin.quote === "string" && pin.quote.trim())
      .map(pin => ({ elementId: pin.elementId, quote: pin.quote }));
    const request = {
      noteId,
      slot: SLOT,
      route: meta.route,
      ...(meta.agent ? { agent: meta.agent } : {}),
      model: meta.model,
      ...(connection ? { connection } : {}),
      outLang: meta.outLang,
      promptVersion: meta.promptVersion,
      schemaVersion: meta.schemaVersion,
      chunk: {
        key: chunk.key,
        units: chunkUnits.map(unit => ({
          elementId: unit.elementId, kind: unit.kind, raw: unit.raw, sectionId: unit.sectionId, headings: unit.headings,
          markdown: unit.markdown, text: unit.text, brief: stops.get(unit.elementId).brief,
        })),
        pins: chunkPins,
      },
      retry: null,
    };
    const ask = async retry => {
      if (!retry) return this.#call(request, signal, tally);
      try { return await this.#call({ ...request, retry }, signal, tally); }
      catch (error) { if (isAbort(error) || signal.aborted) throw error; return null; }
    };
    return checkLadderChunk(ask, { units: chunkUnits, stops, pins: chunkPins, sectionIds: chunk.sectionIds });
  }

  async #records(dir, chunks, meta) {
    const records = new Map();
    await Promise.all(chunks.map(async chunk => {
      const record = await readFold(path.join(dir, "chunks", `${chunk.key}.json`));
      if (record && sameWriter(record.meta, meta) && record.units.length === chunk.hashes.length
        && record.units.every((unit, index) => unit.hash === chunk.hashes[index])) records.set(chunk.key, record);
    }));
    return records;
  }

  // After a full run only the current keys stay; leftovers of a killed write go too.
  async #prune(dir, chunks) {
    const keep = new Set(chunks.map(chunk => chunk.key));
    await this.#serial(dir, async () => {
      for (const folder of [dir, path.join(dir, "chunks")]) {
        const names = await readdir(folder).catch(() => []);
        for (const name of names) {
          const key = chunkFile.exec(name)?.[1];
          const stale = leftoverTemp.test(name) || (folder !== dir && key && !keep.has(key));
          if (stale) await unlink(path.join(folder, name)).catch(() => {});
        }
      }
    });
  }

  #serial(dir, task) {
    const next = (this.writes.get(dir) ?? Promise.resolve()).then(task, task);
    const settled = next.catch(() => {});
    this.writes.set(dir, settled);
    settled.then(() => { if (this.writes.get(dir) === settled) this.writes.delete(dir); });
    return next;
  }

  async #folder(noteId, title, create) {
    if (!noteIdPattern.test(String(noteId))) throw new TypeError("Invalid fold note id.");
    const store = this.storeDir();
    if (!store) throw Object.assign(new Error("Fold storage is not ready."), { code: "FOLD_NO_STORE" });
    const root = path.join(store, "folds");
    const suffix = ` ~${noteId}`;
    const existing = (await readdir(root).catch(() => [])).find(name => name.endsWith(suffix));
    if (existing) return path.join(root, existing);
    if (!create) return null;
    const dir = path.join(root, glassFileName(title || "note", noteId).slice(0, -".jsonl".length));
    await mkdir(path.join(dir, "chunks"), { recursive: true, mode: 0o700 });
    return dir;
  }
}

function summary(chunk, state) {
  return { index: chunk.index, key: chunk.key, unitIds: chunk.unitIds, sectionIds: chunk.sectionIds, state };
}

const json = value => `${JSON.stringify(value, null, 2)}\n`;

// Rebuildable cache: an unreadable or invalid file is a miss, never an error.
async function readFold(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return foldProblems(value).length ? null : value;
  } catch {
    return null;
  }
}
