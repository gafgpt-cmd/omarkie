import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

// Fingerprint → where its glass lives, on this computer, never on the drive.
// Append-only: the last line for a hash wins, so a move never loses the trail.
export class GlassFinder {
  constructor({ file }) {
    if (!file) throw new Error("Glass finder needs a file.");
    this.file = file;
    this.entries = new Map();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      const text = await readFile(this.file, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (!record || record.op !== "see" || typeof record.hash !== "string" || !record.hash) continue;
        this.entries.set(record.hash, record);
      }
    } catch (error) {
      if (error.code === "ENOENT") return this;
      throw error;
    }
    return this;
  }

  lookup(hash) {
    return hash ? this.entries.get(hash) ?? null : null;
  }

  async remember({ hash, size, vaultId, store, journal, noteId, title, path: notePath, mode }) {
    if (!hash || !vaultId || !store || !noteId) return null;
    const previous = this.entries.get(hash);
    if (previous && previous.vaultId === vaultId && previous.journal === journal && previous.path === notePath) return previous;
    const record = { op: "see", hash, size: size ?? null, vaultId, store, journal: journal ?? null, noteId, title: title ?? null,
      path: notePath ?? null, mode: mode ?? null, at: new Date().toISOString() };
    this.entries.set(hash, record);
    try {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await appendFile(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch { /* the finder only helps; glass remains authoritative */ }
    return record;
  }

  hasForeign(vaultId) {
    for (const entry of this.entries.values()) if (entry.vaultId !== vaultId) return true;
    return false;
  }

  // Entries from another vault that this computer already knows.
  matches(hashes, vaultId) {
    const found = new Map();
    for (const hash of hashes) {
      const entry = this.lookup(hash);
      if (!entry) continue;
      if (vaultId && entry.vaultId === vaultId) continue;
      if (!found.has(entry.noteId)) found.set(entry.noteId, entry);
    }
    return [...found.values()];
  }
}
