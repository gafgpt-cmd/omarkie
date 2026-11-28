// A small stand-in for Syncthing between two folders, for tests on machines without it.
// Behaviour follows https://docs.syncthing.net/users/syncing.html and versioning.html:
// - files are written as `.syncthing.<name>.tmp` and renamed into place; mtime travels with the file
// - a file changed on both sides: the older mtime loses and is renamed
//   `<stem>.sync-conflict-<YYYYMMDD>-<HHMMSS>-<device><ext>`; the copy then syncs like any file
// - modified on one side, deleted on the other: the modification wins
// - replaced or deleted by a remote change: the old file moves to `.stversions/` (Trash Can versioning)
// - `.stfolder`, `.stversions`, `.stignore` and `.*.tmp` never sync
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

const ignored = /^(?:\.stfolder|\.stversions|\.stignore|\..*\.tmp|writer\.lock|journal\.lock)$/;
const pad = value => String(value).padStart(2, "0");
const stamp = date => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
export const sha = bytes => createHash("sha256").update(bytes).digest("hex");

export async function snapshot(root) {
  const files = new Map();
  const walk = async (directory, prefix) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignored.test(entry.name)) continue;
      const file = path.join(directory, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(file, relative);
      else if (entry.isFile()) { const bytes = await readFile(file); files.set(relative, { hash: sha(bytes), bytes, mtime: (await stat(file)).mtime }); }
    }
  };
  await walk(root, "");
  return files;
}

export class SyncthingPair {
  constructor(roots, devices = ["LAPTOPA", "DESKTOP"]) { this.roots = roots; this.devices = devices; this.base = new Map(); this.log = []; }
  async start() {
    for (const root of this.roots) await mkdir(path.join(root, ".stfolder"), { recursive: true });
    return this.sync();
  }
  async version(side, relative) {
    const file = path.join(this.roots[side], relative), extension = path.extname(relative);
    const target = path.join(this.roots[side], ".stversions", `${relative.slice(0, relative.length - extension.length)}~${stamp(new Date())}${extension}`);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(file, target);
    this.log.push({ side, versioned: relative });
  }
  async put(side, relative, entry) {
    const file = path.join(this.roots[side], relative), temporary = path.join(path.dirname(file), `.syncthing.${path.basename(file)}.tmp`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temporary, entry.bytes);
    await utimes(temporary, entry.mtime, entry.mtime);
    if (await stat(file).then(() => true, () => false)) await this.version(side, relative);
    await rename(temporary, file);
  }
  async sync() {
    const sides = [await snapshot(this.roots[0]), await snapshot(this.roots[1])], conflicts = [];
    for (const relative of new Set([...this.base.keys(), ...sides[0].keys(), ...sides[1].keys()])) {
      const before = this.base.get(relative), now = sides.map(files => files.get(relative));
      const changed = now.map(entry => entry?.hash !== before);
      if (now[0]?.hash === now[1]?.hash) continue;
      if (changed[0] !== changed[1]) {
        const from = changed[0] ? 0 : 1, to = 1 - from;
        if (now[from]) await this.put(to, relative, now[from]); else await this.version(to, relative);
        continue;
      }
      // Both sides changed. A deletion loses to a modification.
      if (!now[0] || !now[1]) { const keep = now[0] ? 0 : 1; await this.put(1 - keep, relative, now[keep]); continue; }
      const loser = now[0].mtime < now[1].mtime ? 0 : now[1].mtime < now[0].mtime ? 1 : this.devices[0] > this.devices[1] ? 0 : 1, winner = 1 - loser;
      const extension = path.extname(relative), copy = `${relative.slice(0, relative.length - extension.length)}.sync-conflict-${stamp(now[loser].mtime)}-${this.devices[loser]}${extension}`;
      await rename(path.join(this.roots[loser], relative), path.join(this.roots[loser], copy));
      await this.put(1 - loser, copy, now[loser]);
      await this.put(loser, relative, now[winner]);
      conflicts.push({ relative, copy, loser: this.devices[loser] });
    }
    const [first, second] = [await snapshot(this.roots[0]), await snapshot(this.roots[1])];
    if (first.size !== second.size || [...first].some(([relative, entry]) => second.get(relative)?.hash !== entry.hash)) throw new Error("folders did not converge");
    this.base = new Map([...first].map(([relative, entry]) => [relative, entry.hash]));
    return { conflicts, files: first };
  }
}
