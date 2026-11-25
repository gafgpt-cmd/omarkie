import { spawn } from "node:child_process";
import { access, constants, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hookArguments } from "./cli-hook.mjs";

// G17 optional OCR hook: OMARKIE_OCR names a local command; nothing is bundled. The reference
// intake is pdf-md-pipeline's RapidOCR pass plus its cleanup, whose path comes from config:
//   "<pdf-md-pipeline>/tools/image_intake.py" "{image}" -o "{outdir}" --engine rapidocr
// The command gets a temporary PNG, either where `{image}` stands or as its last argument, writes
// text or Markdown to {outdir} or prints it, and never touches the network.
export const ocrLimits = { png: 8 * 1024 * 1024, text: 20_000, stdout: 1024 * 1024, stderr: 16 * 1024, timeout: 30_000 };

export const ocrPlaceholder = "{image}";

export function ocrArgv(configured = process.env.OMARKIE_OCR) {
  const argv = hookArguments(String(configured ?? "").trim());
  return argv && argv.length ? argv : null;
}

async function executable(command, environment = process.env) {
  const candidates = path.isAbsolute(command) || /[\\/]/.test(command) ? [command]
    : (environment.PATH || "").split(path.delimiter).filter(Boolean).map(root => path.join(root, command));
  for (const file of candidates) {
    try {
      await access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      if ((await stat(file)).isFile()) return file;
    } catch { /* try the next PATH entry */ }
  }
  return null;
}

export async function ocrAvailable(environment = process.env) {
  const argv = ocrArgv(environment.OMARKIE_OCR);
  if (!argv) return false;
  return !!(await executable(argv[0], environment));
}

function commandLine(argv, image) {
  const args = argv.slice(1).map(part => part === ocrPlaceholder ? image : part);
  if (!argv.slice(1).some(part => part === ocrPlaceholder)) args.push(image);
  return { command: argv[0], args };
}

function run(command, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", overflow = false, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("The OCR command took too long.")); }, timeout);
    timer.unref?.();
    child.stdout.on("data", chunk => {
      if (stdout.length + chunk.length > ocrLimits.stdout) { overflow = true; child.kill("SIGKILL"); return; }
      stdout += chunk;
    });
    child.stderr.on("data", chunk => { if (stderr.length < ocrLimits.stderr) stderr += chunk; });
    child.on("error", error => finish(error.code === "ENOENT"
      ? new Error("The OCR command was not found. Check OMARKIE_OCR.")
      : new Error(`The OCR command could not start: ${error.message}`)));
    child.once("close", code => {
      if (overflow) return finish(new Error("The OCR command printed too much text."));
      if (code !== 0) {
        const detail = stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${code}`;
        return finish(new Error(`The OCR command failed: ${detail.slice(0, 200)}`));
      }
      const text = stdout.replace(/\r\n?/g, "\n").trim();
      if (!text) return finish(new Error("The OCR command found no text."));
      finish(undefined, { text: text.slice(0, ocrLimits.text) });
    });
  });
}

export async function runOcr(png, { environment = process.env, timeout = ocrLimits.timeout } = {}) {
  const argv = ocrArgv(environment.OMARKIE_OCR);
  if (!argv) throw new Error("Set OMARKIE_OCR to a local OCR command to read ink.");
  const bytes = Buffer.isBuffer(png) ? png : Buffer.from(String(png ?? ""), "base64");
  if (!bytes.length || bytes.length > ocrLimits.png) throw new Error("The ink image is empty or too large to read.");
  const folder = await mkdtemp(path.join(tmpdir(), "omarkie-ocr-"));
  const image = path.join(folder, "ink.png");
  try {
    await writeFile(image, bytes, { mode: 0o600 });
    const { command, args } = commandLine(argv, image);
    return await run(command, args, timeout);
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

export function dataUrlBytes(value) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(typeof value === "string" ? value : "");
  return match ? Buffer.from(match[1], "base64") : null;
}
