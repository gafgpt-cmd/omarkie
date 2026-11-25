import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, stat, truncate, unlink } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  createClock, glassFileName, glassVersion, newMagnetId, parseClock, replayJournalText, replayNotesText, stickyColors,
  visibleMagnets,
} from "../shared/glass-core.mjs";

const markdown = /\.(?:md|markdown|mdown)$/i;
const noFollow = (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
const ownership = ["EACCES", "EPERM", "EROFS"];
const missing = error => { if (error.code !== "ENOENT") throw error; return null; };
const info = file => lstat(file).catch(missing);
const directory = async file => { const item = await info(file); return !!item?.isDirectory() && !item.isSymbolicLink(); };
const relative = (root, file) => path.relative(root, file).split(path.sep).join("/");
const titleOf = name => path.basename(name).replace(markdown, "");
const journalPattern = / ~([a-z0-9]{4,32})\.jsonl$/;

export class GlassService {
  constructor({ root, appData, device, host = os.hostname(), now = Date.now, faults = {} }) {
    if (!root || !appData) throw new Error("Glass storage needs a vault root and an app data folder.");
    this.root = root;
    this.appData = appData;
    this.host = host;
    this.now = now;
    this.faults = faults;
    this.deviceName = device;
    this.pending = [];
    this.memory = new Map();
    this.cache = new Map();
    this.sizes = new Map();
    this.notesById = new Map();
    this.notesByPath = new Map();
    this.journals = new Map();
    this.retryDelay = 1_000;
    this.clock = null;
    this.initialized = false;
    this.mode = null;
    this.vaultId = null;
    this.storeDir = null;
    this.readOnly = false;
    this.tail = Promise.resolve();
    this.closed = false;
  }

  async open({ passive = true } = {}) {
    try {
      this.root = await realpath(this.root);
      const rootInfo = await stat(this.root);
      if (!rootInfo.isDirectory()) throw new Error("Glass storage needs a folder.");
      this.deviceName ??= await this.deviceId();
      this.clock = createClock(this.deviceName, this.now);
      this.loaded = true;
      if (!passive || await this.existingStore()) await this.initialize();
      return this;
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  existingStore() {
    return this.findStore().then(settings => !!settings);
  }

  async findStore() {
    const insideSettings = await readJson(path.join(this.root, ".omarkie", "settings.json"));
    if (goodVaultId(insideSettings?.vaultId)) return insideSettings;
    const remembered = await this.registryEntry();
    if (!goodVaultId(remembered?.vaultId)) return null;
    const outside = path.join(this.appData, "glass-vaults", remembered.vaultId);
    const settings = await readJson(path.join(outside, "settings.json"));
    return goodVaultId(settings?.vaultId) && await directory(outside) ? settings : null;
  }

  initialize() {
    this.opening ??= this.setup().catch(error => { this.opening = null; throw error; });
    return this.opening;
  }

  async setup() {
    await this.resolveStore();
    await this.makeStoreDirectories();
    await this.acquireLock();
    if (!this.readOnly) await this.ensureLayout();
    await this.loadNotes();
    await this.scanJournals();
    this.initialized = true;
    return this;
  }

  async deviceId() {
    const file = path.join(this.appData, "glass-device.json");
    const stored = await readJson(file);
    if (stored?.version === glassVersion && typeof stored.id === "string" && /^[a-z0-9-]{4,64}$/.test(stored.id)) return stored.id;
    const id = `d-${randomBytes(4).toString("hex")}`;
    await mkdir(this.appData, { recursive: true, mode: 0o700 });
    await atomicJson(file, { version: glassVersion, id });
    return id;
  }

  async resolveStore() {
    const inside = path.join(this.root, ".omarkie");
    const insideSettings = await readJson(path.join(inside, "settings.json"));
    const remembered = await this.registryEntry();
    let vaultId = goodVaultId(insideSettings?.vaultId) ? insideSettings.vaultId : goodVaultId(remembered?.vaultId) ? remembered.vaultId : null;
    let requested = insideSettings?.mode === "outside" ? "outside" : "inside";
    if (!insideSettings && goodVaultId(remembered?.vaultId)) {
      const outside = path.join(this.appData, "glass-vaults", remembered.vaultId);
      const settings = await readJson(path.join(outside, "settings.json"));
      if (goodVaultId(settings?.vaultId) && await directory(outside)) requested = "outside";
    }
    if (requested === "inside") {
      if (!await directory(inside)) {
        try { await mkdir(inside, { recursive: true, mode: 0o700 }); }
        catch (error) { if (!ownership.includes(error.code)) throw error; requested = "outside"; }
      }
      if (requested === "inside" && !await this.writable(inside)) requested = "outside";
    }
    this.vaultId = vaultId ?? randomUUID();
    this.mode = requested;
    this.storeDir = this.mode === "inside" ? inside : path.join(this.appData, "glass-vaults", this.vaultId);
    if (this.mode === "outside") {
      await mkdir(this.storeDir, { recursive: true, mode: 0o700 });
      if (!await this.writable(this.storeDir)) throw new Error("Glass storage is not writable in the app data folder.");
    }
    await this.rememberRoot();
  }

  async registryEntry() {
    const registry = await readJson(path.join(this.appData, "glass-vaults", "roots.json"));
    const value = registry?.[this.root];
    return value && typeof value === "object" ? value : null;
  }

  async rememberRoot() {
    const file = path.join(this.appData, "glass-vaults", "roots.json");
    try {
      const registry = await readJson(file) ?? {};
      registry[this.root] = { vaultId: this.vaultId, mode: this.mode, updatedAt: new Date().toISOString() };
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await atomicJson(file, registry);
    } catch { /* the registry only speeds up re-linking; the vault stays authoritative */ }
  }

  async writable(directoryPath) {
    const probe = path.join(directoryPath, `.write-${randomUUID()}`);
    try {
      const handle = await open(probe, "wx", 0o600);
      await handle.close();
      await unlink(probe).catch(() => {});
      return true;
    } catch (error) {
      if (ownership.includes(error.code) || error.code === "ENOSPC") return false;
      throw error;
    }
  }

  async makeStoreDirectories() {
    for (const name of ["glass", "assets"]) {
      const target = path.join(this.storeDir, name);
      const item = await info(target);
      if (item && (!item.isDirectory() || item.isSymbolicLink())) throw new Error(`Glass folder is not a plain directory: ${name}`);
      if (!item) await mkdir(target, { recursive: true, mode: 0o700 });
    }
  }

  async ensureLayout() {
    await writeIfMissing(path.join(this.storeDir, "README.md"), readme);
    const attributes = path.join(this.storeDir, ".gitattributes");
    const current = await readFile(attributes, "utf8").catch(missing);
    if (current === null) await writeFileAtomic(attributes, "*.jsonl merge=union\n");
    else if (!/^\*\.jsonl merge=union$/m.test(current))
      await writeFileAtomic(attributes, `${current.replace(/\n?$/, "\n")}*.jsonl merge=union\n`);
    await writeIfMissing(path.join(this.storeDir, "notes.jsonl"), "");
    const settings = path.join(this.storeDir, "settings.json");
    if (!await info(settings)) await atomicJson(settings, { version: glassVersion, vaultId: this.vaultId, mode: this.mode, createdAt: new Date().toISOString() });
    this.notesFile = path.join(this.storeDir, "notes.jsonl");
  }

  async acquireLock() {
    this.lockFile = path.join(this.storeDir, "writer.lock");
    this.lockToken = randomUUID();
    const claim = { version: glassVersion, host: this.host, pid: process.pid, token: this.lockToken, started: Date.now() };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const handle = await open(this.lockFile, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(claim)); await handle.sync(); }
        finally { await handle.close(); }
        this.lockOwner = claim;
        this.readOnly = false;
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = await readJson(this.lockFile);
        if (owner && this.alive(owner)) {
          this.lockOwner = owner;
          this.readOnly = true;
          this.readOnlyReason = owner.host && owner.host !== this.host ? "another computer owns this vault" : "another Omarkie window owns this vault";
          return;
        }
        await unlink(this.lockFile).catch(missing);
      }
    }
    throw new Error("Could not claim the Glass writer lock.");
  }

  alive(owner) {
    if (!owner || owner.host !== this.host) {
      const started = Number(owner?.started) || 0;
      return owner?.host && owner.host !== this.host && Date.now() - started < 86_400_000;
    }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    if (owner.pid === process.pid) return owner.token !== this.lockToken;
    try { process.kill(owner.pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
  }

  async loadNotes() {
    this.notesFile = path.join(this.storeDir, "notes.jsonl");
    const text = await readLimited(this.notesFile, 64 * 1024 * 1024).catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const replay = replayNotesText(text);
    this.notesById.clear();
    this.notesByPath.clear();
    for (const note of replay.notes.values()) {
      this.notesById.set(note.id, note);
      this.notesByPath.set(note.path, note);
    }
    this.notesInvalid = replay.invalid;
    if (!this.readOnly) await this.repairTail(this.notesFile);
  }

  async scanJournals() {
    const names = await readdir(path.join(this.storeDir, "glass")).catch(() => []);
    for (const name of names) {
      const match = journalPattern.exec(name);
      if (!match) continue;
      const file = path.join(this.storeDir, "glass", name);
      this.journals.set(match[1], file);
      if (!this.readOnly) await this.repairTail(file);
    }
  }

  assertReady() {
    if (!this.loaded) throw new Error("Glass storage is not open.");
    if (this.closed) throw new Error("Glass storage is closed.");
  }

  assertWritable() {
    this.assertReady();
    if (this.readOnly) throw Object.assign(new Error(`Glass is read-only: ${this.readOnlyReason ?? "another writer owns this vault"}.`), { code: "GLASS_READ_ONLY" });
  }

  async validateNote(note) {
    if (typeof note !== "string" || !note.trim() || note.length > 4096 || /[\u0000\\]/.test(note) || path.isAbsolute(note))
      throw new Error("Use a vault-relative Markdown path.");
    const parts = note.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || part.startsWith(".")) || !markdown.test(note))
      throw new Error("Use a vault-relative Markdown path, without hidden folders or symlinks.");
    const file = path.join(this.root, ...parts);
    const metadata = await info(file);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error("Note not found in this vault.");
    const actual = await realpath(file);
    const inside = path.relative(this.root, actual);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("Markdown symlinks are not allowed.");
    return { note: parts.join("/"), file };
  }

  async noteFingerprint(file) {
    const before = await lstat(file);
    const hash = createHash("sha256");
    const prefix = [];
    let kept = 0, size = 0;
    for await (const chunk of createReadStream(file)) {
      size += chunk.length;
      hash.update(chunk);
      if (kept < 1024 * 1024) { const slice = chunk.subarray(0, 1024 * 1024 - kept); prefix.push(slice); kept += slice.length; }
    }
    const after = await lstat(file);
    if (before.size !== size || after.size !== size || after.mtimeMs !== before.mtimeMs) throw new Error("The note changed while reading it; try again.");
    const head = Buffer.concat(prefix).toString("utf8");
    const headings = [...head.matchAll(/^#{1,6}[ \t]+(.+)$/gm)].map(match => match[1].trim().slice(0, 200)).slice(0, 50);
    const firstLines = head.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 3).map(line => line.slice(0, 200));
    return { hash: hash.digest("hex"), size, shape: { headings, firstLines, fileName: path.basename(file) } };
  }

  async identify(note) {
    const { note: name, file } = await this.validateNote(note);
    const fingerprint = await this.noteFingerprint(file);
    const known = this.notesByPath.get(name);
    if (known) {
      if (known.fingerprint?.hash !== fingerprint.hash || known.fingerprint?.size !== fingerprint.size) {
        const record = { op: "note", id: known.id, path: name, title: titleOf(name), fingerprint, hlc: this.clock.next(), device: this.deviceName };
        await this.appendRecord(this.notesFile, record);
        Object.assign(known, { fingerprint, hlc: record.hlc });
      }
      return known;
    }
    const id = this.newNoteId();
    const record = { op: "note", id, path: name, title: titleOf(name), fingerprint, hlc: this.clock.next(), device: this.deviceName };
    const entry = { id, path: name, title: record.title, fingerprint, hlc: record.hlc, device: record.device };
    this.notesById.set(id, entry);
    this.notesByPath.set(name, entry);
    await this.appendRecord(this.notesFile, record);
    return entry;
  }

  newNoteId() {
    for (;;) {
      const id = randomBytes(4).toString("hex").slice(0, 6);
      if (!this.notesById.has(id) && !this.journals.has(id)) return id;
    }
  }

  journalFor(note) {
    if (this.journals.has(note.id)) return this.journals.get(note.id);
    const file = path.join(this.storeDir, "glass", glassFileName(note.title ?? titleOf(note.path), note.id));
    this.journals.set(note.id, file);
    return file;
  }

  async appendRecord(file, record) {
    this.assertWritable();
    const line = `${JSON.stringify(record)}\n`;
    this.remember(file, line);
    await this.enqueueWrite(file, line);
    return line;
  }

  async set(request) {
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    const note = await this.identify(request.note);
    const file = this.journalFor(note);
    const stale = await this.readJournal(file), magnet = stale.magnets.get(request.magnet);
    if (!magnet) throw new Error("Glass magnet not found.");
    if (magnet.deleted?.active) throw new Error("Glass magnet is in the trash; restore it first.");
    const fields = request.fields && typeof request.fields === "object" && !Array.isArray(request.fields) ? { ...request.fields } : {};
    if (request.text !== undefined) fields.text = request.text;
    if (request.color !== undefined) fields.color = request.color;
    if (request.folded !== undefined) fields.folded = request.folded;
    if (request.x !== undefined) fields.x = request.x;
    if (request.y !== undefined) fields.y = request.y;
    if (request.w !== undefined) fields.w = request.w;
    if (request.h !== undefined) fields.h = request.h;
    if (!Object.keys(fields).length) throw new Error("Nothing to change.");
    const kind = magnet.fields.get("kind")?.value ?? null;
    const values = validateMagnetFields(kind, fields, true);
    for (const [field, value] of Object.entries(values)) {
      await this.appendRecord(file, { op: "set", magnetId: magnet.id, field, value, hlc: this.clock.next(), device: this.deviceName });
    }
    const replay = await this.readJournal(file);
    const updated = replay.magnets.get(magnet.id);
    return { ...this.describe(note, file), magnet: updated ? magnetViewFromMap(updated) : null, pending: this.pending.length, saved: this.pending.length === 0 };
  }

  async delete(request) {
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    const note = await this.identify(request.note);
    const file = this.journalFor(note);
    const replay = await this.readJournal(file), magnet = replay.magnets.get(request.magnet);
    if (!magnet) throw new Error("Glass magnet not found.");
    const trashed = magnet.deleted?.active !== true;
    if (trashed) await this.appendRecord(file, { op: "delete", magnetId: magnet.id, hlc: this.clock.next(), device: this.deviceName });
    const next = await this.readJournal(file);
    const updated = next.magnets.get(magnet.id);
    return { ...this.describe(note, file), deleted: true, changed: trashed,
      magnet: updated ? magnetViewFromMap(updated) : null, trash: this.trashOf(next), pending: this.pending.length, saved: this.pending.length === 0 };
  }

  async restore(request) {
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    const note = await this.identify(request.note);
    const file = this.journalFor(note);
    const replay = await this.readJournal(file), magnet = replay.magnets.get(request.magnet);
    if (!magnet) throw new Error("Glass magnet not found.");
    const trashed = magnet.deleted?.active === true;
    if (trashed) await this.appendRecord(file, { op: "restore", magnetId: magnet.id, hlc: this.clock.next(), device: this.deviceName });
    const next = await this.readJournal(file);
    const updated = next.magnets.get(magnet.id);
    return { ...this.describe(note, file), restored: true, changed: trashed,
      magnet: updated ? magnetViewFromMap(updated) : null, trash: this.trashOf(next), pending: this.pending.length, saved: this.pending.length === 0 };
  }

  trashOf(replay) {
    return [...replay.magnets.values()]
      .filter(magnet => magnet.deleted?.active)
      .map(magnet => ({ ...magnetViewFromMap(magnet), clock: parseClock(magnet.deleted.hlc) ?? { t: 0, c: 0 } }))
      .sort((left, right) => right.clock.t - left.clock.t || right.clock.c - left.clock.c)
      .map(({ clock: _, ...magnet }) => magnet);
  }

  enqueueWrite(file, line) {
    const run = this.tail.then(() => this.writeLine(file, line));
    this.tail = run.catch(() => {});
    return run;
  }

  remember(file, line) {
    const entries = this.memory.get(file) ?? [];
    entries.push(line);
    this.memory.set(file, entries);
  }

  forget(file, line) {
    const entries = this.memory.get(file);
    if (!entries) return;
    const index = entries.indexOf(line);
    if (index >= 0) entries.splice(index, 1);
    if (!entries.length) this.memory.delete(file);
  }

  async writeLine(file, line, queue = true) {
    this.assertWritable();
    const existing = await info(file);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Glass journal is not a plain file.");
    let handle, before = null, writing = false;
    try {
      await this.repairTail(file);
      before = this.sizes.get(file) ?? 0;
      if (this.faults.beforeAppend) await this.faults.beforeAppend(file, line);
      handle = await open(file, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow, 0o600);
      writing = true;
      if (this.faults.write) await this.faults.write(handle, line, file);
      else await handle.writeFile(line);
      if (this.faults.sync) await this.faults.sync(handle, file);
      else await handle.sync();
      this.sizes.set(file, before + Buffer.byteLength(line));
      this.forget(file, line);
      this.lastSavedAt = Date.now();
      if (this.error) this.clearError();
      return true;
    } catch (error) {
      if (writing && before !== null) await this.rollback(file, before);
      if (queue) this.pending.push({ file, line });
      this.fail(error);
      return false;
    } finally { await handle?.close().catch(() => {}); }
  }

  async rollback(file, before) {
    try {
      const metadata = await lstat(file);
      if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > before) await truncate(file, before);
    } catch { /* the next attempt repairs the tail before writing */ }
  }

  async repairTail(file) {
    const metadata = await info(file);
    if (!metadata?.isFile()) { this.sizes.set(file, 0); return 0; }
    const handle = await open(file, this.readOnly ? constants.O_RDONLY | noFollow : constants.O_RDWR | noFollow);
    try {
      const size = metadata.size;
      const complete = await lastCompleteOffset(handle, size);
      if (complete !== size && !this.readOnly) await handle.truncate(complete);
      this.sizes.set(file, complete);
      return complete;
    } finally { await handle.close(); }
  }

  fail(error) {
    this.error = { code: error.code ?? "GLASS_WRITE", message: error.message ?? String(error) };
    this.scheduleRetry();
    this.notify();
  }

  clearError() {
    if (!this.error) return;
    this.error = null;
    this.retryDelay = 1_000;
    this.notify();
  }

  scheduleRetry() {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushPending().catch(() => {});
    }, this.retryDelay);
    this.retryTimer.unref?.();
    this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
  }

  async flushPending() {
    this.assertReady();
    if (this.readOnly || this.flushing) return this.flushing ?? this.status();
    const flush = this.tail.then(async () => {
      while (this.pending.length) {
        const entry = this.pending[0];
        const saved = await this.writeLine(entry.file, entry.line, false);
        if (!saved) break;
        this.pending.shift();
      }
      if (!this.pending.length) this.clearError();
      return this.status();
    });
    this.tail = flush.catch(() => {});
    this.flushing = flush;
    try { return await this.flushing; } finally { this.flushing = null; }
  }

  async readJournal(file) {
    const metadata = await info(file);
    const signature = metadata ? `${metadata.size}:${metadata.mtimeMs}` : "missing";
    let cached = this.cache.get(file);
    if (!cached || cached.signature !== signature) {
      const text = metadata ? await readLimited(file, 128 * 1024 * 1024) : "";
      const replay = replayJournalText(text);
      cached = { signature, lines: replay.lines, replay };
      this.cache.set(file, cached);
    }
    const memory = this.memory.get(file) ?? [];
    const replay = memory.length ? replayJournalText([...cached.lines, ...memory].join("\n")) : cached.replay;
    for (const clock of replay.clocks) this.clock.observe(clock);
    return replay;
  }

  async add(request) {
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    const note = await this.identify(request.note);
    const file = this.journalFor(note);
    await mkdir(path.join(this.storeDir, "assets", path.basename(file, ".jsonl")), { recursive: true, mode: 0o700 });
    await this.readJournal(file);
    const magnetId = request.magnet ?? newMagnetId();
    if (typeof magnetId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(magnetId)) throw new Error("Use a short magnet id of letters, digits, _ or -.");
    const fields = { ...(request.fields && typeof request.fields === "object" && !Array.isArray(request.fields) ? request.fields : {}) };
    for (const key of ["text", "kind", "color", "anchor", "x", "y", "w", "h", "folded"])
      if (request[key] !== undefined) fields[key] = request[key];
    if (!Object.keys(fields).length) Object.assign(fields, { kind: "debug", text: "Glass debug magnet", x: 0, y: 0 });
    const values = validateMagnetFields(fields.kind, fields, false);
    if (Object.keys(values).length > 100) throw new Error("A magnet holds at most 100 fields.");
    for (const [field, value] of Object.entries(values)) {
      if (!field || field.length > 200 || /[\u0000-\u001f]/.test(field)) throw new Error("Invalid magnet field.");
      if (value === undefined) throw new Error("Magnet values must be JSON values.");
      const record = { op: "set", magnetId, field, value, hlc: this.clock.next(), device: this.deviceName };
      await this.appendRecord(file, record);
    }
    const replay = await this.readJournal(file);
    const magnet = replay.magnets.get(magnetId);
    return { ...this.describe(note, file), magnet: magnet ? magnetViewFromMap(magnet) : null, pending: this.pending.length, saved: this.pending.length === 0 };
  }

  async list(request) {
    this.assertReady();
    const { note: name } = await this.validateNote(request.note);
    if (!this.initialized && await this.existingStore()) await this.initialize();
    if (!this.initialized) return { note: name, id: null, journal: null, magnets: [], trash: [], initialized: false, pending: 0, status: this.status() };
    const note = this.notesByPath.get(name);
    if (!note) return { note: name, id: null, journal: null, magnets: [], trash: [], pending: this.pending.length, status: this.status() };
    const file = this.journalFor(note);
    const replay = await this.readJournal(file);
    return { ...this.describe(note, file), magnets: visibleMagnets(replay.magnets), trash: this.trashOf(replay),
      unknownOps: replay.unknown.length, invalidLines: replay.invalid, duplicateLines: replay.duplicates, incompleteTail: replay.incomplete, pending: this.pending.length };
  }

  async show(request) {
    this.assertReady();
    const { note: name } = await this.validateNote(request.note);
    if (!this.initialized && await this.existingStore()) await this.initialize();
    if (!this.initialized) return { note: name, id: null, journal: null, magnets: [], trash: [], initialized: false, pending: 0 };
    const note = this.notesByPath.get(name);
    if (!note) return { note: name, id: null, journal: null, magnets: [], trash: [], pending: this.pending.length };
    const file = this.journalFor(note);
    const replay = await this.readJournal(file);
    if (request.magnet) {
      const magnet = replay.magnets.get(request.magnet);
      return { ...this.describe(note, file), magnet: magnet ? magnetViewFromMap(magnet) : null,
        deleted: !!magnet?.deleted?.active, pending: this.pending.length };
    }
    return { ...this.describe(note, file), magnets: visibleMagnets(replay.magnets), trash: this.trashOf(replay),
      unknownOps: replay.unknown.length, invalidLines: replay.invalid, duplicateLines: replay.duplicates, incompleteTail: replay.incomplete, pending: this.pending.length };
  }

  describe(note, file) {
    return { vaultId: this.vaultId, mode: this.mode, readOnly: this.readOnly, note: note.path, id: note.id,
      journal: relative(this.storeDir, file), location: this.mode === "inside" ? ".omarkie" : this.storeDir };
  }

  status() {
    return { version: glassVersion, initialized: this.initialized === true, vaultId: this.vaultId ?? null, mode: this.mode ?? null, readOnly: this.readOnly === true,
      readOnlyReason: this.readOnly ? this.readOnlyReason ?? null : null, root: this.root,
      location: this.mode === "inside" ? ".omarkie" : this.storeDir, notes: this.notesById.size,
      pending: this.pending.length, error: this.error ? { ...this.error } : null, lastSavedAt: this.lastSavedAt ?? null,
      lock: this.lockOwner ? { host: this.lockOwner.host, pid: this.lockOwner.pid } : null, bridge: this.bridgeState ?? null };
  }

  async request(input) {
    if (!input || typeof input !== "object" || typeof input.action !== "string") throw new Error("Invalid Glass request.");
    if (input.action === "status") return this.status();
    if (input.action === "flush") return this.initialized ? this.flushPending() : this.status();
    if (!["add", "set", "delete", "restore", "list", "show"].includes(input.action)) throw new Error("Unknown Glass action.");
    if (typeof input.note !== "string" || !input.note.trim()) throw new Error("--note is required.");
    if (["set", "delete", "restore"].includes(input.action) && (typeof input.magnet !== "string" || !input.magnet.trim())) throw new Error("--magnet is required.");
    return this[input.action](input);
  }

  notify() {
    for (const listener of this.listeners ?? []) {
      try { listener(this.status()); } catch { /* a renderer listener must not break storage */ }
    }
  }

  subscribe(listener) {
    (this.listeners ??= new Set()).add(listener);
    return () => this.listeners?.delete(listener);
  }

  async close() {
    if (this.closed) return this.status();
    await this.opening?.catch(() => {});
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    await this.tail.catch(() => {});
    if (!this.readOnly && this.pending.length) await this.flushPending().catch(() => {});
    this.closed = true;
    if (this.lockToken) {
      const owner = await readJson(this.lockFile).catch(() => null);
      if (owner?.token === this.lockToken) await unlink(this.lockFile).catch(() => {});
    }
    return this.status();
  }
}

