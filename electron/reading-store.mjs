import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { t } from "./i18n.mjs";
import readingCore from "../shared/reading-core.cjs";
import { atomicWrite, digest } from "./store.mjs";
import { moveExclusive } from "./move-exclusive.mjs";

const { validate, putDocument, checkMove, checkPending, tracked, validPath, readJournal, applyRow, pending, badRows, hasTrash, query, readingMarkdown, imageType, imageItem, maxImageBytes } = readingCore(digest, t);
export { readingMarkdown };

const queues = new Map(), cache = new Map();
const noFollow = (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
const invalid = () => new Error(t("阅读图层数据无效。"));
const unsafe = () => new Error(t("阅读数据路径不安全。"));
const missing = error => { if (error.code !== "ENOENT") throw error; return null; };
const info = file => lstat(file).catch(missing);
const absent = error => error.code === "ENOTDIR" ? null : missing(error);
const denied = error => ["EACCES", "EPERM", "EROFS"].includes(error.code);
const purgeMarker = /^purge-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
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
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== "EEXIST") {
        if (create !== "move" || !denied(error)) throw error;
        metadata = await info(directory);
        if (!metadata) return false;
      }
    }
    metadata ??= await info(directory);
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
  const committed = bytes.subarray(0, offset), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let text;
  try { text = decoder.decode(committed); }
  catch {
    const rows = [];
    for (let start = 0, end; (end = committed.indexOf(10, start)) >= 0; start = end + 1) {
      try { rows.push(decoder.decode(committed.subarray(start, end))); } catch { rows.push("!"); }
    }
    text = rows.join("\n");
  }
  const entries = readJournal(text);
  const index = { signature, offset, entries };
  cache.set(log, index);
  return index;
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
      const code = lastError();
      if ([5, 19].includes(code)) throw Object.assign(unsafe(), { code: "EACCES" });
      if (code !== 32) throw unsafe();
    };
  });
  return (await lockAPI)(lock);
}

async function locked(root, create, run) {
  const directory = path.join(root, ".omarkie"), lock = path.join(directory, "journal.lock");
  if (!await directoryAt(root, directory, create)) return run(false);
  const uninitialized = async () => !await info(path.join(directory, "store.jsonl")) && !await info(lock);
  if (!create && await uninitialized()) return run(false);
  const deadline = performance.now() + 3000;
  for (;;) {
    let release;
    try { release = await acquire(lock); }
    catch (error) {
      if (create === "move" && denied(error) && await uninitialized()) return run(false);
      throw error;
    }
    if (release) { try { return await run(true); } finally { await release(); } }
    if (process.env.NODE_TEST_CONTEXT && process.send) process.send("journal-lock-contended");
    if (performance.now() >= deadline) throw unsafe();
    await delay(20);
  }
}

async function moveFingerprint(root, prefix, files, skipMissing = false) {
  const rows = [], measured = [];
  if (!files.length && !skipMissing) {
    const target = path.join(root, prefix);
    if (!within(root, target) || process.platform === "win32" && prefix.includes("\\")) return null;
    const metadata = await lstat(target, { bigint: true }).catch(absent);
    if ((!metadata?.isFile() && !metadata?.isDirectory()) || await realpath(target).catch(absent) !== target) return null;
    return { fingerprint: `0:${digest(`${metadata.dev}:${metadata.ino}`)}`, files };
  }
  for (const suffix of files) {
    const file = suffix ? `${prefix}/${suffix}` : prefix;
    if (process.platform === "win32" && file.includes("\\")) throw unsafe();
    const target = path.join(root, file);
    if (!within(root, target)) throw unsafe();
    const metadata = await lstat(target).catch(absent);
    if (!metadata?.isFile() || await realpath(target).catch(absent) !== target) { if (skipMissing) continue; return null; }
    const handle = await open(target, constants.O_RDONLY | noFollow).catch(absent);
    if (!handle) { if (skipMissing) continue; return null; }
    let size = 0;
    const hash = createHash("sha256");
    try {
      if (!(await handle.stat()).isFile()) return null;
      for await (const chunk of handle.createReadStream({ autoClose: false })) { size += chunk.length; hash.update(chunk); }
    } finally { await handle.close(); }
    const marker = `${size}:${hash.digest("hex")}`;
    measured.push(suffix);
    rows.push(suffix, marker);
  }
  if (measured.length === 1 && measured[0] === "") return { fingerprint: rows[1], files: measured };
  const bytes = Buffer.from(rows.join("\0"));
  return { fingerprint: `${bytes.length}:${digest(bytes)}`, files: measured };
}

