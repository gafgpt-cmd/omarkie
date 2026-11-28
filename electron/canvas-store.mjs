// JSON Canvas boards inside the open vault: list, read, atomic whole-board save with a base revision.
// Every path is vault-relative, never a symlink and never hidden; the host re-checks the board shape.
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, digest } from "./store.mjs";
import { canvasLimits, emptyCanvas, parseCanvas, serializeCanvas } from "../shared/json-canvas.mjs";

const boardFile = /\.canvas$/i, noteFile = /\.(md|markdown|mdown)$/i;
const noteLimit = 4 * 1024 * 1024, listLimit = 1000, depthLimit = 8;
const nameOrder = new Intl.Collator("en", { numeric: true });

function failure(message, code = "CANVAS_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}
const within = (base, file) => {
  const relative = path.relative(base, file);
  return !!relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
const posix = relative => relative.split(path.sep).join("/");

async function vault(folder) {
  if (!folder) throw failure("Open a notes folder first.", "NO_FOLDER");
  return realpath(folder);
}

// Resolves a vault-relative path the way the renderer wrote it. Missing files are allowed only when
// `existing` is false; their folder must already exist inside the vault.
async function resolve(root, relative, pattern, existing = true) {
  if (typeof relative !== "string" || !relative || relative.length > 1024 || relative.includes("\0") || path.isAbsolute(relative) || /^[a-z]:/i.test(relative))
    throw failure("The board path is not valid.");
  const parts = relative.replace(/\\/g, "/").split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.startsWith("."))) throw failure("The board path is not valid.");
  if (!pattern.test(parts.at(-1))) throw failure(pattern === boardFile ? "Choose a .canvas board." : "Choose a Markdown note.");
  const file = path.join(root, ...parts);
  if (!within(root, file)) throw failure("The file is outside the notes folder.");
  const parent = await realpath(path.dirname(file)).catch(() => null);
  if (!parent || parent !== path.dirname(file)) throw failure("The file is outside the notes folder.");
  const metadata = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (metadata?.isSymbolicLink() || metadata && !metadata.isFile()) throw failure("The file is outside the notes folder.");
  if (!metadata && existing) throw failure("The file no longer exists.", "ENOENT");
  return { file, relative: parts.join("/"), metadata };
}

const decode = bytes => bytes.toString("utf8").replace(/^\uFEFF/, "");

async function read(root, relative) {
  const { file, relative: clean, metadata } = await resolve(root, relative, boardFile);
  if (metadata.size > canvasLimits.bytes) throw failure("The board is larger than 20 MB.", "CANVAS_TOO_LARGE");
  const bytes = await readFile(file);
  return { file: clean, name: path.basename(clean), text: decode(bytes), hash: digest(bytes) };
}

async function currentHash(file) {
  try { return digest(await readFile(file)); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function save(root, request) {
  if (typeof request.text !== "string" || Buffer.byteLength(request.text) > canvasLimits.bytes) throw failure("The board is larger than 20 MB.", "CANVAS_TOO_LARGE");
  parseCanvas(request.text);
  const base = request.base ?? null;
  if (base !== null && (typeof base !== "string" || !/^[a-f0-9]{64}$/.test(base))) throw failure("The board revision is not valid.");
  const { file, relative } = await resolve(root, request.file, boardFile, false);
  const verify = async () => {
    if (await currentHash(file) !== base) throw failure("The board changed on disk. Your edits are kept.", "EXTERNAL_CHANGE");
  };
  await verify();
  const bytes = Buffer.from(request.text, "utf8");
  await atomicWrite(file, bytes, verify);
  return { file: relative, name: path.basename(relative), hash: digest(bytes) };
}

async function create(root, request) {
  const folder = typeof request.folder === "string" && request.folder ? request.folder.replace(/\\/g, "/").replace(/\/+$/, "") : "";
  const stem = String(request.name ?? "").replace(/\.canvas$/i, "").replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ").replace(/^[.\s]+/, "").trim().slice(0, 120) || "Untitled board";
  const text = serializeCanvas(emptyCanvas());
  for (let index = 1; index <= 200; index++) {
    const relative = `${folder ? folder + "/" : ""}${stem}${index > 1 ? ` ${index}` : ""}.canvas`;
    const { file, metadata } = await resolve(root, relative, boardFile, false);
    if (metadata) continue;
    try {
      await atomicWrite(file, Buffer.from(text, "utf8"), async () => { if (await currentHash(file) !== null) throw failure("exists", "EEXIST"); });
    } catch (error) { if (error.code === "EEXIST") continue; throw error; }
    return read(root, relative);
  }
  throw failure("Choose another board name.");
}

async function list(root) {
  const files = [];
  let truncated = false;
  const walk = async (directory, depth) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (depth === 0) throw error; return; }
    entries.sort((a, b) => nameOrder.compare(a.name, b.name));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (depth < depthLimit) await walk(file, depth + 1); continue; }
      if (!entry.isFile() || !boardFile.test(entry.name)) continue;
      if (files.length >= listLimit) { truncated = true; return; }
      const metadata = await lstat(file).catch(() => null);
      if (!metadata?.isFile()) continue;
      files.push({ file: posix(path.relative(root, file)), name: entry.name, modified: metadata.mtimeMs / 1000 });
    }
  };
  await walk(root, 0);
  return { files, truncated };
}

// File cards show a note (or one heading of it). Missing notes are a state, not an error.
async function note(root, relative) {
  let resolved;
  try { resolved = await resolve(root, relative, noteFile); }
  catch (error) { if (error.code === "ENOENT") return { file: relative, missing: true }; throw error; }
  if (resolved.metadata.size > noteLimit) throw failure("The note is too large to preview.");
  const bytes = await readFile(resolved.file);
  return { file: resolved.relative, text: decode(bytes), hash: digest(bytes) };
}

export async function canvasRequest(folder, request) {
  if (!request || typeof request !== "object") throw failure("Unknown board action.");
  const root = await vault(folder);
  switch (request.action) {
    case "list": return list(root);
    case "read": return read(root, request.file);
    case "save": return save(root, request);
    case "create": return create(root, request);
    case "note": return note(root, request.file);
    default: throw failure("Unknown board action.");
  }
}
