// Fold service (design §4.1-4.3): the single writer of `<store>/folds/<note> ~<id>/`: the ladder slot's `fold.json` +
// `chunks/<key>.json`, the Estudio slot's `estudio.json` + `estudio-chunks/<key>.json`. Chunks queue in document order
// (visible chunk first), run two at a time across notes, stream in queue order, and cancel without a partial cache
// entry. Each slot runs on its own: a ladder run and an Estudio run of one note neither cancel nor prune each other.
// Model calls go through the injected runner; no route lives here.

import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { assembleEstudio, assembleFold, chunkUnits, foldRecord, planChunks, queueOrder, sameWriter } from "../shared/fold-cache.mjs";
import { checkLadderChunk } from "../shared/fold-check.mjs";
import { checkEstudioChunk, mergeEstudio } from "../shared/fold-estudio.mjs";
import { SLOTS, foldProblems } from "../shared/fold-format.mjs";
import { extractUnits, foldDocumentLadder, isHiddenUnit } from "../shared/fold-units.mjs";
import { glassFileName } from "../shared/glass-core.mjs";
import { atomicWrite } from "./store.mjs";

// Where each slot keeps its note record and its chunk cache files.
const FILES = Object.freeze({
  ladder: { record: "fold.json", chunks: "chunks" },
  estudio: { record: "estudio.json", chunks: "estudio-chunks" },
});
const noteIdPattern = /^[a-z0-9]{4,32}$/;
const chunkFile = /^([0-9a-f]{64})\.json$/;
const leftoverTemp = /^\..+\.tmp$/;
const runKey = (slot, noteId) => `${slot}:${noteId}`;

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
   * @param {{ versions: (slot: string) => { promptVersion: number, schemaVersion: number }, run: (request: object) => Promise<object> }} options.runner
   * @param {(file: string, data: string) => Promise<void>} [options.write] atomic file write (tmp + fsync + rename).
   */
  constructor({ storeDir, runner, write = atomicWrite, concurrency = 2, now = () => new Date() }) {
    super();
    if (!runner || typeof runner.run !== "function" || typeof runner.versions !== "function") throw new TypeError("Fold service needs a runner.");
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

  /** Cached fold of one slot for the note as it is now: fresh chunks show written lines, edited chunks keep the old
   *  lines as stale. `noteId` null: the store does not know the note yet, so nothing is cached. */
  async get({ noteId, title, markdown, pins = [], slot = "ladder" }) {
    if (!SLOTS.includes(slot)) throw new TypeError("Invalid fold slot.");
    const units = extractUnits(markdown);
    const dir = noteId === null ? null : await this.#folder(noteId, title, false);
    const found = dir ? await readFold(path.join(dir, FILES[slot].record)) : null;
    const previous = found?.meta.slot === slot ? found : null;
    const running = this.active.has(runKey(slot, noteId));
    if (!previous) {
      const chunks = chunkUnits(units).map(chunk => ({ ...chunk, key: null }));
      return { noteId, slot, fold: null, chunks: chunks.map(chunk => summary(chunk, "local")), stale: 0, running };
    }
    const meta = { ...previous.meta, ...this.runner.versions(slot) };
    const chunks = planChunks(units, meta, pins);
    const records = await this.#records(dir, chunks, meta);
    const fold = (slot === "estudio" ? assembleEstudio : assembleFold)(meta, units, chunks, records, previous);
    const states = chunks.map(chunk => summary(chunk, records.has(chunk.key) ? "written" : "stale"));
    return { noteId, slot, fold, chunks: states, stale: states.filter(chunk => chunk.state === "stale").length, running };
  }

  /**
   * Starts a run of one slot. Only chunks without a fresh cache file call the runner; `sections` limits the run to
   * the chunks holding those heading ids. A second run of the same slot and note cancels the first (finished chunks
   * stay) and starts once the first has settled, so the note record never goes back to an older note version.
   * `connection` reaches the runner with each chunk (the route's endpoint); it is never written to the cache.
   */
  run({ noteId, title, markdown, slot = "ladder", route, agent, model, outLang, pins = [], sections = null, visible = null, connection = null }) {
    if (!noteIdPattern.test(String(noteId))) throw new TypeError("Invalid fold note id.");
    if (!SLOTS.includes(slot)) throw new TypeError("Invalid fold slot.");
    const meta = { slot, route, ...(route === "agent" ? { agent } : {}), model, ...this.runner.versions(slot), outLang, created: this.now().toISOString() };
    const problems = foldProblems(foldRecord(meta, [], [], [], slot === "estudio" ? mergeEstudio([]) : null));
    if (problems.length) throw new TypeError(`Invalid fold run: ${problems.join("; ")}`);
    this.cancel({ noteId, slot });
    const key = runKey(slot, noteId);
    const runId = `${noteId}-${++this.runs}`;
    const controller = new AbortController();
    const prior = this.tails.get(key) ?? Promise.resolve();
    const done = prior.then(() => this.#execute({ runId, noteId, title, markdown, meta, pins, sections, visible, connection, signal: controller.signal }))
      .finally(() => { if (this.active.get(key)?.runId === runId) this.active.delete(key); });
    const tail = done.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    this.active.set(key, { runId, controller, done });
    return { runId, done };
  }

  /** Stops the note's run of `slot`, or of every slot: finished chunks stay cached, the rest stay local. */
  cancel({ noteId, slot = null }) {
    let stopped = false;
    for (const each of slot ? [slot] : SLOTS) {
      const run = this.active.get(runKey(each, noteId));
      if (!run) continue;
      this.active.delete(runKey(each, noteId));
      run.controller.abort();
      stopped = true;
    }
    return stopped;
  }

  async close() {
    for (const run of this.active.values()) run.controller.abort();
    this.active.clear();
    await Promise.allSettled([...this.tails.values()]);
  }

  async #execute({ runId, noteId, title, markdown, meta, pins, sections, visible, connection, signal }) {
    const { slot } = meta;
    const ladder = slot === "ladder" ? foldDocumentLadder(markdown) : null;
    const allUnits = ladder ? ladder.units : extractUnits(markdown);
    const units = new Map(allUnits.map(unit => [unit.elementId, unit]));
    const stops = ladder ? new Map(ladder.byUnit.map(entry => [entry.unit.elementId, entry.stops])) : null;
    const chunks = planChunks(allUnits, meta, pins);
    const dir = await this.#folder(noteId, title, true);
    await mkdir(path.join(dir, FILES[slot].chunks), { recursive: true, mode: 0o700 });
    const found = await readFold(path.join(dir, FILES[slot].record));
    const previous = found?.meta.slot === slot ? found : null;
    const records = await this.#records(dir, chunks, meta);
    const wanted = Array.isArray(sections) ? new Set(sections) : null;
    const inWanted = chunk => !wanted || chunk.unitIds.some(id => wanted.has(units.get(id).sectionId));
    const queue = queueOrder(chunks.filter(chunk => !records.has(chunk.key) && inWanted(chunk)), visible);
    const tally = { calls: 0, ms: 0, written: 0, errors: 0 };
    const emit = event => this.emit("progress", { runId, noteId, slot, ...event });
    const assemble = slot === "estudio" ? assembleEstudio : assembleFold;
    const saveFold = () => this.#serial(dir, async () => {
      const record = assemble(meta, allUnits, chunks, records, previous);
      await this.write(path.join(dir, FILES[slot].record), json(record));
      return record;
    });
    if (signal.aborted) {
      emit({ phase: "cancelled", total: queue.length, ...tally });
      return { runId, state: "cancelled", ...tally };
    }

    emit({ phase: "start", total: queue.length, cached: records.size, chunks: queue.map(chunk => summary(chunk, "queued")) });
    if (!queue.length) {
      await saveFold();
      await this.#prune(dir, chunks, slot);
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
        const created = { ...meta, created: this.now().toISOString() };
        const record = slot === "estudio"
          ? foldRecord(created, chunkUnits, [], [], reply.estudio)
          : foldRecord(created, chunkUnits, reply.written, reply.sections);
        const problems = foldProblems(record);
        if (problems.length) throw Object.assign(new Error(`Fold reply rejected: ${problems[0]}`), { code: "FOLD_INVALID" });
        await this.#serial(dir, () => this.write(path.join(dir, FILES[slot].chunks, `${chunk.key}.json`), json(record)));
        records.set(chunk.key, record);
        const saved = await saveFold();
        tally.written++;
        outcome = slot === "estudio"
          // An Estudio chunk shows as the whole merged sheet: a chunk's items fold into the others'.
          ? { state: "written", chunk: summary(chunk, "written"), estudio: saved.estudio, retried: reply.retried, outOfFold: reply.outOfFold }
          : { state: "written", chunk: summary(chunk, "written"), written: record.written, sections: record.sections, warnings: reply.warnings };
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
    await this.#prune(dir, chunks, slot);
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

  // One chunk: the slot's shared checker calls, validates, payload-checks and retries once naming the lost tokens;
  // the ladder then falls back to Brief words (`checkLadderChunk`), Estudio drops the item (`checkEstudioChunk`).
  async #foldChunk({ noteId, meta, chunk, chunkUnits: allUnits, stops, pins, connection, signal, tally }) {
    // HTML comments are invisible on the page: the model never sees them, so no line can quote or obey them.
    const chunkUnits = allUnits.filter(unit => !isHiddenUnit(unit));
    const chunkIds = new Set(chunkUnits.map(unit => unit.elementId));
    const chunkPins = pins.filter(pin => chunkIds.has(pin?.elementId) && typeof pin.quote === "string" && pin.quote.trim())
      .map(pin => ({ elementId: pin.elementId, quote: pin.quote }));
    const estudio = meta.slot === "estudio";
    const request = {
      noteId,
      slot: meta.slot,
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
          markdown: unit.markdown, text: unit.text,
          ...(estudio ? (unit.cells ? { cells: unit.cells } : {}) : { brief: stops.get(unit.elementId).brief }),
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
    if (estudio) return checkEstudioChunk(ask, { units: request.chunk.units, pins: chunkPins });
    return checkLadderChunk(ask, { units: chunkUnits, stops, pins: chunkPins, sectionIds: chunk.sectionIds });
  }

  async #records(dir, chunks, meta) {
    const records = new Map();
    await Promise.all(chunks.map(async chunk => {
      const record = await readFold(path.join(dir, FILES[meta.slot].chunks, `${chunk.key}.json`));
      if (record && sameWriter(record.meta, meta) && record.units.length === chunk.hashes.length
        && record.units.every((unit, index) => unit.hash === chunk.hashes[index])) records.set(chunk.key, record);
    }));
    return records;
  }

  // After a full run only the slot's current keys stay; leftovers of a killed write go too. The other slot's cache
  // folder is never touched.
  async #prune(dir, chunks, slot) {
    const keep = new Set(chunks.map(chunk => chunk.key));
    await this.#serial(dir, async () => {
      for (const folder of [dir, path.join(dir, FILES[slot].chunks)]) {
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