async function transaction(root, writing, run) {
  const log = path.join(root, ".omarkie", "store.jsonl");
  const metadata = regular(await info(log));
  if (!metadata && !writing) return run(null);
  const flags = (writing ? constants.O_CREAT : 0) | constants.O_RDWR | constants.O_APPEND;
  const handle = await open(log, flags | noFollow, 0o600);
  try {
    let index = await load(log, handle);
    const append = async record => {
      const before = regular(await handle.stat({ bigint: true }));
      if (fingerprint(before) !== index.signature) throw unsafe();
      if (before.size !== BigInt(index.offset)) {
        if (process.platform === "win32") {
          // Windows append handles lack truncate access.
          const repair = await open(log, constants.O_RDWR | noFollow);
          try {
            if (fingerprint(regular(await repair.stat({ bigint: true }))) !== index.signature) throw unsafe();
            await repair.truncate(index.offset);
          } finally { await repair.close(); }
        } else await handle.truncate(index.offset);
      }
      const row = JSON.stringify({ v: 1, ...record });
      await handle.writeFile(row + "\n");
      await handle.sync();
      const after = regular(await handle.stat({ bigint: true }));
      const offset = index.offset + Buffer.byteLength(row) + 1;
      if (after.size !== BigInt(offset)) { index = await load(log, handle); return; }
      applyRow(index.entries, row);
      index = { signature: fingerprint(after), offset, entries: index.entries };
      cache.set(log, index);
    };
    const intent = pending(index.entries);
    let notice = badRows(index.entries) > 0;
    if (notice) console.warn("Reading journal skipped invalid rows.");
    if (intent) {
      const { from, to, fingerprint, files = [""] } = intent;
      try {
        const source = (await moveFingerprint(root, from, files))?.fingerprint === fingerprint, destination = (await moveFingerprint(root, to, files))?.fingerprint === fingerprint;
        if (source !== destination) await append(destination ? { move: { from, to } } : { cancel: true });
        else { notice = true; console.warn("Reading move recovery could not identify the original document."); }
      } catch { notice = true; console.warn("Reading move recovery could not confirm the destination."); }
    }
    const names = await readdir(path.dirname(log)).catch(() => { notice = true; return []; });
    for (const name of names) {
      const id = purgeMarker.exec(name)?.[1];
      if (!id) continue;
      try {
        if (hasTrash(index.entries, id)) await append({ purgeTrash: id });
        await unlink(path.join(path.dirname(log), name));
      } catch { notice = true; }
    }
    return await run(index.entries, append, notice);
  } finally { await handle.close(); }
}

export async function recoverReadingVault(root) {
  try { return await locked(root, false, exists => exists && transaction(root, false, (_, __, notice) => !!notice)); }
  catch (error) { console.warn("Reading journal recovery:", error.code ?? error.name); return true; }
}

export async function moveReadingEntries(folder, execute, trashPath) {
  if (!folder) return execute();
  const root = await realpath(folder);
  const relative = file => path.relative(root, file).split(path.sep).join("/");
  return queued(root, () => locked(root, "move", exists => !exists ? execute() : transaction(root, false, async (entries, append) => {
    const trashed = entries && trashPath && within(root, trashPath) ? { path: relative(trashPath), id: randomUUID() } : null;
    if (trashed && !validPath(trashed.path)) throw invalid();
    if (trashed) { checkPending(entries, trashed.path, true); await append({ trash: trashed }); }
    let change;
    try { change = await execute(async (source, destination) => {
    if (entries && within(root, source) && within(root, destination)) {
      const from = relative(source), to = relative(destination);
      try { checkMove(from, to); } catch { throw invalid(); }
      checkPending(entries, from, true); checkPending(entries, to, true);
      const files = tracked(entries, from);
      let evidence;
      try { evidence = await moveFingerprint(root, from, files, true); } catch {}
      if (!evidence) throw new Error(t("Cannot move a tracked note that is unreadable."));
      const collisions = [];
      for (const suffix of tracked(entries, to)) {
        const candidate = suffix ? path.join(source, suffix) : source;
        if (!within(root, candidate) || process.platform === "win32" && suffix.includes("\\")) continue;
        if (await lstat(candidate).then(stat => stat.isFile(), () => false) && await realpath(candidate).catch(() => null) === candidate) collisions.push(suffix);
      }
      if (!evidence.files.length) {
        if (!collisions.length) return moveExclusive(source, destination);
        evidence = await moveFingerprint(root, from, []);
        if (!evidence) return moveExclusive(source, destination);
      }
      if (pending(entries)) throw unsafe();
      await append({ intent: { from, to, ...evidence, collisions } });
      try { await moveExclusive(source, destination); }
      catch (error) { await append({ cancel: true }).catch(() => {}); throw error; }
      await append({ move: { from, to } }).catch(() => {});
    } else await moveExclusive(source, destination);
    }); } catch (error) {
      if (trashed) await append({ restore: trashed });
      throw error;
    }
    if (trashed) {
      try { await append({ purgeTrash: trashed.id }); }
      catch {
        const marker = await open(path.join(root, ".omarkie", `purge-${trashed.id}`), "wx", 0o600);
        await marker.close();
      }
    }
    return change;
  })));
}

