// Phone companion: a vault copy kept in this browser's IndexedDB. Read, search and edit offline.
// Data moves only when the person picks a folder or zip to import, or downloads an export.
// Nothing here opens a network connection.
import { conflictName } from "../shared/sync-conflicts.mjs";
import { t } from "./i18n";

export interface CompanionNote { path: string; text: string; exported: string }
export interface CompanionStatus { name: string; importedAt: number; exportedAt: number | null; notes: number; images: number; changed: number }
interface Meta { name: string; importedAt: number; exportedAt: number | null }
interface Entry { path: string; bytes: Uint8Array }

const noteFile = /\.(?:md|markdown|mdown)$/i;
const imageTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" };
const sizeLimit = 20 * 1024 * 1024;
let opened: Promise<IDBDatabase> | null = null;

function database() {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("omarkie-companion", 1);
    request.onupgradeneeded = () => {
      for (const store of ["notes", "images"]) request.result.createObjectStore(store, { keyPath: "path" });
      request.result.createObjectStore("meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opened = null; reject(request.error); };
  });
  return opened;
}
function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function write(stores: string[], work: (transaction: IDBTransaction) => void) {
  const transaction = (await database()).transaction(stores, "readwrite");
  work(transaction);
  await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(transaction.error); });
}
async function read<T>(store: string, key?: string): Promise<T> {
  const objects = (await database()).transaction(store).objectStore(store);
  return result((key === undefined ? objects.getAll() : objects.get(key)) as IDBRequest<T>);
}

// Vault-relative path when the file belongs in a companion; null for hidden folders (.stversions,
// .omarkie, .trash), other file types and anything too large.
function wanted(path: string, size: number) {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length || size > sizeLimit || parts.some(part => part.startsWith(".") || part === "node_modules")) return null;
  const relative = parts.join("/");
  return noteFile.test(relative) || imageTypes[relative.split(".").pop()!.toLowerCase()] ? relative : null;
}
function decode(bytes: Uint8Array) {
  const label = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  return new TextDecoder(label).decode(bytes);
}

export async function status(): Promise<CompanionStatus | null> {
  const meta = await read<Meta | undefined>("meta", "vault");
  if (!meta) return null;
  const [notes, images] = await Promise.all([read<CompanionNote[]>("notes"), read<{ path: string }[]>("images")]);
  return { ...meta, notes: notes.length, images: images.length, changed: notes.filter(note => note.text !== note.exported).length };
}
export const notes = () => read<CompanionNote[]>("notes");
export const note = (path: string) => read<CompanionNote | undefined>("notes", path);
export async function images() { return read<{ path: string; blob: Blob }[]>("images"); }
export async function saveNote(path: string, text: string) {
  const current = await note(path);
  if (!current) throw new Error(t("This note is no longer on this device. Save a copy instead."));
  await write(["notes"], transaction => transaction.objectStore("notes").put({ ...current, text }));
}

async function replace(name: string, entries: Entry[], skipped: number) {
  const noteRows: CompanionNote[] = [], imageRows: { path: string; blob: Blob }[] = [];
  for (const entry of entries) {
    if (noteFile.test(entry.path)) { const text = decode(entry.bytes); noteRows.push({ path: entry.path, text, exported: text }); }
    else imageRows.push({ path: entry.path, blob: new Blob([entry.bytes.slice()], { type: imageTypes[entry.path.split(".").pop()!.toLowerCase()] }) });
  }
  if (!noteRows.length) throw new Error(t("No Markdown notes found to import."));
  await write(["notes", "images", "meta"], transaction => {
    for (const store of ["notes", "images", "meta"]) transaction.objectStore(store).clear();
    for (const row of noteRows) transaction.objectStore("notes").put(row);
    for (const row of imageRows) transaction.objectStore("images").put(row);
    transaction.objectStore("meta").put({ name, importedAt: Date.now(), exportedAt: null } satisfies Meta, "vault");
  });
  // Ask the browser not to evict the copy under storage pressure; refusal still leaves it working.
  await navigator.storage?.persist?.().catch(() => false);
  return { notes: noteRows.length, images: imageRows.length, skipped };
}

export async function importFolder(files: FileList | File[]) {
  const list = [...files], name = list[0]?.webkitRelativePath.split("/")[0] || t("Vault");
  const entries: Entry[] = [];
  let skipped = 0;
  for (const file of list) {
    const path = wanted(file.webkitRelativePath.split("/").slice(1).join("/") || file.name, file.size);
    if (path) entries.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) }); else skipped++;
  }
  return replace(name, entries, skipped);
}

export async function importZip(file: File) {
  // fflate loads on demand: only companion import/export needs it, the desktop startup bundle stays as is.
  const { unzip } = await import("fflate"), bytes = new Uint8Array(await file.arrayBuffer());
  let skipped = 0;
  const unpacked = await new Promise<Record<string, Uint8Array>>((resolve, reject) => unzip(bytes, {
    filter: item => !item.name.endsWith("/") && (wanted(item.name, item.originalSize) ? true : (skipped++, false)),
  }, (error, data) => error ? reject(error) : resolve(data)));
  const names = Object.keys(unpacked), top = names[0]?.split("/")[0];
  // A zip of the vault folder itself wraps every entry in that folder: name the vault after it.
  const wrapped = !!top && names.every(name => name.startsWith(top + "/"));
  const entries = names.map(name => ({ path: wanted(wrapped ? name.slice(top.length + 1) : name, 0)!, bytes: unpacked[name] })).filter(entry => entry.path);
  return replace(wrapped ? top : file.name.replace(/\.zip$/i, ""), entries, skipped);
}

// Changed notes leave as conflict copies beside the original, so unzipping into the desktop vault
// overwrites nothing and the desktop offers to compare.
export async function exportChanges() {
  const changed = (await notes()).filter(row => row.text !== row.exported);
  if (!changed.length) return null;
  const { zipSync, strToU8 } = await import("fflate"), now = new Date(), files: Record<string, Uint8Array> = {};
  for (const row of changed) {
    const slash = row.path.lastIndexOf("/");
    files[row.path.slice(0, slash + 1) + conflictName(row.path.slice(slash + 1), "companion", now)] = strToU8(row.text);
  }
  const meta = (await read<Meta>("meta", "vault"));
  const bytes = zipSync(files, { level: 6, mtime: now });
  await write(["notes", "meta"], transaction => {
    for (const row of changed) transaction.objectStore("notes").put({ ...row, exported: row.text });
    transaction.objectStore("meta").put({ ...meta, exportedAt: now.getTime() }, "vault");
  });
  return { name: `${meta.name}-companion-${now.toISOString().slice(0, 10)}.zip`, bytes };
}

export async function forget() {
  await write(["notes", "images", "meta"], transaction => { for (const store of ["notes", "images", "meta"]) transaction.objectStore(store).clear(); });
}
