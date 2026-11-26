// G18: write the export as new files; the note and .omarkie/ are read only here.
// Both the app (IPC) and omarkie-axi call this module, so one rule decides every byte written.
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { glassFileName, replayJournalText, replayNotesText, sanitizeTitle, visibleMagnets, glassVersion } from "../shared/glass-core.mjs";
import { buildMarkdownExport, glassExportModes, glassExportTargets } from "../shared/glass-export.mjs";

const markdown = /\.(?:md|markdown|mdown)$/i;
const missing = error => { if (error.code !== "ENOENT") throw error; return null; };
const info = file => lstat(file).catch(missing);

async function readJson(file) {
  const text = await readFile(file, "utf8").catch(missing);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Electron keeps user data under the app name set in main.mjs, so an outside store lives beside
// the app's own files rather than a guessed lowercase folder. OMARKIE_DATA_DIR wins when set.
function dataDir() {
  if (process.env.OMARKIE_DATA_DIR) return process.env.OMARKIE_DATA_DIR;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Omarkie");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Omarkie");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Omarkie");
}

const vaultIdPattern = /^[a-zA-Z0-9-]{8,64}$/;
const storeAt = (root, directory) => ({ root, directory, notes: path.join(directory, "notes.jsonl"),
  glass: path.join(directory, "glass"), assets: path.join(directory, "assets") });

// The glass store is inside the vault unless settings.json says it lives in app data. A read-only
// vault has no settings.json at all; the app only remembers that store in its registry.
export async function glassStore(root, { appData } = {}) {
  const inside = path.join(root, ".omarkie");
  const data = appData || dataDir();
  const settings = await readJson(path.join(inside, "settings.json"));
  if (typeof settings?.vaultId === "string" && vaultIdPattern.test(settings.vaultId)) {
    return storeAt(root, settings.mode === "outside" ? path.join(data, "glass-vaults", settings.vaultId) : inside);
  }
  const registry = await readJson(path.join(data, "glass-vaults", "roots.json"));
  const remembered = registry?.[root];
  if (remembered?.mode === "outside" && typeof remembered.vaultId === "string" && vaultIdPattern.test(remembered.vaultId)) {
    const directory = path.join(data, "glass-vaults", remembered.vaultId);
    if (await readJson(path.join(directory, "settings.json"))) return storeAt(root, directory);
  }
  return storeAt(root, inside);
}

async function noteRecord(notesFile, noteName) {
  const text = await readFile(notesFile, "utf8").catch(() => "");
  if (!text) return null;
  // The app keeps the newest record for a path, so the reader exports the journal it shows.
  return [...replayNotesText(text).notes.values()].reverse().find(record => record.path === noteName) ?? null;
}

async function journalFor(directory, record) {
  if (!record) return null;
  const names = await readdir(directory).catch(() => []);
  return names.find(name => name.endsWith(` ~${record.id}.jsonl`)) ?? null;
}

async function readLayer(directory, notesFile, assetsRoot, noteName) {
  const record = await noteRecord(notesFile, noteName);
  const journalName = await journalFor(directory, record);
  if (!journalName) return { record: null, magnets: [], journal: null, assets: null, journalName: null };
  const journal = path.join(directory, journalName);
  const replay = replayJournalText(await readFile(journal, "utf8").catch(() => ""));
  return { record, magnets: visibleMagnets(replay.magnets), journal,
    assets: path.join(assetsRoot, path.basename(journalName, ".jsonl")), journalName };
}

export async function glassForNote(root, noteName, options = {}) {
  const store = await glassStore(root, options);
  return { store, ...(await readLayer(store.glass, store.notes, store.assets, noteName)) };
}

// Someone else's journal, synced under .omarkie/share with the same layout:
// notes.jsonl, glass/<title> ~<id>.jsonl and assets/<title> ~<id>/.
export async function sharedGlassForNote(root, noteName, options = {}) {
  const store = await glassStore(root, options);
  const share = path.join(root, ".omarkie", "share");
  return { store, ...(await readLayer(path.join(share, "glass"), path.join(share, "notes.jsonl"), path.join(share, "assets"), noteName)) };
}

function safeAssetName(value, fallback) {
  const name = String(value ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "-").replace(/^\.+/, "").trim().slice(0, 96);
  return name || fallback;
}

function uniqueName(name, taken) {
  let candidate = name, counter = 1;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name, extension = dot > 0 ? name.slice(dot) : "";
  while (taken.has(candidate.toLowerCase())) { counter += 1; candidate = `${base}-${counter}${extension}`; }
  taken.add(candidate.toLowerCase());
  return candidate;
}

