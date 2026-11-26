// Local process hooks for G22: enhance, generate and speech-to-text.
// Nothing is bundled and no paid API is used: a hook exists only when the person configured one.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { imageDefaults, imageTypeOf } from "../shared/glass-images.mjs";

const hookNames = { enhance: "OMARKIE_ENHANCE", generate: "OMARKIE_IMAGEGEN", stt: "OMARKIE_STT" };
const hookFiles = { enhance: "enhance", generate: "image-gen", stt: "stt" };
const hookLimit = 120_000;
const transcriptLimit = 4_000;

async function commandFor(name, appData) {
  const env = hookNames[name];
  const configured = process.env[env]?.trim()
    || (appData ? (await readFile(path.join(appData, hookFiles[name]), "utf8").catch(() => "")).trim() : "");
  if (!configured) return null;
  let argv;
  try { argv = JSON.parse(configured); } catch { argv = configured; }
  if (!Array.isArray(argv)) argv = [argv];
  if (!argv.length || argv.some(part => typeof part !== "string" || !part)) return null;
  return argv;
}

export async function hookState(appData) {
  const state = {};
  for (const name of Object.keys(hookNames)) state[name] = !!(await commandFor(name, appData));
  return state;
}

function run(argv, { timeout = hookLimit } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], timeout, windowsHide: true });
    const out = [], err = [];
    child.stdout.on("data", chunk => { if (out.length < 64) out.push(chunk); });
    child.stderr.on("data", chunk => { if (err.length < 64) err.push(chunk); });
    child.once("error", reject);
    child.once("exit", code => {
      const stdout = Buffer.concat(out).toString("utf8");
      if (code === 0) { resolve(stdout); return; }
      const stderr = Buffer.concat(err).toString("utf8").trim().slice(0, 400);
      reject(Object.assign(new Error(stderr || `${path.basename(argv[0])} exited with ${code}.`), { code: "HOOK_FAILED", status: code }));
    });
  });
}

// The hook reads one file and writes one file; the caller keeps the only copy in the vault.
export async function runImageHook(name, { input, prompt, appData, extension = "png" } = {}) {
  const argv = await commandFor(name, appData);
  if (!argv) return { ok: false, code: "HOOK_MISSING", hint: `${hookNames[name]} is not configured.` };
  // Generate has no input picture: the prompt is its first argument. Enhance takes the source picture.
  const source = name === "generate" ? String(prompt ?? "").slice(0, 1_000) : String(input ?? "");
  const scratch = await mkdtemp(path.join(os.tmpdir(), `omarkie-${name}-`));
  const output = path.join(scratch, `output.${extension}`);
  try {
    await run([...argv, source, output]);
    const bytes = await readFile(output).catch(() => null);
    if (!bytes?.length) {
      await rmdir(scratch).catch(() => {});
      return { ok: false, code: "HOOK_FAILED", hint: "The hook wrote no picture." };
    }
    if (bytes.length > imageDefaults.maxBytes) {
      await unlink(output).catch(() => {});
      await rmdir(scratch).catch(() => {});
      return { ok: false, code: "OUTPUT_TOO_LARGE", hint: "The hook's picture is too large." };
    }
    const type = imageTypeOf(bytes);
    if (!type) {
      await unlink(output).catch(() => {});
      await rmdir(scratch).catch(() => {});
      return { ok: false, code: "HOOK_FAILED", hint: "The hook did not write a picture." };
    }
    return { ok: true, path: output, bytes, type, scratch };
  } catch (error) {
    await unlink(output).catch(() => {});
    await rmdir(scratch).catch(() => {});
    return { ok: false, code: error?.code ?? "HOOK_FAILED", hint: error?.message ?? "The hook failed." };
  }
}

export async function cleanHookResult(result) {
  if (!result?.scratch) return;
  await unlink(result.path).catch(() => {});
  await rmdir(result.scratch).catch(() => {});
}

// Batch WAV in, transcript out: the same budget G21 uses, so a clinical vault needs no network.
export async function transcribe(wav, { appData, extension = "wav" } = {}) {
  const argv = await commandFor("stt", appData);
  if (!argv) return { ok: false, code: "HOOK_MISSING", hint: "OMARKIE_STT is not configured." };
  if (!Buffer.isBuffer(wav) || !wav.length) return { ok: false, code: "VALIDATION_ERROR", hint: "No audio was recorded." };
  if (wav.length > imageDefaults.maxBytes) return { ok: false, code: "OUTPUT_TOO_LARGE", hint: "The recording is too long." };
  const scratch = await mkdtemp(path.join(os.tmpdir(), "omarkie-stt-"));
  const input = path.join(scratch, `speech.${extension}`);
  try {
    await writeFile(input, wav, { mode: constants.S_IRUSR | constants.S_IWUSR });
    const stdout = await run([...argv, input]);
    const text = String(stdout ?? "").replace(/\r\n?/g, "\n").trim().slice(0, transcriptLimit);
    return text ? { ok: true, text } : { ok: false, code: "HOOK_FAILED", hint: "The speech hook returned no words." };
  } catch (error) {
    return { ok: false, code: error?.code ?? "HOOK_FAILED", hint: error?.message ?? "Speech to text failed." };
  } finally {
    await unlink(input).catch(() => {});
    await rmdir(scratch).catch(() => {});
  }
}
