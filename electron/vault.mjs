import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

// Obsidian-style attachment lookup for a reference missing next to its note, cheapest place first:
// the vault's attachment folder (Obsidian setting, or a usual name), then the whole vault as the last resort.
// The vault is the nearest folder holding .obsidian, else the open folder, else the note's folder.
const media = /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|ogg|mp3|wav|m4a)$/i;
const attachmentNames = ["_ATTACHMENTS", "attachments", "Attachments", "assets", "images"];
const maxEntries = 50000, maxDepth = 12, retryAfter = 60000;
const indexes = new Map();

export async function vaultRoot(documentDirectory, openFolder) {
  for (let directory = documentDirectory; ; directory = path.dirname(directory)) {
    if (await stat(path.join(directory, ".obsidian")).then(item => item.isDirectory(), () => false)) return directory;
    if (path.dirname(directory) === directory) break;
  }
  const relative = openFolder ? path.relative(openFolder, documentDirectory) : "..";
  return relative.startsWith("..") || path.isAbsolute(relative) ? documentDirectory : openFolder;
}

async function attachmentFolders(root) {
  const configured = await readFile(path.join(root, ".obsidian", "app.json"), "utf8").then(text => JSON.parse(text).attachmentFolderPath, () => "");
  const folders = [...(typeof configured === "string" && configured && !configured.startsWith(".") ? [configured] : []), ...attachmentNames].map(name => path.join(root, name));
  const existing = await Promise.all(folders.map(folder => stat(folder).then(item => item.isDirectory(), () => false)));
  return [...new Set(folders.filter((_, index) => existing[index]))];
}

// Every entry walked counts toward the limit, so a huge tree costs a bounded walk.
async function buildIndex(root) {
  const byName = new Map();
  let entries = 0;
  const walk = async (directory, depth) => {
    let items;
    try { items = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of items) {
      if (++entries > maxEntries) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (depth < maxDepth) await walk(file, depth + 1); }
      else if (entry.isFile() && media.test(entry.name)) {
        const key = entry.name.toLowerCase();
        byName.set(key, [...(byName.get(key) || []), file]);
      }
    }
  };
  await walk(root, 0);
  return byName;
}

// Built once per folder; a miss rebuilds at most once a minute, so a broken link never re-walks the tree on every paint.
async function lookup(folder, parts) {
  let cached = indexes.get(folder);
  if (!cached) indexes.set(folder, cached = { built: Date.now(), byName: buildIndex(folder) });
  const find = async () => {
    const candidates = (await cached.byName).get(parts.at(-1).toLowerCase()) || [];
    const suffix = path.sep + parts.join(path.sep), shortest = list => list.sort((a, b) => a.length - b.length)[0];
    return shortest(candidates.filter(file => file.endsWith(suffix))) || shortest(candidates.filter(file => file.toLowerCase().endsWith(suffix.toLowerCase())));
  };
  const found = await find();
  if (found || Date.now() - cached.built < retryAfter) return found;
  indexes.set(folder, cached = { built: Date.now(), byName: buildIndex(folder) });
  return find();
}

// Exact relative-path suffix first, then case-insensitive; the shortest path wins, as in Obsidian.
export async function findInVault(root, reference) {
  const parts = reference.split(/[\\/]/).filter(part => part && part !== ".");
  if (!parts.length) return undefined;
  for (const folder of await attachmentFolders(root)) {
    const found = await lookup(folder, parts);
    if (found) return found;
  }
  return lookup(root, parts);
}
