import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { encodeVoiceWav, validVoiceLanguage, validVoiceWav, voiceKeyMatches, wavInfo } from "../shared/voice.mjs";
import { runStt, sttArgv, sttConfigured } from "../electron/stt.mjs";
import { Voice } from "../electron/voice.mjs";
import { voiceFields } from "../electron/glass-service.mjs";
import { voiceFromMagnet } from "../src/glass/voice-model.ts";

const scratch = [];
after(async () => { for (const root of scratch) await rm(root, { recursive: true, force: true }); });

async function area() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-voice-"));
  scratch.push(root);
  return root;
}

function wav({ seconds = 0.5, rate = 16_000, channels = 1, bits = 16 } = {}) {
  const frames = Math.round(rate * seconds), bytes = new Uint8Array(44 + frames * channels * bits / 8);
  const view = new DataView(bytes.buffer);
  const text = (at, value) => { for (let index = 0; index < value.length; index += 1) view.setUint8(at + index, value.charCodeAt(index)); };
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * channels * bits / 8, true);
  view.setUint16(32, channels * bits / 8, true); view.setUint16(34, bits, true);
  text(36, "data"); view.setUint32(40, bytes.length - 44, true);
  return Buffer.from(bytes);
}

async function hook(root, body) {
  const file = path.join(root, "stt.sh");
  await writeFile(file, `#!/bin/sh\n${body}\n`, "utf8");
  await chmod(file, 0o755);
  return file;
}

test("the hook receives exactly one 16 kHz mono PCM WAV", () => {
  const ok = wav();
  assert.deepEqual(wavInfo(ok), { audio: 1, channels: 1, rate: 16_000, bits: 16, dataBytes: 16_000, frames: 8_000, seconds: 0.5 });
  assert.equal(validVoiceWav(ok), true);
  assert.equal(validVoiceWav(wav({ rate: 48_000 })), false);
  assert.equal(validVoiceWav(wav({ channels: 2 })), false);
  assert.equal(validVoiceWav(wav({ bits: 8 })), false);
  assert.equal(validVoiceWav(Buffer.from("not a wav")), false);
  const encoded = encodeVoiceWav(new Float32Array(3_200), 16_000);
  const info = wavInfo(encoded);
  assert.equal(info.rate, 16_000);
  assert.equal(info.channels, 1);
  assert.equal(info.bits, 16);
  assert.equal(info.frames, 3_200);
});

test("empty, bare and malformed hook values are rejected instead of guessed", () => {
  assert.equal(sttConfigured({}), false);
  assert.equal(sttConfigured({ OMARKIE_STT: "  " }), false);
  assert.equal(sttConfigured({ OMARKIE_STT: "/bin/true" }), true);
  assert.deepEqual(sttArgv("/usr/bin/voxtype transcribe {wav}"), ["/usr/bin/voxtype transcribe {wav}"]);
  assert.deepEqual(sttArgv('["voxtype", "transcribe", "{wav}"]'), ["voxtype", "transcribe", "{wav}"]);
  assert.equal(sttArgv("[not json"), null);
  assert.equal(sttArgv('["ok", 7]'), null);
  assert.equal(sttArgv(""), null);
});

test("Alt+V matches a Spanish keyboard by code, and never fires with extra modifiers", () => {
  assert.equal(voiceKeyMatches({ key: "v", code: "KeyV", altKey: true }, "Alt+V"), true);
  assert.equal(voiceKeyMatches({ key: "v", code: "KeyV", altKey: true }, "Alt+v"), true);
  assert.equal(voiceKeyMatches({ key: "v", code: "KeyV" }, "Alt+V"), false);
  assert.equal(voiceKeyMatches({ key: "v", code: "KeyV", altKey: true, ctrlKey: true }, "Alt+V"), false);
  assert.equal(voiceKeyMatches({ key: "v", code: "KeyV", altKey: true }, "garbage"), false);
});

test("a hook that prints a transcript yields clean text", async () => {
  const root = await area();
  const file = await hook(root, `printf '  Hola, mundo.\\r\\n  '`);
  const result = await runStt({ argv: [file], audio: path.join(root, "a.wav"), environment: { PATH: process.env.PATH } });
  assert.deepEqual({ ok: result.ok, text: result.text, code: result.code }, { ok: true, text: "Hola, mundo.", code: "ok" });
});

