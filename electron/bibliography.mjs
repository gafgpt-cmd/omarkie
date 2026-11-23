import { constants, watchFile, unwatchFile } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, digest } from "./store.mjs";
import { cslByteLimit, parseCSL } from "./interchange.mjs";
import { t } from "./i18n.mjs";

const empty = { raw: "", source: null };
const limits = { source: cslByteLimit, preference: 3 * cslByteLimit };
const preference = (dataDir, root) => path.join(dataDir, "bibliographies", digest(root) + ".json");
const absoluteLocal = file => typeof file === "string" && file.length <= 4096 && !file.includes("\0") &&
  (process.platform === "win32" ? /^[a-z]:[\\/][^:]*$/i.test(file) : file.startsWith("/") && !file.startsWith("//"));

async function regularFile(file, read) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(t("文件不是普通文件"));
    return await read(handle, stat.size);
  } finally { await handle.close(); }
}

async function readBounded(file, max) {
  return regularFile(file, async (handle, size) => {
    if (size > max) throw new Error(t("书目超过 2 MB"));
    const data = Buffer.allocUnsafe(size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== size) throw new Error(t("CSL JSON 书目无效"));
    return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, offset));
  });
}

async function readPreference(file) {
  try {
    const { raw, source } = JSON.parse(await readBounded(file, limits.preference));
    if (source !== null && (!absoluteLocal(source) || !/\.json$/i.test(source))) throw new Error(t("CSL JSON 书目无效"));
    if (raw !== "") parseCSL(raw, true);
    return { raw, source };
  } catch (error) {
    if (error.code === "ENOENT") return empty;
    throw new Error(t("CSL JSON 书目无效"));
  }
}

async function readExport(file) {
  if (!absoluteLocal(file) || !/\.json$/i.test(file) || await realpath(file) !== file) throw new Error(t("CSL JSON 书目无效"));
  const raw = await readBounded(file, limits.source);
  parseCSL(raw, true);
  return raw;
}

function exportCSL(entries) {
  return entries.length ? JSON.stringify(entries.map(({ "omarkie-pdf": _attachment, ...entry }) => entry)) : "";
}

export class VaultBibliography {
  #state;
  #entries = new Map();
  #csl = "";
  #stale = false;
  #stop;
  #closed = false;
  #queue = Promise.resolve();

  constructor(dataDir, root, changed) {
    this.root = root;
    this.file = preference(dataDir, root);
    this.changed = changed;
  }

  run(action, value) {
    const operation = this.#queue.then(async () => {
      if (this.#closed) throw new Error(t("请先打开笔记文件夹"));
      if (!this.#state) {
        this.#set(await readPreference(this.file));
        if (this.#state.source) await this.#refresh(this.#state.source);
      }
      switch (action) {
        case "info": return { csl: this.#csl, source: this.#state.source ? path.basename(this.#state.source) : null, stale: this.#stale };
        case "save":
          parseCSL(value);
          await this.#save({ raw: value, source: null });
          return;
        case "link": {
          if (!absoluteLocal(value)) throw new Error(t("CSL JSON 书目无效"));
          const source = await realpath(value);
          await this.#save({ raw: await readExport(source), source });
          return;
        }
        case "disconnect": await this.#save({ raw: this.#state.raw, source: null }); return;
        case "clear": await this.#save(empty); return;
        case "suggest": return this.#suggest(value);
        case "pdf": return this.#pdf(value);
      }
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }

  close() { this.#closed = true; this.#stop?.(); }

  #set(state) {
    const entries = state.raw ? parseCSL(state.raw, true) : [];
    this.#csl = exportCSL(entries);
    this.#entries = new Map(entries.map(entry => {
      const title = typeof entry.title === "string" ? entry.title.slice(0, 300) : "";
      const authors = Array.isArray(entry.author) ? entry.author.slice(0, 5).map(author => author?.family || author?.literal).filter(name => typeof name === "string").join(", ").slice(0, 160) : "";
      const paths = state.source && Array.isArray(entry["omarkie-pdf"]) ? entry["omarkie-pdf"].slice(0, 16).filter(pdf => absoluteLocal(pdf) && /\.pdf$/i.test(pdf)) : [];
      return [entry.id, { id: entry.id, title, authors, terms: `${entry.id} ${title} ${authors}`.normalize().toLowerCase(), paths }];
    }));
    if (this.#state?.source !== state.source) {
      this.#stop?.(); this.#stop = undefined;
      if (state.source && !this.#closed) {
        const source = state.source;
        const refresh = () => {
          const operation = this.#queue.then(() => this.#refresh(source));
          this.#queue = operation.catch(() => {});
        };
        watchFile(source, { persistent: false, interval: 750 }, refresh);
        this.#stop = () => unwatchFile(source, refresh);
      }
    }
    this.#state = state;
  }

  async #save(state) {
    if (this.#closed) return;
    await atomicWrite(this.file, JSON.stringify(state));
    if (this.#closed) return;
    this.#set(state);
    this.#stale = false;
    this.changed();
  }

  async #refresh(source) {
    if (this.#closed || this.#state.source !== source) return;
    try {
      const raw = await readExport(source);
      if (this.#closed) return;
      if (raw !== this.#state.raw) await this.#save({ raw, source });
      else if (this.#stale) { this.#stale = false; this.changed(); }
    } catch {
      if (!this.#closed && !this.#stale) { this.#stale = true; this.changed(); }
    }
  }

  #suggest(query) {
    if (typeof query !== "string" || query.length > 256 || /[^\p{L}\p{M}\p{N}_.:+/-]/u.test(query)) return [];
    const term = query.normalize().toLowerCase(), first = [], rest = [];
    for (const entry of this.#entries.values()) {
      const list = entry.id.toLowerCase().startsWith(term) ? first : entry.terms.includes(term) ? rest : null;
      if (list && list.length < 8) list.push({ id: entry.id, title: entry.title, authors: entry.authors });
      if (first.length === 8) break;
    }
    return first.concat(rest).slice(0, 8);
  }

  async #pdf(key) {
    for (const file of this.#entries.get(key)?.paths || []) {
      try {
        const canonical = await realpath(file);
        if (!absoluteLocal(canonical) || !/\.pdf$/i.test(canonical)) continue;
        const pdf = await regularFile(canonical, async handle => {
          const buffer = Buffer.alloc(5);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          return bytesRead === 5 && buffer.toString("ascii") === "%PDF-";
        });
        if (pdf) return canonical;
      } catch { /* Try the next local attachment. */ }
    }
    return null;
  }
}
