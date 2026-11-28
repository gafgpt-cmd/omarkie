import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { archiveLag, clockLabel, encodeVoiceWav, energyFrames, lectureNote, transcriptStamp, UtteranceSegmenter, validVoiceLanguage, validVoiceWav, voiceKeyMatches, wavInfo } from "../shared/voice.mjs";
import { runStt, sttArgv, sttConfigured } from "../electron/stt.mjs";
import { Voice } from "../electron/voice.mjs";
import { GlassService, voiceFields } from "../electron/glass-service.mjs";
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

function hookEnv(extra = {}) {
  const env = { PATH: process.env.PATH, ...extra };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

async function hook(root, body) {
  const file = path.join(root, "stt.mjs");
  await writeFile(file, `${body}\n`, "utf8");
  return [process.execPath, file];
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
  const argv = await hook(root, `process.stdout.write("  Hola, mundo.\\r\\n  ");`);
  const result = await runStt({ argv, audio: path.join(root, "a.wav"), environment: hookEnv() });
  assert.deepEqual({ ok: result.ok, text: result.text, code: result.code }, { ok: true, text: "Hola, mundo.", code: "ok" });
});

test("hook exit codes map to the documented failures and keep stderr", async () => {
  const root = await area();
  const argv = await hook(root, `process.stderr.write("wav is 48k\\n"); process.exit(3);`);
  const result = await runStt({ argv, audio: path.join(root, "a.wav"), environment: hookEnv() });
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad-audio");
  assert.match(result.stderr, /48k/);
  assert.equal(result.text, null);
});

test("silence is no-speech, not an empty transcript", async () => {
  const root = await area();
  const argv = await hook(root, `process.exit(0);`);
  const result = await runStt({ argv, audio: path.join(root, "a.wav"), environment: hookEnv() });
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-speech");
});

