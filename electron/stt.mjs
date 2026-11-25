// G21: run the user's local speech-to-text hook. One process per utterance; the audio path
// travels in OMARKIE_STT_AUDIO, never interpolated into a shell string. No network here.
import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cleanTranscript, voiceDefaults } from "../shared/voice.mjs";

export const sttFailures = {
  "hook-missing": "The speech hook could not start.",
  "no-speech": "No speech was heard.",
  "bad-audio": "The audio was rejected by the speech hook.",
  "no-model": "The speech model is missing.",
  "language-unsupported": "The speech hook cannot use that language.",
  "config": "The speech hook needs configuration.",
  io: "The speech hook hit a temporary file error.",
  "not-found": "The speech hook command was not found.",
  failed: "The speech hook failed.",
  timeout: "The speech hook took too long.",
  cancelled: "The recording was cancelled.",
};

const exitCodes = { 2: "no-speech", 3: "bad-audio", 4: "no-model", 5: "language-unsupported", 64: "config", 75: "io", 127: "not-found" };
const stdoutBytes = 4 * 1024 * 1024, stderrBytes = 8 * 1024;

export function sttConfigured(environment = process.env) {
  return typeof environment.OMARKIE_STT === "string" && environment.OMARKIE_STT.trim().length > 0;
}

// A bare value is one executable; `["cmd", "arg"]` adds arguments. `{wav}` is an opt-in placeholder.
export function sttArgv(configured) {
  const value = typeof configured === "string" ? configured.trim() : "";
  if (!value) return null;
  let argv;
  try { argv = value.startsWith("[") ? JSON.parse(value) : [value]; }
  catch { return null; }
  return Array.isArray(argv) && argv.length && argv.every(part => typeof part === "string" && part && !part.includes("\0")) ? argv : null;
}

// PTT is one short utterance; memo and lecture chunks may be a full minute each.
export function sttTimeout(mode) {
  return mode === "dictation" || mode === "ask" ? 20_000 : 120_000;
}

function killTree(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); }
  catch { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
  setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  }, 500).unref?.();
}

export function runStt({ argv, audio, language = "auto", mode = "dictation", timeoutMs, environment = process.env, signal }) {
  const [command, ...rest] = argv ?? [];
  if (!command) return Promise.resolve({ ok: false, code: "hook-missing", text: null, message: sttFailures["hook-missing"] });
  const args = rest.map(part => part.split("{wav}").join(audio));
  const env = { ...environment, OMARKIE_STT_AUDIO: audio, OMARKIE_STT_LANG: language || "auto",
    OMARKIE_STT_MODE: mode, OMARKIE_STT_TIMESTAMPS: "none", OMARKIE_STT_PROTOCOL: "text" };
  const limit = timeoutMs ?? sttTimeout(mode);
  return new Promise(resolve => {
    let settled = false, failure, stdout = "", stderr = "", timer;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", cancel);
      resolve(value);
    };
    const cancel = () => { killTree(child); finish({ ok: false, code: "cancelled", text: null, message: sttFailures.cancelled }); };
    let child;
    try {
      child = spawn(command, args, {
        cwd: path.dirname(audio), env, windowsHide: true, detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, code: "hook-missing", text: null, message: error.message });
      return;
    }
    child.on("error", error => {
      failure = error;
      if (["ENOENT", "EACCES", "EPERM", "EISDIR"].includes(error.code)) finish({ ok: false, code: "hook-missing", text: null, message: error.message });
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { if (stdout.length < stdoutBytes) stdout += chunk.slice(0, stdoutBytes - stdout.length); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-stderrBytes); });
    child.once("close", code => {
      if (settled) return;
      if (failure && !code) { finish({ ok: false, code: "hook-missing", text: null, message: failure.message, stderr }); return; }
      if (code !== 0) {
        const mapped = exitCodes[code] ?? "failed";
        finish({ ok: false, code: mapped, text: null, message: sttFailures[mapped], exit: code, stderr: stderr.trim() });
        return;
      }
      const text = cleanTranscript(stdout);
      if (!text) { finish({ ok: false, code: "no-speech", text: null, message: sttFailures["no-speech"], stderr: stderr.trim() }); return; }
      finish({ ok: true, code: "ok", text, stderr: stderr.trim() });
    });
    timer = setTimeout(() => {
      if (settled) return;
      killTree(child);
      finish({ ok: false, code: "timeout", text: null, message: sttFailures.timeout, stderr: stderr.trim() });
    }, limit);
    if (signal) {
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener("abort", cancel, { once: true });
    }
  });
}

export function safeWavName(name) {
  const base = path.basename(String(name ?? "utterance.wav")).replace(/[^\p{L}\p{N}._-]/gu, "-").slice(-96) || "utterance.wav";
  return /\.wav$/i.test(base) ? base : `${base}.wav`;
}

// A failed hook must leave the audio recoverable; the newest 20 recordings stay, like voxtype.
export async function keepAudio(file, directory, limit = 20) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const kept = path.join(directory, `${stamp}-${randomUUID().slice(0, 8)}-${safeWavName(path.basename(file))}`);
  await copyFile(file, kept);
  const names = (await readdir(directory).catch(() => [])).filter(name => name.endsWith(".wav")).sort();
  for (const name of names.slice(0, Math.max(0, names.length - limit))) await unlink(path.join(directory, name)).catch(() => {});
  return kept;
}

export async function wavBytes(file) {
  const metadata = await stat(file).catch(() => null);
  if (!metadata?.isFile()) throw new Error("Audio file not found.");
  if (metadata.size > voiceDefaults.wavBytes) throw new Error("That recording is too long.");
  return readFile(file);
}
