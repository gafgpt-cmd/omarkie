import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rmdir, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { imageSize } from "image-size";
import {
  anchorVersion, createClock, glassFileName, glassVersion, newMagnetId, parseClock, parseJournalText,
  replayJournalText, replayNotesText, stickyColors, validAnchor, visibleMagnets,
} from "../shared/glass-core.mjs";
import {
  assetFile, convertible, displayFile, extensionFor, imageDefaults, imageFields, imageTypeOf, mimeFor,
  orientationSize, scrapImageMagnet, validSource,
} from "../shared/glass-images.mjs";
import {
  inkColors, inkWidths, validInkBox, validInkColor, validInkParts, validInkSize, validInkTool,
} from "../shared/ink-core.mjs";
import { arrowColors, arrowHeads, arrowStyles, stickerIds, stickerLayer, validArrowEnd, validStickerImage } from "../shared/glass-marks.mjs";
import {
  cardDefaults, cardFields, cardLayer, cardPageMarkdown, cardPageStem, extractSection, parseCardLink,
} from "../shared/glass-cards.mjs";
import {
  decodeNote, encodeNote, inkSvg, insertBlock, mergeAnchorOf, mergeDiff, mergeKindLabel, mergeLines,
  mergeableKinds, noteLineEnding, noteMergeSettings, replayMerges, resolveMergeElement,
} from "../shared/glass-merge.mjs";
import { markdownElements } from "../shared/element-model.mjs";
import { journalTimeline, magnetsAt, parseScrubTime } from "../shared/glass-scrub.mjs";
import { findInVault, vaultRoot } from "./vault.mjs";

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
    this.listing = new Map();
    this.closed = false;
    this.finder = null;
    this.indexStatus = null;
    this.offer = null;
    this.lost = [];
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
    this.afterInitialize?.();
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
        await this.rememberNote(known, name);
      }
      return known;
    }
    const id = this.newNoteId();
    const record = { op: "note", id, path: name, title: titleOf(name), fingerprint, hlc: this.clock.next(), device: this.deviceName };
    const entry = { id, path: name, title: record.title, fingerprint, hlc: record.hlc, device: record.device };
    this.notesById.set(id, entry);
    this.notesByPath.set(name, entry);
    await this.appendRecord(this.notesFile, record);
    await this.rememberNote(entry, name);
    return entry;
  }

  async rememberNote(note, name = note.path) {
    if (!this.finder || !note.fingerprint?.hash) return;
    await this.finder.remember({ hash: note.fingerprint.hash, size: note.fingerprint.size, vaultId: this.vaultId,
      store: this.storeDir, journal: relative(this.storeDir, this.journalFor(note)), noteId: note.id,
      title: note.title, path: name, mode: this.mode }).catch(() => {});
  }

  async refreshFingerprint(note, fingerprint, name = note.path) {
    if (note.fingerprint?.hash === fingerprint.hash && note.fingerprint?.size === fingerprint.size) return note;
    this.assertWritable();
    const record = { op: "note", id: note.id, path: name, title: note.title ?? titleOf(name), fingerprint,
      hlc: this.clock.next(), device: this.deviceName };
    await this.appendRecord(this.notesFile, record);
    note.fingerprint = fingerprint;
    note.hlc = record.hlc;
    await this.rememberNote(note, name);
    return note;
  }

  currentNotes() {
    return [...this.notesById.values()].map(note => ({ id: note.id, path: note.path, title: note.title,
      fingerprint: note.fingerprint ?? null }));
  }

  async recordMove(note, to, { title, fingerprint } = {}) {
    this.assertWritable();
    const record = { op: "move", id: note.id, to, hlc: this.clock.next(), device: this.deviceName,
      title: title ?? titleOf(to), ...(fingerprint ? { fingerprint } : {}) };
    await this.appendRecord(this.notesFile, record);
    this.notesByPath.delete(note.path);
    note.path = to;
    note.title = record.title;
    if (fingerprint) note.fingerprint = fingerprint;
    this.notesByPath.set(to, note);
    await this.rememberNote(note, to);
    return record;
  }

  async recordFolder(from, to) {
    this.assertWritable();
    const record = { op: "folder", from, to, hlc: this.clock.next(), device: this.deviceName };
    await this.appendRecord(this.notesFile, record);
    for (const note of this.notesById.values()) {
      if (note.path !== from && !note.path.startsWith(`${from}/`)) continue;
      this.notesByPath.delete(note.path);
      note.path = `${to}${note.path.slice(from.length)}`;
      this.notesByPath.set(note.path, note);
    }
    return record;
  }

  async appendText(file, text) {
    this.assertWritable();
    const line = text.endsWith("\n") ? text : `${text}\n`;
    await this.enqueueWrite(file, line);
    return line;
  }

  async magnetsForIndex() {
    const result = [];
    for (const [noteId, file] of this.journals) {
      const replay = await this.readJournal(file).catch(() => null);
      if (!replay) continue;
      for (const magnet of visibleMagnets(replay.magnets)) {
        const fields = magnet.fields ?? {};
        const text = [fields.text, fields.title, fields.quote, fields.body]
          .filter(value => typeof value === "string" && value.trim()).join("\n").slice(0, 8_000);
        result.push({ id: magnet.id, noteId, kind: magnet.kind ?? null, text, fields });
      }
    }
    return result;
  }

  // Bring one note's glass from a store this computer already knows about. Nothing at the old location changes.
  async attachForeign(notePath, foreign) {
    const { note: name, file } = await this.validateNote(notePath);
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    if (!foreign || typeof foreign.store !== "string" || typeof foreign.noteId !== "string")
      throw new Error("Glass finder entry is incomplete.");
    const storeRoot = await realpath(foreign.store).catch(() => null);
    if (!storeRoot) throw new Error("The old glass store is not reachable.");
    const journalName = path.basename(String(foreign.journal ?? ""));
    if (!journalPattern.test(journalName)) throw new Error("Glass finder journal name is invalid.");
    const source = path.join(storeRoot, "glass", journalName);
    const resolved = await realpath(source).catch(() => null);
    if (!resolved || !resolved.startsWith(`${storeRoot}${path.sep}`)) throw new Error("Glass finder journal is outside its store.");
    const text = await readLimited(resolved, 128 * 1024 * 1024).catch(error => { if (error.code === "ENOENT") return ""; throw error; });

    let note = this.notesByPath.get(name);
    if (!note) {
      const fingerprint = await this.noteFingerprint(file);
      const id = /^[a-z0-9]{4,32}$/.test(foreign.noteId) && !this.notesById.has(foreign.noteId) && !this.journals.has(foreign.noteId)
        ? foreign.noteId : this.newNoteId();
      const record = { op: "note", id, path: name, title: titleOf(name), fingerprint, hlc: this.clock.next(), device: this.deviceName };
      note = { id, path: name, title: record.title, fingerprint, hlc: record.hlc, device: record.device };
      this.notesById.set(id, note);
      this.notesByPath.set(name, note);
      this.journals.set(id, path.join(this.storeDir, "glass", glassFileName(record.title, id)));
      await this.appendRecord(this.notesFile, record);
    }

    const target = this.journalFor(note);
    const existing = new Set(parseJournalText(await readFile(target, "utf8").catch(() => "")).lines);
    let copied = 0;
    for (const line of parseJournalText(text).lines) {
      if (!line.trim() || existing.has(line)) continue;
      existing.add(line);
      await this.appendText(target, line);
      copied += 1;
    }

    const sourceAssets = path.join(storeRoot, "assets", journalName.replace(/\.jsonl$/, ""));
    const targetAssets = path.join(this.storeDir, "assets", path.basename(target, ".jsonl"));
    const assets = await copyPlainTree(sourceAssets, targetAssets);
    const replay = await this.readJournal(target);
    for (const clock of replay.clocks) this.clock.observe(clock);
    await this.rememberNote(note, name);
    return { note: name, id: note.id, journal: relative(this.storeDir, target), lines: copied, assets };
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
    if (kind === "card" && fields.card !== undefined && fields.card !== magnet.fields.get("card")?.value)
      throw new Error("A card keeps its card kind.");
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
      for (const clock of replay.clocks) this.clock.observe(clock);
      cached = { signature, lines: replay.lines, replay };
      this.cache.set(file, cached);
    }
    const memory = this.memory.get(file);
    // Unflushed records already advanced this device's clock when written.
    return memory?.length ? replayJournalText([...cached.lines, ...memory].join("\n")) : cached.replay;
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
    for (const key of ["text", "kind", "color", "anchor", "x", "y", "w", "h", "folded", "layer", "tool", "size", "parts", "card", "title", "link", "question", "answer", "answerAt", "choices"])
      if (request[key] !== undefined) fields[key] = request[key];
    if (request.image !== undefined) {
      if (!request.image || typeof request.image !== "object" || Array.isArray(request.image)) throw new Error("Invalid image payload.");
      Object.assign(fields, await this.imageAsset({ file, image: request.image, width: fields.w, wrap: fields.wrap }));
    }
    if (fields.anchor !== undefined && fields.kind !== "sticky") {
      if (!validAnchor(fields.anchor)) throw new Error("Invalid Glass anchor.");
      fields.anchor = { ...fields.anchor, version: fields.anchor.version ?? anchorVersion };
    }
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
    this.notify();
    return { ...this.describe(note, file), magnet: magnet ? magnetViewFromMap(magnet) : null, pending: this.pending.length, saved: this.pending.length === 0 };
  }

  assetDir(journal) {
    return path.join(this.storeDir, "assets", path.basename(journal, ".jsonl"));
  }

  async takenAssets(directory) {
    return new Set((await readdir(directory).catch(() => [])).filter(name => !name.startsWith(".")));
  }

  // Original bytes stay untouched; a light display copy is written only when one was supplied or can be converted.
  async imageAsset({ file, image, width, wrap }) {
    if (this.readOnly) throw Object.assign(new Error("Glass is read-only."), { code: "GLASS_READ_ONLY" });
    const directory = this.assetDir(file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let bytes, sourceName;
    if (typeof image.path === "string" && image.path.trim()) {
      const absolute = path.resolve(image.path);
      const metadata = await info(absolute);
      if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error("Image file not found.");
      if (metadata.size > imageDefaults.maxBytes) throw new Error(`Images must be ${Math.round(imageDefaults.maxBytes / 1024 / 1024)} MB or smaller.`);
      bytes = await readFile(absolute);
      sourceName = path.basename(absolute);
    } else if (typeof image.base64 === "string") {
      bytes = Buffer.from(image.base64, "base64");
      sourceName = typeof image.name === "string" ? image.name : "image";
    } else throw new Error("An image needs a file path or its bytes.");
    if (!bytes.length || bytes.length > imageDefaults.maxBytes) throw new Error(`Images must be ${Math.round(imageDefaults.maxBytes / 1024 / 1024)} MB or smaller.`);
    const type = imageTypeOf(bytes);
    if (!type) throw new Error("That image format is not supported.");
    const asset = assetFile(image.name || sourceName, extensionFor(type), await this.takenAssets(directory));
    await writeFileAtomic(path.join(directory, asset), bytes);
    const oriented = orientationSize(imageDimensions(bytes))
      ?? orientationSize({ width: image.width, height: image.height })
      ?? { width: 4, height: 3 };
    const aspect = Math.round((oriented.width / oriented.height) * 10_000) / 10_000;
    let display = null;
    const preview = typeof image.displayBase64 === "string" ? Buffer.from(image.displayBase64, "base64") : null;
    if (preview?.length && ["webp", "jpeg", "png"].includes(imageTypeOf(preview))) {
      const name = displayFile(asset);
      await writeFileAtomic(path.join(directory, name), preview);
      display = name;
    } else if (convertible(type)) {
      const converted = await this.convertImage(bytes, type).catch(() => null);
      if (converted?.length && imageTypeOf(converted) === "jpeg") {
        const name = displayFile(asset);
        await writeFileAtomic(path.join(directory, name), converted);
        display = name;
      }
    }
    const requested = Number(width);
    const w = Math.round(Math.min(imageDefaults.maxW, Math.max(imageDefaults.minW, Number.isFinite(requested) && requested > 0 ? requested : imageDefaults.w)));
    const fields = imageFields({ kind: "image", name: image.name || sourceName, asset, display, bytes: bytes.length, w,
      h: Math.max(imageDefaults.minH, Math.round(w / aspect)), aspect, wrap: image.wrap ?? wrap ?? "left" });
    return fields;
  }

  // HEIC/TIFF cannot be decoded by Chromium; an external converter may make the light copy.
  async convertImage(bytes, type) {
    const configured = process.env.OMARKIE_IMAGE_CONVERT?.trim()
      || (await readFile(path.join(this.appData, "image-convert"), "utf8").catch(() => "")).trim();
    if (!configured) return null;
    let argv;
    try { argv = JSON.parse(configured); } catch { argv = configured; }
    if (!Array.isArray(argv)) argv = [argv];
    if (!argv.length || argv.some(part => typeof part !== "string" || !part)) return null;
    const scratch = await mkdtemp(path.join(os.tmpdir(), "omarkie-image-"));
    const [input, output] = [path.join(scratch, `image.${extensionFor(type)}`), path.join(scratch, "display.jpg")];
    try {
      await writeFileAtomic(input, bytes);
      const converted = await new Promise((resolve, reject) => {
        const child = spawn(argv[0], [...argv.slice(1), input, output], { stdio: "ignore", timeout: 120_000, windowsHide: true });
        child.once("error", reject);
        child.once("exit", code => code === 0 ? resolve(true) : reject(new Error(`Image converter exited with ${code}.`)));
      });
      if (!converted) return null;
      const result = await readFile(output).catch(() => null);
      return result?.length && result.length <= imageDefaults.maxBytes ? result : null;
    } finally {
      await unlink(input).catch(() => {});
      await unlink(output).catch(() => {});
      await rmdir(scratch).catch(() => {});
    }
  }

  async magnetAsset(request) {
    this.assertReady();
    const { note: name } = await this.validateNote(request.note);
    if (!this.initialized && await this.existingStore()) await this.initialize();
    if (!this.initialized) throw new Error("Glass is not initialized in this vault.");
    const note = this.notesByPath.get(name);
    if (!note) throw new Error("Glass note not found.");
    const file = this.journalFor(note);
    const replay = await this.readJournal(file), magnet = replay.magnets.get(request.magnet);
    if (!magnet) throw new Error("Glass magnet not found.");
    const fields = magnetViewFromMap(magnet).fields;
    if (fields.kind !== "image") throw new Error("That magnet is not an image.");
    const directory = this.assetDir(file);
    const wanted = request.which === "original" ? fields.asset : fields.display ?? fields.asset;
    if (!wanted) throw new Error("This image has no stored copy yet.");
    const asset = path.join(directory, wanted);
    const metadata = await info(asset);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error("The image file is missing.");
    const bytes = await readFile(asset);
    const type = imageTypeOf(bytes) ?? (wanted.endsWith(".webp") ? "webp" : null);
    return { note: name, magnet: magnet.id, name: wanted, which: request.which === "original" ? "original" : "display",
      mime: mimeFor(type), bytes: bytes.length, base64: bytes.toString("base64") };
  }

  // The renderer makes the light copy where Chromium already decoded the picture; the service just stores it.
  async assetDisplay(request) {
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    const note = await this.identify(request.note);
    const file = this.journalFor(note);
    const replay = await this.readJournal(file), magnet = replay.magnets.get(request.magnet);
    if (!magnet) throw new Error("Glass magnet not found.");
    const fields = magnetViewFromMap(magnet).fields;
    if (fields.kind !== "image" || !fields.asset) throw new Error("That magnet is not an image.");
    const bytes = Buffer.from(String(request.base64 ?? ""), "base64");
    const type = imageTypeOf(bytes);
    if (!["webp", "jpeg", "png"].includes(type)) throw new Error("A display copy must be a WebP, JPEG or PNG image.");
    if (bytes.length > imageDefaults.maxBytes) throw new Error("Display copy is too large.");
    const directory = this.assetDir(file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const name = displayFile(fields.asset);
    await writeFileAtomic(path.join(directory, name), bytes);
    await this.appendRecord(file, { op: "set", magnetId: magnet.id, field: "display", value: name, hlc: this.clock.next(), device: this.deviceName });
    const next = await this.readJournal(file);
    return { ...this.describe(note, file), magnet: magnetViewFromMap(next.magnets.get(magnet.id)), display: name, bytes: bytes.length };
  }

  // A vault whose only picture store is Learning mode's scraps still opens the glass and migrates them.
  async legacyScraps(name) {
    const store = path.join(this.root, ".omarkie", "store.jsonl");
    const metadata = await info(store).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) return false;
    const text = await readFile(store, "utf8").catch(() => "");
    return text.split("\n").some(line => {
      if (!line.trim()) return false;
      try {
        const entry = JSON.parse(line)?.entry;
        return entry?.type === "scrap" && !entry.deleted && !!entry.image?.hash && entry.document === name;
      } catch { return false; }
    });
  }

  // Learning mode's image scraps become glass images in place; scraps and their blobs are left alone.
  async importScraps(note) {
    if (this.readOnly || !this.initialized) return 0;
    const store = path.join(this.root, ".omarkie", "store.jsonl");
    const metadata = await info(store);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) return 0;
    const signature = `${metadata.size}:${metadata.mtimeMs}`;
    this.scrapImports ??= new Map();
    if (this.scrapImports.get(note.id) === signature) return 0;
    const text = await readFile(store, "utf8");
    if (!text) return 0;
    const scraps = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const entry = row?.entry;
      if (entry?.type !== "scrap" || entry.deleted || !entry.image?.hash || entry.document !== note.path) continue;
      scraps.push(entry);
    }
    if (!scraps.length) { this.scrapImports.set(note.id, signature); return 0; }
    const file = this.journalFor(note), directory = this.assetDir(file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const taken = await this.takenAssets(directory);
    const replay = await this.readJournal(file), source = path.join(this.root, ".omarkie", "scraps");
    let imported = 0;
    for (const scrap of scraps) {
      const id = scrapImageMagnet({ scrap, asset: "image.png" }).id;
      if (replay.magnets.has(id)) continue;
      if (!/^[a-f0-9]{64}$/.test(scrap.image.hash)) continue;
      const bytes = await readFile(path.join(source, scrap.image.hash)).catch(() => null);
      if (!bytes?.length || bytes.length > imageDefaults.maxBytes) continue;
      const type = imageTypeOf(bytes);
      if (!type) continue;
      const asset = assetFile(scrap.body || "image", extensionFor(type), taken);
      taken.add(asset);
      await writeFileAtomic(path.join(directory, asset), bytes);
      const oriented = orientationSize(imageDimensions(bytes));
      const blockText = String(scrap.anchor?.block ?? "").trim();
      if (!blockText) continue;
      const magnet = scrapImageMagnet({ scrap, asset, width: oriented?.width, height: oriented?.height, blockText,
        headings: Array.isArray(scrap.anchor?.headings) ? scrap.anchor.headings : [] });
      for (const [field, value] of Object.entries(magnet.fields))
        await this.appendRecord(file, { op: "set", magnetId: magnet.id, field, value, hlc: this.clock.next(), device: this.deviceName });
      imported += 1;
    }
    this.scrapImports.set(note.id, signature);
    if (imported) this.notify();
    return imported;
  }

  async list(request) {
    this.assertReady();
    const { note: name } = await this.validateNote(request.note);
    const pending = this.listing.get(name);
    if (pending) return pending;
    // Readers must not see a legacy image halfway through its journal import.
    const listing = this.listNote(name).finally(() => this.listing.delete(name));
    this.listing.set(name, listing);
    return listing;
  }

  async listNote(name) {
    if (!this.initialized && (await this.existingStore() || await this.legacyScraps(name))) await this.initialize();
    if (!this.initialized) return { note: name, id: null, journal: null, magnets: [], trash: [], initialized: false, pending: 0, status: this.status() };
    let note = this.notesByPath.get(name);
    if (!note && this.initialized && !this.readOnly && await this.legacyScraps(name)) note = await this.identify(name);
    if (!note) return { note: name, id: null, journal: null, magnets: [], trash: [], pending: this.pending.length, status: this.status() };
    const file = this.journalFor(note);
    const imported = await this.importScraps(note).catch(() => 0);
    const replay = await this.readJournal(file);
    return { ...this.describe(note, file), magnets: visibleMagnets(replay.magnets), trash: this.trashOf(replay), imported,
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

  // G17 time scrub: read-only views of the journal. `timeline` lists the wall-clock moments
  // the slider can stop on; `scrub` replays every record at or before the chosen moment.
  async timeline(request) {
    this.assertReady();
    const { note: name } = await this.validateNote(request.note);
    const note = this.notesByPath.get(name);
    if (!note) return { note: name, id: null, journal: null, points: [], from: null, to: null, events: 0, count: 0 };
    const file = this.journalFor(note);
    const replay = await this.readJournal(file);
    return { ...this.describe(note, file), ...journalTimeline(replay.lines) };
  }

  async scrub(request) {
    this.assertReady();
    const { note: name } = await this.validateNote(request.note);
    const at = parseScrubTime(request.at);
    if (at === null) throw new Error("--at must be an ISO time or epoch milliseconds.");
    const note = this.notesByPath.get(name);
    if (!note) return { note: name, id: null, journal: null, at, magnets: [] };
    const file = this.journalFor(note);
    const replay = await this.readJournal(file);
    const state = magnetsAt(replay.lines, at);
    return { ...this.describe(note, file), at, magnets: state.magnets, lines: state.lines };
  }

  // Where the vault says attachments go and how its links look; read only, never written.
  async mergeSettingsFor(file, name) {
    let root = this.root;
    try { root = await vaultRoot(path.dirname(file), this.root); } catch { root = this.root; }
    let notePath = relative(root, file);
    if (!notePath || notePath.startsWith("..") || path.isAbsolute(notePath)) { root = this.root; notePath = name; }
    const obsidian = await directory(path.join(root, ".obsidian"));
    const appJson = obsidian ? await readJson(path.join(root, ".obsidian", "app.json")) ?? {} : null;
    return { root, notePath, ...noteMergeSettings({ appJson, notePath }) };
  }

  attachmentDir(root, folder) {
    const dir = folder ? path.resolve(root, ...folder.split("/")) : root;
    const inside = path.relative(root, dir);
    if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("The vault's attachment folder sits outside the vault.");
    return dir;
  }

  async mergeImageMapping({ kind, fields, magnet, journal, settings }) {
    const directory = this.attachmentDir(settings.root, settings.attachmentFolder);
    const taken = new Set(await readdir(directory).catch(() => []));
    let bytes, base, extension;
    if (kind === "ink") {
      bytes = Buffer.from(inkSvg(fields), "utf8");
      base = `ink-${String(magnet.id).replace(/^m-/, "").slice(0, 8) || "stroke"}`;
      extension = "svg";
    } else {
      if (typeof fields.asset !== "string" || !fields.asset || /[/\\]/.test(fields.asset)) throw new Error("The picture has no stored copy.");
      const source = path.join(this.assetDir(journal), fields.asset);
      const metadata = await info(source);
      if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error("The picture file is missing from the glass.");
      bytes = await readFile(source);
      base = fields.name || fields.asset;
      extension = path.extname(fields.asset).slice(1).toLowerCase() || "png";
    }
    const assetName = assetFile(base, extension, taken);
    const assetPath = settings.attachmentFolder ? `${settings.attachmentFolder}/${assetName}` : assetName;
    const mapping = mergeLines(kind, fields, { settings, assetPath, assetName: kind === "ink" ? "Ink" : fields.name || assetName });
    return { ...mapping, asset: { bytes, name: assetName, base, extension, rel: assetPath, abs: path.join(directory, assetName) } };
  }

  async buildMerge(request) {
    if (!this.initialized) await this.initialize();
    this.assertReady();
    const { note: name, file } = await this.validateNote(request.note);
    const note = await this.identify(name);
    const journal = this.journalFor(note);
    const replay = await this.readJournal(journal);
    const magnet = replay.magnets.get(String(request.magnet ?? ""));
    if (!magnet || magnet.deleted?.active) throw new Error("Glass magnet not found.");
    const view = magnetViewFromMap(magnet);
    const fields = view.fields;
    const kind = fields.kind;
    if (!mergeableKinds.includes(kind)) throw new Error("Only sticky notes, pictures, ink and cards can merge down.");
    const anchor = mergeAnchorOf(fields);
    if (!anchor) throw new Error("This magnet has no paragraph anchor to merge into.");
    const before = await readFile(file);
    const { bom, text } = decodeNote(before);
    const eol = noteLineEnding(text);
    const elements = markdownElements(text);
    let resolved;
    if (fields.source && typeof fields.source.line === "number") {
      const exact = elements.find(element => element.kind === fields.source.kind && element.line === fields.source.line)
        ?? elements.find(element => element.id === fields.source.element);
      if (exact) resolved = { element: exact, tier: "source", confidence: 1 };
    }
    resolved ??= resolveMergeElement(elements, anchor);
    if (!resolved) throw new Error("Merge down could not find the paragraph this magnet points at. Move it onto a paragraph and try again.");
    const settings = await this.mergeSettingsFor(file, name);
    const mapping = kind === "image" || kind === "ink"
      ? await this.mergeImageMapping({ kind, fields, magnet: view, journal, settings })
      : mergeLines(kind, fields, { settings });
    const diff = mergeDiff(text, resolved.element.to, mapping.lines, eol);
    const buffer = encodeNote({ bom, text: diff.next });
    return { name, file, note, journal, magnet: view, kind, fields, mapping, settings, element: resolved.element,
      confidence: resolved.confidence, tier: resolved.tier, bom, eol, baseHash: hashBytes(before), afterHash: hashBytes(buffer),
      beforeBuffer: before, buffer, diff };
  }

  publicMerge(built) {
    return { id: null, note: built.name, magnet: built.magnet.id, kind: built.kind, label: built.mapping.label ?? mergeKindLabel(built.kind, built.fields),
      style: built.mapping.style ?? "markdown", element: { id: built.element.id, kind: built.element.kind, line: built.element.line,
        headings: [...built.element.headings] }, confidence: built.confidence, tier: built.tier,
      baseHash: built.baseHash, baseSize: built.beforeBuffer.length, eol: built.eol === "\r\n" ? "CRLF" : "LF", bom: built.bom,
      diff: built.diff.rows, added: built.mapping.lines, removed: built.diff.removed, attachment: built.mapping.asset?.rel ?? null,
      linkStyle: built.settings.linkStyle, attachmentFolder: built.settings.attachmentFolder };
  }

  async mergePreview(request) {
    const built = await this.buildMerge(request);
    return { ...this.describe(built.note, built.file), merge: this.publicMerge(built) };
  }

  async mergeAccept(request) {
    if (!request.approved) {
      const preview = await this.buildMerge(request);
      return { ...this.describe(preview.note, preview.file), needsUser: true, preview: this.publicMerge(preview),
        message: "Preview only. The user presses Accept in Omarkie; an agent never writes the page." };
    }
    this.assertWritable();
    const built = await this.buildMerge(request);
    if (typeof request.expectedHash === "string" && request.expectedHash && request.expectedHash !== built.baseHash) {
      return { ...this.describe(built.note, built.file), stale: true, preview: this.publicMerge(built) };
    }
    const fresh = await readFile(built.file);
    if (hashBytes(fresh) !== built.baseHash) {
      const again = await this.buildMerge(request);
      return { ...this.describe(again.note, again.file), stale: true, preview: this.publicMerge(again) };
    }
    const mergeId = typeof request.mergeId === "string" && /^mg-[a-z0-9]{6,32}$/.test(request.mergeId) ? request.mergeId : `mg-${randomBytes(6).toString("hex")}`;
    const undoRel = `assets/${path.basename(built.journal, ".jsonl")}/undo-${mergeId}.md`;
    const undoAbs = path.join(this.storeDir, ...undoRel.split("/"));
    await mkdir(path.dirname(undoAbs), { recursive: true, mode: 0o700 });
    await writeBytesAtomic(undoAbs, built.beforeBuffer);
    let assetWritten = false;
    let mapping = built.mapping, buffer = built.buffer, diff = built.diff;
    try {
      if (mapping.asset) {
        await mkdir(path.dirname(mapping.asset.abs), { recursive: true, mode: 0o700 });
        const existing = await readFile(mapping.asset.abs).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (existing && !existing.equals(mapping.asset.bytes)) {
          // Someone put a different file with that name since the preview: pick a free name, never clobber.
          const taken = new Set(await readdir(path.dirname(mapping.asset.abs)));
          const assetName = assetFile(mapping.asset.base, mapping.asset.extension, taken);
          const assetPath = built.settings.attachmentFolder ? `${built.settings.attachmentFolder}/${assetName}` : assetName;
          mapping = { ...mergeLines(built.kind, built.fields, { settings: built.settings, assetPath, assetName: built.fields.name || assetName }),
            asset: { ...mapping.asset, name: assetName, rel: assetPath, abs: path.join(path.dirname(mapping.asset.abs), assetName) } };
          diff = mergeDiff(decodeNote(built.beforeBuffer).text, built.element.to, mapping.lines, built.eol);
          buffer = encodeNote({ bom: built.bom, text: diff.next });
        }
        if (!existing || !existing.equals(mapping.asset.bytes)) {
          await writeBytesAtomic(mapping.asset.abs, mapping.asset.bytes);
          assetWritten = true;
        }
      }
      await this.appendRecord(built.journal, { op: "merge", mergeId, magnetId: built.magnet.id, kind: built.kind,
        line: built.element.line, baseHash: built.baseHash, afterHash: hashBytes(buffer), undo: undoRel,
        ...(mapping.asset ? { attachment: mapping.asset.rel } : {}), hlc: this.clock.next(), device: this.deviceName });
      await writeBytesAtomic(built.file, buffer);
    } catch (error) {
      if (assetWritten && mapping.asset) await unlink(mapping.asset.abs).catch(() => {});
      await this.appendRecord(built.journal, { op: "merge-undo", mergeId, automatic: true, hlc: this.clock.next(), device: this.deviceName }).catch(() => {});
      throw error;
    }
    await this.appendRecord(built.journal, { op: "delete", magnetId: built.magnet.id, hlc: this.clock.next(), device: this.deviceName });
    await this.identify(built.name).catch(() => {});
    const next = await this.readJournal(built.journal);
    const updated = next.magnets.get(built.magnet.id);
    this.notify();
    const merge = { id: mergeId, magnet: built.magnet.id, kind: built.kind, attachment: mapping.asset?.rel ?? null,
      baseHash: built.baseHash, afterHash: hashBytes(buffer), undone: false, at: null };
    return { ...this.describe(built.note, built.file), merged: true, merge, lines: mapping.lines, diff: diff.rows,
      magnet: updated ? magnetViewFromMap(updated) : null, history: await this.mergeHistoryOf(built.journal) };
  }

  async mergeHistoryOf(journal) {
    const text = await readFile(journal, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    return replayMerges(text);
  }

  async mergeHistory(request) {
    const { note: name, file } = await this.validateNote(request.note);
    if (!this.initialized) return { note: name, merges: [] };
    const note = this.notesByPath.get(name);
    if (!note) return { note: name, merges: [] };
    const merges = await this.mergeHistoryOf(this.journalFor(note));
    return { ...this.describe(note, this.journalFor(note)), note: name, merges };
  }

  async mergeUndo(request) {
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    const { note: name, file } = await this.validateNote(request.note);
    const note = this.notesByPath.get(name);
    if (!note) throw new Error("Glass note not found.");
    const journal = this.journalFor(note);
    const history = await this.mergeHistoryOf(journal);
    const target = request.merge ? history.find(entry => entry.id === request.merge) : history.find(entry => !entry.undone);
    if (!target || target.undone) throw new Error("There is no merge to undo on this note.");
    const inside = path.relative(this.storeDir, path.resolve(this.storeDir, ...String(target.undo).split("/")));
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("The merge undo copy is outside the glass store.");
    const bytes = await readFile(path.join(this.storeDir, ...target.undo.split("/"))).catch(error => {
      throw error.code === "ENOENT" ? new Error("The merge undo copy is missing.") : error;
    });
    const currentHash = hashBytes(await readFile(file));
    if (target.afterHash && currentHash !== target.afterHash && !request.force) {
      return { ...this.describe(note, journal), undoStale: true, merge: target, currentHash,
        message: "The note changed after the merge; choose whether to restore it anyway." };
    }
    await writeBytesAtomic(file, bytes);
    await this.appendRecord(journal, { op: "merge-undo", mergeId: target.id, force: request.force === true,
      hlc: this.clock.next(), device: this.deviceName });
    const replay = await this.readJournal(journal);
    const magnet = replay.magnets.get(target.magnet);
    let restored = false;
    if (magnet?.deleted?.active) {
      await this.appendRecord(journal, { op: "restore", magnetId: target.magnet, hlc: this.clock.next(), device: this.deviceName });
      restored = true;
    }
    await this.identify(name).catch(() => {});
    this.notify();
    return { ...this.describe(note, journal), undone: true, merge: { ...target, undone: true }, restoredMagnet: restored,
      history: await this.mergeHistoryOf(journal) };
  }

  async liftUp(request) {
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    const { note: name, file } = await this.validateNote(request.note);
    if (typeof request.element !== "string" || !request.element.trim()) throw new Error("--element is required.");
    const note = await this.identify(name);
    const journal = this.journalFor(note);
    const text = decodeNote(await readFile(file)).text;
    const elements = markdownElements(text);
    const element = elements.find(item => item.id === request.element);
    if (!element) throw new Error("That element is not in this note.");
    const source = { element: element.id, kind: element.kind, line: element.line, path: name };
    const id = newMagnetId();
    let fields;
    if (element.kind === "image" || element.kind === "embed") {
      const reference = imageReferenceOf(element.markdown);
      if (!reference) throw new Error("That picture has no file reference to lift.");
      const sourceFile = await this.resolveImageReference(reference, file);
      if (!sourceFile) throw new Error("The picture file could not be found in this vault.");
      const metadata = await info(sourceFile);
      if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error("The picture file could not be found in this vault.");
      Object.assign(fields = {}, await this.imageAsset({ file: journal, image: { path: sourceFile, name: path.basename(sourceFile) }, width: 320 }));
      // Place on the nearest text block: an image line has no block text the glass index can match.
      const at = elements.findIndex(item => item.id === element.id);
      const neighbour = [...elements.slice(0, at)].reverse().find(item => item.text.trim())
        ?? elements.slice(at + 1).find(item => item.text.trim()) ?? element;
      Object.assign(fields, { anchor: { version: 2, landmarks: [
        { kind: "block", block: neighbour.markdown, headings: [...neighbour.headings], line: neighbour.line },
        ...(Array.isArray(element.landmarks?.landmarks) ? element.landmarks.landmarks : []),
      ] }, x: 0, y: 0, source });
    } else {
      if (!element.text.trim()) throw new Error("That element is empty.");
      fields = { kind: "sticky", text: element.text.slice(0, 20_000), color: stickyColors[0],
        anchor: { version: 2, landmarks: [{ kind: "block", block: element.markdown, headings: [...element.headings], line: element.line }] },
        x: 0, y: 0, w: 232, h: 168, folded: false, source };
    }
    const values = validateMagnetFields(fields.kind, fields, false);
    for (const [field, value] of Object.entries(values))
      await this.appendRecord(journal, { op: "set", magnetId: id, field, value, hlc: this.clock.next(), device: this.deviceName });
    const replay = await this.readJournal(journal);
    const magnet = replay.magnets.get(id);
    this.notify();
    return { ...this.describe(note, journal), lifted: true, source, magnet: magnet ? magnetViewFromMap(magnet) : null };
  }

  async resolveImageReference(reference, noteFile) {
    const clean = String(reference).replace(/^<|>$/g, "").trim();
    if (!clean) return null;
    const settings = await this.mergeSettingsFor(noteFile, "");
    const candidates = [path.resolve(path.dirname(noteFile), clean), path.resolve(settings.root, clean)];
    for (const candidate of candidates) {
      const inside = path.relative(settings.root, candidate);
      if (inside.startsWith("..") || path.isAbsolute(inside)) continue;
      const metadata = await info(candidate);
      if (metadata?.isFile() && !metadata.isSymbolicLink()) return candidate;
    }
    return findInVault(settings.root, clean).catch(() => undefined);
  }

  describe(note, file) {
    return { vaultId: this.vaultId, mode: this.mode, readOnly: this.readOnly, note: note.path, id: note.id,
      journal: relative(this.storeDir, file), location: this.mode === "inside" ? ".omarkie" : this.storeDir };
  }

  // A static card resolves its section on demand; nothing about the source note is stored or rewritten.
  async resolveCardLink(noteName, link) {
    const parsed = parseCardLink(link ?? "");
    if (!parsed) return { status: "invalid", link: link ?? "", target: null, section: null, heading: null, markdown: "" };
    const targetName = parsed.target || noteName;
    const base = noteName.includes("/") ? noteName.slice(0, noteName.lastIndexOf("/")) : "";
    const stem = targetName.replace(/\.(?:md|markdown|mdown)$/i, "");
    const candidates = [];
    const offer = value => { const clean = value.replace(/^\.\//, ""); if (clean && !candidates.includes(clean)) candidates.push(clean); };
    if (!targetName.includes("/")) {
      if (base) offer(`${base}/${stem}.md`);
      offer(`${stem}.md`);
    } else {
      offer(`${stem}.md`);
      if (base) offer(`${base}/${stem}.md`);
    }
    if (!targetName.includes("/") && this.sync) {
      const located = await this.sync.requestIndex("locate", { target: stem }).catch(() => []);
      for (const pathName of located ?? []) offer(pathName);
    }
    for (const candidate of candidates.slice(0, 12)) {
      const reading = await this.readNoteText(candidate);
      if (!reading) continue;
      const section = extractSection(reading, parsed.section);
      return { status: section.status, link: link ?? "", target: candidate, section: parsed.section || null,
        heading: section.heading, markdown: section.markdown };
    }
    return { status: "missing", link: link ?? "", target: `${stem}.md`, section: parsed.section || null, heading: null, markdown: "" };
  }

  async readNoteText(name) {
    let note, file;
    try { ({ note, file } = await this.validateNote(name)); } catch { return null; }
    const metadata = await info(file);
    if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024) return null;
    return await readFile(file, "utf8");
  }

  async card(request) {
    this.assertReady();
    const { note: name } = await this.validateNote(request.note);
    if (!this.initialized && await this.existingStore()) await this.initialize();
    if (!this.initialized) throw new Error("Glass is not initialized in this vault.");
    const note = this.notesByPath.get(name);
    if (!note) throw new Error("Glass note not found.");
    const file = this.journalFor(note);
    const replay = await this.readJournal(file), magnet = replay.magnets.get(request.magnet);
    if (!magnet || magnet.deleted?.active) throw new Error("Glass card not found.");
    const fields = magnetViewFromMap(magnet).fields;
    if (fields.kind !== "card") throw new Error("That magnet is not a card.");
    if (request.mode === "resolve") {
      if (fields.card !== "static") return { ...this.describe(note, file), magnet: magnet.id, card: fields.card, status: "ok" };
      const resolved = await this.resolveCardLink(name, fields.link);
      return { ...this.describe(note, file), magnet: magnet.id, card: "static", title: fields.title ?? "", ...resolved };
    }
    if (request.mode !== "page") throw new Error("Unknown card request.");
    this.assertWritable();
    const card = { card: fields.card, title: fields.title, link: fields.link, question: fields.question, answer: fields.answer, choices: fields.choices };
    const options = {};
    if (fields.card === "static") {
      const resolved = await this.resolveCardLink(name, fields.link);
      if (resolved.status !== "ok") {
        throw new Error(resolved.status === "missing" ? `The linked note is missing: ${resolved.target}`
          : resolved.status === "section-missing" ? `The linked section is missing: ${resolved.section}`
          : "The card link is not a note or section link.");
      }
      options.markdown = resolved.markdown;
    } else if (fields.card === "ai" && !fields.answer?.trim()) throw new Error("The card has no cached answer yet.");
    else if (fields.card === "menu" && !fields.choices?.length) throw new Error("The menu card has no choices.");
    const markdown = cardPageMarkdown(card, options);
    if (Buffer.byteLength(markdown) > cardDefaults.pageBytes) throw new Error("The card page is too large to write.");
    const written = await this.writeCardPage(name, cardPageStem(card), markdown);
    return { ...this.describe(note, file), magnet: magnet.id, card: fields.card, path: written.path, name: written.name, bytes: written.bytes };
  }

  // The page is a new note; an existing file is never overwritten or appended to.
  async writeCardPage(noteName, stem, markdown) {
    const folder = noteName.includes("/") ? noteName.slice(0, noteName.lastIndexOf("/")) : "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const title = attempt ? `${stem} (${attempt + 1})` : stem;
      const relativeName = folder ? `${folder}/${title}.md` : `${title}.md`;
      if (relativeName === noteName) continue;
      const file = path.join(this.root, ...relativeName.split("/"));
      let handle;
      try { handle = await open(file, "wx", 0o600); }
      catch (error) { if (error.code === "EEXIST") continue; throw error; }
      try { await handle.writeFile(markdown, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      return { path: relativeName, name: title, bytes: Buffer.byteLength(markdown) };
    }
    throw new Error("Too many pages already use that title.");
  }

  status() {
    return { version: glassVersion, initialized: this.initialized === true, vaultId: this.vaultId ?? null, mode: this.mode ?? null, readOnly: this.readOnly === true,
      readOnlyReason: this.readOnly ? this.readOnlyReason ?? null : null, root: this.root,
      location: this.mode === "inside" ? ".omarkie" : this.storeDir, notes: this.notesById.size,
      pending: this.pending.length, error: this.error ? { ...this.error } : null, lastSavedAt: this.lastSavedAt ?? null,
      lock: this.lockOwner ? { host: this.lockOwner.host, pid: this.lockOwner.pid } : null, bridge: this.bridgeState ?? null,
      index: this.indexStatus ?? null, bring: this.offer ?? null, lost: this.lost ?? [] };
  }

  async request(input) {
    if (!input || typeof input !== "object" || typeof input.action !== "string") throw new Error("Invalid Glass request.");
    if (input.action === "status") return this.status();
    if (input.action === "flush") return this.initialized ? this.flushPending() : this.status();
    if (["map", "find", "bring", "finder", "reindex"].includes(input.action)) {
      if (!this.sync) throw new Error("The vault index is not running. Open the folder in Omarkie first.");
      return this.sync[input.action](input);
    }
    if (!["add", "set", "delete", "restore", "list", "show", "asset", "asset-display", "card",
      "merge-preview", "merge-accept", "merge-undo", "merge-history", "lift-up", "timeline", "scrub"].includes(input.action)) throw new Error("Unknown Glass action.");
    if (typeof input.note !== "string" || !input.note.trim()) throw new Error("--note is required.");
    if (["set", "delete", "restore", "asset", "asset-display", "card", "merge-preview", "merge-accept"].includes(input.action) && (typeof input.magnet !== "string" || !input.magnet.trim())) throw new Error("--magnet is required.");
    if (input.action === "merge-preview") return this.mergePreview(input);
    if (input.action === "merge-accept") return this.mergeAccept(input);
    if (input.action === "merge-undo") return this.mergeUndo(input);
    if (input.action === "merge-history") return this.mergeHistory(input);
    if (input.action === "lift-up") return this.liftUp(input);
    if (input.action === "asset") return this.magnetAsset(input);
    if (input.action === "asset-display") return this.assetDisplay(input);
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

async function copyPlainTree(source, target) {
  const root = await info(source);
  if (!root?.isDirectory() || root.isSymbolicLink()) return 0;
  let copied = 0;
  async function walk(from, to) {
    let entries;
    try { entries = await readdir(from, { withFileTypes: true }); } catch { return; }
    await mkdir(to, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      const fromFile = path.join(from, entry.name);
      const toFile = path.join(to, entry.name);
      if (entry.isDirectory()) { await walk(fromFile, toFile); continue; }
      if (!entry.isFile()) continue;
      if (await info(toFile)) continue;
      try { await copyFile(fromFile, toFile, constants.COPYFILE_EXCL); copied += 1; } catch { /* keep the old asset on any refusal */ }
    }
  }
  await walk(source, target);
  return copied;
}

function imageDimensions(bytes) {
  try { return imageSize(bytes) ?? {}; } catch { return {}; }
}

function magnetViewFromMap(magnet) {
  const fields = {};
  for (const [field, entry] of magnet.fields) if (!entry.removed) fields[field] = entry.value;
  return { id: magnet.id, fields, kind: fields.kind ?? null, deleted: !!magnet.deleted?.active };
}

const stickyFieldNames = new Set(["kind", "text", "color", "anchor", "x", "y", "w", "h", "folded", "source"]);
const finite = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

function sourceField(value) {
  const source = validSource(value);
  if (!source) throw new Error("A lifted copy needs its source element and line.");
  return source;
}

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
    } else if (field === "source") {
      values.source = sourceField(value);
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

const inkFieldNames = new Set(["kind", "layer", "tool", "color", "size", "parts"]);

// Ink: a palette colour and a known nib for its tool, then parts that each carry their own
// element anchor and 1-4000 points inside that box.
function inkFieldValues(fields) {
  const values = {};
  for (const [field, value] of Object.entries(fields)) {
    if (!inkFieldNames.has(field)) throw new Error(`Unknown ink field: ${field}.`);
    if (field === "kind") {
      if (value !== "ink") throw new Error("Ink keeps its kind.");
      values.kind = "ink";
    } else if (field === "layer") {
      if (value !== "ink") throw new Error("Ink stays on the ink layer.");
      values.layer = "ink";
    } else if (field === "tool") {
      if (!validInkTool(value)) throw new Error("Ink tool must be pen or highlighter.");
      values.tool = value;
    } else if (field === "color") {
      if (typeof value !== "string" || !Object.values(inkColors).some(palette => palette.includes(value))) throw new Error("Ink colour is not in the palette.");
      values.color = value;
    } else if (field === "size") {
      if (typeof value !== "number" || !Object.values(inkWidths).some(widths => widths.includes(value))) throw new Error("Ink size is not a known nib width.");
      values.size = value;
    } else {
      if (!validInkParts(value)) throw new Error("Ink parts need a box, an anchor and 1-4,000 points each, 24 parts at most.");
      for (const part of value) {
        if (!validInkBox(part.box)) throw new Error("Ink part box is not a block, list item, or table cell.");
        if (!validAnchor(part.anchor)) throw new Error("Ink part has an invalid anchor.");
      }
      values.parts = value;
    }
  }
  return values;
}

const stickerFieldNames = new Set(["kind", "sticker", "image", "anchor", "x", "y", "w", "h", "rotate", "layer"]);

// A sticker is the built-in sheet id or one custom image, plus its box and its paragraph.
export function stickerFields(fields, partial) {
  const values = {};
  for (const [field, value] of Object.entries(fields)) {
    if (!stickerFieldNames.has(field)) throw new Error(`Unknown sticker field: ${field}.`);
    if (field === "kind") {
      if (value !== "sticker") throw new Error("A sticker keeps its kind.");
      values.kind = value;
    } else if (field === "sticker") {
      if (typeof value !== "string" || !stickerIds.includes(value)) throw new Error(`Sticker must be one of: ${stickerIds.join(", ")}.`);
      values.sticker = value;
    } else if (field === "image") {
      if (!validStickerImage(value)) throw new Error("A custom sticker needs a data URL image under 300 KB.");
      values.image = value;
    } else if (field === "anchor") {
      if (!stickyAnchor(value)) throw new Error("A sticker needs one block anchor with its heading path.");
      values.anchor = value;
    } else if (field === "layer") {
      if (value !== stickerLayer) throw new Error("A sticker lands on the notes layer.");
      values.layer = value;
    } else if (field === "rotate") {
      if (!finite(value, -360, 360)) throw new Error("Sticker rotate must be a number between -360 and 360.");
      values.rotate = Math.round(value);
    } else {
      const limits = field === "w" || field === "h" ? [24, 1200] : [-200_000, 200_000];
      if (!finite(value, limits[0], limits[1])) throw new Error(`Sticker ${field} must be a number between ${limits[0]} and ${limits[1]}.`);
      values[field] = Math.round(value);
    }
  }
  if (!partial) {
    if (values.sticker === undefined && values.image === undefined) throw new Error("A sticker needs a built-in sticker id or a custom image.");
    if (values.sticker !== undefined && values.image !== undefined) throw new Error("A sticker is either built-in or custom, not both.");
    if (!values.anchor) throw new Error("A sticker needs an anchor.");
    values.layer ??= stickerLayer;
    values.x ??= 0;
    values.y ??= 0;
    values.w ??= 72;
    values.h ??= 72;
    values.rotate ??= 0;
  }
  return values;
}

const arrowFieldNames = new Set(["kind", "from", "to", "style", "color", "head", "label"]);

// An arrow points from one end to another; both ends are stored, so a reflow re-routes it.
export function arrowFields(fields, partial) {
  const values = {};
  for (const [field, value] of Object.entries(fields)) {
    if (!arrowFieldNames.has(field)) throw new Error(`Unknown arrow field: ${field}.`);
    if (field === "kind") {
      if (value !== "arrow") throw new Error("An arrow keeps its kind.");
      values.kind = value;
    } else if (field === "from" || field === "to") {
      if (!validArrowEnd(value)) throw new Error(`Arrow ${field} must be an element with landmarks or a magnet id.`);
      values[field] = value;
    } else if (field === "style") {
      if (!arrowStyles.includes(value)) throw new Error(`Arrow style must be one of: ${arrowStyles.join(", ")}.`);
      values.style = value;
    } else if (field === "color") {
      if (!arrowColors.includes(value)) throw new Error(`Arrow colour must be one of: ${arrowColors.join(", ")}.`);
      values.color = value;
    } else if (field === "head") {
      if (!arrowHeads.includes(value)) throw new Error(`Arrow head must be one of: ${arrowHeads.join(", ")}.`);
      values.head = value;
    } else {
      if (typeof value !== "string" || value.length > 240 || value.includes("\u0000")) throw new Error("Arrow label must be text up to 240 characters.");
      values.label = value;
    }
  }
  if (!partial) {
    if (!values.from || !values.to) throw new Error("An arrow needs a from and a to end.");
    values.style ??= "straight";
    values.color ??= "ink";
    values.head ??= "solid";
    values.label ??= "";
  }
  if (values.from && values.to && values.from.kind === values.to.kind &&
      (values.from.element ?? values.from.magnet) === (values.to.element ?? values.to.magnet))
    throw new Error("An arrow needs two different ends.");
  return values;
}

// Other magnet kinds stay open for later slices; each mark is validated field by field.
function validateMagnetFields(kind, fields, partial) {
  if (kind === "image") {
    const values = imageFields(partial ? fields : { ...fields, kind: "image" }, { partial });
    if (!partial) {
      if (!values.name) throw new Error("An image magnet needs a name.");
      if (!values.asset) throw new Error("An image magnet needs an asset.");
      if (!values.anchor) throw new Error("An image magnet needs an anchor.");
      values.display ??= null;
    }
    return values;
  }
  if (kind === "ink") {
    const values = inkFieldValues(partial ? fields : { ...fields, kind: "ink" });
    if (!partial) {
      if (!values.tool || !values.color) throw new Error("Ink needs a tool and a colour.");
      if (!validInkColor(values.tool, values.color)) throw new Error("Ink colour does not belong to that tool.");
      if (!validInkSize(values.tool, values.size)) throw new Error("Ink nib width does not belong to that tool.");
      if (!values.parts) throw new Error("Ink needs its stroke parts.");
      values.layer ??= "ink";
    }
    return values;
  }
  if (kind === "sticker") return stickerFields(partial ? fields : { ...fields, kind: "sticker" }, partial);
  if (kind === "arrow") return arrowFields(partial ? fields : { ...fields, kind: "arrow" }, partial);
  if (kind === "card") {
    const values = cardFields(partial ? fields : { ...fields, kind: "card" });
    if (!partial) {
      if (!values.card) throw new Error("A card needs a card kind: static, ai or menu.");
      if (!values.anchor) throw new Error("A card needs an anchor.");
      values.layer ??= cardLayer;
      values.title ??= "";
      values.x ??= 0;
      values.y ??= 0;
      values.w ??= cardDefaults.w;
      values.folded ??= true;
      if (values.card === "static" && !values.link) throw new Error("A static card needs a link.");
      if (values.card === "ai" && !values.question?.trim()) throw new Error("An AI card needs a question.");
      if (values.card === "menu" && !values.choices?.length) throw new Error("A menu card needs at least one choice.");
    }
    return values;
  }
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

// Merge down writes bytes, not strings: a note may carry any encoding, BOM and line endings.
async function writeBytesAtomic(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const existing = await info(file).catch(() => undefined);
  try {
    const handle = await open(temporary, "wx", existing ? existing.mode & 0o777 : 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function imageReferenceOf(markdown) {
  const embed = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/u.exec(String(markdown ?? ""));
  if (embed) return embed[1].trim();
  const link = /!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)/u.exec(String(markdown ?? ""));
  return link ? link[1].replace(/^<|>$/g, "").trim() : null;
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