// One image magnet: the light display copy when it exists, else the original.
async function imageAsset(reader, taken, magnet) {
  const wanted = magnet.fields?.display ?? magnet.fields?.asset;
  if (typeof wanted !== "string" || !wanted || /[/\\]/.test(wanted)) return null;
  const source = path.join(reader.assets, wanted);
  const metadata = await info(source);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) return null;
  const name = uniqueName(safeAssetName(magnet.fields?.name || wanted, wanted), taken);
  return { name, from: source };
}

async function writeAtomic(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.partial`);
  try { await writeFile(temporary, bytes); await rename(temporary, file); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

// Page pictures travel with the bundle in vault-relative folders, so an import can put them back.
function pageLinks(source) {
  const matches = [...String(source).matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))\)/g)];
  return matches.map(match => decodeURIComponent(match[1] ?? match[2] ?? ""))
    .filter(link => link && !/^[a-z][a-z0-9+.-]*:/i.test(link) && !link.startsWith("/"));
}

async function copyPageImages(root, noteDir, source, outDir, copied) {
  for (const link of pageLinks(source)) {
    // Resolve symlinks first: a folder inside the vault can point at anything on the disk.
    const from = await realpath(path.resolve(noteDir, link)).catch(() => null);
    if (!from) continue;
    const inside = path.relative(root, from);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) continue;
    const metadata = await info(from).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) continue;
    const to = path.join(outDir, ...inside.split("/"));
    if (copied.has(to)) continue;
    copied.add(to);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

// The deepest folder that already exists decides where a write lands: a symlinked subfolder
// would otherwise let a bundle's link write outside the vault.
async function existingParent(root, file) {
  for (let current = path.dirname(file);; current = path.dirname(current)) {
    if (await info(current).catch(() => null)) {
      const actual = await realpath(current).catch(() => null);
      if (!actual) return null;
      const inside = path.relative(root, actual);
      return inside.startsWith("..") || path.isAbsolute(inside) ? null : actual;
    }
    if (current === path.dirname(current)) return null;
  }
}

// Only a missing picture is copied back: an import never replaces a file the vault already holds.
async function restorePageImages(root, noteFile, bundle, source) {
  const store = path.join(root, ".omarkie");
  for (const link of pageLinks(source)) {
    const to = path.resolve(path.dirname(noteFile), link);
    const inside = path.relative(root, to);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) continue;
    if (inside.split(path.sep)[0] === ".omarkie") continue;
    if (await info(to).catch(() => null)) continue;
    const parent = await existingParent(root, to);
    if (!parent || parent === store || parent.startsWith(`${store}${path.sep}`)) continue;
    // A bundle that links a folder somewhere else would read files it was never given.
    const from = await realpath(path.join(bundle, ...inside.split(path.sep))).catch(() => null);
    if (!from) continue;
    const reached = path.relative(bundle, from);
    if (!reached || reached.startsWith("..") || path.isAbsolute(reached)) continue;
    const metadata = await info(from).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) continue;
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

async function resolveNote(root, note) {
  if (typeof note !== "string" || !note.trim() || path.isAbsolute(note) || /[\u0000\\]/.test(note)) throw new Error("Use a vault-relative Markdown path.");
  const file = path.join(root, ...note.split("/"));
  const metadata = await info(file);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || !markdown.test(note)) throw new Error("Note not found in this vault.");
  const actual = await realpath(file);
  const inside = path.relative(root, actual);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("The note is outside the vault.");
  return { file: actual, note: inside.split(path.sep).join("/") };
}

function checksum(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// An export only ever writes new files beside the vault: never the note it copies, never the glass store.
async function exportTarget(out, root, noteFile) {
  const target = path.resolve(out);
  const parent = await realpath(path.dirname(target)).catch(() => path.dirname(target));
  const absolute = path.join(parent, path.basename(target));
  if (absolute === noteFile) throw new Error("Choose another name; an export never overwrites the note it copies.");
  const inside = path.relative(path.join(root, ".omarkie"), absolute);
  if (!inside.startsWith("..") && !path.isAbsolute(inside)) throw new Error("An export cannot write inside the glass store.");
  return absolute;
}

function bundleNotePath(root, note) {
  if (typeof note !== "string" || !note.trim() || path.isAbsolute(note) || /[\u0000\\]/.test(note)) throw new Error("The bundle note path is not vault-relative.");
  if (!markdown.test(note)) throw new Error("An Omarkie bundle restores a Markdown note.");
  const segments = note.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) throw new Error("The bundle note path is outside this vault.");
  if (segments[0] === ".omarkie") throw new Error("The bundle note path points at the glass store.");
  const file = path.join(root, ...segments);
  const inside = path.relative(root, file);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("The bundle note path is outside this vault.");
  return { note: segments.join("/"), file };
}

// mode: page | flat | handout | cheatsheet | bundle. out is a .md file, or a folder for bundle.
export async function exportGlassNote({ root, note, mode = "flat", out, target = "github", order = [], now = new Date(), appData }) {
  if (!glassExportModes.includes(mode)) throw new Error("Unknown Glass export mode.");
  if (!glassExportTargets.includes(target)) throw new Error("Unknown Glass export target.");
  root = await realpath(root);
  const resolved = await resolveNote(root, note);
  const source = await readFile(resolved.file);
  const before = checksum(source);
  const bom = source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(source.subarray(bom ? 3 : 0)); }
  catch { throw new Error("This note is not UTF-8; export leaves it untouched."); }
  const title = path.basename(resolved.note).replace(markdown, "");
  const glass = await glassForNote(root, resolved.note, { appData });
  const magnets = glass.magnets.filter(magnet => !magnet.deleted);
  if (["flat", "handout", "cheatsheet", "bundle"].includes(mode) && !magnets.length) throw new Error("No magnets to export.");
  if (!out) throw new Error("Name the file or folder to export to.");
  const taken = new Set();
  const images = new Map();
  for (const magnet of magnets) {
    if ((magnet.fields?.kind ?? magnet.kind) !== "image") continue;
    const asset = await imageAsset(glass, taken, magnet);
    if (asset) images.set(magnet.id, asset);
  }
  if (mode === "bundle") {
    const folder = await exportTarget(path.basename(out) === sanitizeTitle(title) ? out : path.join(out, sanitizeTitle(title)), root, resolved.file);
    if (await info(folder)) throw new Error("That export folder already exists; choose a new name.");
    await mkdir(folder, { recursive: true });
    const files = [];
    const noteOut = path.join(folder, path.basename(resolved.note));
    await writeAtomic(noteOut, source);
    files.push(noteOut);
    const copied = new Set();
    await copyPageImages(root, path.dirname(resolved.file), text, folder, copied);
    files.push(...copied);
    if (glass.journal && glass.journalName) {
      const storeDir = path.join(folder, ".omarkie");
      const glassDir = path.join(storeDir, "glass");
      await mkdir(glassDir, { recursive: true });
      await writeAtomic(path.join(glassDir, glass.journalName), await readFile(glass.journal));
      files.push(path.join(glassDir, glass.journalName));
      if (glass.record) {
        const row = { op: "note", id: glass.record.id, path: resolved.note, title: glass.record.title ?? title,
          ...(glass.record.fingerprint ? { fingerprint: glass.record.fingerprint } : {}),
          ...(glass.record.hlc ? { hlc: glass.record.hlc } : {}), ...(glass.record.device ? { device: glass.record.device } : {}) };
        await writeAtomic(path.join(storeDir, "notes.jsonl"), `${JSON.stringify(row)}\n`);
        files.push(path.join(storeDir, "notes.jsonl"));
      }
      if (glass.assets) {
        const targetDir = path.join(storeDir, "assets", path.basename(glass.journalName, ".jsonl"));
        let names = [];
        try { names = await readdir(glass.assets); } catch {}
        for (const name of names) {
          const from = path.join(glass.assets, name);
          const metadata = await info(from);
          if (!metadata?.isFile() || metadata.isSymbolicLink()) continue;
          const to = path.join(targetDir, name);
          await mkdir(targetDir, { recursive: true });
          await copyFile(from, to);
          files.push(to);
        }
      }
    }
    const manifest = { version: glassVersion, note: resolved.note, id: glass.record?.id ?? null, title,
      mode: "bundle", createdAt: now.toISOString(), sourceHash: before };
    const manifestPath = path.join(folder, "omarkie-bundle.json");
    await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    files.push(manifestPath);
    const after = checksum(await readFile(resolved.file));
    if (after !== before) throw new Error("The source note changed during export.");
    return { mode, note: resolved.note, out: folder, files, checksum: before };
  }
  const extension = mode === "page" ? path.extname(out) || ".md" : ".md";
  if (!markdown.test(out)) out += extension;
  out = await exportTarget(out, root, resolved.file);
  if (mode === "page") {
    await mkdir(path.dirname(out), { recursive: true });
    await writeAtomic(out, source);
    return { mode, note: resolved.note, out, files: [out], checksum: before };
  }
  const folder = `${path.basename(out).replace(markdown, "")}.assets`;
  const built = buildMarkdownExport({ noteName: resolved.note, noteText: text, magnets, mode, order, target,
    assets: { folder, images: id => images.get(id) } });
  const files = [];
  await mkdir(path.dirname(out), { recursive: true });
  await writeAtomic(out, built.markdown);
  files.push(out);
  if (built.files.length) {
    const assetDir = path.join(path.dirname(out), folder);
    await mkdir(assetDir, { recursive: true });
    for (const file of built.files) {
      const target = path.join(assetDir, file.name);
      if (file.bytes) await writeAtomic(target, file.bytes);
      else if (file.from) await copyFile(file.from, target);
      files.push(target);
    }
  }
  const after = checksum(await readFile(resolved.file));
  if (after !== before) throw new Error("The source note changed during export.");
  return { mode, note: resolved.note, out, files, checksum: before };
}

// Journal asset names come from the source folder, so two vaults can both hold "photo.png".
// Copying must not overwrite a different local picture, and the journal lines must follow the new name.
async function importAssets(from, to) {
  const mapping = new Map();
  let names = [];
  try { names = await readdir(from); } catch { return mapping; }
  const known = new Map();
  for (const name of await readdir(to).catch(() => [])) {
    const metadata = await info(path.join(to, name)).catch(() => null);
    known.set(name, metadata?.isFile() ? metadata.size : -1);
  }
  const taken = new Set([...known.keys()].map(name => name.toLowerCase()));
  const sameBytes = async (name, bytes) => {
    if (known.get(name) !== bytes.length) return false;
    return (await readFile(path.join(to, name)).catch(() => null))?.equals(bytes) === true;
  };
  for (const name of names) {
    const source = path.join(from, name);
    const metadata = await info(source);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) continue;
    const bytes = await readFile(source);
    if (await sameBytes(name, bytes)) continue;
    let target = null;
    for (const candidate of known.keys()) if (await sameBytes(candidate, bytes)) { target = candidate; break; }
    if (!target) {
      target = known.has(name) ? uniqueName(name, taken) : name;
      await mkdir(to, { recursive: true });
      await copyFile(source, path.join(to, target));
      known.set(target, bytes.length);
      taken.add(target.toLowerCase());
    }
    if (target !== name) mapping.set(name, target);
  }
  return mapping;
}

// A renamed journal moves its undo copies with it; merge and swap records point at them by path.
function retargetJournal(lines, mapping, oldBase, newBase) {
  const prefix = `assets/${oldBase}/`;
  const replacement = `assets/${newBase}/`;
  if (!mapping.size && oldBase === newBase) return lines;
  return lines.map(line => {
    let record;
    try { record = JSON.parse(line); } catch { return line; }
    if (!record || typeof record !== "object") return line;
    let changed = false;
    if (record.op === "set" && typeof record.value === "string" && ["asset", "display", "audio"].includes(record.field)) {
      const next = mapping.get(record.value);
      if (next) { record.value = next; changed = true; }
    }
    if (typeof record.undo === "string" && record.undo.startsWith(prefix)) {
      record.undo = `${replacement}${record.undo.slice(prefix.length)}`;
      changed = true;
    }
    return changed ? JSON.stringify(record) : line;
  });
}

function journalId(name) {
  return / ~([a-z0-9]{4,32})\.jsonl$/.exec(name)?.[1] ?? null;
}

function freshNoteId(known, taken) {
  for (;;) {
    const id = randomUUID().replace(/-/g, "").slice(0, 8);
    if (!known.has(id) && !taken.has(id)) return id;
  }
}

// Re-import a bundle folder into a vault without touching any existing note or journal line.
export async function importGlassBundle({ root, bundle, appData }) {
  root = await realpath(root);
  bundle = await realpath(bundle);
  const manifest = await readJson(path.join(bundle, "omarkie-bundle.json"));
  if (!manifest || manifest.version !== glassVersion || typeof manifest.note !== "string") throw new Error("That folder is not an Omarkie glass bundle.");
  const wanted = path.basename(manifest.note);
  const sourceNote = path.join(bundle, wanted);
  if (!(await info(sourceNote))?.isFile()) throw new Error("The bundle has no Markdown note.");
  const sourceBytes = await readFile(sourceNote);
  let { note: noteName, file: target } = bundleNotePath(root, manifest.note);
  if (await info(target)) {
    const existing = await readFile(target);
    if (!existing.equals(sourceBytes)) {
      ({ note: noteName, file: target } = bundleNotePath(root, noteName.replace(/\.(?:md|markdown|mdown)$/i, " (imported).md")));
      if (await info(target)) throw new Error("A different note with that name already exists.");
    }
  }
  await mkdir(path.dirname(target), { recursive: true });
  const existing = await readFile(target).catch(() => null);
  if (!existing) await writeAtomic(target, sourceBytes);
  try {
    const bom = sourceBytes[0] === 0xef && sourceBytes[1] === 0xbb && sourceBytes[2] === 0xbf;
    await restorePageImages(root, target, bundle, new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes.subarray(bom ? 3 : 0)));
  } catch { /* a note that is not UTF-8 still imports; its pictures stay where the vault has them */ }
  const store = await glassStore(root, { appData });
  const insideStore = store.directory === path.join(root, ".omarkie");
  const settingsFile = path.join(store.directory, "settings.json");
  // A fresh vault becomes discoverable the way the app first creates its store; an outside store
  // already has its own settings, and writing one inside would move the store on the next open.
  if (insideStore && !(await info(settingsFile))) {
    const registry = await readJson(path.join(appData || dataDir(), "glass-vaults", "roots.json"));
    const remembered = registry?.[root];
    const vaultId = typeof remembered?.vaultId === "string" && vaultIdPattern.test(remembered.vaultId) ? remembered.vaultId : randomUUID();
    await writeAtomic(settingsFile, `${JSON.stringify({ version: glassVersion, vaultId, mode: "inside", createdAt: new Date().toISOString() }, null, 2)}\n`);
  }
  const rows = (await readFile(store.notes, "utf8").catch(() => "")).split("\n").filter(line => line.trim());
  const seen = new Set(rows);
  const known = replayNotesText(`${rows.join("\n")}\n`).notes;
  // A vault that already tracks this note keeps its id: appending a second record for one path
  // would make the app read the imported journal and strand the note's own marks.
  const tracked = [...known.values()].reverse().find(record => record.path === noteName && /^[a-z0-9]{4,32}$/.test(record.id)) ?? null;
  const journals = await readdir(store.glass).catch(() => []);
  const usedIds = new Set(journals.map(journalId).filter(Boolean));
  // A note that was renamed keeps its journal's old title; follow the file the app already reads.
  const journalNameFor = id => journals.find(name => name.endsWith(` ~${id}.jsonl`)) ?? null;
  let noteId = tracked?.id ?? null;
  let journalName = null;
  const bundleGlass = path.join(bundle, ".omarkie", "glass");
  const bundleNotes = path.join(bundle, ".omarkie", "notes.jsonl");
  if (await info(bundleGlass)) {
    for (const name of (await readdir(bundleGlass)).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const lines = (await readFile(path.join(bundleGlass, name), "utf8")).split("\n").filter(line => line.trim());
      const bundled = journalId(name);
      if (!bundled) throw new Error("The bundle's glass journal is not readable.");
      if (!noteId) noteId = known.has(bundled) ? freshNoteId(known, usedIds) : bundled;
      usedIds.add(noteId);
      journalName = journalNameFor(noteId) ?? glassFileName(path.basename(noteName, path.extname(noteName)), noteId);
      const targetJournal = path.join(store.glass, journalName);
      const oldBase = path.basename(name, ".jsonl"), newBase = path.basename(journalName, ".jsonl");
      const assetsFrom = path.join(bundle, ".omarkie", "assets", oldBase);
      const assetsTo = path.join(store.assets, newBase);
      const renamed = await importAssets(assetsFrom, assetsTo);
      const incoming = retargetJournal(lines, renamed, oldBase, newBase);
      const current = (await readFile(targetJournal, "utf8").catch(() => "")).split("\n").filter(line => line.trim());
      const have = new Set(current);
      const merged = [...current, ...incoming.filter(line => !have.has(line))];
      await mkdir(path.dirname(targetJournal), { recursive: true });
      await writeAtomic(targetJournal, `${merged.join("\n")}\n`);
    }
  }
  if (await info(bundleNotes)) {
    for (const line of (await readFile(bundleNotes, "utf8")).split("\n").filter(line => line.trim())) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.op !== "note") continue;
      record.path = noteName;
      if (noteId) record.id = noteId;
      const row = JSON.stringify(record);
      if (!seen.has(row)) { rows.push(row); seen.add(row); }
    }
  }
  if (rows.length) await writeAtomic(store.notes, `${rows.join("\n")}\n`);
  return { note: noteName, file: target, journal: journalName };
}
