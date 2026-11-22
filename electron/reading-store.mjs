import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { t } from "./i18n.mjs";
import readingCore from "../shared/reading-core.cjs";
import { digest } from "./store.mjs";
import { moveExclusive } from "./move-exclusive.mjs";

const { validate, putDocument, readJournal, pending, allEntries, query, readingMarkdown } = readingCore(digest);
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
  const chunks = [];
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) chunks.push(chunk);
  const bytes = Buffer.concat(chunks), offset = bytes.lastIndexOf(10) + 1;
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

let lockAPI;
async function acquire(lock) {
  lockAPI ??= import("koffi").then(({ default: koffi }) => {
    if (process.platform !== "win32") {
      const flock = koffi.load(null).func("int flock(int fd, int operation)");
      return async lock => {
        const handle = await open(lock, constants.O_CREAT | constants.O_RDWR | noFollow, 0o600);
        try {
          regular(await handle.stat());
          if (flock(handle.fd, 6) === 0) return () => handle.close();
          if (![4, 11, 35].includes(koffi.errno())) throw unsafe();
        } catch (error) { await handle.close(); throw error; }
        await handle.close();
      };
    }
    const dll = koffi.load("kernel32.dll");
    const create = dll.func("intptr_t __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)");
    const lastError = dll.func("uint32 __stdcall GetLastError()");
    const close = dll.func("int __stdcall CloseHandle(intptr_t)");
    return async lock => {
      regular(await info(lock));
      const handle = create(path.toNamespacedPath(lock), 0x40000000, 0, null, 4, 0x00200080, null);
      if (handle !== -1 && handle !== -1n) return () => close(handle);
      if (lastError() !== 32) throw unsafe();
    };
  });
  return (await lockAPI)(lock);
}

async function locked(root, create, run) {
  const directory = path.join(root, ".omarkie"), lock = path.join(directory, "journal.lock");
  if (!await directoryAt(root, directory, create)) return run(false);
  const deadline = performance.now() + 3000;
  for (;;) {
    const release = await acquire(lock);
    if (release) { try { return await run(true); } finally { await release(); } }
    if (performance.now() >= deadline) throw unsafe();
    await delay(20);
  }
}

async function existsAt(root, file) {
  const target = path.join(root, file);
  if (!within(root, target)) throw unsafe();
  const metadata = await lstat(target, { bigint: true }).catch(missing);
  if (!metadata) return false;
  if (metadata.isSymbolicLink() || await realpath(target) !== target) throw unsafe();
  return true;
}

async function transaction(root, writing, run) {
  const directory = path.join(root, ".omarkie"), log = path.join(directory, "store.jsonl"), file = path.join(directory, "index.json");
  const metadata = regular(await info(log));
  if (!metadata && !writing) return run(null);
  const snapshot = regular(await info(file));
  const flags = (writing ? constants.O_CREAT : 0) | constants.O_RDWR | constants.O_APPEND;
  const handle = await open(log, flags | noFollow, 0o600);
  try {
    let index = await load(log, handle);
    const append = async record => {
      const before = regular(await handle.stat({ bigint: true }));
      if (fingerprint(before) !== index.signature) throw unsafe();
      if (before.size !== BigInt(index.offset)) await handle.truncate(index.offset);
      await handle.writeFile(JSON.stringify({ v: 1, ...record }) + "\n");
      await handle.sync();
      index = await load(log, handle);
    };
    const intent = pending(index.entries);
    let notice = false;
    if (intent) {
      const { from, to } = intent;
      try {
        const source = await existsAt(root, from), destination = await existsAt(root, to);
        notice = source === destination;
        await append(!source && destination ? { move: { from, to } } : { cancel: true });
      } catch { notice = true; }
      if (notice) console.warn("Reading move recovery could not confirm the destination.");
    }
    const result = await run(index.entries, append, notice);
    if (index.dirty || !snapshot) await writeIndex(root, directory, file, index).catch(() => {});
    return result;
  } finally { await handle.close(); }
}

export async function recoverReadingVault(root) {
  try { return await locked(root, false, exists => exists && transaction(root, false, (_, __, notice) => !!notice)); }
  catch (error) { console.warn("Reading journal recovery:", error.code ?? error.name); return true; }
}

export async function moveReadingEntries(folder, execute) {
  if (!folder) return execute();
  const root = await realpath(folder);
  return locked(root, true, () => transaction(root, false, (entries, append) => execute(async (source, destination) => {
    if (entries && within(root, source) && within(root, destination)) {
      const relative = file => path.relative(root, file).split(path.sep).join("/");
      const from = relative(source), to = relative(destination);
      if (pending(entries) || from === to) throw unsafe();
      await append({ intent: { from, to } });
      await moveExclusive(source, destination);
      await append({ move: { from, to } }).catch(() => {});
    } else await moveExclusive(source, destination);
  })));
}

async function operate({ root, document, current }, request) {
  let validated;
  try { validated = validate(request); } catch { throw invalid(); }
  const { item } = validated, writing = !!item;
  return locked(root, writing, exists => {
    if (!exists) return [];
    return transaction(root, writing, async (entries, append) => {
      const source = path.join(root, document);
      if (!current() || await realpath(source) !== source || !(await lstat(source)).isFile() || !current()) throw unsafe();
      if (!entries) return [];
      if (!item) return query(entries, document, validated);
      const entry = { ...item, document: putDocument(entries, document, item, validated.owner), at: new Date().toISOString() };
      await append({ entry });
      return entry;
    });
  });
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