test("hook exit codes map to the documented failures and keep stderr", async () => {
  const root = await area();
  const bad = await hook(root, `echo 'wav is 48k' >&2; exit 3`);
  const result = await runStt({ argv: [bad], audio: path.join(root, "a.wav"), environment: { PATH: process.env.PATH } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad-audio");
  assert.match(result.stderr, /48k/);
  assert.equal(result.text, null);
});

test("silence is no-speech, not an empty transcript", async () => {
  const root = await area();
  const silent = await hook(root, `exit 0`);
  const result = await runStt({ argv: [silent], audio: path.join(root, "a.wav"), environment: { PATH: process.env.PATH } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-speech");
});

test("the {wav} placeholder receives the audio path and no shell interpolation happens", async () => {
  const root = await area();
  const audio = path.join(root, "utterance.wav");
  const witness = path.join(root, "seen.txt");
  const file = await hook(root, `printf '%s' "$1" > '${witness}'`);
  const result = await runStt({ argv: [file, "{wav}"], audio, environment: { PATH: process.env.PATH } });
  assert.equal(result.ok, false);
  assert.equal(await readdir(root).then(names => names.includes("seen.txt")), true);
  const seen = await readFile(witness, "utf8");
  assert.equal(seen, audio);
});

test("Voice.transcribe rejects bad audio before starting the hook", async () => {
  const root = await area();
  const file = await hook(root, `printf 'should not run'`);
  const voice = new Voice({ dataDir: root, environment: { OMARKIE_STT: file, PATH: process.env.PATH } });
  const result = await voice.transcribe({ wavBase64: Buffer.from("nope").toString("base64") });
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad-audio");
});

test("Voice.transcribe keeps the audio when the hook fails", async () => {
  const root = await area();
  const file = await hook(root, `exit 4`);
  const voice = new Voice({ dataDir: root, environment: { OMARKIE_STT: file, PATH: process.env.PATH } });
  const result = await voice.transcribe({ wavBase64: wav().toString("base64") });
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-model");
  assert.ok(result.kept, "failed audio stays recoverable");
  assert.match(result.kept, /voice-failed/);
  assert.equal((await readdir(path.dirname(result.kept))).length, 1);
});

test("a cancelled transcription keeps no audio at all", async () => {
  const root = await area();
  const file = await hook(root, `sleep 5`);
  const voice = new Voice({ dataDir: root, environment: { OMARKIE_STT: file, PATH: process.env.PATH } });
  const controller = new AbortController();
  const running = voice.transcribe({ wavBase64: wav().toString("base64"), signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.code, "cancelled");
  assert.equal(result.kept, null, "the person discarded this utterance");
  assert.equal(await readdir(path.join(root, "voice-failed")).catch(() => null), null, "no voice-failed directory is created");
});

test("missing hook is a config answer, never a crash", async () => {
  const root = await area();
  const voice = new Voice({ dataDir: root, environment: {} });
  assert.equal(voice.info().configured, false);
  const result = await voice.transcribe({ wavBase64: wav().toString("base64") });
  assert.equal(result.ok, false);
  assert.equal(result.code, "config");
});

test("a memo needs its audio, transcript, duration, language and one block anchor", () => {
  const base = { kind: "voice", text: "Auscultate before the second dose.", duration: 12_500, lang: "es",
    audio: "voice-abc.webm", mime: "audio/webm", x: 10, y: 4, w: 320, h: 64,
    anchor: { landmarks: [{ kind: "block", block: "Dose two", headings: ["Plan"] }] } };
  const fields = voiceFields(base);
  assert.equal(fields.kind, "voice");
  assert.equal(fields.lang, "es");
  assert.throws(() => voiceFields({ ...base, text: null }), /transcript/);
  assert.throws(() => voiceFields({ ...base, mime: "audio/flac" }), /Voice audio/);
  assert.throws(() => voiceFields({ ...base, duration: -1 }), /duration/);
  assert.throws(() => voiceFields({ ...base, lang: "Spanish" }), /language/);
  assert.throws(() => voiceFields({ ...base, anchor: undefined }), /anchor/);
  assert.equal(validVoiceLanguage("auto"), true);
  assert.equal(validVoiceLanguage("en-GB"), true);
  assert.equal(validVoiceLanguage("EN"), false);
});

test("the renderer drops a memo magnet without audio or anchor", () => {
  const fields = { kind: "voice", text: "Revisar la dosis", audio: "voice-a.webm", mime: "audio/webm",
    duration: 900, lang: "auto", x: 4, y: 6, w: 320, h: 64,
    anchor: { landmarks: [{ kind: "block", block: "Dose two", headings: ["Plan"] }] } };
  const memo = voiceFromMagnet({ id: "v-1", kind: "voice", fields });
  assert.equal(memo.text, "Revisar la dosis");
  assert.equal(memo.audio, "voice-a.webm");
  assert.equal(memo.duration, 900);
  assert.equal(voiceFromMagnet({ id: "v-2", kind: "voice", fields: { ...fields, audio: "" } }), undefined);
  assert.equal(voiceFromMagnet({ id: "v-3", kind: "voice", fields: { ...fields, anchor: { landmarks: [] } } }), undefined);
});
