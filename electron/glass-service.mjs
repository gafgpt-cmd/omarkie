import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rmdir, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { imageSize } from "image-size";
import {
  anchorVersion, assertNoStoreSecrets, clockSkewLimit, conflictLine, createClock, glassFileName, glassVersion, journalOpId, newMagnetId, parseClock, parseJournalText,
  replayJournalText, replayNotesText, sanitizeTitle, stickyColors, validAnchor, visibleMagnets,
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
  validCompareFields, validMeasureFields, validSheetLabelFields, validTraceFields,
} from "../shared/glass-visual.mjs";
import {
  cardDefaults, cardFields, cardLayer, cardPageMarkdown, cardPageStem, extractSection, parseCardLink,
} from "../shared/glass-cards.mjs";
import { clipFieldValues, cutoutFieldValues, extraPageFieldValues, sheetTitle } from "../shared/glass-clips.mjs";
import { labelFields } from "../shared/glass-labels.mjs";
import {
  cardId, cardView, dueStudyCards, normalizeGrade, parseStudyText, previewGrade, srsDefaults, studySummary,
} from "../shared/srs-core.mjs";
import { assertCalcDefinition, calcLimits, evaluateCalc } from "../shared/calc-model.mjs";
import {
  decodeNote, encodeNote, inkSvg, insertBlock, mergeAnchorOf, mergeDiff, mergeKindLabel, mergeLines,
  mergeableKinds, noteLineEnding, noteMergeSettings, replayMerges, resolveMergeElement,
} from "../shared/glass-merge.mjs";
import { markdownElements } from "../shared/element-model.mjs";
import { journalTimeline, magnetsAt, parseScrubTime } from "../shared/glass-scrub.mjs";
import {
  attributionText, candidateAllowed, capProposals, compareSet, isSwapId, latestSwaps, normalLicence, onlineAllowed,
  replaySwaps, replacementLines, swapActionsFor, swapActionList, swapDefaults, swapDestinations, swapDiff, swapFootnoteRef,
} from "../shared/element-swap.mjs";
import { findInVault, vaultRoot } from "./vault.mjs";
import { readGlassSettings, writeGlassSettings } from "./glass-state.mjs";
import { searchOnline } from "./image-search.mjs";
import { cleanHookResult, hookState, runImageHook, transcribe } from "./image-hooks.mjs";
import { layerCounts, layerPatch, layerStates, validGlassLayer } from "../shared/glass-layers.mjs";
import {
  chapterMarks, cleanTranscript, timestampLabel, validSpeakerSegments, validVoiceLanguage, validVoiceWav,
  voiceDefaults, voiceMimes,
} from "../shared/voice.mjs";

const markdown = /\.(?:md|markdown|mdown)$/i;
const noFollow = (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
const ownership = ["EACCES", "EPERM", "EROFS"];
const missing = error => { if (error.code !== "ENOENT") throw error; return null; };
const info = file => lstat(file).catch(missing);
const directory = async file => { const item = await info(file); return !!item?.isDirectory() && !item.isSymbolicLink(); };
const relative = (root, file) => path.relative(root, file).split(path.sep).join("/");
const titleOf = name => path.basename(name).replace(markdown, "");
const journalPattern = / ~([a-z0-9]{4,32})\.jsonl$/;
const vaultPicture = /\.(?:png|jpe?g|gif|webp|avif)$/i;

function previewOfBytes(bytes, type) {
  if (!bytes?.length || bytes.length > swapDefaults.previewBytes || !type) return null;
  return { base64: bytes.toString("base64"), mime: mimeFor(type) };
}

function candidateId(...parts) {
  return `c-${createHash("sha256").update(parts.map(part => String(part ?? "")).join("\u0001")).digest("hex").slice(0, 10)}`;
}

// A bounded walk; hidden folders, .omarkie and symlinks never enter, so a vault cannot stall the search.
async function vaultImages(root, limit = 8) {
  const found = [];
  let entries = 0;
  async function walk(directory, depth) {
    if (entries > 4_000 || found.length > 400) return;
    let items;
    try { items = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of items.sort((left, right) => left.name.localeCompare(right.name))) {
      if (++entries > 4_000) return;
      if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (depth < 8) await walk(absolute, depth + 1); continue; }
      if (!entry.isFile() || !vaultPicture.test(entry.name)) continue;
      const metadata = await info(absolute);
      if (!metadata?.isFile()) continue;
      found.push({ absolute, rel: relative(root, absolute), name: entry.name, size: metadata.size });
      if (found.length > 400) return;
    }
  }
  await walk(root, 0);
  return found.slice(0, Math.max(limit, 0));
}

// Identity of one journal line, so a conflict copy never adds an op twice.
function journalLineKey(line) {
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (typeof record.opId === "string" && record.opId) return `op:${record.opId}`;
  return parseClock(record.hlc) ? `op:${journalOpId(record)}` : null;
}

