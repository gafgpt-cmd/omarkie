// Shared helpers for the G23 daily-life chaos suite.
// Throwaway vaults only: every vault lives under a fresh mktemp directory and never touches a real one.
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GlassService } from "../../electron/glass-service.mjs";
import { GlassSync } from "../../electron/glass-sync.mjs";
import { replayJournalText, replayNotesText } from "../../shared/glass-core.mjs";

const scratchRoots = [];

export async function scratch(prefix = "omarkie-chaos-") {
  const root = await mkdtemp(path.join(process.env.OMARKIE_CHAOS_ROOT ?? tmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}

export async function cleanup() {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => {});
}

export async function vault(files = {}, options = {}) {
  const root = options.root ?? await scratch();
  const folder = options.folder ?? path.join(root, "vault");
  const data = options.data ?? path.join(root, "app-data");
  const cache = options.cache ?? path.join(root, "cache");
  await mkdir(folder, { recursive: true });
  await mkdir(data, { recursive: true });
  await mkdir(cache, { recursive: true });
  if (!options.noObsidian) {
    await mkdir(path.join(folder, ".obsidian"), { recursive: true });
    await writeFile(path.join(folder, ".obsidian", "app.json"), '{"attachmentFolderPath":"assets"}\n');
  }
  for (const [name, content] of Object.entries(files)) await put(folder, name, content);
  return { root, folder, data, cache };
}

export async function put(root, name, content) {
  const file = path.join(root, ...name.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

export const quietWatcher = async () => ({ close() {} });

export async function openService(environment, options = {}) {
  return new GlassService({ root: environment.folder, appData: environment.data, device: options.device ?? "chaos-device", ...options }).open();
}

export async function openSync(environment, options = {}) {
  const service = options.service ?? await openService(environment, options);
  const sync = new GlassSync({ service, cacheDir: environment.cache, appData: environment.data,
    watcherFactory: options.watcherFactory ?? quietWatcher });
  await sync.start();
  await sync.whenIdle();
  return { service, sync };
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function fileHash(file) {
  return sha256(await readFile(file));
}

export async function exists(file) {
  return !!(await lstat(file).catch(() => null));
}

// Every non-hidden file under a folder, keyed by NFC-relative path, hashed by content.
export async function contentHashes(root, { skip = [".omarkie"] } = {}) {
  const result = new Map();
  async function walk(folder, relative) {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (skip.includes(name.split("/")[0])) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file, name);
      else if (entry.isFile()) result.set(name.normalize("NFC"), sha256(await readFile(file)));
    }
  }
  await walk(root, "");
  return result;
}

export async function storeDirOf(environment) {
  const inside = path.join(environment.folder, ".omarkie");
  if (await exists(path.join(inside, "settings.json"))) return inside;
  const settings = await readJson(path.join(inside, "settings.json"));
  if (settings?.mode === "outside") return path.join(environment.data, "glass-vaults", settings.vaultId);
  const registry = await readJson(path.join(environment.data, "glass-vaults", "roots.json")) ?? {};
  const remembered = registry[await realpathOr(environment.folder)];
  if (remembered?.vaultId) {
    const outside = path.join(environment.data, "glass-vaults", remembered.vaultId);
    if (await exists(path.join(outside, "settings.json"))) return outside;
  }
  return inside;
}

async function realpathOr(file) {
  return (await import("node:fs/promises")).realpath(file).catch(() => file);
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

const journalName = / ~([a-z0-9]{4,32})\.jsonl$/;

// The study's "glass comes back every time" manifest: note sha set, magnet id set, anchors.
// Sorted by code point, never localeCompare, so two manifests compare byte-for-byte.
export async function manifest(environment) {
  const store = await storeDirOf(environment);
  const settings = await readJson(path.join(store, "settings.json"));
  const notesText = await readFile(path.join(store, "notes.jsonl"), "utf8").catch(() => "");
  const replayed = replayNotesText(notesText);
  const magnets = new Map();
  for (const name of await readdir(path.join(store, "glass")).catch(() => [])) {
    const match = journalName.exec(name);
    if (!match) continue;
    const journal = replayJournalText(await readFile(path.join(store, "glass", name), "utf8").catch(() => ""));
    magnets.set(match[1], {
      invalid: journal.invalid,
      magnets: [...journal.magnets.values()]
        .filter(magnet => !magnet.deleted?.active)
        .map(magnet => ({
          id: magnet.id,
          anchor: magnet.fields.get("anchor")?.value ?? null,
          text: magnet.fields.get("text")?.value ?? null,
        }))
        .sort((left, right) => compare(left.id, right.id)),
    });
  }
  const rows = [];
  for (const note of replayed.notes.values()) {
    const file = path.join(environment.folder, ...note.path.split("/"));
    rows.push({
      id: note.id,
      path: note.path.normalize("NFC"),
      sha256: await fileHash(file).catch(() => null),
      magnets: magnets.get(note.id)?.magnets ?? [],
      invalid: magnets.get(note.id)?.invalid ?? 0,
    });
  }
  rows.sort((left, right) => compare(left.path, right.path));
  const journals = (await readdir(path.join(store, "glass")).catch(() => [])).filter(name => journalName.test(name)).sort(compare);
  return { vaultId: settings?.vaultId ?? null, mode: settings?.mode ?? null, store, notes: rows, journals };
}

export function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Manifest equality without the store path, which legitimately changes with the vault's location.
export function sameGlass(left, right) {
  return JSON.stringify({ vaultId: left.vaultId, notes: left.notes }) === JSON.stringify({ vaultId: right.vaultId, notes: right.notes });
}

export async function notesLines(environment) {
  const store = await storeDirOf(environment);
  const text = await readFile(path.join(store, "notes.jsonl"), "utf8").catch(() => "");
  return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

export async function journalLines(environment, id) {
  const store = await storeDirOf(environment);
  const names = (await readdir(path.join(store, "glass")).catch(() => [])).filter(name => journalName.test(name) && journalName.exec(name)[1] === id);
  return names.flatMap(name => readFile(path.join(store, "glass", name), "utf8").then(text => text.split("\n").filter(line => line.trim())));
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function waitFor(condition, { timeout = 5_000, interval = 25, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await sleep(interval);
  }
}

export async function setMtime(file, date) {
  await utimes(file, date, date);
}

export async function makeReadOnly(directory) {
  await chmod(directory, 0o555);
}

export async function restoreMode(directory, mode = 0o755) {
  await chmod(directory, mode);
}

export async function copyTree(source, target, options = {}) {
  await cp(source, target, { recursive: true, preserveTimestamps: true, filter: options.filter });
  return target;
}

export async function sizeOf(file) {
  return (await stat(file).catch(() => null))?.size ?? null;
}

export async function spawnNode(script, args, options = {}) {
  const { spawn } = await import("node:child_process");
  return spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"], ...options });
}
