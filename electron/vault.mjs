import { readdir, stat } from "node:fs/promises";
import path from "node:path";

// Obsidian-style attachment lookup: a reference missing next to the note is searched by file name
// in the note's vault (the nearest folder holding .obsidian, else the open folder, else the note's folder).
const media = /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|ogg|mp3|wav|m4a)$/i;
const limit = 50000, maxDepth = 12, freshFor = 10000;
const indexes = new Map();

export async function vaultRoot(documentDirectory, openFolder) {
  for (let directory = documentDirectory; ; directory = path.dirname(directory)) {
    if (await stat(path.join(directory, ".obsidian")).then(item => item.isDirectory(), () => false)) return directory;
    if (path.dirname(directory) === directory) break;
  }
  const relative = openFolder ? path.relative(openFolder, documentDirectory) : "..";
  return relative.startsWith("..") || path.isAbsolute(relative) ? documentDirectory : openFolder;
}

async function buildIndex(root) {
  const byName = new Map();
  let count = 0;
  const walk = async (directory, depth) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (count >= limit || entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (depth < maxDepth) await walk(file, depth + 1); }
      else if (entry.isFile() && media.test(entry.name)) {
        count++;
        const key = entry.name.toLowerCase();
        byName.set(key, [...(byName.get(key) || []), file]);
      }
    }
  };
  await walk(root, 0);
  return byName;
}

// Exact relative-path suffix first, then case-insensitive; the shortest path wins, as in Obsidian.
export async function findInVault(root, reference) {
  let cached = indexes.get(root);
  if (!cached || Date.now() - cached.built > freshFor) {
    cached = { built: Date.now(), byName: buildIndex(root) };
    indexes.set(root, cached);
  }
  const parts = reference.split(/[\\/]/).filter(part => part && part !== "."), name = parts.at(-1)?.toLowerCase();
  const candidates = (await cached.byName).get(name) || [];
  const suffix = path.sep + parts.join(path.sep), shortest = list => list.sort((a, b) => a.length - b.length)[0];
  return shortest(candidates.filter(file => file.endsWith(suffix))) || shortest(candidates.filter(file => file.toLowerCase().endsWith(suffix.toLowerCase())));
}
