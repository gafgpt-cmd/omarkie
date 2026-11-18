import { readdir, readFile, realpath, lstat, mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { decodeText } from "./store.mjs";
import { t } from "./i18n.mjs";
const asset = /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|ogg|mp3|wav|m4a)$/i;
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); };
async function owned(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part.startsWith(".") && part !== ".assets") || /[:\0]/.test(relative)) throw new Error(t("知识库路径无效"));
  const file = path.resolve(root, relative);
  if (!inside(root, file) || await realpath(file) !== file) throw new Error(t("知识库路径无效"));
  return file;
}
export async function vaultSnapshot(store) {
  if (!store.folder) throw new Error(t("请先打开文件夹"));
  const inventory = await store.scan(), root = inventory.folder, notes = [], assets = [];
  let truncated = inventory.truncated || inventory.skipped > 0, total = 0, entries = 0;
  const deadline = Date.now() + 5000;
  for (const entry of inventory.files.filter(entry => entry.isDirectory !== "true")) {
    if (Date.now() > deadline) { truncated = true; break; }
    const file = await owned(root, entry.relative), info = await lstat(file);
    if (!info.isFile() || info.size > 8 * 1024 * 1024 || total + info.size > 64 * 1024 * 1024) { truncated = true; continue; }
    const bytes = await readFile(file); total += bytes.length;
    try { notes.push({ token: entry.token, relative: entry.relative.split(path.sep).join("/"), content: decodeText(bytes).content, path: file }); }
    catch { truncated = true; }
  }
  async function walk(directory, depth) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 50000 || Date.now() > deadline) { truncated = true; return; }
      if (entry.name.startsWith(".") && !(entry.name === ".assets" && entry.isDirectory()) || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (depth < 12) await walk(file, depth + 1); else truncated = true; }
      else if (entry.isFile() && asset.test(entry.name)) assets.push({ relative: path.relative(root, file).split(path.sep).join("/") });
    }
  }
  await walk(root, 0);
  return { notes, assets, truncated };
}
export async function exportBundle(store, payload, parent) {
  if (!store.folder || !payload || !Array.isArray(payload.notes) || !Array.isArray(payload.assets) || payload.notes.length > 1000 || payload.assets.length > 50000 || typeof payload.index !== "string" || typeof payload.log !== "string") throw new Error(t("压缩包无效"));
  const source = await realpath(store.folder), target = await realpath(parent);
  if (inside(source, target)) throw new Error(t("请选择知识库之外的目标位置"));
  const names = new Set(["index.md", "log.md"]); let total = 0;
  function destination(relative) {
    if (typeof relative !== "string" || !relative || /^[\\/]|[:\0]/.test(relative) || relative.split(/[\\/]/).some(part => !part || part.startsWith(".") && part !== ".assets") || names.has(relative.toLowerCase())) throw new Error(t("压缩包路径无效"));
    names.add(relative.toLowerCase()); return relative;
  }
  const notes = payload.notes.map(note => {
    const file = store.fileTokens.get(note.token);
    if (!file || !inside(source, file) || typeof note.content !== "string" || Buffer.byteLength(note.content) > 8 * 1024 * 1024 || (total += Buffer.byteLength(note.content)) > 64 * 1024 * 1024) throw new Error(t("压缩包无效"));
    return { ...note, relative: destination(note.relative) };
  });
  const assets = [];
  for (const item of payload.assets) {
    if (!asset.test(item.source)) throw new Error(t("压缩包无效"));
    const file = await owned(source, item.source), info = await lstat(file);
    if (!info.isFile() || info.size > 100 * 1024 * 1024 || (total += info.size) > 512 * 1024 * 1024) throw new Error(t("压缩包超过大小限制"));
    assets.push({ file, relative: destination(item.relative) });
  }
  if (Buffer.byteLength(payload.index) + Buffer.byteLength(payload.log) > 2 * 1024 * 1024) throw new Error(t("压缩包无效"));
  const output = path.join(target, "knowledge-bundle-" + randomUUID());
  await mkdir(output, { mode: 0o700 });
  // A fresh directory and exclusive writes never overwrite an existing bundle or the vault.
  for (const note of [...notes, { relative: "index.md", content: payload.index }, { relative: "log.md", content: payload.log }]) {
    const file = path.join(output, note.relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, note.content, { encoding: "utf8", flag: "wx" });
  }
  for (const item of assets) { const file = path.join(output, item.relative); await mkdir(path.dirname(file), { recursive: true }); await copyFile(item.file, file, 1); }
  return output;
}
