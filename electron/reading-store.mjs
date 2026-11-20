import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { t } from "./i18n.mjs";
import { readingAnchor, resolveReadingAnchors } from "./reading-anchors.mjs";

const kinds = new Set(["note", "highlight", "card", "answer", "schedule", "payload"]);
const queues = new Map(), cache = new Map();
const noFollow = (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
const invalid = () => new Error(t("阅读图层数据无效。"));
const unsafe = () => new Error(t("阅读数据路径不安全。"));
const missing = error => { if (error.code !== "ENOENT") throw error; return null; };
const info = file => lstat(file).catch(missing);
const within = (root, file) => {
  const relative = path.relative(root, file);
  return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function scope(store, id) {
  const file = store.require(id).path, folder = store.folder;
  if (!file || !folder) throw new Error(t("请先打开文件夹并保存文档。"));
  const root = await realpath(folder), document = await realpath(file);
  if (!within(root, document) || document !== file || !(await lstat(document)).isFile()) throw unsafe();
  return { root, document: path.relative(root, document).split(path.sep).join("/"), current: () => store.folder === folder && store.require(id).path === file };
}

async function directoryAt(root, directory, create = false) {
  let metadata = await info(directory);
  if (!metadata && create) {
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    metadata = await info(directory);
  }
  if (metadata && (!metadata.isDirectory() || await realpath(directory) !== path.join(root, ".omarkie"))) throw unsafe();
  return metadata !== null;
}

function regular(metadata) {
  if (metadata && (!metadata.isFile() || metadata.nlink !== 1 && metadata.nlink !== 1n)) throw unsafe();
  return metadata;
}

function text(value, max = 65_536) {
  if (typeof value !== "string" || value.length > max || !value.trim()) throw invalid();
  return value;
}
function identifier(value) {
  if (typeof value !== "string" || !/^[\w.:-]{1,200}$/.test(value)) throw invalid();
  return value;
}
function number(value, min, max, integer = true) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw invalid();
  return value;
}
function blockAt(value) {
  if (!value || !Array.isArray(value.headings) || value.headings.length > 6 || value.headings.some(heading => typeof heading !== "string" || heading.length > 262_144)) throw invalid();
  if (typeof value.block !== "string" || value.block.length > 20_000_000) throw invalid();
  return { block: value.block, headings: value.headings, line: number(value.line, 1, 20_000_000) };
}
function target(value) {
  const block = blockAt(value);
  if (!block.block.trim() || block.block.length > 262_144) throw invalid();
  return readingAnchor({ ...block, quote: text(value.quote) });
}
function itemAt(item) {
  if (!item || !kinds.has(item.type)) throw invalid();
  const base = { id: identifier(item.id), type: item.type };
  switch (item.type) {
    case "note": return { ...base, body: text(item.body), anchor: target(item.anchor) };
    case "highlight": return { ...base, text: text(item.text), ...(item.anchor === undefined ? {} : { anchor: target(item.anchor) }) };
    case "card": return { ...base, front: text(item.front), back: text(item.back), ...(item.anchor === undefined ? {} : { anchor: target(item.anchor) }) };
    case "answer": return { ...base, cardId: identifier(item.cardId), rating: number(item.rating, 0, 5) };
    case "schedule": {
      const due = new Date(text(item.dueAt, 50));
      if (!Number.isFinite(+due)) throw invalid();
      return { ...base, cardId: identifier(item.cardId), dueAt: due.toISOString(), intervalDays: number(item.intervalDays, 0, 1e8, false), repetitions: number(item.repetitions, 0, 1e8), easeFactor: number(item.easeFactor, 1, 100, false) };
    }
    case "payload": return { ...base, markdown: text(item.markdown, 1_000_000), ...(item.anchor === undefined ? {} : { anchor: target(item.anchor) }) };
  }
}

const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
function indexEntry(entries, entry) {
  let items = entries.get(entry.document);
  if (!items) entries.set(entry.document, items = new Map());
  items.set(`${entry.type}:${entry.id}`, entry);
}
async function load(log, handle) {
  const stat = regular(await handle.stat({ bigint: true }));
  const signature = fingerprint(stat), existing = cache.get(log);
  if (signature === existing?.signature) return existing;
  const bytes = await handle.readFile(), offset = bytes.lastIndexOf(10) + 1, entries = new Map();
  if (fingerprint(await handle.stat({ bigint: true })) !== signature) throw unsafe();
  try {
    const committed = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    for (const row of committed.split("\n")) {
      if (!row) continue;
      const { v, entry } = JSON.parse(row);
      if (v !== 1 || typeof entry.document !== "string" || typeof entry.at !== "string") throw invalid();
      const normalized = itemAt(entry);
      indexEntry(entries, { ...normalized, document: entry.document, at: entry.at });
    }
  } catch { throw new Error(t("阅读记录损坏，未更改原文件。")); }
  const index = { signature, offset, entries, dirty: !!offset };
  cache.set(log, index);
  return index;
}
function allEntries(index) {
  const entries = [];
  for (const items of index.entries.values()) for (const entry of items.values()) entries.push(entry);
  return entries;
}
async function writeIndex(root, directory, file, index) {
  const temporary = path.join(directory, `.index.${randomUUID()}.tmp`);
  let created = false;
  try {
    const out = await open(temporary, "wx", 0o600);
    created = true;
    try { await out.writeFile(JSON.stringify({ v: 1, bytes: index.offset, entries: allEntries(index) }) + "\n", "utf8"); await out.sync(); }
    finally { await out.close(); }
    await directoryAt(root, directory);
    regular(await info(file));
    await rename(temporary, file);
    index.dirty = false;
  } finally {
    if (created) await unlink(temporary).catch(missing);
  }
}

async function operate({ root, document, current }, request) {
  const directory = path.join(root, ".omarkie"), log = path.join(directory, "store.jsonl"), file = path.join(directory, "index.json");
  const writing = request.action === "put", item = writing ? itemAt(request.item) : null;
  let blocks, types;
  if (request.action === "resolve") {
    if (!Array.isArray(request.blocks) || request.blocks.length > 250_000) throw invalid();
    let size = 0;
    blocks = request.blocks.map(input => {
      const block = blockAt(input);
      size += block.block.length + block.headings.reduce((total, heading) => total + heading.length, 0);
      if (size > 40_000_000) throw invalid();
      return block;
    });
  } else if (request.action === "list") {
    if (request.scope !== undefined && request.scope !== "document" && request.scope !== "vault") throw invalid();
    if (request.types !== undefined) {
      if (!Array.isArray(request.types) || request.types.length > kinds.size || request.types.some(kind => !kinds.has(kind))) throw invalid();
      types = new Set(request.types);
    }
  } else if (!writing) throw invalid();
  if (!current()) throw unsafe();
  if (!await directoryAt(root, directory, writing)) return [];
  const metadata = regular(await info(log));
  if (!metadata && !writing) return [];
  const snapshot = regular(await info(file));
  if (!current()) throw unsafe();
  const flags = writing ? constants.O_CREAT | constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY;
  const handle = await open(log, flags | noFollow, 0o600);
  try {
    const index = await load(log, handle);
    if (writing) {
      if (!current()) throw unsafe();
      const entry = { ...item, document, at: new Date().toISOString() }, row = Buffer.from(JSON.stringify({ v: 1, entry }) + "\n", "utf8");
      const before = await handle.stat({ bigint: true });
      if (fingerprint(before) !== index.signature || !current()) throw unsafe();
      if (before.size !== BigInt(index.offset)) await handle.truncate(index.offset);
      await handle.writeFile(row);
      await handle.sync();
      index.signature = fingerprint(await handle.stat({ bigint: true }));
      index.offset += row.length;
      indexEntry(index.entries, entry);
      index.dirty = true;
      // A failed cache replacement cannot undo a durable journal append.
      await writeIndex(root, directory, file, index).catch(() => {});
      return entry;
    }
    if (index.dirty || !snapshot) await writeIndex(root, directory, file, index).catch(() => {});
    const items = request.scope === "vault" ? allEntries(index) : [...(index.entries.get(document)?.values() ?? [])];
    if (blocks) return resolveReadingAnchors(items.filter(entry => entry.type === "note"), blocks);
    return types ? items.filter(entry => types.has(entry.type)) : items;
  } finally { await handle.close(); }
}

export async function readingStore(store, id, request) {
  if (!request || typeof request !== "object") throw invalid();
  const authorized = await scope(store, id);
  const prior = queues.get(authorized.root) || Promise.resolve();
  const result = prior.then(() => operate(authorized, request));
  const settled = result.catch(() => {});
  queues.set(authorized.root, settled);
  try { return await result; }
  finally { if (queues.get(authorized.root) === settled) queues.delete(authorized.root); }
}

export function readingMarkdown(items) {
  const quote = text => text.replaceAll("\r", "").split("\n").map(line => `> ${line}`).join("\n");
  return items.map(item => {
    const source = quote([item.document, ...(item.anchor?.headings || [])].join(" › "));
    return item.type === "note"
      ? `${source}\n${quote(item.anchor.quote)}\n\n${item.body}`
      : `${source}\n\n${item.front}\n\n${item.back}`;
  }).join("\n\n---\n\n") + "\n";
}