test("the {wav} placeholder receives the audio path and no shell interpolation happens", async () => {
  const root = await area();
  const audio = path.join(root, "utterance $(nope).wav");
  const witness = path.join(root, "seen.txt");
  const argv = await hook(root, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.WITNESS, process.argv[2] ?? "");`);
  const result = await runStt({ argv: [...argv, "{wav}"], audio, environment: hookEnv({ WITNESS: witness }) });
  assert.equal(result.ok, false);
  assert.equal(await readdir(root).then(names => names.includes("seen.txt")), true);
  const seen = await readFile(witness, "utf8");
  assert.equal(seen, audio);
});

test("Voice.transcribe rejects bad audio before starting the hook", async () => {
  const root = await area();
  const argv = await hook(root, `process.stdout.write("should not run");`);
  const voice = new Voice({ dataDir: root, environment: hookEnv({ OMARKIE_STT: JSON.stringify(argv) }) });
  const result = await voice.transcribe({ wavBase64: Buffer.from("nope").toString("base64") });
  assert.equal(result.ok, false);
  assert.equal(result.code, "bad-audio");
});

test("Voice.transcribe keeps the audio when the hook fails", async () => {
  const root = await area();
  const argv = await hook(root, `process.exit(4);`);
  const voice = new Voice({ dataDir: root, environment: hookEnv({ OMARKIE_STT: JSON.stringify(argv) }) });
  const result = await voice.transcribe({ wavBase64: wav().toString("base64") });
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-model");
  assert.ok(result.kept, "failed audio stays recoverable");
  assert.match(result.kept, /voice-failed/);
  assert.equal((await readdir(path.dirname(result.kept))).length, 1);
});

test("a cancelled transcription keeps no audio at all", async () => {
  const root = await area();
  const argv = await hook(root, `setTimeout(() => {}, 5000);`);
  const voice = new Voice({ dataDir: root, environment: hookEnv({ OMARKIE_STT: JSON.stringify(argv) }) });
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

// Synthetic lecture audio: a faint noise floor with 220 Hz tone bursts standing in for speech.
function lectureSignal(seconds, bursts, rate = 16_000) {
  const samples = new Float32Array(rate * seconds);
  let seed = 7;
  for (let index = 0; index < samples.length; index += 1) { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; samples[index] = (seed / 2 ** 31 - 0.5) * 0.001; }
  for (const [fromMs, toMs] of bursts)
    for (let index = Math.round(fromMs * rate / 1000); index < Math.round(toMs * rate / 1000); index += 1) samples[index] += 0.2 * Math.sin(2 * Math.PI * 220 * index / rate);
  return samples;
}

test("lecture utterances start within one frame of the speech, split at pauses, drop blips and cut long runs", () => {
  const bursts = [[1_010, 2_000], [3_005, 3_300], [3_600, 4_200], [6_000, 6_040], [8_013, 40_000]];
  const signal = lectureSignal(42, bursts), segmenter = new UtteranceSegmenter(16_000), utterances = [];
  for (let at = 0; at < signal.length; at += 1024) utterances.push(...segmenter.push(signal.subarray(at, at + 1024)));
  utterances.push(...segmenter.flush());
  const near = (actual, expected, slack, label) => assert.ok(Math.abs(actual - expected) <= slack, `${label}: ${actual} vs ${expected}`);
  assert.equal(utterances.length, 4, JSON.stringify(utterances.map(({ startMs, endMs }) => [startMs, endMs])));
  // A 300 ms pause stays inside one utterance; the 40 ms blip is no speech at all.
  [[1_010, 2_000], [3_005, 4_200], [8_013, null]].forEach(([start, end], index) => {
    near(utterances[index].startMs, start, 20, `start ${index}`);
    if (end !== null) near(utterances[index].endMs, end, 20, `end ${index}`);
  });
  // The 32 s burst is cut once it reaches 25 s, at the quietest frame of the last 5 s, and carries on from there.
  assert.ok(utterances[2].endMs - utterances[2].startMs <= 25_000);
  assert.equal(utterances[3].startMs, utterances[2].endMs);
  near(utterances[3].endMs, 40_000, 20, "end of the cut run");
  // Each utterance keeps 200 ms of padding either side for the STT hook.
  near(utterances[0].samples.length / 16, utterances[0].endMs - utterances[0].startMs + 400, 1, "padded samples");
});

test("clock labels floor, and transcript stamps read the same grammar the timeline uses", () => {
  assert.equal(clockLabel(0), "00:00");
  assert.equal(clockLabel(61_999), "01:01");
  assert.equal(clockLabel(61_999, true), "01:01.9");
  assert.equal(clockLabel(3_723_500, true), "1:02:03.5");
  assert.equal(clockLabel(-5), "00:00");
  assert.deepEqual(transcriptStamp("00:12 Spaced practice"), { seconds: 12, length: 6 });
  assert.equal(transcriptStamp("[1:02:03.5] - Retrieval").seconds, 3723.5);
  assert.equal(transcriptStamp("05:10.4 Text").seconds, 310.4);
  assert.equal(transcriptStamp("12:61 Too many seconds"), null);
  assert.equal(transcriptStamp("00:12"), null);
  assert.equal(transcriptStamp("Dose at 00:12"), null);
});

const LECTURE_SEGMENTS = [
  { startMs: 400, endMs: 2_000, text: "Spaced practice fights forgetting." },
  { startMs: 2_400, endMs: 4_000, text: "It needs  gaps." },
  { startMs: 6_000, endMs: 7_000, text: "Retrieval beats rereading." },
  { startMs: 7_200, endMs: 7_900, text: "   " },
  { startMs: 310_050, endMs: 312_000, text: "Sleep keeps what you learned." },
];

test("the archive's start is found on the tap's clock by matching their first seconds", () => {
  const rate = 16_000, tap = new Float32Array(rate * 6);
  let seed = 3;
  const noise = () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return (seed / 2 ** 31 - 0.5) * 0.004; };
  for (let index = 0; index < tap.length; index += 1) tap[index] = noise();
  for (const [from, to] of [[0.5, 1.4], [2.2, 2.6], [3.1, 4.4], [5.0, 5.3]])
    for (let index = from * rate; index < to * rate; index += 1) tap[index] += 0.3 * Math.sin(2 * Math.PI * 180 * index / rate);
  // The recorder started 170 ms into the tap and its codec adds a little noise of its own.
  const archive = tap.slice(Math.round(0.17 * rate)).map(sample => sample + noise() / 4);
  assert.equal(archiveLag(energyFrames(tap, rate), energyFrames(archive, rate)), 17);
  assert.equal(archiveLag(energyFrames(tap, rate), energyFrames(tap, rate)), 0);
  // A silent room has nothing to match: the caller keeps its fallback.
  assert.equal(archiveLag(energyFrames(new Float32Array(rate * 6), rate), energyFrames(new Float32Array(rate * 6), rate)), null);
  assert.equal(archiveLag(energyFrames(tap.slice(0, rate / 2), rate), energyFrames(archive, rate)), null, "too short to compare");
});

test("a lecture note has its audio, a section at the start, each mark and every five minutes, and stamped paragraphs", () => {
  const note = lectureNote({ title: "Lecture 2026-01-05 0900", audio: "Lecture 2026-01-05 0900.m4a", segments: LECTURE_SEGMENTS,
    marks: [{ atMs: 6_500 }, { atMs: "x" }, null], at: "2026-01-05T09:00:00.000Z" });
  assert.equal(note, [
    "---", "type: Reference", 'title: "Lecture 2026-01-05 0900"', "tags: [lecture]",
    'generated: { by: "process:voice", at: "2026-01-05T09:00:00.000Z" }', "---", "",
    "# Lecture 2026-01-05 0900", "", "![[Lecture 2026-01-05 0900.m4a]]", "",
    "## 00:00", "", "00:00.4 Spaced practice fights forgetting. It needs gaps.", "",
    "## 00:06", "", "00:06.0 Retrieval beats rereading.", "",
    "## 05:10", "", "05:10.0 Sleep keeps what you learned.", "",
  ].join("\n"));
  assert.doesNotMatch(lectureNote({ title: "T", segments: LECTURE_SEGMENTS.slice(0, 1), at: "x" }), /!\[\[/);
});

test("Save writes one lecture note and its audio beside the source note, never over an existing page", async () => {
  const root = await area(), vault = path.join(root, "vault");
  await mkdir(path.join(vault, "class"), { recursive: true });
  await writeFile(path.join(vault, "class", "source.md"), "# Source\n\nNotes.\n");
  const service = await new GlassService({ root: vault, appData: path.join(root, "app") }).open({ passive: false });
  try {
    const audio = Buffer.from("synthetic m4a bytes");
    const request = { action: "voice-lecture", note: "class/source.md", transcript: LECTURE_SEGMENTS, marks: [], audio: { mime: "audio/mp4", base64: audio.toString("base64") } };
    const first = await service.request(request), second = await service.request(request);
    assert.match(first.title, /^Lecture \d{4}-\d{2}-\d{2} \d{4}$/);
    assert.equal(first.note, `class/${first.title}.md`);
    assert.equal(first.audio, `${first.title}.m4a`);
    assert.equal(first.segments, LECTURE_SEGMENTS.length);
    assert.deepEqual(await readFile(path.join(vault, "class", first.audio)), audio);
    const markdown = await readFile(path.join(vault, first.note), "utf8");
    assert.ok(markdown.includes(`![[${first.title}.m4a]]`));
    assert.match(markdown, /^00:00\.4 Spaced practice/m);
    // A second Save in the same minute: the note and its audio take the next free title together.
    assert.notEqual(second.note, first.note);
    assert.equal(second.audio, `${second.title}.m4a`);
    assert.ok((await readFile(path.join(vault, second.note), "utf8")).includes(`![[${second.title}.m4a]]`));
    await assert.rejects(service.request({ ...request, audio: { mime: "audio/webm", base64: "AAAA" } }), /MP4/);
    await assert.rejects(service.request({ ...request, transcript: [] }), /at least one/);
    const bare = await service.request({ ...request, audio: null });
    assert.equal(bare.audio, null);
    assert.doesNotMatch(await readFile(path.join(vault, bare.note), "utf8"), /!\[\[/);
  } finally { await service.close(); }
});
