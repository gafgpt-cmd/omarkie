import { createHash } from "node:crypto";
import { lstat, opendir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { GlassFinder } from "./glass-finder.mjs";
import { GlassIndex } from "./glass-index.mjs";
import { createWatcher, ignoredPath, mountInfo } from "./glass-watcher.mjs";
import { isNotePath, noteKey, planMoves } from "../shared/glass-moves.mjs";


const markdown = /\.(?:md|markdown|mdown)$/i;
const image = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i;
const kinds = { pdf: /\.pdf$/i, audio: /\.(?:mp3|wav|ogg|m4a|flac|opus|aac)$/i, video: /\.(?:mp4|mov|webm|mkv|avi)$/i };

export function kindOf(name) {
  if (markdown.test(name)) return "note";
  if (image.test(name)) return "image";
  for (const [kind, pattern] of Object.entries(kinds)) if (pattern.test(name)) return kind;
  return "other";
}

function shapeOf(head, fileName) {
  return {
    headings: [...head.matchAll(/^#{1,6}[ \t]+(.+)$/gm)].map(match => match[1].trim().slice(0, 200)).slice(0, 50),
    firstLines: head.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 3).map(line => line.slice(0, 200)),
    fileName,
  };
}

const missing = error => { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; return null; };

// FAT and exFAT stamp whole seconds (2 s on FAT), so size plus an equal mtime is not proof of
// unchanged content: a same-size edit inside the stamp window keeps the old signature.
const coarseTypes = new Set(["vfat", "fat", "msdos", "umsdos", "exfat"]);
const coarseStamp = value => Number.isFinite(value) && value % 1_000 === 0;
async function coarseFilesystem(root) {
  const mount = await mountInfo(root).catch(() => null);
  return !!mount && coarseTypes.has(mount.type);
}

// One index, one watcher and one mover per open vault.
export class GlassSync {
  constructor({ service, cacheDir, appData, watcherFactory = createWatcher, indexFactory = GlassIndex, trace = () => {} }) {
    if (!service?.root || !cacheDir || !appData) throw new Error("Glass sync needs a service, a cache folder and app data.");
    this.service = service;
    this.root = service.root;
    this.cacheDir = cacheDir;
    this.watcherFactory = watcherFactory;
    this.indexFactory = indexFactory;
    // trace(step, ms): startup step durations for the app's debug log.
    this.trace = trace;
    this.finder = new GlassFinder({ file: path.join(appData, "glass-finder.jsonl") });
    this.queue = Promise.resolve();
    this.scanning = false;
    this.scanComplete = false;
    this.total = 0;
    this.indexed = 0;
    this.unclaimed = new Map();
    this.lost = [];
    this.offer = null;
    this.noteByKey = new Map();
    this.caseInsensitive = false;
    this.indexId = null;
    this.closed = false;
    // map and find wait for the first indexed batch of the startup scan; a cold-start call never reads an empty index.
    this.firstBatch = new Promise(resolve => { this.firstBatchDone = resolve; });
  }

  async start() {
    let lap = performance.now();
    const step = name => { const now = performance.now(); this.trace(name, Math.round(now - lap)); lap = now; };
    await this.finder.load();
    this.service.finder = this.finder;
    step("finder");
    await this.rebuildNoteKeys();
    step("note-keys");
    await this.openIndex();
    step("index");
    this.unsubscribe = this.service.subscribe?.(() => this.scheduleMagnets());
    const scanFrom = performance.now();
    this.scanTask = this.scan("startup").catch(error => { this.error = error.message; this.scanComplete = true; });
    void this.scanTask.then(() => this.trace("scan", Math.round(performance.now() - scanFrom)));
    this.queue = this.scanTask;
    this.mode = null;
    this.watcher = await this.watcherFactory({ root: this.root, onBatch: events => this.handleBatch(events),
      onMode: mode => { this.mode = mode; this.notify(); } }).catch(error => {
      this.watcherError = error.message;
      return null;
    });
    step("watcher");
    this.service.afterInitialize = () => { void this.retarget().catch(error => { this.error = error.message; this.notify(); }); };
    return this;
  }

  indexPath() {
    const id = this.service.vaultId ?? `h-${createHash("sha256").update(this.root).digest("hex").slice(0, 16)}`;
    return path.join(this.cacheDir, id, "index.db");
  }

  // A retarget swaps the database while the rest of the app keeps asking; retry once after the swap.
  async requestIndex(op, payload = {}) {
    try { return await this.index.request(op, payload); }
    catch (error) {
      if (this.closed || !/closed/i.test(error.message)) throw error;
      await this.queue.catch(() => {});
      return this.index.request(op, payload);
    }
  }

  async openIndex() {
    this.indexId = this.service.vaultId ?? null;
    this.magnetSignature = null;
    this.indexFile = this.indexPath();
    this.index = await new this.indexFactory({ file: this.indexFile }).open();
    return this.index;
  }

  async retarget() {
    if (this.closed || this.indexId === this.service.vaultId) return;
    const job = async () => {
      await this.index?.close();
      await this.openIndex();
      await this.scan("retarget");
    };
    this.queue = this.queue.then(job, job);
    return this.queue;
  }

  async rebuildNoteKeys() {
    this.noteByKey = new Map();
    for (const note of this.service.notesById.values()) {
      const key = noteKey(note.path, this.caseInsensitive);
      this.noteByKey.set(key, note);
    }
    this.noteFor = relative => this.noteByKey.get(noteKey(relative, this.caseInsensitive)) ?? null;
  }

  async noteIdFor(relative) {
    return this.noteFor(relative)?.id ?? null;
  }

  // A case-insensitive drive (exFAT, NTFS, APFS default) needs keyed matching; a probe never writes.
  async detectCase(sample) {
    if (process.platform === "darwin" || process.platform === "win32") return true;
    if (!sample) return false;
    const file = path.join(this.root, ...sample.split("/"));
    const base = path.basename(file);
    const toggled = base === base.toLowerCase() ? base.toUpperCase() : base.toLowerCase();
    if (toggled === base) return false;
    const other = path.join(path.dirname(file), toggled);
    const [left, right] = await Promise.all([stat(file).catch(() => null), stat(other).catch(() => null)]);
    return !!left && !!right && left.ino === right.ino && left.dev === right.dev;
  }

  async walk() {
    const entries = [];
    async function visit(folder, relative) {
      let directory;
      try { directory = await opendir(folder, { bufferSize: 128 }); } catch { return; }
      const batch = [];
      async function flush() {
        const readings = await Promise.all(batch.map(async ([file, name]) => {
          try {
            const metadata = await lstat(file);
            return metadata.isFile() ? { path: name, size: metadata.size, mtime: metadata.mtimeMs, kind: kindOf(name) } : null;
          } catch { return null; }
        }));
        for (const reading of readings) if (reading) entries.push(reading);
        batch.length = 0;
      }
      for await (const entry of directory) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (ignoredPath(name)) continue;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) { await visit(file, name); continue; }
        if (!entry.isFile()) continue;
        batch.push([file, name]);
        if (batch.length === 32) await flush();
      }
      if (batch.length) await flush();
    }
    await visit(this.root, "");
    return entries;
  }

  async readNote(entry, needShape = true) {
    const file = path.join(this.root, ...entry.path.split("/"));
    const buffer = await readFile(file).catch(missing);
    if (!buffer) return null;
    const hash = createHash("sha256").update(buffer).digest("hex");
    const text = buffer.toString("utf8"), fileName = path.basename(entry.path);
    const shape = needShape ? shapeOf(buffer.length <= 1024 * 1024 ? text : buffer.subarray(0, 1024 * 1024).toString("utf8"), fileName) : undefined;
    return { ...entry, size: buffer.length, hash, text, title: fileName.replace(markdown, ""), shape };
  }

  async exists(relative) {
    const file = path.join(this.root, ...relative.split("/"));
    if (this.caseInsensitive) {
      const parent = path.dirname(file);
      const wanted = path.basename(file).normalize("NFC").toLowerCase();
      const names = await readdir(parent).catch(() => null);
      return !!names?.some(name => name.normalize("NFC").toLowerCase() === wanted);
    }
    return !!(await lstat(file).catch(() => null))?.isFile();
  }

  async scan(reason = "rescan") {
    if (this.closed) return this.status();
    this.scanning = true;
    this.scanComplete = false;
    this.scanReason = reason;
    this.indexed = 0;
    this.error = null;
    try {
      const previous = new Map((await this.requestIndex("snapshot")).map(row => [row.path, row]));
      const entries = await this.walk();
      this.coarseFs = await coarseFilesystem(this.root);
      const sample = entries.find(entry => entry.kind === "note")?.path;
      this.caseInsensitive = await this.detectCase(sample);
      await this.rebuildNoteKeys();
      this.total = entries.length;
      let indexed = 0;
      const tracked = this.service.currentNotes();
      const seen = new Set();
      const readings = [];
      let batch = [];
      const flush = async () => {
        if (!batch.length) return;
        await this.requestIndex("files", { files: batch });
        indexed += batch.length;
        this.indexed = indexed;
        this.firstBatchDone();
        batch = [];
      };
      const caseFold = relative => noteKey(relative, this.caseInsensitive);
      for (let start = 0; start < entries.length; start += 256) {
        if (this.closed) return this.status();
        const chunk = entries.slice(start, start + 256);
        await Promise.all(chunk.map(async entry => {
          seen.add(entry.path);
          const prior = previous.get(entry.path);
          const noteId = this.noteFor(entry.path)?.id ?? null;
          if (entry.kind === "note") {
            if (prior?.hash && prior.size === entry.size && prior.mtime === entry.mtime
              && !this.coarseFs && !coarseStamp(entry.mtime)) {
              if (prior.note_id !== noteId) batch.push({ ...entry, noteId });
              return;
            }
            const reading = await this.readNote(entry, tracked.length > 0);
            if (!reading) return;
            reading.noteId = noteId;
            if (tracked.length) readings.push(reading);
            batch.push(reading);
            return;
          }
          batch.push({ ...entry, noteId: null });
        }));
        await flush();
      }
      await flush();

      const stale = [...previous.keys()].filter(file => !seen.has(file));
      if (stale.length) await this.requestIndex("remove", { paths: stale });

      for (const reading of readings) {
        const note = this.noteFor(reading.path);
        if (!note || this.service.readOnly) continue;
        if (note.fingerprint?.hash === reading.hash && note.fingerprint?.size === reading.size) continue;
        await this.service.refreshFingerprint(note, { hash: reading.hash, size: reading.size, shape: reading.shape }, reading.path)
          .catch(error => { this.error = error.message; });
      }

      // A case-insensitive drive folds `Kerma.md` and `kerma.md` onto one file: follow the spelling
      // the drive now reports, so the stored path can never go stale after a case-only rename.
      if (this.caseInsensitive) {
        const folded = new Map([...seen].map(pathName => [caseFold(pathName), pathName]));
        for (const note of tracked) {
          if (seen.has(note.path)) continue;
          const actual = folded.get(caseFold(note.path));
          if (!actual || actual === note.path) continue;
          if (!this.service.readOnly) {
            await this.service.recordMove(note, actual).catch(error => { this.error = error.message; });
          }
        }
        if (tracked.length) await this.rebuildNoteKeys();
      }
      const present = this.caseInsensitive && tracked.length ? new Set([...seen].map(caseFold)) : seen;
      const missingNotes = tracked.filter(note => !present.has(caseFold(note.path)));
      this.lost = [];
      if (missingNotes.length) {
        const readingsByPath = new Map(readings.map(reading => [reading.path, reading]));
        const caseOnly = [];
        const added = readings.filter(reading => !this.noteFor(reading.path));
        const missing = [];
        for (const note of missingNotes) {
          const match = added.find(reading => caseFold(reading.path) === caseFold(note.path));
          if (!match) {
            missing.push({ ...note, hash: note.fingerprint?.hash, size: note.fingerprint?.size, shape: note.fingerprint?.shape });
            continue;
          }
          caseOnly.push({ note, match });
          readingsByPath.delete(match.path);
        }
        const plan = planMoves({ missing, added: added.filter(reading => readingsByPath.has(reading.path)), caseInsensitive: this.caseInsensitive });
        await this.applyCaseOnly(caseOnly, readingsByPath);
        await this.applyPlan(plan, readingsByPath);
        this.lost = plan.lost.map(item => ({ ...item, title: this.service.notesById.get(item.id)?.title ?? null }));
      }
      await this.publishNotes();
      await this.publishMagnets();
      this.unclaimed.clear();
      await this.updateOffer();
      this.scanComplete = true;
      this.scanAt = Date.now();
      this.error = null;
    } catch (error) {
      this.error = error.message;
      this.scanComplete = true;
    } finally {
      this.scanning = false;
      this.firstBatchDone();
      this.notify();
    }
    return this.status();
  }

  async applyCaseOnly(pairs, readingsByPath) {
    for (const { note, match } of pairs) {
      readingsByPath.delete(match.path);
      if (this.service.readOnly) continue;
      await this.service.recordMove(note, match.path, { fingerprint: { hash: match.hash, size: match.size, shape: match.shape } })
        .catch(error => { this.error = error.message; });
    }
    if (pairs.length) await this.rebuildNoteKeys();
  }

  async applyPlan(plan, readingsByPath) {
    let changed = false;
    if (!this.service.readOnly) {
      for (const folder of plan.folders) {
        await this.service.recordFolder(folder.from, folder.to).catch(error => { this.error = error.message; });
        changed = true;
      }
    }
    const applied = [];
    for (const move of plan.moves) {
      const reading = readingsByPath.get(move.to);
      const note = this.service.notesById.get(move.id);
      if (!note || !reading) continue;
      if (!this.service.readOnly) {
        await this.service.recordMove(note, move.to, { fingerprint: { hash: reading.hash, size: reading.size, shape: reading.shape } })
          .catch(error => { this.error = error.message; });
      }
      readingsByPath.delete(move.to);
      applied.push({ id: move.id, from: move.from, to: move.to, confidence: move.confidence });
      changed = true;
    }
    if (changed) await this.rebuildNoteKeys();
    this.lastPlan = { folders: plan.folders, moves: applied, lost: plan.lost.length, unmatched: plan.unmatched.length };
    return this.lastPlan;
  }

  async publishNotes() {
    await this.requestIndex("notes", { notes: this.service.currentNotes().map(note => ({ id: note.id, path: note.path,
      title: note.title, fingerprint: note.fingerprint ?? null })) });
  }

  scheduleMagnets() {
    if (this.magnetTimer) clearTimeout(this.magnetTimer);
    this.magnetTimer = setTimeout(() => {
      this.magnetTimer = null;
      const publish = async () => {
        if (this.closed) return;
        try { await this.publishMagnets(); }
        catch (error) {
          if (this.closed || this.error === error.message) return;
          this.error = error.message;
          this.notify();
        }
      };
      this.queue = this.queue.then(publish, publish);
    }, 250);
    this.magnetTimer.unref?.();
  }

  async publishMagnets() {
    const magnets = await this.service.magnetsForIndex().catch(() => []);
    const signature = magnets.map(magnet => `${magnet.id}:${magnet.text}:${magnet.noteId}`).join("\n");
    if (signature === this.magnetSignature) return;
    await this.requestIndex("magnets", { magnets });
    this.magnetSignature = signature;
  }

  async updateOffer() {
    if (!this.finder.hasForeign(this.service.vaultId)) { this.offer = null; return; }
    try {
      const rows = (await this.requestIndex("snapshot")).filter(row => row.kind === "note" && row.hash);
      const found = this.finder.matches(rows.map(row => row.hash), this.service.vaultId);
      const paths = new Map(rows.map(row => [row.hash, row.path]));
      this.offer = found.length ? { count: found.length, vaults: [...new Set(found.map(entry => entry.vaultId))],
        notes: found.slice(0, 50).map(entry => ({ id: entry.noteId, title: entry.title, path: paths.get(entry.hash) ?? entry.path,
          hash: entry.hash, from: entry.vaultId })) } : null;
    } catch { this.offer = null; }
  }

  // Watcher batches are serialized behind the running scan so a trickle never races a full pass.
  handleBatch(events) {
    const job = () => this.applyEvents(events);
    this.queue = this.queue.then(job, job);
    return this.queue;
  }

  async applyEvents(events) {
    if (this.closed) return;
    // A sync client dropping a journal copy is an event the note watcher can never see.
    const absorbed = await this.service.absorbConflictCopies().catch(error => { this.error = error.message; return null; });
    let full = false;
    const removed = new Set();
    const readings = [];
    const files = [];
    for (const event of events) {
      const relative = event.path;
      if (!relative || ignoredPath(relative)) continue;
      const file = path.join(this.root, ...relative.split("/"));
      const metadata = await lstat(file).catch(() => null);
      if (!metadata) {
        removed.add(relative);
        // A disappeared folder has no markdown suffix; rescan so its children leave the index too.
        if (!this.noteFor(relative) && !isNotePath(relative)) full = true;
        continue;
      }
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) { full = true; continue; }
      if (!metadata.isFile()) continue;
      const kind = kindOf(relative);
      if (kind === "note") {
        const reading = await this.readNote({ path: relative, size: metadata.size, mtime: metadata.mtimeMs, kind });
        if (!reading) { removed.add(relative); continue; }
        const note = this.noteFor(relative);
        if (!note) { this.unclaimed.set(relative, reading); readings.push(reading); continue; }
        const same = note.fingerprint?.hash === reading.hash && note.fingerprint?.size === reading.size;
        if (!same && !this.service.readOnly) {
          await this.service.refreshFingerprint(note, { hash: reading.hash, size: reading.size, shape: reading.shape }, relative)
            .catch(error => { this.error = error.message; });
        }
        files.push({ ...reading, noteId: note.id });
      } else files.push({ path: relative, kind, size: metadata.size, mtime: metadata.mtimeMs, noteId: null });
    }
    if (files.length) await this.requestIndex("files", { files });
    if (removed.size) await this.requestIndex("remove", { paths: [...removed] });
    if (full) return this.scan("directory-change");
    const status = await this.reconcile({ removed, readings });
    if (absorbed?.lines) {
      await this.publishNotes();
      await this.publishMagnets();
    }
    return status;
  }

  async reconcile({ removed, readings }) {
    await this.rebuildNoteKeys();
    const candidates = new Set();
    for (const relative of removed) {
      const note = this.noteFor(relative);
      if (note) candidates.add(note.id);
      for (const item of this.service.notesById.values())
        if (item.path.startsWith(`${relative}/`)) candidates.add(item.id);
    }
    const missingNotes = [];
    for (const id of candidates) {
      const note = this.service.notesById.get(id);
      if (!note) continue;
      if (!await this.exists(note.path)) missingNotes.push({ ...note, hash: note.fingerprint?.hash,
        size: note.fingerprint?.size, shape: note.fingerprint?.shape });
    }
    for (const reading of readings) this.unclaimed.set(reading.path, reading);
    for (const relative of this.unclaimed.keys()) if (!await this.exists(relative)) this.unclaimed.delete(relative);
    const added = [...this.unclaimed.values()].filter(reading => !this.noteFor(reading.path));
    if (!missingNotes.length && !added.length) return this.status();

    const plan = planMoves({ missing: missingNotes, added, caseInsensitive: this.caseInsensitive });
    await this.applyPlan(plan, this.unclaimed);
    if (plan.folders.length || plan.moves.length) {
      for (const folder of plan.folders)
        for (const pathName of [...this.unclaimed.keys()]) if (pathName.startsWith(`${folder.to}/`)) this.unclaimed.delete(pathName);
      await this.publishNotes();
      await this.publishMagnets();
      this.lost = this.lost.filter(item => !plan.moves.some(move => move.id === item.id) && this.service.notesById.has(item.id));
    }
    if (plan.lost.length) this.lost = plan.lost.map(item => ({ ...item, title: this.service.notesById.get(item.id)?.title ?? null }));
    if (this.unclaimed.size > 5_000) this.unclaimed = new Map([...this.unclaimed].slice(-5_000));
    await this.updateOffer();
    this.notify();
    return this.status();
  }

  async focus() {
    if (this.closed) return this.status();
    // Native watches cover local drives; a poll or a dead watcher needs a catch-up pass when the
    // window returns. Either way a sync client writes journals under `.omarkie`, which no note
    // watcher can see, so the glass index catches up on focus too.
    const job = async () => {
      const absorbed = await this.service.absorbConflictCopies().catch(error => { this.error = error.message; return null; });
      await this.publishMagnets().catch(error => { this.error = error.message; });
      if (absorbed?.lines) await this.publishNotes();
      if (this.mode === "polling" || this.watcherError) return this.scan("focus");
      return this.status();
    };
    this.queue = this.queue.then(job, job);
    return this.queue;
  }

  async reindex() {
    return this.focus();
  }

  // The note on screen should be searchable before the rest of a 50,000-note vault.
  async prioritize(file) {
    if (this.closed || !file || !this.index) return null;
    const relative = path.relative(this.root, file).split(path.sep).join("/");
    if (!relative || relative.startsWith("..") || ignoredPath(relative) || !isNotePath(relative)) return null;
    if (await this.requestIndex("file", { path: relative })) return null;
    const metadata = await lstat(file).catch(() => null);
    if (!metadata?.isFile()) return null;
    const reading = await this.readNote({ path: relative, size: metadata.size, mtime: metadata.mtimeMs, kind: "note" });
    if (!reading) return null;
    reading.noteId = this.noteFor(relative)?.id ?? null;
    await this.requestIndex("files", { files: [reading] });
    await this.rebuildNoteKeys();
    return reading.path;
  }

  async map() {
    if (this.scanning) await this.firstBatch;
    const base = await this.requestIndex("map");
    const startup = !this.scanComplete && this.scanning;
    return { vault: this.root, vaultId: this.service.vaultId ?? null, index: this.indexFile, rebuilt: false,
      ...base,
      unindexed: Math.max(0, this.total - this.indexed) + this.unclaimed.size,
      indexing: startup, scanComplete: this.scanComplete, scanReason: this.scanReason ?? null,
      lost: this.lost, bring: this.offer, watcher: this.mode, error: this.error ?? null };
  }

  async find(request) {
    const query = String(request.query ?? request.text ?? "").trim();
    if (!query) throw new Error("A search query is required.");
    const limit = Number(request.limit) > 0 ? Number(request.limit) : 20;
    if (this.scanning) await this.firstBatch;
    const results = await this.requestIndex("find", { query, limit });
    return { query, count: results.length, results };
  }

  async finder() {
    await this.updateOffer();
    return { offer: this.offer, lost: this.lost };
  }

  bring(request) {
    const job = () => this.bringNow(request);
    this.queue = this.queue.then(job, job);
    return this.queue;
  }

  async bringNow(request) {
    const offer = this.offer ?? (await this.updateOffer(), this.offer);
    if (!offer) return { brought: [], skipped: [], offer: null };
    const rows = (await this.requestIndex("snapshot")).filter(row => row.kind === "note" && row.hash);
    const wanted = request?.note ? [request.note] : null;
    const candidates = [];
    for (const row of rows) {
      const entry = this.finder.lookup(row.hash);
      if (!entry || entry.vaultId === this.service.vaultId) continue;
      if (wanted && row.path !== wanted) continue;
      candidates.push({ row, entry });
    }
    const brought = [], skipped = [];
    for (const { row, entry } of candidates) {
      try {
        brought.push(await this.service.attachForeign(row.path, entry));
      } catch (error) { skipped.push({ path: row.path, reason: error.message }); }
    }
    if (brought.length) {
      await this.rebuildNoteKeys();
      await this.publishNotes();
      await this.publishMagnets();
    }
    await this.updateOffer();
    this.notify();
    return { brought, skipped, offer: this.offer };
  }

  status() {
    return { indexFile: this.indexFile ?? null, indexing: this.scanning, scanComplete: this.scanComplete,
      indexed: this.indexed, total: this.total, watcher: this.mode ?? null, lost: this.lost.length,
      bring: this.offer?.count ?? 0, caseInsensitive: this.caseInsensitive, error: this.error ?? null };
  }

  notify() {
    this.service.indexStatus = this.status();
    this.service.lost = this.lost;
    this.service.offer = this.offer;
    this.service.notify();
  }

  async whenIdle() {
    await this.queue.catch(() => {});
    return this.status();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.magnetTimer) clearTimeout(this.magnetTimer);
    this.magnetTimer = null;
    this.unsubscribe?.();
    this.service.finder = null;
    this.service.afterInitialize = null;
    await Promise.resolve(this.watcher?.close()).catch(() => {});
    await this.queue.catch(() => {});
    await this.index?.close().catch(() => {});
  }
}