// The only hosts a candidate may be downloaded from: the app's two picture sources and whatever
// an installation points its own search at. A loopback, private or metadata address is never here.
function swapDownloadHosts() {
  const hosts = new Set(["upload.wikimedia.org", "commons.wikimedia.org", "api.openverse.org"]);
  for (const name of ["OMARKIE_SWAP_COMMONS", "OMARKIE_SWAP_OPENVERSE"]) {
    const configured = process.env[name]?.trim();
    if (!configured) continue;
    try { hosts.add(new URL(configured).hostname.toLowerCase()); } catch { /* a bad override adds nothing */ }
  }
  return hosts;
}

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
    if (insideSettings) assertNoStoreSecrets(insideSettings, "`.omarkie/settings.json`");
    if (goodVaultId(insideSettings?.vaultId)) return insideSettings;
    const remembered = await this.registryEntry();
    if (!goodVaultId(remembered?.vaultId)) return null;
    const outside = path.join(this.appData, "glass-vaults", remembered.vaultId);
    const settings = await readJson(path.join(outside, "settings.json"));
    if (settings) assertNoStoreSecrets(settings, "Glass settings");
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
    if (insideSettings) assertNoStoreSecrets(insideSettings, "`.omarkie/settings.json`");
    const remembered = await this.registryEntry();
    let vaultId = goodVaultId(insideSettings?.vaultId) ? insideSettings.vaultId : goodVaultId(remembered?.vaultId) ? remembered.vaultId : null;
    let requested = insideSettings?.mode === "outside" ? "outside" : "inside";
    if (!insideSettings && goodVaultId(remembered?.vaultId)) {
      const outside = path.join(this.appData, "glass-vaults", remembered.vaultId);
      const settings = await readJson(path.join(outside, "settings.json"));
      if (settings) assertNoStoreSecrets(settings, "Glass settings");
      if (goodVaultId(settings?.vaultId) && await directory(outside)) requested = "outside";
    }
    if (requested === "inside") {
      if (!await directory(inside)) {
        try { await mkdir(inside, { recursive: true, mode: 0o700 }); }
        catch (error) {
          // A read-only FUSE mount refuses the mkdir; Node's recursive mkdir reports that refusal as
          // ENOENT while the vault folder itself still exists. Either way the fallback is outside mode.
          const refused = ownership.includes(error.code) || (error.code === "ENOENT" && await directory(this.root));
          if (!refused) throw error;
          requested = "outside";
        }
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
    const existing = await readJson(settings);
    if (!existing) {
      const initial = { version: glassVersion, vaultId: this.vaultId, mode: this.mode, createdAt: new Date().toISOString() };
      assertNoStoreSecrets(initial, "Glass settings");
      await atomicJson(settings, initial);
    } else if (existing.vaultId !== this.vaultId || existing.mode !== this.mode) {
      // Sync can create settings before the first glass write; keep its remote fields and add the vault id.
      const merged = { ...existing, version: glassVersion, vaultId: this.vaultId, mode: this.mode };
      assertNoStoreSecrets(merged, "Glass settings");
      await atomicJson(settings, merged);
    }
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

  // A note's identity is its id, never the spelling of its path. HFS+ hands the same file back
  // decomposed and Linux composed, so every path lookup normalizes to NFC and keeps both keys.
  pathAliases(value) {
    const nfc = String(value).normalize("NFC");
    return nfc === value ? [value] : [value, nfc];
  }

  setPath(note, name) {
    for (const key of this.pathAliases(name)) this.notesByPath.set(key, note);
  }

  dropPath(name) {
    for (const key of this.pathAliases(name)) this.notesByPath.delete(key);
  }

  async loadNotes() {
    this.notesFile = path.join(this.storeDir, "notes.jsonl");
    const text = await readLimited(this.notesFile, 64 * 1024 * 1024).catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const replay = replayNotesText(text);
    this.logQuarantine(this.notesFile, replay.quarantined);
    this.notesById.clear();
    this.notesByPath.clear();
    for (const note of replay.notes.values()) {
      this.notesById.set(note.id, note);
      this.setPath(note, note.path);
    }
    this.notesInvalid = replay.invalid;
    if (!this.readOnly) await this.repairTail(this.notesFile);
  }

  async scanJournals() {
    await this.absorbConflictCopies();
    const names = await readdir(path.join(this.storeDir, "glass")).catch(() => []);
    for (const name of names) {
      const match = journalPattern.exec(name);
      if (!match) continue;
      const file = path.join(this.storeDir, "glass", name);
      this.journals.set(match[1], file);
      if (!this.readOnly) await this.repairTail(file);
    }
  }

  // Syncthing, Drive and Dropbox never edit a file: they drop a copy beside it
  // (`x ~id.jsonl.sync-conflict-….jsonl`, `x ~id (1).jsonl`, `x ~id (conflicted copy …).jsonl`).
  // Every op in a copy is real, so the lines are union-merged by op id into the one journal and the
  // copy is moved to `merged/`, never deleted. Runs at open and on every sync batch.
  async absorbConflictCopies() {
    if (!this.loaded || this.readOnly || this.closed || !this.storeDir) return { lines: 0, copies: [] };
    const glass = path.join(this.storeDir, "glass");
    const names = await readdir(glass).catch(() => []);
    const groups = new Map();
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      // Syncthing inserts its marker before the extension (`x ~id.sync-conflict-….jsonl`), Drive and
      // Dropbox append after it; both point at the same journal id.
      const match = / ~([a-z0-9]{4,32})(?:\.jsonl|\.sync-conflict|[ (])/.exec(name);
      if (!match) continue;
      const list = groups.get(match[1]) ?? [];
      list.push(name);
      groups.set(match[1], list);
    }
    const merged = [], moved = [];
    for (const [id, list] of groups) {
      if (list.length < 2) continue;
      const note = this.notesById.get(id);
      const expected = note ? glassFileName(note.title ?? titleOf(note.path), id) : null;
      const canonical = (expected && list.includes(expected) ? expected : null)
        ?? list.find(name => name.endsWith(` ~${id}.jsonl`))
        ?? [...list].sort()[0];
      const copies = list.filter(name => name !== canonical).sort();
      const canonicalFile = path.join(glass, canonical);
      const known = new Map();
      for (const line of parseJournalText(await readFile(canonicalFile, "utf8").catch(() => "")).lines) {
        const key = journalLineKey(line);
        if (key) known.set(key, line);
      }
      const appended = [];
      for (const copy of copies) {
        const text = await readFile(path.join(glass, copy), "utf8").catch(() => "");
        for (const line of parseJournalText(text).lines) {
          const trimmed = line.trim();
          if (!trimmed || conflictLine.test(trimmed)) continue;
          const key = journalLineKey(trimmed) ?? `line:${trimmed}`;
          if (known.has(key)) continue;
          known.set(key, line);
          appended.push(line);
        }
      }
      if (appended.length) await this.appendText(canonicalFile, appended.join("\n"));
      await mkdir(path.join(this.storeDir, "merged"), { recursive: true, mode: 0o700 });
      for (const copy of copies) {
        try { await rename(path.join(glass, copy), path.join(this.storeDir, "merged", copy)); moved.push(copy); }
        catch { /* leave the copy in place; the next pass retries */ }
      }
      merged.push({ id, journal: canonical, lines: appended.length, copies: copies.length });
    }
    if (merged.length) this.notify();
    return { lines: merged.reduce((sum, item) => sum + item.lines, 0), copies: moved, merged };
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
    if (metadata?.isSymbolicLink()) throw new Error("Markdown symlinks are not allowed.");
    if (!metadata?.isFile()) throw new Error("Note not found in this vault.");
    // The vault root is already resolved, so any symlinked folder along the way changes this path.
    if (await realpath(file) !== file) throw new Error("Markdown symlinks are not allowed.");
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
    let name, file;
    try { ({ note: name, file } = await this.validateNote(note)); }
    catch (error) {
      // The drive went away mid-session. A note this vault already knows keeps its glass path, so
      // the write queues behind the offline banner instead of being refused outright.
      const known = this.notesByPath.get(String(note).normalize("NFC"));
      if (known && (["ENOENT", "EACCES", "EPERM", "EROFS", "ENOTDIR"].includes(error.code) || /not found in this vault/u.test(error.message))) return known;
      throw error;
    }
    const fingerprint = await this.noteFingerprint(file);
    const known = this.notesByPath.get(name);
    if (known) {
      if (known.fingerprint?.hash !== fingerprint.hash || known.fingerprint?.size !== fingerprint.size) {
        const record = { op: "note", id: known.id, path: known.path, title: known.title ?? titleOf(known.path), fingerprint, hlc: this.clock.next(), device: this.deviceName };
        await this.appendRecord(this.notesFile, record);
        Object.assign(known, { fingerprint, hlc: record.hlc });
        await this.rememberNote(known, known.path);
      }
      return known;
    }
    const id = this.newNoteId();
    const record = { op: "note", id, path: name, title: titleOf(name), fingerprint, hlc: this.clock.next(), device: this.deviceName };
    const entry = { id, path: name, title: record.title, fingerprint, hlc: record.hlc, device: record.device };
    this.notesById.set(id, entry);
    this.setPath(entry, name);
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
    // The sync layer works from currentNotes() snapshots; the live object is the one the app reads.
    const current = this.notesById.get(note.id) ?? note;
    if (current.fingerprint?.hash === fingerprint.hash && current.fingerprint?.size === fingerprint.size) return current;
    this.assertWritable();
    const record = { op: "note", id: current.id, path: name, title: current.title ?? titleOf(name), fingerprint,
      hlc: this.clock.next(), device: this.deviceName };
    await this.appendRecord(this.notesFile, record);
    current.fingerprint = fingerprint;
    current.hlc = record.hlc;
    await this.rememberNote(current, name);
    return current;
  }

  currentNotes() {
    return [...this.notesById.values()].map(note => ({ id: note.id, path: note.path, title: note.title,
      fingerprint: note.fingerprint ?? null }));
  }

  async recordMove(note, to, { title, fingerprint } = {}) {
    // Move whichever copy arrives, but always keep the live note object authoritative.
    const current = this.notesById.get(note.id) ?? note;
    this.assertWritable();
    const record = { op: "move", id: current.id, to, hlc: this.clock.next(), device: this.deviceName,
      title: title ?? titleOf(to), ...(fingerprint ? { fingerprint } : {}) };
    await this.appendRecord(this.notesFile, record);
    this.dropPath(current.path);
    current.path = to;
    current.title = record.title;
    if (fingerprint) current.fingerprint = fingerprint;
    this.setPath(current, to);
    await this.rememberNote(current, to);
    return record;
  }

  async recordFolder(from, to) {
    this.assertWritable();
    const record = { op: "folder", from, to, hlc: this.clock.next(), device: this.deviceName };
    await this.appendRecord(this.notesFile, record);
    for (const note of this.notesById.values()) {
      if (note.path !== from && !note.path.startsWith(`${from}/`)) continue;
      this.dropPath(note.path);
      note.path = `${to}${note.path.slice(from.length)}`;
      this.setPath(note, note.path);
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
      this.setPath(note, name);
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
    const identified = record.opId ? record : { ...record, opId: journalOpId(record) };
    const line = `${JSON.stringify(identified)}\n`;
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
    if (kind === "card" && Object.keys(values).some(field => ["card", "formula", "inputs", "unit", "citation", "precision"].includes(field))) {
      const current = {};
      for (const [field, entry] of magnet.fields) if (!entry.removed) current[field] = entry.value;
      await checkCardDefinition({ ...current, ...values });
    }
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
    const bytes = Buffer.from(line, "utf8");
    let handle, before = null, writing = false;
    try {
      await this.repairTail(file);
      const known = this.sizes.get(file);
      // The journal changed size while it was being probed: appending now would land after a tail
      // that was never repaired, and rolling back on a guessed offset could drop good lines.
      if (known === undefined)
        throw Object.assign(new Error("The glass journal changed while it was being read; the change was not saved."), { code: "GLASS_CHANGED" });
      before = known;
      if (this.faults.beforeAppend) await this.faults.beforeAppend(file, line);
      handle = await open(file, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow, 0o600);
      writing = true;
      const written = this.faults.write
        ? await this.faults.write(handle, line, file)
        : (await handle.write(bytes, 0, bytes.length, null)).bytesWritten;
      // A full disk can return a short count with no exception. Treat anything but the whole
      // line as failure and roll back, so a torn line is never left behind.
      if (typeof written === "number" && written !== bytes.length)
        throw Object.assign(new Error(`Glass wrote ${written} of ${bytes.length} bytes; the change was not saved.`), { code: "SHORT_WRITE", written, lineBytes: bytes.length });
      if (this.faults.sync) await this.faults.sync(handle, file);
      else await handle.sync();
      this.sizes.set(file, before + bytes.length);
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
      // The file changed size under the probe (a sync merge rewrote it); nothing can be decided
      // here, and truncating on a guess would delete good lines.
      if (complete === null) { this.sizes.delete(file); return null; }
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

  // After a sync writes journals or notes.jsonl outside this process, reload from disk before the
  // next reader asks. Pending local lines flush first so nothing is lost.
  async reloadStore() {
    this.assertReady();
    if (this.readOnly) return this.status();
    await this.flushPending();
    this.cache.clear();
    this.memory.clear();
    this.listing.clear();
    await this.loadNotes();
    await this.scanJournals();
    return this.status();
  }

  async readJournal(file) {
    const metadata = await info(file);
    const signature = metadata ? `${metadata.size}:${metadata.mtimeMs}` : "missing";
    let cached = this.cache.get(file);
    if (!cached || cached.signature !== signature) {
      const text = metadata ? await readLimited(file, 128 * 1024 * 1024) : "";
      const replay = replayJournalText(text);
      for (const clock of replay.clocks) this.clock.observe(clock);
      this.logQuarantine(file, replay.quarantined);
      cached = { signature, lines: replay.lines, replay };
      this.cache.set(file, cached);
    }
    const memory = this.memory.get(file);
    // Unflushed records already advanced this device's clock when written.
    if (!memory?.length) return cached.replay;
    const combined = replayJournalText([...cached.lines, ...memory].join("\n"));
    this.logQuarantine(file, combined.quarantined);
    return combined;
  }

  logQuarantine(file, quarantined) {
    if (!quarantined?.length) return;
    this.quarantineLogged ??= new Map();
    const key = `${file}:${quarantined.length}`;
    if (this.quarantineLogged.get(file) === key) return;
    this.quarantineLogged.set(file, key);
    const reasons = [...new Set(quarantined.map(item => item.reason))].join(", ");
    console.warn(`[glass] ${quarantined.length} journal line(s) quarantined in ${path.basename(file)}: ${reasons}`);
  }

  async add(request) {
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    const note = await this.identify(request.note);
    const file = this.journalFor(note);
    // A full or vanished drive must queue the op, not refuse it before the journal write is tried.
    await mkdir(path.join(this.storeDir, "assets", path.basename(file, ".jsonl")), { recursive: true, mode: 0o700 })
      .catch(error => { if (!ownership.includes(error.code) && error.code !== "ENOENT") throw error; });
    await this.readJournal(file);
    const magnetId = request.magnet ?? newMagnetId();
    if (typeof magnetId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(magnetId)) throw new Error("Use a short magnet id of letters, digits, _ or -.");
    const fields = { ...(request.fields && typeof request.fields === "object" && !Array.isArray(request.fields) ? request.fields : {}) };
    for (const key of ["text", "kind", "color", "anchor", "x", "y", "w", "h", "folded", "layer", "tool", "size", "parts", "card", "title", "link", "question", "answer", "answerAt", "choices",
      "strokes", "source", "region", "lasso", "notePath", "savedAt", "aspect", "name", "asset", "display", "bytes", "locked",
      "audio", "mime", "duration", "lang", "segments"])
      if (request[key] !== undefined) fields[key] = request[key];
    if (request.image !== undefined) {
      if (!request.image || typeof request.image !== "object" || Array.isArray(request.image)) throw new Error("Invalid image payload.");
      const kind = fields.kind === "cutout" ? "cutout" : "image";
      const stored = await this.imageAsset({ file, image: request.image, width: fields.w, wrap: fields.wrap, kind });
      if (kind === "cutout") { delete stored.wrap; delete stored.rot; delete stored.tape; }
      Object.assign(fields, stored);
    }
    if (fields.anchor !== undefined && fields.kind !== "sticky") {
      if (!validAnchor(fields.anchor)) throw new Error("Invalid Glass anchor.");
      fields.anchor = { ...fields.anchor, version: fields.anchor.version ?? anchorVersion };
    }
    if (!Object.keys(fields).length) Object.assign(fields, { kind: "debug", text: "Glass debug magnet", x: 0, y: 0 });
    const values = validateMagnetFields(fields.kind, fields, false);
    await checkCardDefinition(values);
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
  async imageAsset({ file, image, width, wrap, kind = "image" }) {
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
    const fields = imageFields({ kind: kind === "cutout" ? "image" : kind, name: image.name || sourceName, asset, display,
      bytes: bytes.length, w, h: Math.max(imageDefaults.minH, Math.round(w / aspect)), aspect, wrap: image.wrap ?? wrap ?? "left" });
    if (kind === "cutout") fields.kind = "cutout";
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
    if (fields.kind === "voice") {
      if (!fields.audio) throw new Error("This memo has no stored audio.");
      const asset = path.join(this.assetDir(file), fields.audio);
      const metadata = await info(asset);
      if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error("The audio file is missing.");
      const bytes = await readFile(asset);
      return { note: name, magnet: magnet.id, name: fields.audio, which: "audio", mime: fields.mime,
        bytes: bytes.length, base64: bytes.toString("base64") };
    }
    if (fields.kind !== "image" && fields.kind !== "cutout") throw new Error("That magnet has no picture.");
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
    return { ...this.describe(note, file), magnets: visibleMagnets(replay.magnets), trash: this.trashOf(replay), layers: layerStates(replay.layers), imported,
      unknownOps: replay.unknown.length, invalidLines: replay.invalid, quarantinedLines: replay.quarantined.length,
      duplicateLines: replay.duplicates, incompleteTail: replay.incomplete, pending: this.pending.length };
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
        deleted: !!magnet?.deleted?.active, quarantinedLines: replay.quarantined.length, pending: this.pending.length };
    }
    return { ...this.describe(note, file), magnets: visibleMagnets(replay.magnets), trash: this.trashOf(replay), layers: layerStates(replay.layers),
      unknownOps: replay.unknown.length, invalidLines: replay.invalid, quarantinedLines: replay.quarantined.length,
      duplicateLines: replay.duplicates, incompleteTail: replay.incomplete, pending: this.pending.length };
  }

  // Study queue: one append-only study.jsonl per vault. A review is never rewritten; the
  // FSRS schedule is replayed from the card definition plus its answers, so a crash loses nothing.
  studyFile() {
    return path.join(this.storeDir, "study.jsonl");
  }

  async readStudy() {
    const file = this.studyFile();
    const text = await readLimited(file, 64 * 1024 * 1024).catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    const memory = this.memory.get(file) ?? [];
    return parseStudyText(memory.length ? `${text}${text && !text.endsWith("\n") ? "\n" : ""}${memory.join("")}` : text);
  }

  currentStudyNote(card) {
    const note = this.notesById.get(card.noteId);
    return note ? note.path : card.note;
  }

  studyCardView(card, study, now = this.now()) {
    const view = cardView(card, study.reviews, now);
    return { ...view, note: this.currentStudyNote(card) };
  }

  async ensureStudyCard(note, request) {
    const study = await this.readStudy();
    const id = cardId(note.id, request.magnet);
    const existing = study.cards.get(id);
    const front = typeof request.front === "string" ? request.front.trim() : "";
    const back = typeof request.back === "string" ? request.back : "";
    if (front.length > srsDefaults.frontLimit) throw new Error(`A card front must be up to ${srsDefaults.frontLimit} characters.`);
    if (back.length > srsDefaults.backLimit) throw new Error(`A card back must be up to ${srsDefaults.backLimit} characters.`);
    if (existing && (!front || (existing.front === front && existing.back === back))) return { study, card: existing, created: false };
    if (!existing && !front) throw new Error("A new study card needs a front.");
    const record = { op: "card", id, noteId: note.id, note: note.path, magnet: request.magnet,
      front: existing?.front && !front ? existing.front : front, back: existing && !front ? existing.back : back,
      source: typeof request.source === "string" ? request.source.slice(0, srsDefaults.sourceLimit) : existing?.source ?? "label",
      created: existing?.created ?? new Date(this.now()).toISOString() };
    await this.appendRecord(this.studyFile(), record);
    return { study: await this.readStudy(), card: (await this.readStudy()).cards.get(id), created: !existing };
  }

  async srsDue() {
    this.assertReady();
    const study = await this.readStudy();
    const now = this.now();
    const summary = studySummary(study, now);
    return { count: summary.due, total: summary.total, learning: summary.learning,
      due: dueStudyCards(study, now).map(card => this.studyCardView(card, study, now)) };
  }

  async srsCard(request) {
    this.assertReady();
    this.assertWritable();
    const note = await this.identify(request.note);
    if (typeof request.magnet !== "string" || !request.magnet) throw new Error("--magnet is required.");
    const { study, card, created } = await this.ensureStudyCard(note, request);
    return { created, card: this.studyCardView(card, study) };
  }

  async srsAnswer(request) {
    this.assertReady();
    this.assertWritable();
    const note = await this.identify(request.note);
    if (typeof request.magnet !== "string" || !request.magnet) throw new Error("--magnet is required.");
    const grade = normalizeGrade(request.grade);
    if (!grade) throw new Error("Grade must be again, hard, good, easy or 1-4.");
    const id = cardId(note.id, request.magnet);
    const existing = (await this.readStudy()).cards.get(id);
    if (!existing && grade !== "again" && request.create !== true) return { created: false, card: null };
    const { card } = await this.ensureStudyCard(note, { ...request, magnet: request.magnet });
    if (request.preview === true) {
      const study = await this.readStudy();
      return { created: !existing, card: this.studyCardView(card, study), preview: previewGrade(card, study.reviews, grade, this.now()) };
    }
    const record = { op: "review", id, rating: grade, at: new Date(this.now()).toISOString() };
    await this.appendRecord(this.studyFile(), record);
    const study = await this.readStudy();
    return { created: !existing, card: this.studyCardView(card, study), preview: null };
  }

  async srsReview(request) {
    this.assertReady();
    if (typeof request.id !== "string" || !request.id) throw new Error("--card is required.");
    const grade = normalizeGrade(request.grade);
    if (!grade) throw new Error("Grade must be again, hard, good, easy or 1-4.");
    const study = await this.readStudy();
    const card = study.cards.get(request.id);
    if (!card) throw new Error("Study card not found.");
    if (request.preview === true) return { card: this.studyCardView(card, study), preview: previewGrade(card, study.reviews, grade, this.now()) };
    this.assertWritable();
    await this.appendRecord(this.studyFile(), { op: "review", id: card.id, rating: grade, at: new Date(this.now()).toISOString() });
    const next = await this.readStudy();
    return { card: this.studyCardView(card, next), preview: null };
  }

  async studyState(request) {
    this.assertReady();
    const note = await this.identify(request.note);
    const study = await this.readStudy();
    return { note: note.path, exam: study.exams.get(note.id) === true, labelsHidden: study.labels.get(note.id) === true };
  }

  async studySet(request) {
    this.assertReady();
    this.assertWritable();
    const note = await this.identify(request.note);
    const at = new Date(this.now()).toISOString();
    if (typeof request.exam === "boolean")
      await this.appendRecord(this.studyFile(), { op: "exam", noteId: note.id, note: note.path, on: request.exam, at });
    if (typeof request.labelsHidden === "boolean")
      await this.appendRecord(this.studyFile(), { op: "labels", noteId: note.id, note: note.path, hidden: request.labelsHidden, at });
    return this.studyState({ note: note.path });
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

  // ---- G22 swap anything: pick, complain, compare, cover or replace, undo ----
  async swapContext(request) {
    if (!this.initialized) await this.initialize();
    const { note: name, file } = await this.validateNote(request.note);
    const known = this.notesByPath.get(name);
    const note = known ?? (this.readOnly ? { id: null, path: name, title: titleOf(name) } : await this.identify(name));
    const journal = this.journalFor(note);
    const text = decodeNote(await readFile(file)).text;
    return { name, file, note, journal, text, elements: markdownElements(text) };
  }

  async swapRecords(journal) {
    return replaySwaps(await readFile(journal, "utf8").catch(() => ""));
  }

  swapEcho(element, elements) {
    const at = elements.findIndex(item => item.id === element.id);
    const near = (offset) => {
      const row = elements[at + offset];
      return row ? { kind: row.kind, line: row.line, text: row.text.slice(0, 160) } : null;
    };
    return {
      id: element.id, kind: element.kind, line: element.line, headings: [...element.headings],
      markdown: element.markdown, text: element.text.slice(0, 4_000),
      heading_path: element.headings.join(" › "), quote: element.text.slice(0, 400),
      neighbours: [near(-1), near(1)].filter(Boolean),
    };
  }

  swapElementOf(elements, id) {
    const element = elements.find(item => item.id === id);
    if (!element) throw Object.assign(new Error("That element is not in this note."), { code: "ELEMENT_NOT_FOUND" });
    return element;
  }

  async swapSettings(request) {
    this.assertReady();
    const { note: name, file } = await this.validateNote(request.note);
    const root = await vaultRoot(path.dirname(file), this.root);
    if (request.neverOnline === undefined) return { note: name, ...(await readGlassSettings(root, { appData: this.appData })) };
    this.assertWritable();
    const settings = await writeGlassSettings(root, { neverOnline: request.neverOnline === true }, { appData: this.appData });
    return { note: name, ...settings };
  }

  // The original is a candidate too: the compare widget needs both sides.
  async swapCurrent(element, file, name) {
    if (element.kind === "image" || element.kind === "embed") {
      const reference = imageReferenceOf(element.markdown);
      const source = reference ? await this.resolveImageReference(reference, file) : null;
      const metadata = source ? await info(source) : null;
      if (!source || !metadata?.isFile() || metadata.isSymbolicLink()) return null;
      const bytes = await readFile(source);
      const type = imageTypeOf(bytes);
      const size = orientationSize(imageDimensions(bytes)) ?? { width: 0, height: 0 };
      if (!type || size.width < 1) return null;
      return {
        id: "current", kind: "find", current: true, source: "vault", sourceLabel: "your vault",
        title: path.basename(reference ?? source), vaultPath: relative(await vaultRoot(path.dirname(file), this.root), source),
        width: size.width, height: size.height, bytes: bytes.length,
        licence: { code: "own", version: null, url: null, attribution: "", required: false },
        preview: previewOfBytes(bytes, type), absolute: source,
      };
    }
    return { id: "current", kind: "rewrite", current: true, title: "Current", text: element.markdown, source: "page", sourceLabel: "your note" };
  }

  // Vault pictures first: a bounded walk, filenames scored against the complaint, no index required.
  async swapVaultCandidates(query, file, name, skip) {
    const root = await vaultRoot(path.dirname(file), this.root);
    const files = await vaultImages(root, swapDefaults.searchResults + 4);
    const tokens = String(query ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 2).slice(0, 8);
    const scored = files.filter(item => item.absolute !== skip).map(item => {
      const haystack = item.rel.toLowerCase();
      const hits = tokens.filter(token => haystack.includes(token)).length;
      return { ...item, score: hits };
    }).filter(item => !tokens.length || item.score > 0).sort((left, right) => right.score - left.score || left.rel.localeCompare(right.rel));
    const candidates = [];
    for (const item of (scored.length ? scored : files.filter(row => row.absolute !== skip).sort((l, r) => l.rel.localeCompare(r.rel)))) {
      if (candidates.length >= swapDefaults.candidates - 1) break;
      if (item.size > imageDefaults.maxBytes) continue;
      const bytes = await readFile(item.absolute).catch(() => null);
      const type = bytes ? imageTypeOf(bytes) : null;
      const size = bytes ? orientationSize(imageDimensions(bytes)) : null;
      if (!bytes || !type || !size || Math.min(size.width, size.height) < swapDefaults.minEdge) continue;
      candidates.push({
        id: candidateId(name, item.rel, "vault"), kind: "find", source: "vault", sourceLabel: "your vault",
        title: item.name, vaultPath: item.rel, width: size.width, height: size.height, bytes: bytes.length,
        licence: { code: "own", version: null, url: null, attribution: "", required: false },
        preview: previewOfBytes(bytes, type), absolute: item.absolute,
      });
    }
    return candidates;
  }

  async swapHookCandidate(kind, element, file, complaint, hooks) {
    if (!hooks[kind === "enhance" ? "enhance" : "generate"]) {
      return { candidate: null, warning: { code: "HOOK_MISSING", message: `${kind === "enhance" ? "OMARKIE_ENHANCE" : "OMARKIE_IMAGEGEN"} is not configured.` } };
    }
    let input;
    if (kind === "enhance") {
      if (element.kind !== "image" && element.kind !== "embed") return { candidate: null, warning: { code: "UNSUPPORTED_KIND", message: "Only a picture can be enhanced." } };
      const reference = imageReferenceOf(element.markdown);
      input = reference ? await this.resolveImageReference(reference, file) : null;
      if (!input) return { candidate: null, warning: { code: "SOURCE_OFFLINE", message: "The picture file is missing from this vault." } };
    }
    const prompt = kind === "generate" ? (complaint || element.text).slice(0, 1_000) : undefined;
    const result = await runImageHook(kind === "enhance" ? "enhance" : "generate", { input, prompt, appData: this.appData });
    if (!result.ok) return { candidate: null, warning: { code: result.code, message: result.hint } };
    try {
      const size = orientationSize(imageDimensions(result.bytes));
      if (!size || Math.min(size.width, size.height) < swapDefaults.minEdge) {
        return { candidate: null, warning: { code: "CANDIDATE_TOO_SMALL", message: `The hook's picture is smaller than ${swapDefaults.minEdge} px.` } };
      }
      const stem = kind === "enhance" ? `${path.basename(input, path.extname(input))} sharpened` : "Generated picture";
      return { candidate: {
        id: candidateId(relative(this.root, file), stem, kind), kind, source: kind, sourceLabel: kind === "enhance" ? "enhanced on this machine" : "generated on this machine",
        title: stem, width: size.width, height: size.height, bytes: result.bytes.length, base64: result.bytes.toString("base64"),
        licence: { code: "local", version: null, url: null, attribution: "", required: false },
        operations: kind === "enhance" ? ["sharpened locally"] : ["generated locally"],
        preview: previewOfBytes(result.bytes, result.type),
      }, warning: null };
    } finally {
      await cleanHookResult(result);
    }
  }

  async swapOptions(request) {
    const { name, file, note, text, elements } = await this.swapContext(request);
    const element = this.swapElementOf(elements, request.element);
    const actions = swapActionsFor(element);
    if (!actions.length) throw Object.assign(new Error("This element cannot be swapped."), { code: "UNSUPPORTED_KIND" });
    const complaint = String(request.complaint ?? "").trim().slice(0, swapDefaults.complaintLimit);
    const root = await vaultRoot(path.dirname(file), this.root);
    const settings = await readGlassSettings(root, { appData: this.appData });
    const hooks = await hookState(this.appData);
    // A hook action exists only when the hook does, so the chips match what this machine can do.
    const usable = actions.filter(action => action !== "enhance" || hooks.enhance).filter(action => action !== "generate" || hooks.generate);
    const kind = swapActionList.includes(request.kind) && usable.includes(request.kind) ? request.kind : usable[0] ?? actions[0];
    const warnings = [];
    const found = [];
    const current = await this.swapCurrent(element, file, name);
    if (kind === "find") found.push(...await this.swapVaultCandidates(complaint || element.text, file, name, current?.absolute));
    if (kind === "enhance" || kind === "generate") {
      const { candidate, warning } = await this.swapHookCandidate(kind, element, file, complaint, hooks);
      if (candidate) found.push(candidate);
      if (warning) warnings.push(warning);
    }
    const online = onlineAllowed({ requested: request.online === true, neverOnline: settings.neverOnline });
    let searched = false;
    if (kind === "find" && online.allowed && complaint) {
      searched = true;
      // A results file keeps searches offline and deterministic on a machine or a test.
      const fixture = process.env.OMARKIE_SWAP_SEARCH?.trim();
      const fixtureResults = fixture
        ? { candidates: JSON.parse(await readFile(fixture, "utf8")).map(item => ({ ...item, source: item.source ?? "commons", online: true })), errors: [] }
        : null;
      const { candidates, errors } = fixtureResults ?? await searchOnline(complaint, { limit: 3 });
      for (const error of errors) warnings.push({ code: error.code, message: `${error.source}: ${error.message}` });
      for (const candidate of candidates) {
        const checked = candidateAllowed(candidate);
        if (!candidate.preview && typeof candidate.bytesBase64 === "string" && candidate.bytesBase64) {
          const bytes = Buffer.from(candidate.bytesBase64, "base64");
          candidate.preview = previewOfBytes(bytes, imageTypeOf(bytes));
        }
        const view = this.swapCandidateView(candidate, root, name);
        if (checked.ok) found.push(view);
        else warnings.push({ code: checked.code, message: `${view.title}: ${checked.hint}` });
      }
    }
    // An answer from the search the reader asked for outranks vault files the scan happened to find;
    // otherwise a handful of pictures beside the note crowds the result out of the cap.
    const ranked = [...found.filter(candidate => candidate.online === true), ...found.filter(candidate => candidate.online !== true)];
    const candidates = compareSet(current, ranked.slice(0, swapDefaults.candidates - (current ? 1 : 0)));
    return { ...this.describe(note, file), element: this.swapEcho(element, elements), actions, kind, complaint, hooks,
      online: { ...online, searched }, neverOnline: settings.neverOnline, candidates, warnings };
  }

  swapCandidateView(candidate, root, name) {
    const licence = normalLicence(candidate.licence);
    return { ...candidate, id: candidate.id ?? candidateId(name, candidate.sourceUrl ?? candidate.title ?? "", candidate.source ?? "web"),
      licence: licence ?? null, online: candidate.online === true, preview: candidate.preview ?? null };
  }

  async swapCandidateBytes(candidate, { neverOnline = false } = {}) {
    const inline = typeof candidate.base64 === "string" && candidate.base64 ? candidate.base64
      : typeof candidate.bytesBase64 === "string" && candidate.bytesBase64 ? candidate.bytesBase64 : null;
    if (inline) {
      const bytes = Buffer.from(inline, "base64");
      return { bytes, type: imageTypeOf(bytes) };
    }
    if (typeof candidate.vaultPath === "string" && candidate.vaultPath) {
      const clean = candidate.vaultPath.replace(/^\.\//, "");
      if (clean.startsWith("..") || path.isAbsolute(clean)) throw Object.assign(new Error("That vault picture is outside this vault."), { code: "ELEMENT_NOT_FOUND" });
      const bytes = await readFile(path.resolve(this.root, ...clean.split("/"))).catch(() => null);
      return bytes ? { bytes, type: imageTypeOf(bytes) } : null;
    }
    if (typeof candidate.downloadUrl === "string" && /^https?:\/\//i.test(candidate.downloadUrl)) {
      // A candidate can arrive from an agent, so the download is the one place this app still
      // reaches the network on its own: it needs the vault's consent and a known picture host
      // (never loopback or link-local metadata addresses), and a redirect must not move it.
      if (neverOnline) throw Object.assign(new Error("This vault never goes online."), { code: "SOURCE_OFFLINE" });
      let address;
      try { address = new URL(candidate.downloadUrl); } catch { address = null; }
      if (!address || address.username || address.password || !swapDownloadHosts().has(address.hostname.toLowerCase()))
        throw Object.assign(new Error(`Omarkie only downloads pictures from its own picture sources, not from ${address?.hostname ?? "that address"}.`), { code: "SOURCE_NOT_ALLOWED" });
      const response = await fetch(address, { signal: AbortSignal.timeout(20_000), redirect: "error", headers: { accept: "image/*", "user-agent": "omarkie-swap/1 (+local note app)" } });
      if (!response.ok) throw Object.assign(new Error(`The picture download failed (${response.status}).`), { code: "SOURCE_OFFLINE" });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > imageDefaults.maxBytes) throw Object.assign(new Error("The picture is too large."), { code: "OUTPUT_TOO_LARGE" });
      return { bytes, type: imageTypeOf(bytes) };
    }
    return null;
  }

  async swapAddMagnet(journal, fields, magnetId = newMagnetId()) {
    const values = validateMagnetFields(fields.kind, fields, false);
    for (const [field, value] of Object.entries(values))
      await this.appendRecord(journal, { op: "set", magnetId, field, value, hlc: this.clock.next(), device: this.deviceName });
    return magnetId;
  }

  async swapApply(request) {
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    const { name, file, note, journal, text, elements } = await this.swapContext(request);
    const element = this.swapElementOf(elements, request.element);
    const actions = swapActionsFor(element);
    if (!actions.length) throw Object.assign(new Error("This element cannot be swapped."), { code: "UNSUPPORTED_KIND" });
    const mode = request.mode === "replace" ? "replace" : "cover";
    const candidate = request.candidate && typeof request.candidate === "object" ? request.candidate : null;
    if (!candidate) throw Object.assign(new Error("Choose a candidate first."), { code: "VALIDATION_ERROR" });
    const checked = candidateAllowed(candidate);
    if (!checked.ok) throw Object.assign(new Error(checked.hint), { code: checked.code });
    const kind = swapActionList.includes(candidate.kind) ? candidate.kind : actions[0];
    const swapId = isSwapId(request.swapId) ? request.swapId : `sw-${randomBytes(6).toString("hex")}`;
    const at = this.now();
    const isPicture = candidate.kind !== "rewrite" && candidate.kind !== "redraw";
    const settings = await this.mergeSettingsFor(file, name);
    let bytes = null, type = null;
    if (isPicture) {
      const { neverOnline } = await readGlassSettings(settings.root, { appData: this.appData });
      const loaded = await this.swapCandidateBytes(candidate, { neverOnline });
      if (!loaded?.bytes?.length || !loaded.type) throw Object.assign(new Error("The candidate picture could not be read."), { code: "SOURCE_OFFLINE" });
      ({ bytes, type } = loaded);
    }
    const operations = Array.isArray(candidate.operations) ? candidate.operations : [];
    const citation = attributionText({ ...candidate, licence: normalLicence(candidate.licence) }, { accessed: at, operations });
    const eol = noteLineEnding(text);
    // A picture always lands in the vault's attachment folder first; the page only points at it.
    let attachment = null, mapping = null;
    if (isPicture) {
      const folder = this.attachmentDir(settings.root, settings.attachmentFolder);
      const taken = new Set(await readdir(folder).catch(() => []));
      const assetName = assetFile(candidate.title || candidate.name || "swap", extensionFor(type), taken);
      const assetPath = settings.attachmentFolder ? `${settings.attachmentFolder}/${assetName}` : assetName;
      const width = Math.round(Math.min(imageDefaults.maxW, Math.max(imageDefaults.minW, Number(candidate.width) || imageDefaults.w)));
      mapping = mergeLines("image", { name: candidate.title || assetName, w: width }, { settings, assetPath, assetName });
      attachment = { name: assetName, rel: assetPath, abs: path.join(folder, assetName), bytes };
    }
    let lines = isPicture
      ? replacementLines(candidate, { swapId, accessed: at, operations, imageMarkdown: mapping.lines[0] })
      : replacementLines(candidate, { swapId, accessed: at, operations });
    // A table cell is part of a row, not a block: write it as one inline cell and move the
    // footnote definition after the whole table, or the next cell and the table itself break.
    let target = element;
    if (element.kind === "table-cell") {
      const table = elements.find(item => item.kind === "table" && item.from <= element.from && element.to <= item.to);
      if (!table) throw Object.assign(new Error("That table cell is not inside a table."), { code: "UNSUPPORTED_KIND" });
      const inline = isPicture ? lines[0] : `${tableCellText(candidate.text)}${swapFootnoteRef(swapId)}`;
      const row = `${text.slice(table.from, element.from)}${inline}${text.slice(element.to, table.to)}`;
      lines = [...row.split(eol), "", lines.at(-1)];
      target = table;
    }
    const before = await readFile(file), beforeNote = decodeNote(before);
    // The candidate may have been fetched over the network since this element was read;
    // writing the diff built from that older text would revert whatever the editor saved.
    if (mode === "replace" && beforeNote.text !== text) {
      return { ...this.describe(note, file), stale: true, swapId, mode, footnote: citation,
        message: "The note changed while the change was being prepared; nothing was written." };
    }
    const diff = swapDiff(text, target, lines, eol);
    const baseHash = hashBytes(before);
    const buffer = encodeNote({ bom: beforeNote.bom, text: diff.next });
    if (request.dryRun === true) {
      return { ...this.describe(note, file), needsUser: true, swapId, mode, expectedHash: baseHash,
        candidate: this.swapCandidateView(candidate, settings.root, name),
        element: this.swapEcho(element, elements), diff: diff.rows, footnote: citation, attachment: attachment?.rel ?? null,
        message: "Preview only. Pass --accept to write it." };
    }
    if (mode === "replace" && request.approved !== true) {
      return { ...this.describe(note, file), needsUser: true, swapId, mode, expectedHash: baseHash,
        candidate: this.swapCandidateView(candidate, settings.root, name),
        element: this.swapEcho(element, elements), diff: diff.rows, footnote: citation, attachment: attachment?.rel ?? null,
        message: "Preview only. Press Accept to replace this element in the page." };
    }
    if (mode === "replace" && typeof request.expectedHash === "string" && request.expectedHash && request.expectedHash !== baseHash) {
      return { ...this.describe(note, file), stale: true, swapId, mode, diff: diff.rows, footnote: citation,
        message: "The note changed since the preview; nothing was written." };
    }
    const fresh = await readFile(file);
    if (hashBytes(fresh) !== baseHash) {
      return { ...this.describe(note, file), stale: true, swapId, mode, diff: diff.rows, footnote: citation,
        message: "The note changed since the preview; nothing was written." };
    }
    let magnetId = null, undoRel = null, assetWritten = false;
    if (mode === "replace") {
      undoRel = `assets/${path.basename(journal, ".jsonl")}/undo-${swapId}.md`;
      await mkdir(path.dirname(path.join(this.storeDir, ...undoRel.split("/"))), { recursive: true, mode: 0o700 });
      await writeBytesAtomic(path.join(this.storeDir, ...undoRel.split("/")), before);
      try {
        if (attachment) {
          await mkdir(path.dirname(attachment.abs), { recursive: true, mode: 0o700 });
          const existing = await readFile(attachment.abs).catch(error => { if (error.code === "ENOENT") return null; throw error; });
          if (existing && !existing.equals(attachment.bytes))
            throw Object.assign(new Error("A different picture already has that name; choose the candidate again."), { code: "NOTE_WRITE_CONFLICT" });
          if (!existing) { await writeBytesAtomic(attachment.abs, attachment.bytes); assetWritten = true; }
        }
        await writeBytesAtomic(file, buffer);
      } catch (error) {
        if (assetWritten && attachment) await unlink(attachment.abs).catch(() => {});
        throw error;
      }
    } else {
      const anchor = { version: 2, landmarks: [...(element.landmarks?.landmarks ?? [])] };
      let fields;
      if (isPicture) {
        const stored = await this.imageAsset({ file: journal, image: { base64: bytes.toString("base64"), name: candidate.title || "swap" }, width: 320 });
        fields = { ...stored, anchor, x: 0, y: 0, coverOf: element.id,
          source: { element: element.id, kind: element.kind, line: element.line, path: name } };
      } else {
        fields = { kind: "sticky", text: String(candidate.text ?? "").slice(0, swapDefaults.textLimit), color: stickyColors[0],
          anchor, x: 0, y: 0, w: 232, h: 168, folded: false,
          source: { element: element.id, kind: element.kind, line: element.line, path: name } };
      }
      magnetId = await this.swapAddMagnet(journal, fields);
    }
    await this.appendRecord(journal, { op: "swap", swapId, element: { id: element.id, kind: element.kind, line: element.line },
      mode, kind, candidateId: candidate.id ?? null, title: candidate.title ?? null, source: candidate.source ?? null,
      licence: normalLicence(candidate.licence), attribution: citation, ...(magnetId ? { magnetId } : {}),
      ...(attachment ? { attachment: attachment.rel } : {}), ...(undoRel ? { undo: undoRel } : {}),
      baseHash, afterHash: mode === "replace" ? hashBytes(buffer) : null, at: new Date(at).toISOString(),
      hlc: this.clock.next(), device: this.deviceName });
    await this.identify(name).catch(() => {});
    const replay = await this.readJournal(journal);
    const magnet = magnetId ? replay.magnets.get(magnetId) : null;
    this.notify();
    return { ...this.describe(note, file), swap: { swapId, mode, kind, elementId: element.id, title: candidate.title ?? null,
      attachment: attachment?.rel ?? null, magnetId, attribution: citation }, applied: true,
      diff: mode === "replace" ? diff.rows : null, magnet: magnet ? magnetViewFromMap(magnet) : null };
  }

  async swapRestore(request) {
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    const { name, file, note, journal } = await this.swapContext(request);
    const records = await this.swapRecords(journal);
    const latest = latestSwaps(records.applied);
    const record = request.swap
      ? records.applied.find(entry => entry.swapId === request.swap)
      : request.element ? latest.find(entry => entry.element?.id === request.element) : latest[0];
    if (!record) throw Object.assign(new Error("Nothing to restore on this note."), { code: "ELEMENT_NOT_FOUND" });
    if (record.mode === "replace") {
      if (!record.undo) throw new Error("The undo copy for that swap is missing.");
      const inside = path.relative(this.storeDir, path.resolve(this.storeDir, ...String(record.undo).split("/")));
      if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("The undo copy sits outside the glass store.");
      const bytes = await readFile(path.join(this.storeDir, ...record.undo.split("/"))).catch(error => {
        throw error.code === "ENOENT" ? new Error("The undo copy for that swap is missing.") : error;
      });
      const currentHash = hashBytes(await readFile(file));
      if (record.afterHash && currentHash !== record.afterHash && request.force !== true) {
        return { ...this.describe(note, file), undoStale: true, swap: record,
          message: "The note changed after the swap; press Undo again to restore it anyway." };
      }
      await writeBytesAtomic(file, bytes);
    }
    if (record.magnetId) {
      const replay = await this.readJournal(journal);
      const magnet = replay.magnets.get(record.magnetId);
      if (magnet && magnet.deleted?.active !== true)
        await this.appendRecord(journal, { op: "delete", magnetId: record.magnetId, hlc: this.clock.next(), device: this.deviceName });
    }
    await this.appendRecord(journal, { op: "swap-undo", swapId: record.swapId, hlc: this.clock.next(), device: this.deviceName });
    await this.identify(name).catch(() => {});
    this.notify();
    return { ...this.describe(note, file), restored: true, swap: record, noteUnchanged: record.mode === "cover" };
  }

  async swapPropose(request) {
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    const { name, file, note, journal, elements } = await this.swapContext(request);
    const element = this.swapElementOf(elements, request.element);
    if (!swapActionsFor(element).length) throw Object.assign(new Error("This element cannot be swapped."), { code: "UNSUPPORTED_KIND" });
    const input = Array.isArray(request.candidates) ? request.candidates : [];
    if (!input.length) throw new Error("Pass at least one candidate to propose.");
    const records = await this.swapRecords(journal);
    const now = this.now();
    const open = capProposals(records.proposals.map(entry => ({ ...entry, candidateId: entry.candidate?.id, title: entry.candidate?.title,
      dismissed: records.dismissed.has(entry.swapId), at: Date.parse(entry.at ?? 0) || 0 })), { now });
    const room = Math.max(0, Math.min(swapDefaults.proposalBatch, swapDefaults.proposalNote - open.length));
    const accepted = [], rejected = [];
    const seen = new Set(open.map(entry => entry.candidateId));
    for (const candidate of input) {
      if (accepted.length >= room) { rejected.push({ title: candidate?.title ?? null, code: "PROPOSAL_CAP", hint: "The proposal cap for this note is reached." }); continue; }
      const checked = candidateAllowed(candidate);
      if (!checked.ok) { rejected.push({ title: candidate?.title ?? null, code: checked.code, hint: checked.hint }); continue; }
      const view = this.swapCandidateView(candidate, this.root, name);
      if (seen.has(view.id)) { rejected.push({ title: view.title, code: "PROPOSAL_DUPLICATE", hint: "That candidate is already waiting." }); continue; }
      seen.add(view.id);
      const swapId = `sw-${randomBytes(6).toString("hex")}`;
      const stored = { ...view };
      delete stored.preview;
      // A local hook's picture has no vault path yet; keep its bytes so the card can still apply.
      if (stored.base64?.length && stored.base64.length < 2_500_000) stored.bytesBase64 = stored.base64;
      delete stored.base64;
      delete stored.absolute;
      await this.appendRecord(journal, { op: "swap-propose", swapId, element: { id: element.id, kind: element.kind, line: element.line },
        candidate: stored, at: new Date(now + accepted.length).toISOString(), hlc: this.clock.next(), device: this.deviceName });
      accepted.push({ swapId, candidate: view, at: new Date(now + accepted.length).toISOString() });
    }
    return { ...this.describe(note, file), element: this.swapEcho(element, elements), proposals: accepted, rejected, cap: swapDefaults.proposalBatch };
  }

  async swapDismiss(request) {
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    const { note, file, journal } = await this.swapContext(request);
    if (!isSwapId(request.swap)) throw new Error("Pass the proposal id to dismiss.");
    await this.appendRecord(journal, { op: "swap-dismiss", swapId: request.swap, hlc: this.clock.next(), device: this.deviceName });
    return { ...this.describe(note, file), dismissed: request.swap };
  }

  async swapState(request) {
    if (!this.initialized) await this.initialize();
    const { name, file, note, journal } = await this.swapContext(request);
    const records = await this.swapRecords(journal);
    const root = await vaultRoot(path.dirname(file), this.root);
    const settings = await readGlassSettings(root, { appData: this.appData });
    const proposals = capProposals(records.proposals.map(entry => ({ ...entry, candidateId: entry.candidate?.id, title: entry.candidate?.title,
      dismissed: records.dismissed.has(entry.swapId), at: Date.parse(entry.at ?? 0) || 0 })), { now: this.now() });
    return { ...this.describe(note, file), swaps: latestSwaps(records.applied), proposals, hooks: await hookState(this.appData),
      neverOnline: settings.neverOnline, destinations: swapDestinations };
  }

  async swapVoice(request) {
    this.assertReady();
    const wav = typeof request.audio === "string" ? Buffer.from(request.audio, "base64") : null;
    const extension = request.extension === "webm" || request.extension === "ogg" ? request.extension : "wav";
    return transcribe(wav, { appData: this.appData, extension });
  }

  // Layers exist per note: the panel reads their state with the current magnet counts.
  async layers(request) {
    this.assertReady();
    const { note: name } = await this.validateNote(request.note);
    if (!this.initialized && await this.existingStore()) await this.initialize();
    const empty = { note: name, id: null, journal: null, layers: layerStates(), counts: layerCounts([]), initialized: false, pending: this.pending.length };
    if (!this.initialized) return empty;
    const note = this.notesByPath.get(name);
    if (!note) return empty;
    const file = this.journalFor(note);
    const replay = await this.readJournal(file);
    return { ...this.describe(note, file), layers: layerStates(replay.layers),
      counts: layerCounts(visibleMagnets(replay.magnets)), pending: this.pending.length };
  }

  // One journal line per changed field, so two devices merging journals keep the newest value alone.
  async layer(request) {
    this.assertWritable();
    if (!validGlassLayer(request.layer)) throw new Error("Layer must be one of: ink, notes, media, cards, comments.");
    const patch = layerPatch(request);
    const note = await this.identify(request.note);
    const file = this.journalFor(note);
    for (const [field, value] of Object.entries(patch))
      await this.appendRecord(file, { op: "layer", layer: request.layer, field, value, hlc: this.clock.next(), device: this.deviceName });
    const replay = await this.readJournal(file);
    this.notify();
    return { ...this.describe(note, file), layer: request.layer, changed: Object.keys(patch), layers: layerStates(replay.layers),
      counts: layerCounts(visibleMagnets(replay.magnets)), pending: this.pending.length, saved: this.pending.length === 0 };
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
    if (request.mode === "eval") {
      if (fields.card !== "calc") throw new Error("Only a calculator card evaluates.");
      const values = request.values && typeof request.values === "object" && !Array.isArray(request.values) ? request.values : {};
      return { ...this.describe(note, file), magnet: magnet.id, card: "calc",
        evaluation: await evaluateCalc(fields, values) };
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

  // Save as note is the clip's only path into the vault: one new Markdown file, never an edit.
  async clipSave(request) {
    this.assertReady();
    const { note: name } = await this.validateNote(request.note);
    if (!this.initialized && await this.existingStore()) await this.initialize();
    if (!this.initialized) throw new Error("Glass is not initialized in this vault.");
    this.assertWritable();
    const note = this.notesByPath.get(name);
    if (!note) throw new Error("Glass note not found.");
    const file = this.journalFor(note);
    const replay = await this.readJournal(file), magnet = replay.magnets.get(request.magnet);
    if (!magnet || magnet.deleted?.active) throw new Error("Glass clip not found.");
    const fields = magnetViewFromMap(magnet).fields;
    if (fields.kind !== "clip") throw new Error("That magnet is not a clip.");
    const previous = typeof fields.notePath === "string" ? fields.notePath : "";
    // The field is a stored vault path; a crafted `../x.md` must not resolve outside the vault.
    const inside = previous && !path.isAbsolute(previous)
      && previous.split("/").every(part => part && part !== "." && part !== ".." && !part.startsWith("."));
    if (inside) {
      const existing = path.join(this.root, ...previous.split("/"));
      const metadata = await info(existing).catch(() => null);
      if (metadata?.isFile() && !metadata.isSymbolicLink()) return { ...this.describe(note, file), magnet: magnet.id,
        path: previous, name: path.basename(previous, ".md"), bytes: metadata.size, created: false };
    }
    const text = typeof fields.text === "string" ? fields.text : "";
    if (!text.trim()) throw new Error("Write something in the clip before saving it as a note.");
    const stem = sanitizeTitle(sheetTitle(fields)) || "Clipped page";
    const written = await this.writeCardPage(name, stem, text.endsWith("\n") ? text : `${text}\n`);
    const savedAt = new Date().toISOString();
    for (const [field, value] of Object.entries({ notePath: written.path, savedAt }))
      await this.appendRecord(file, { op: "set", magnetId: magnet.id, field, value, hlc: this.clock.next(), device: this.deviceName });
    const next = await this.readJournal(file);
    return { ...this.describe(note, file), magnet: magnetViewFromMap(next.magnets.get(magnet.id)), path: written.path,
      name: written.name, bytes: written.bytes, created: true };
  }

  // The renderer records; the service owns the immutable audio copy and the transcript magnet.
  async voiceMemo(request) {
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    const note = await this.identify(request.note);
    const file = this.journalFor(note);
    const audio = request.audio;
    if (!audio || typeof audio !== "object" || Array.isArray(audio)) throw new Error("A voice memo needs its recorded audio.");
    if (!voiceMimes.includes(audio.mime)) throw new Error(`Voice audio must be one of: ${voiceMimes.join(", ")}.`);
    if (typeof audio.base64 !== "string" || !audio.base64) throw new Error("A voice memo needs its recorded audio.");
    const bytes = Buffer.from(audio.base64, "base64");
    if (!bytes.length) throw new Error("A voice memo needs its recorded audio.");
    if (bytes.length > voiceDefaults.memoBytes) throw new Error("That recording is too large to store.");
    if (audio.mime === "audio/wav" && !validVoiceWav(bytes))
      throw new Error("A WAV memo must be 16 kHz mono PCM signed 16-bit.");
    const directory = this.assetDir(file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const name = `voice-${hashBytes(bytes).slice(0, 16)}.${voiceExtensions[audio.mime]}`;
    if (!await info(path.join(directory, name))) await writeBytesAtomic(path.join(directory, name), bytes);
    const stored = await this.add({ note: request.note, magnet: request.magnet, fields: {
      kind: "voice", text: cleanTranscript(request.text), audio: name, mime: audio.mime,
      duration: Number(request.durationMs) || 0, lang: request.lang ?? "auto",
      ...(request.segments ? { segments: request.segments } : {}),
      anchor: request.anchor, x: request.x ?? 0, y: request.y ?? 0, w: request.w ?? 320, h: request.h ?? 64,
    } });
    return { ...stored, audio: name, mime: audio.mime, bytes: bytes.length };
  }

  // Lecture mode writes exactly one new note, on Save, then pins its chapter timestamps.
  async voiceLecture(request) {
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    const { note: source } = await this.validateNote(request.note);
    const segments = validSpeakerSegments(request.transcript);
    if (!segments?.length) throw new Error("A lecture needs at least one transcribed segment.");
    const marks = Array.isArray(request.marks) ? request.marks.slice(0, voiceDefaults.markLimit) : [];
    const chapters = chapterMarks(segments, marks);
    const at = new Date();
    const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${String(at.getHours()).padStart(2, "0")}${String(at.getMinutes()).padStart(2, "0")}`;
    const stem = sanitizeTitle(`Lecture ${stamp}`);
    const paragraphs = segments.map(segment => `${timestampLabel(segment.startMs)} ${segment.text}`);
    const body = `---\ntype: Reference\ntitle: ${JSON.stringify(stem)}\ntags: [lecture]\ngenerated: { by: "process:voice", at: ${JSON.stringify(at.toISOString())} }\n---\n\n# ${stem}\n\n## Transcript\n\n${paragraphs.join("\n\n")}\n`;
    if (Buffer.byteLength(body) > voiceDefaults.transcriptBytes) throw new Error("That lecture transcript is too large for one note.");
    const written = await this.writeCardPage(source, stem, body);
    const note = await this.identify(written.path);
    const file = this.journalFor(note);
    const magnets = [];
    for (const chapter of chapters) {
      let index = 0;
      for (let cursor = 0; cursor < segments.length; cursor += 1) if (segments[cursor].startMs <= chapter.atMs) index = cursor;
      const paragraph = paragraphs[index];
      if (!paragraph) continue;
      const field = { kind: "sticky", text: chapter.label, color: "blue",
        anchor: { landmarks: [{ kind: "block", block: paragraph, headings: ["Transcript"] }] },
        x: 336 + (magnets.length % 3) * 24, y: 0, w: 232, h: 96, folded: false };
      const values = validateMagnetFields("sticky", field, false);
      const magnetId = newMagnetId();
      for (const [name, value] of Object.entries(values))
        await this.appendRecord(file, { op: "set", magnetId, field: name, value, hlc: this.clock.next(), device: this.deviceName });
      magnets.push(magnetId);
    }
    this.notify();
    return { note: written.path, title: stem, bytes: written.bytes, segments: segments.length, chapters: magnets.length, magnets };
  }

  status() {
    return { version: glassVersion, initialized: this.initialized === true, vaultId: this.vaultId ?? null, mode: this.mode ?? null, readOnly: this.readOnly === true,
      readOnlyReason: this.readOnly ? this.readOnlyReason ?? null : null, root: this.root,
      location: this.mode === "inside" ? ".omarkie" : this.storeDir, notes: this.notesById.size,
      pending: this.pending.length, error: this.error ? { ...this.error } : null, lastSavedAt: this.lastSavedAt ?? null,
      lock: this.lockOwner ? { host: this.lockOwner.host, pid: this.lockOwner.pid } : null, bridge: this.bridgeState ?? null,
      index: this.indexStatus ?? null, bring: this.offer ?? null, lost: this.lost ?? [],
      clock: this.clockReport() };
  }

  // What the newest clock this vault has seen says about this machine's wall time.
  clockReport() {
    const aheadMs = Math.max(0, (this.clock?.top?.t ?? 0) - this.now());
    return { aheadMs, behindByOurClock: aheadMs > 0, unknown: aheadMs > clockSkewLimit };
  }

  // A board is one Media-layer magnet whose Excalidraw scene lives in `.omarkie/assets/boards`.
  // Load and save are separate so the Excalidraw chunk only mounts when a person opens a board.
  async board(request) {
    if (!this.initialized) await this.initialize();
    this.assertWritable();
    const note = await this.identify(request.note);
    const file = this.journalFor(note);
    const mode = request.mode ?? "add";
    if (!["add", "load", "save"].includes(mode)) throw new Error("Board mode must be add, load or save.");
    const replay = await this.readJournal(file);
    if (mode === "add") {
      if (layerStates(replay.layers).media.locked) throw new Error("The Media layer is locked. Unlock it before adding a board.");
      const magnetId = request.magnet ?? newMagnetId();
      if (typeof magnetId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(magnetId)) throw new Error("Use a short board id of letters, digits, _ or -.");
      const asset = this.boardAssetPath(magnetId);
      await mkdir(path.dirname(asset.absolute), { recursive: true, mode: 0o700 });
      await writeIfMissing(asset.absolute, `${JSON.stringify(blankBoard(), null, 2)}\n`);
      const fields = {
        kind: "board",
        layer: "media",
        asset: asset.relative,
        name: typeof request.name === "string" && request.name.trim() ? request.name.trim().slice(0, 120) : "Board",
        title: typeof request.title === "string" && request.title.trim() ? request.title.trim().slice(0, 120) : "Board",
      };
      if (request.anchor !== undefined) fields.anchor = request.anchor;
      for (const key of ["x", "y", "w", "h"]) if (Number.isFinite(request[key])) fields[key] = request[key];
      const added = await this.add({ note: note.path, magnet: magnetId, fields });
      return { ...added, asset: asset.relative, scene: blankBoard() };
    }
    const { note: name, magnet } = await this.boardMagnet(replay, request.magnet);
    const { absolute, relative: asset } = this.boardAssetPath(magnet.id);
    if (mode === "load") {
      const scene = await this.readBoard(absolute);
      return { ...this.describe(note, file), magnet: magnetViewFromMap(magnet), asset, ...scene };
    }
    const scene = validBoardScene(request.scene);
    const text = `${JSON.stringify(scene, null, 2)}\n`;
    if (Buffer.byteLength(text) > boardLimit) throw new Error("A board is limited to 16 MB. Split it into smaller boards.");
    await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    await writeFileAtomic(absolute, text);
    return { ...this.describe(note, file), magnet: magnetViewFromMap(magnet), asset, bytes: Buffer.byteLength(text), savedAt: new Date().toISOString() };
  }

  async boardMagnet(replay, id) {
    if (typeof id !== "string" || !id.trim()) throw new Error("--magnet is required for a board.");
    const magnet = replay.magnets.get(id);
    if (!magnet || magnet.deleted?.active) throw new Error("Board not found.");
    if (magnetViewFromMap(magnet).fields.kind !== "board") throw new Error("That magnet is not a board.");
    return { magnet };
  }

  boardAssetPath(id) {
    const relativePath = `.omarkie/assets/boards/${id}.excalidraw.json`;
    const absolute = path.join(this.root, ...relativePath.split("/"));
    return { relative: relativePath, absolute };
  }

  async readBoard(absolute) {
    let text;
    try {
      text = await readLimited(absolute, boardLimit);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { scene: blankBoard(), corrupt: false, missing: true };
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.elements)) throw new Error("Not an Excalidraw scene.");
      return { scene: validBoardScene(parsed), corrupt: false, missing: false };
    } catch {
      // Keep the unreadable bytes beside the board; the blank scene only becomes the new file on save.
      const backup = `${absolute}.corrupt-${Date.now()}`;
      await copyFile(absolute, backup).catch(() => {});
      return { scene: blankBoard(), corrupt: true, missing: false };
    }
  }

  async request(input) {
    if (!input || typeof input !== "object" || typeof input.action !== "string") throw new Error("Invalid Glass request.");
    if (input.action === "status") return this.status();
    if (input.action === "flush") return this.initialized ? this.flushPending() : this.status();
    if (input.action === "board") return this.board(input);
    if (["map", "find", "bring", "finder", "reindex"].includes(input.action)) {
      if (!this.sync) throw new Error("The vault index is not running. Open the folder in Omarkie first.");
      return this.sync[input.action](input);
    }
    if (!["add", "set", "delete", "restore", "list", "show", "asset", "asset-display", "card", "clip-save", "voice-memo", "voice-lecture",
      "layers", "layer", "board", "merge-preview", "merge-accept", "merge-undo", "merge-history", "lift-up", "timeline", "scrub", "ocr",
      "srs-due", "srs-card", "srs-answer", "srs-review", "study-state", "study-set",
      "swap-options", "swap-apply", "swap-restore", "swap-propose", "swap-dismiss", "swap-state", "swap-settings", "swap-voice"].includes(input.action)) throw new Error("Unknown Glass action.");
    if (input.action === "swap-voice") return this.swapVoice(input);
    if (input.action === "srs-due") return this.srsDue();
    if (input.action === "srs-review") return this.srsReview(input);
    if (typeof input.note !== "string" || !input.note.trim()) throw new Error("--note is required.");
    if (input.action === "srs-card") return this.srsCard(input);
    if (input.action === "srs-answer") return this.srsAnswer(input);
    if (input.action === "study-state") return this.studyState(input);
    if (input.action === "study-set") return this.studySet(input);
    if (["set", "delete", "restore", "asset", "asset-display", "card", "clip-save", "merge-preview", "merge-accept"].includes(input.action) && (typeof input.magnet !== "string" || !input.magnet.trim())) throw new Error("--magnet is required.");
    if (input.action === "clip-save") return this.clipSave(input);
    if (input.action === "voice-memo") return this.voiceMemo(input);
    if (input.action === "voice-lecture") return this.voiceLecture(input);
    if (input.action === "merge-preview") return this.mergePreview(input);
    if (input.action === "merge-accept") return this.mergeAccept(input);
    if (input.action === "merge-undo") return this.mergeUndo(input);
    if (input.action === "merge-history") return this.mergeHistory(input);
    if (input.action === "lift-up") return this.liftUp(input);
    if (input.action === "swap-options") return this.swapOptions(input);
    if (input.action === "swap-apply") return this.swapApply(input);
    if (input.action === "swap-restore") return this.swapRestore(input);
    if (input.action === "swap-propose") return this.swapPropose(input);
    if (input.action === "swap-dismiss") return this.swapDismiss(input);
    if (input.action === "swap-state") return this.swapState(input);
    if (input.action === "swap-settings") return this.swapSettings(input);
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

// The last newline-terminated offset, or null when a read came back empty because the file shrank
// under the probe. A zero-length read must never make the walk stand still or conclude "0".
export async function lastCompleteOffset(handle, size) {
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
    if (!probe.bytesRead) return null;
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

const voiceFieldNames = new Set(["kind", "text", "audio", "mime", "duration", "lang", "segments", "anchor", "x", "y", "w", "h"]);
const voiceExtensions = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a" };

// A voice memo is the audio plus its transcript; the audio is an immutable file in assets/.
export function voiceFields(fields, partial = false) {
  const values = {};
  for (const [field, value] of Object.entries(fields)) {
    if (!voiceFieldNames.has(field)) throw new Error(`Unknown voice field: ${field}.`);
    if (field === "kind") {
      if (value !== "voice") throw new Error("A voice memo keeps its kind.");
      values.kind = "voice";
    } else if (field === "text") {
      if (typeof value !== "string" || value.length > voiceDefaults.textLimit || value.includes("\u0000")) throw new Error("A voice transcript must be text up to 20,000 characters.");
      values.text = value;
    } else if (field === "audio") {
      if (typeof value !== "string" || !value || /[/\\]/.test(value) || value.length > 200) throw new Error("Voice audio must be a plain file name.");
      values.audio = value;
    } else if (field === "mime") {
      if (!voiceMimes.includes(value)) throw new Error(`Voice audio must be one of: ${voiceMimes.join(", ")}.`);
      values.mime = value;
    } else if (field === "duration") {
      if (!finite(value, 0, voiceDefaults.maxSeconds * 1000)) throw new Error("A voice duration must be milliseconds within the recording limit.");
      values.duration = Math.round(value);
    } else if (field === "lang") {
      if (!validVoiceLanguage(value)) throw new Error("A voice language must be a BCP-47 tag or auto.");
      values.lang = value;
    } else if (field === "segments") {
      if (value === null) { values.segments = null; continue; }
      const segments = validSpeakerSegments(value);
      if (!segments) throw new Error("Voice segments need ascending start/end milliseconds and text.");
      values.segments = segments;
    } else if (field === "anchor") {
      if (!stickyAnchor(value)) throw new Error("A voice memo needs one block anchor with its heading path.");
      values.anchor = value;
    } else {
      const limits = field === "w" ? [72, 4000] : field === "h" ? [48, 4000] : [-200_000, 200_000];
      if (!finite(value, limits[0], limits[1])) throw new Error(`Voice ${field} must be a number between ${limits[0]} and ${limits[1]}.`);
      values[field] = Math.round(value);
    }
  }
  if (!partial) {
    if (typeof values.text !== "string") throw new Error("A voice memo needs its transcript text.");
    if (!values.audio || !values.mime) throw new Error("A voice memo needs the recorded audio.");
    if (!values.anchor) throw new Error("A voice memo needs an anchor to its paragraph.");
    values.lang ??= "auto";
    values.duration ??= 0;
    values.x ??= 0;
    values.y ??= 0;
    values.w ??= 320;
    values.h ??= 64;
  }
  return values;
}

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

// A calculator only saves when maths can read its formula and every unit.
async function checkCardDefinition(fields) {
  if (fields?.card !== "calc" || !fields.formula || !fields.unit || !fields.inputs?.length) return;
  await assertCalcDefinition({ formula: fields.formula, inputs: fields.inputs, unit: fields.unit });
}

const boardLimit = 16 * 1024 * 1024;

function blankBoard() {
  return { type: "excalidraw", version: 2, source: "omarkie", elements: [], appState: { gridSize: 20, gridModeEnabled: true }, files: {} };
}

// Excalidraw scenes are data only: elements, view state and embedded files. Collaborator maps and
// callbacks never enter the vault.
function validBoardScene(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !Array.isArray(input.elements)) throw new Error("A board needs an Excalidraw scene.");
  if (input.elements.length > 10_000) throw new Error("A board is limited to 10,000 elements.");
  if (input.appState !== undefined && (typeof input.appState !== "object" || input.appState === null || Array.isArray(input.appState))) throw new Error("Board appState must be an object.");
  if (input.files !== undefined && (typeof input.files !== "object" || input.files === null || Array.isArray(input.files))) throw new Error("Board files must be an object.");
  const appState = {};
  for (const key of ["viewBackgroundColor", "gridSize", "gridModeEnabled", "theme", "currentItemStrokeColor", "currentItemBackgroundColor", "currentItemFontFamily", "currentItemFontSize", "currentItemStrokeWidth", "currentItemStrokeStyle", "currentItemRoughness", "currentItemOpacity", "currentItemFillStyle", "currentItemStrokeSharpness", "currentItemStartArrowhead", "currentItemEndArrowhead", "zoom", "scrollX", "scrollY", "selectedElementIds"])
    if (input.appState?.[key] !== undefined) appState[key] = input.appState[key];
  const files = {};
  for (const [key, file] of Object.entries(input.files ?? {})) {
    if (!file || typeof file !== "object" || typeof file.dataURL !== "string" || !file.dataURL.startsWith("data:")) continue;
    files[key] = { id: file.id, mimeType: file.mimeType, dataURL: file.dataURL, created: file.created };
  }
  return { type: "excalidraw", version: 2, source: "omarkie", elements: input.elements, appState, files };
}

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
  if (kind === "voice") return voiceFields(partial ? fields : { ...fields, kind: "voice" }, partial);
  if (kind === "sticker") return stickerFields(partial ? fields : { ...fields, kind: "sticker" }, partial);
  if (kind === "arrow") return arrowFields(partial ? fields : { ...fields, kind: "arrow" }, partial);
  if (kind === "label") return labelFields(partial ? fields : { ...fields, kind: "label" }, partial);
  if (kind === "compare") {
    const values = validCompareFields({ ...fields, ...(partial ? {} : { kind: "compare", layer: "compare" }) }, { partial });
    if (!values) throw new Error("A compare card needs two different pictures, a value 0-100, a direction, labels and a box.");
    return values;
  }
  if (kind === "trace" || kind === "sheet-label" || kind === "measure") {
    if (partial) throw new Error("A visual mark keeps its geometry; delete it and add a new one.");
    const values = kind === "trace" ? validTraceFields({ ...fields, kind: "trace", layer: "trace" })
      : kind === "sheet-label" ? validSheetLabelFields({ ...fields, kind: "sheet-label", layer: "trace" })
        : validMeasureFields({ ...fields, kind: "measure", layer: "measure" });
    if (!values) throw new Error(kind === "trace" ? "A tracing stroke needs a picture, a sheet, a tool, a width and 2-4,000 points."
      : kind === "sheet-label" ? "A sheet label needs a picture, a sheet, a point, text and a label size."
        : "A measure needs a picture, a type, and two or three points.");
    return values;
  }
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
      if (values.card === "calc") {
        if (!values.formula?.trim()) throw new Error("A calculator card needs a formula.");
        if (!values.inputs?.length) throw new Error("A calculator card needs its inputs.");
        if (!values.unit) throw new Error("A calculator card needs an output unit.");
        if (!values.citation?.trim()) throw new Error("A calculator card needs a citation.");
        values.precision ??= calcLimits.defaultPrecision;
      }
      if (values.card === "flow") {
        if (!values.flow) throw new Error("A flow card needs its decision steps.");
        if (!values.citation?.trim()) throw new Error("A flow card needs a citation.");
      }
      values.proposed ??= false;
    }
    return values;
  }
  if (kind === "clip") return clipFieldValues(partial ? fields : { ...fields, kind: "clip" }, partial);
  if (kind === "extra-page") return extraPageFieldValues(partial ? fields : { ...fields, kind: "extra-page" }, partial);
  if (kind === "cutout") return cutoutFieldValues(partial ? fields : { ...fields, kind: "cutout" }, partial);
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

// One table cell holds inline content only: escape its pipe separators and keep line breaks inline.
function tableCellText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").split("\n").map(line => line.trim()).filter(Boolean)
    .join("<br>").replace(/\|/g, "\\|");
}

const readme = `# Omarkie glass
Your notes are untouched; glass lives in this folder.
- \`glass/\` — one JSONL journal per note that has glass. Each line carries a deterministic \`opId\`.
- \`assets/\` — glass images, one folder per note.
- \`notes.jsonl\` — note id, vault-relative path and fingerprint.
- \`study.jsonl\` — spaced-repetition cards, their answers, exam mode and hidden labels.
- \`settings.json\` — vault id and storage mode.
- \`writer.lock\` — present and owned while one Omarkie instance writes; a second instance opens read-only.
- \`.gitattributes\` — \`*.jsonl merge=union\`, so git keeps every journal line; Omarkie dedupes by \`opId\` on read.
- \`README.md\` — this map.
- Secrets never live here. A sync token belongs in the OS keychain; this folder syncs to every device and backup.
`;