async function imagePath(root, hash, create) {
  const dir = path.join(root, ".omarkie", "scraps");
  if (create) await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  if (await realpath(dir) !== dir || !(await lstat(dir)).isDirectory()) throw unsafe();
  const file = path.join(dir, hash);
  regular(await info(file));
  return file;
}

async function readImage(file, hash) {
  const handle = await open(file, constants.O_RDONLY | noFollow);
  try {
    const { size } = regular(await handle.stat());
    if (size < 12 || size > maxImageBytes) throw invalid();
    const bytes = Buffer.allocUnsafe(size), { bytesRead } = await handle.read(bytes);
    if (bytesRead !== size || digest(bytes) !== hash) throw invalid();
    return bytes;
  } finally { await handle.close(); }
}

async function operate({ root, document, current }, request, remoteBytes) {
  let validated;
  let bytes, item;
  try {
    validated = validate(request);
    item = validated.item;
    if (remoteBytes || validated.imageBytes) {
      bytes = remoteBytes ?? Buffer.from(validated.imageBytes, "base64");
      if (bytes.length < 12 || bytes.length > maxImageBytes) throw invalid();
      imageType(bytes.toString("hex", 0, 12));
      item = imageItem(request, digest(bytes));
    }
  } catch { throw invalid(); }
  const writing = !!item;
  const empty = validated.study ? { entries: [], locations: [] } : [];
  return locked(root, writing, exists => {
    if (!exists) {
      if (validated.imageHash) throw invalid();
      return empty;
    }
    return transaction(root, writing, async (entries, append) => {
      const source = path.join(root, document);
      if (!current() || await realpath(source) !== source || !(await lstat(source)).isFile() || !current()) throw unsafe();
      if (validated.imageHash) {
        const bytes = await readImage(await imagePath(root, validated.imageHash, false), validated.imageHash);
        return `data:image/${imageType(bytes.toString("hex", 0, 12))};base64,${bytes.toString("base64")}`;
      }
      if (!entries) return empty;
      if (!item) return query(entries, document, validated);
      const entry = { ...item, document: putDocument(entries, document, item, validated.owner), at: new Date().toISOString() };
      if (bytes) {
        const hash = item.image.hash, file = await imagePath(root, hash, true);
        if (await info(file)) await readImage(file, hash);
        else await atomicWrite(file, bytes, () => imagePath(root, hash, false));
      }
      await append({ entry });
      return entry;
    });
  });
}

async function queued(root, run) {
  const prior = queues.get(root) || Promise.resolve();
  const result = prior.then(run);
  const settled = result.catch(() => {});
  queues.set(root, settled);
  try { return await result; }
  finally { if (queues.get(root) === settled) queues.delete(root); }
}

export async function readingStore(store, id, request) {
  if (!request || typeof request !== "object") throw invalid();
  const authorized = await scope(store, id);
  let remoteBytes;
  if (request.action === "putImage" && request.address !== undefined) {
    let address;
    try { address = typeof request.address === "string" && request.address.length <= 8192 && new URL(request.address); } catch { throw invalid(); }
    if (!address || address.protocol !== "https:" || address.username || address.password || request.bytes !== undefined) throw invalid();
    const { downloadImage } = await import("./image-actions.mjs");
    ({ bytes: remoteBytes } = await downloadImage(address, { redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" }));
  }
  return queued(authorized.root, () => operate(authorized, request, remoteBytes));
}
