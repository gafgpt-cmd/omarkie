import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { t } from "./i18n.mjs";
const exec = promisify(execFile);

// PDFs open as a Markdown copy made by an external converter, called as `<converter...> <file.pdf> --output <folder>`.
// It is configured as an executable path or a JSON argv array, in OMARKIE_PDF_CONVERTER or the data folder's
// `pdf-converter` file, else found on PATH as `pdf-md`. Without one, the PDF opens in the system viewer instead.
export const isPdf = file => /\.pdf$/i.test(file);
export async function pdfConverter(dataDir, environment = process.env) {
  const configured = environment.OMARKIE_PDF_CONVERTER || (await readFile(path.join(dataDir, "pdf-converter"), "utf8").catch(() => "")).trim();
  const names = process.platform === "win32" ? ["pdf-md.exe", "pdf-md.cmd"] : ["pdf-md"];
  const candidates = configured
    ? [configured.startsWith("[") ? JSON.parse(configured) : [configured]]
    : (environment.PATH || "").split(path.delimiter).filter(Boolean).flatMap(root => names.map(name => [path.join(root, name)]));
  for (const argv of candidates) {
    if (!Array.isArray(argv) || !argv.length || argv.some(part => typeof part !== "string")) throw new Error(t("PDF 转换器设置无效。"));
    try { await access(argv[0]); return argv; } catch {}
  }
  return null;
}
async function markdownIn(folder, depth = 0) {
  let best = null;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory() && depth < 2) { const found = await markdownIn(file, depth + 1); if (found && (!best || found.size > best.size)) best = found; }
    else if (entry.isFile() && /\.md$/i.test(entry.name)) { const { size } = await stat(file); if (!best || size > best.size) best = { file, size }; }
  }
  return best;
}
// One copy per PDF version (path, size, modification time): reopening an unchanged PDF needs no conversion.
export async function convertPdf(file, dataDir, converter, timeout = 30 * 60 * 1000) {
  const source = await realpath(file), { size, mtimeMs } = await stat(source);
  const key = createHash("sha256").update(`${source}\0${size}\0${mtimeMs}`).digest("hex").slice(0, 12);
  const root = path.join(dataDir, "PDF"), folder = path.join(root, `${path.basename(source).replace(/\.pdf$/i, "").replace(/[^\p{L}\p{N} _.-]/gu, "-").slice(0, 80)}-${key}`);
  const cached = await markdownIn(folder).catch(() => null);
  if (cached) return cached.file;
  const partial = path.join(root, `.${randomUUID()}.partial`);
  await mkdir(partial, { recursive: true });
  try {
    await exec(converter[0], [...converter.slice(1), source, "--output", partial], { timeout, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
    if (!await markdownIn(partial)) throw new Error(t("PDF 转换器没有生成 Markdown 文件。"));
    await rename(partial, folder);
    return (await markdownIn(folder)).file;
  } finally { await rm(partial, { recursive: true, force: true }); }
}