async function lastCompleteOffset(handle, size) {
  if (!size) return 0;
  const chunk = Buffer.alloc(Math.min(64 * 1024, size));
  const read = await handle.read(chunk, 0, chunk.length, size - chunk.length);
  const tail = chunk.subarray(0, read.bytesRead);
  const index = tail.lastIndexOf(10);
  if (index >= 0) return size - tail.length + index + 1;
  let offset = size - tail.length;
  while (offset > 0) {
    const length = Math.min(64 * 1024, offset);
    const buffer = Buffer.alloc(length);
    const probe = await handle.read(buffer, 0, length, offset - length);
    const part = buffer.subarray(0, probe.bytesRead);
    const found = part.lastIndexOf(10);
    if (found >= 0) return offset - part.length + found + 1;
    offset -= part.length;
  }
  return 0;
}

function magnetViewFromMap(magnet) {
  const fields = {};
  for (const [field, entry] of magnet.fields) if (!entry.removed) fields[field] = entry.value;
  return { id: magnet.id, fields, kind: fields.kind ?? null, deleted: !!magnet.deleted?.active };
}

const stickyFieldNames = new Set(["kind", "text", "color", "anchor", "x", "y", "w", "h", "folded"]);
const finite = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

export function stickyFields(fields) {
  const values = {};
  for (const [field, value] of Object.entries(fields)) {
    if (!stickyFieldNames.has(field)) throw new Error(`Unknown sticky note field: ${field}.`);
    if (field === "kind") {
      if (value !== "sticky") throw new Error("A sticky note keeps its kind.");
      values.kind = value;
    } else if (field === "text") {
      if (typeof value !== "string" || value.length > 20_000 || value.includes("\u0000")) throw new Error("Sticky text must be text up to 20,000 characters.");
      values.text = value;
    } else if (field === "color") {
      if (!stickyColors.includes(value)) throw new Error(`Sticky colour must be one of: ${stickyColors.join(", ")}.`);
      values.color = value;
    } else if (field === "anchor") {
      if (!stickyAnchor(value)) throw new Error("A sticky note needs one block anchor with its heading path.");
      values.anchor = value;
    } else if (field === "folded") {
      if (typeof value !== "boolean") throw new Error("Sticky folded must be true or false.");
      values.folded = value;
    } else {
      const limits = field === "w" || field === "h" ? [72, 4000] : [-200_000, 200_000];
      if (!finite(value, limits[0], limits[1])) throw new Error(`Sticky ${field} must be a number between ${limits[0]} and ${limits[1]}.`);
      values[field] = Math.round(value);
    }
  }
  return values;
}

