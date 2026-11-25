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

function dataDir() {
  return process.env.OMARKIE_DATA_DIR || path.join(os.homedir(), ".config", "omarkie");
}

// The glass store is inside the vault unless settings.json says it lives in app data.
export async function glassStore(root) {
  const inside = path.join(root, ".omarkie");
  const settings = await readJson(path.join(inside, "settings.json"));
  const directory = settings?.mode === "outside" && settings?.vaultId ? path.join(dataDir(), "glass-vaults", settings.vaultId) : inside;
  return { root, directory, notes: path.join(directory, "notes.jsonl"), glass: path.join(directory, "glass"), assets: path.join(directory, "assets") };
}

async function noteRecord(notesFile, noteName) {
  const text = await readFile(notesFile, "utf8").catch(() => "");
  if (!text) return null;
  return [...replayNotesText(text).notes.values()].find(record => record.path === noteName) ?? null;
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

export async function glassForNote(root, noteName) {
  const store = await glassStore(root);
  return { store, ...(await readLayer(store.glass, store.notes, store.assets, noteName)) };
}

// Someone else's journal, synced under .omarkie/share with the same layout:
// notes.jsonl, glass/<title> ~<id>.jsonl and assets/<title> ~<id>/.
export async function sharedGlassForNote(root, noteName) {
  const store = await glassStore(root);
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

async function copyPageImages(root, noteDir, source, outDir, copied) {
  const matches = [...String(source).matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))\)/g)];
  for (const match of matches) {
    const link = decodeURIComponent(match[1] ?? match[2] ?? "");
    if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("/")) continue;
    const from = path.resolve(noteDir, link);
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

// mode: page | flat | handout | cheatsheet | bundle. out is a .md file, or a folder for bundle.
export async function exportGlassNote({ root, note, mode = "flat", out, target = "github", order = [], now = new Date() }) {
  if (!glassExportModes.includes(mode)) throw new Error("Unknown Glass export mode.");
  if (!glassExportTargets.includes(target)) throw new Error("Unknown Glass export target.");
  root = await realpath(root);
  const resolved = await resolveNote(root, note);
  const source = await readFile(resolved.file);
  const before = checksum(source);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(source.subarray(source[0] === 0xef ? 3 : 0)); }
  catch { throw new Error("This note is not UTF-8; export leaves it untouched."); }
  const title = path.basename(resolved.note).replace(markdown, "");
  const glass = await glassForNote(root, resolved.note);
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
    const folder = path.basename(out) === sanitizeTitle(title) ? out : path.join(out, sanitizeTitle(title));
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

// Re-import a bundle folder into a vault without touching any existing note or journal line.
export async function importGlassBundle({ root, bundle }) {
  root = await realpath(root);
  bundle = await realpath(bundle);
  const manifest = await readJson(path.join(bundle, "omarkie-bundle.json"));
  if (!manifest || manifest.version !== glassVersion || typeof manifest.note !== "string") throw new Error("That folder is not an Omarkie glass bundle.");
  const wanted = path.basename(manifest.note);
  let noteName = manifest.note;
  const sourceNote = path.join(bundle, wanted);
  if (!(await info(sourceNote))?.isFile()) throw new Error("The bundle has no Markdown note.");
  let target = path.join(root, ...noteName.split("/"));
  const targetInfo = await info(target);
  if (targetInfo) {
    const existing = await readFile(target), incoming = await readFile(sourceNote);
    if (!existing.equals(incoming)) {
      noteName = noteName.replace(/\.(?:md|markdown|mdown)$/i, " (imported).md");
      target = path.join(root, ...noteName.split("/"));
      if (await info(target)) throw new Error("A different note with that name already exists.");
    }
  }
  await mkdir(path.dirname(target), { recursive: true });
  const existing = await readFile(target).catch(() => null);
  if (!existing) await writeAtomic(target, await readFile(sourceNote));
  const notesFile = path.join(root, ".omarkie", "notes.jsonl");
  const rows = (await readFile(notesFile, "utf8").catch(() => "")).split("\n").filter(line => line.trim());
  const seen = new Set(rows);
  let journalName = null;
  const bundleGlass = path.join(bundle, ".omarkie", "glass");
  const bundleNotes = path.join(bundle, ".omarkie", "notes.jsonl");
  if (await info(bundleNotes)) {
    for (const line of (await readFile(bundleNotes, "utf8")).split("\n").filter(line => line.trim())) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.op !== "note") continue;
      record.path = noteName;
      const row = JSON.stringify(record);
      if (!seen.has(row)) { rows.push(row); seen.add(row); }
    }
  }
  if (await info(bundleGlass)) {
    for (const name of await readdir(bundleGlass)) {
      if (!name.endsWith(".jsonl")) continue;
      const lines = (await readFile(path.join(bundleGlass, name), "utf8")).split("\n").filter(line => line.trim());
      const match = / ~([a-z0-9]{4,32})\.jsonl$/.exec(name);
      if (!match) continue;
      journalName = glassFileName(path.basename(noteName, path.extname(noteName)), match[1]);
      const targetJournal = path.join(root, ".omarkie", "glass", journalName);
      const current = (await readFile(targetJournal, "utf8").catch(() => "")).split("\n").filter(line => line.trim());
      const have = new Set(current);
      const merged = [...current, ...lines.filter(line => !have.has(line))];
      await mkdir(path.dirname(targetJournal), { recursive: true });
      await writeAtomic(targetJournal, `${merged.join("\n")}\n`);
      const assetsFrom = path.join(bundle, ".omarkie", "assets", path.basename(name, ".jsonl"));
      const assetsTo = path.join(root, ".omarkie", "assets", path.basename(journalName, ".jsonl"));
      let names = [];
      try { names = await readdir(assetsFrom); } catch {}
      for (const asset of names) {
        const from = path.join(assetsFrom, asset);
        if (!(await info(from))?.isFile()) continue;
        await mkdir(assetsTo, { recursive: true });
        await copyFile(from, path.join(assetsTo, asset));
      }
    }
  }
  if (rows.length) await writeAtomic(notesFile, `${rows.join("\n")}\n`);
  const settingsFile = path.join(root, ".omarkie", "settings.json");
  if (!(await info(settingsFile))) {
    await writeAtomic(settingsFile, `${JSON.stringify({ version: glassVersion, vaultId: randomUUID(), mode: "inside", createdAt: new Date().toISOString() }, null, 2)}\n`);
  }
  return { note: noteName, file: target, journal: journalName };
}
