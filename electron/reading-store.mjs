import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { t } from "./i18n.mjs";
import readingCore from "../shared/reading-core.cjs";
import { digest } from "./store.mjs";

const { validate, indexEntry, readJournal, allEntries, query, readingMarkdown } = readingCore(digest);
export { readingMarkdown };

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

const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
async function load(log, handle) {
  const stat = regular(await handle.stat({ bigint: true }));
  const signature = fingerprint(stat), existing = cache.get(log);
  if (signature === existing?.signature) return existing;
  const bytes = await handle.readFile(), offset = bytes.lastIndexOf(10) + 1;
  if (fingerprint(await handle.stat({ bigint: true })) !== signature) throw unsafe();
  let entries;
  try { entries = readJournal(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset))); }
  catch { throw new Error(t("阅读记录损坏，未更改原文件。")); }
  const index = { signature, offset, entries, dirty: !!offset };
  cache.set(log, index);
  return index;
}
async function writeIndex(root, directory, file, index) {
  const temporary = path.join(directory, `.index.${randomUUID()}.tmp`);
  let created = false;
  try {
    const out = await open(temporary, "wx", 0o600);
    created = true;
    try { await out.writeFile(JSON.stringify({ v: 1, bytes: index.offset, entries: allEntries(index.entries) }) + "\n", "utf8"); await out.sync(); }
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
  let validated;
  try { validated = validate(request); } catch { throw invalid(); }
  const { item } = validated, writing = !!item;
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
    return query(index.entries, document, validated);
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