function stickyAnchor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const landmarks = value.landmarks;
  if (!Array.isArray(landmarks) || !landmarks.length || landmarks.length > 8) return false;
  return landmarks.every(landmark => {
    if (!landmark || typeof landmark !== "object" || landmark.kind !== "block") return false;
    if (typeof landmark.block !== "string" || !landmark.block.trim() || landmark.block.length > 262_144) return false;
    if (!Array.isArray(landmark.headings) || landmark.headings.length > 6) return false;
    if (!landmark.headings.every(heading => typeof heading === "string" && heading.length <= 400)) return false;
    return landmark.line === undefined || Number.isInteger(landmark.line);
  });
}

// Other magnet kinds stay open for later slices; a sticky note is validated field by field.
function validateMagnetFields(kind, fields, partial) {
  if (kind !== "sticky") {
    if (partial && Object.hasOwn(fields, "kind")) throw new Error("A magnet keeps its kind.");
    return fields;
  }
  const values = stickyFields(partial ? fields : { ...fields, kind: "sticky" });
  if (!partial) {
    if (typeof values.text !== "string") throw new Error("A sticky note needs text.");
    if (!values.anchor) throw new Error("A sticky note needs an anchor.");
    values.color ??= stickyColors[0];
    values.folded ??= false;
    values.x ??= 0;
    values.y ??= 0;
    values.w ??= 232;
    values.h ??= 168;
  }
  return values;
}

function goodVaultId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(value) ? value : null;
}

async function readJson(file) {
  try { return JSON.parse(await readLimited(file, 1024 * 1024)); }
  catch (error) { if (["ENOENT", "EISDIR", "ELOOP"].includes(error.code) || error instanceof SyntaxError) return null; throw error; }
}

async function readLimited(file, limit) {
  const handle = await open(file, constants.O_RDONLY | noFollow);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > limit) throw new Error("Glass file is too large.");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

async function writeIfMissing(file, content) {
  if (await info(file)) return;
  await writeFileAtomic(file, content);
}

async function writeFileAtomic(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function atomicJson(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

const readme = `# Omarkie glass
Your notes are untouched; glass lives in this folder.
- \`glass/\` — one JSONL journal per note that has glass.
- \`assets/\` — glass images, one folder per note.
- \`notes.jsonl\` — note id, vault-relative path and fingerprint.
- \`settings.json\` — vault id and storage mode.
- \`writer.lock\` — present and owned while one Omarkie instance writes; a second instance opens read-only.
- \`.gitattributes\` — \`*.jsonl merge=union\`, so git keeps every journal line.
- \`README.md\` — this map.
`;
