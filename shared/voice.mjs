// G21: local speech-to-text. One CLI hook (OMARKIE_STT) takes a 16 kHz mono WAV and prints the
// transcript; nothing here touches the network. Pure functions only, shared by Electron, the
// renderer and omarkie-axi.

export const voiceDefaults = {
  rate: 16_000, channels: 1, bits: 16,
  textLimit: 20_000, memoBytes: 32 * 1024 * 1024, wavBytes: 120 * 1024 * 1024,
  maxSeconds: 3_600, chunkMs: 60_000, segmentLimit: 4_000, markLimit: 400,
  languageLimit: 16, keyLimit: 40, defaultKey: "Alt+V", minChapterMs: 10_000,
  transcriptBytes: 4 * 1024 * 1024,
};
export const voiceModes = ["dictation", "memo", "lecture", "ask"];
export const voiceMimes = ["audio/webm", "audio/ogg", "audio/wav", "audio/mpeg", "audio/mp4"];

const language = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// "auto" asks the engine; a BCP-47 tag pins the language. `auto` needs a multilingual model.
export function validVoiceLanguage(value) {
  return value === "auto" || typeof value === "string" && value.length <= voiceDefaults.languageLimit && language.test(value);
}

export function validVoiceMode(value) {
  return typeof value === "string" && voiceModes.includes(value);
}

export function cleanTranscript(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim().slice(0, voiceDefaults.textLimit);
}

// --- WAV: 16 kHz, mono, PCM signed 16-bit little-endian. One sample format, no guessing. ---
const four = (view, offset) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));

function viewOf(bytes) {
  if (bytes instanceof ArrayBuffer) return new DataView(bytes);
  if (ArrayBuffer.isView(bytes)) return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return null;
}

// Reads the RIFF chunks; returns null when the bytes are not a WAV file at all.
export function wavInfo(bytes) {
  const view = viewOf(bytes);
  if (!view || view.byteLength < 44 || four(view, 0) !== "RIFF" || four(view, 8) !== "WAVE") return null;
  let offset = 12, format = null, dataBytes = 0;
  while (offset + 8 <= view.byteLength) {
    const id = four(view, offset), size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > view.byteLength && id !== "data") break;
    if (id === "fmt " && size >= 16) {
      format = { audio: view.getUint16(body, true), channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === "data") {
      dataBytes = Math.min(size, view.byteLength - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!format) return null;
  const frames = format.channels && format.bits ? Math.floor(dataBytes / (format.channels * format.bits / 8)) : 0;
  return { ...format, dataBytes, frames, seconds: format.rate ? frames / format.rate : 0 };
}

// The hook contract: anything else is rejected with exit 3 rather than silently mis-transcribed.
export function validVoiceWav(bytes) {
  const info = wavInfo(bytes);
  return !!info && info.audio === 1 && info.channels === voiceDefaults.channels
    && info.bits === voiceDefaults.bits && info.rate === voiceDefaults.rate
    && info.dataBytes > 0 && info.seconds <= voiceDefaults.maxSeconds;
}

// Float samples (-1..1) → the one WAV shape the hook accepts. Runs in the renderer too.
export function encodeVoiceWav(samples, rate = voiceDefaults.rate) {
  const frames = samples.length;
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); };
  text(0, "RIFF"); view.setUint32(4, 36 + frames * 2, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, frames * 2, true);
  for (let index = 0; index < frames; index += 1) {
    const sample = Number.isFinite(samples[index]) ? Math.max(-1, Math.min(1, samples[index])) : 0;
    view.setInt16(44 + index * 2, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true);
  }
  return bytes;
}

// --- Push-to-talk key: one configurable chord held to record. ---
const named = new Set(["space", "enter", "tab", "escape", "scrolllock", "pause", "insert", "delete", "home", "end", "pageup", "pagedown"]);
const modifierOf = { ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", opt: "alt", shift: "shift", meta: "meta", cmd: "meta", command: "meta", super: "meta", win: "meta" };

export function voiceKey(value) {
  if (typeof value !== "string" || !value.trim() || value.length > voiceDefaults.keyLimit) return null;
  const parts = value.split("+").map(part => part.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return null;
  const spec = { ctrl: false, alt: false, shift: false, meta: false, key: null };
  for (const part of parts.slice(0, -1)) {
    const modifier = modifierOf[part];
    if (!modifier) return null;
    spec[modifier] = true;
  }
  const last = parts.at(-1);
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(last) || named.has(last) || /^[a-z0-9]$/.test(last)) spec.key = last;
  else return null;
  return spec;
}

// Layout-independent for letters (event.code), so a Spanish keyboard still fires Alt+V.
export function voiceKeyMatches(event, value) {
  const spec = typeof value === "string" ? voiceKey(value) : value;
  if (!spec || !event) return false;
  if (!!event.ctrlKey !== spec.ctrl || !!event.altKey !== spec.alt || !!event.shiftKey !== spec.shift || !!event.metaKey !== spec.meta) return false;
  const key = String(event.key ?? "").toLowerCase();
  if (/^[a-z]$/.test(spec.key)) return key === spec.key || event.code === `Key${spec.key.toUpperCase()}`;
  if (/^[0-9]$/.test(spec.key)) return key === spec.key || key === spec.key;
  return key === spec.key;
}

// --- Lecture: 1-hour chunks, monotonic offsets, nothing renumbered back to zero. ---
export function timestampLabel(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  const pad = value => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function lectureChunks(totalMs, chunkMs = voiceDefaults.chunkMs) {
  const total = Math.max(0, Number(totalMs) || 0), size = Math.max(1000, Number(chunkMs) || voiceDefaults.chunkMs);
  const chunks = [];
  for (let start = 0; start < total; start += size) chunks.push({ startMs: start, endMs: Math.min(total, start + size) });
  return chunks;
}

export function validSpeakerSegments(value) {
  if (!Array.isArray(value) || value.length > voiceDefaults.segmentLimit) return null;
  let previous = -1;
  const segments = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { startMs, endMs, text } = item;
    if (typeof startMs !== "number" || !Number.isFinite(startMs) || startMs < 0 || startMs > voiceDefaults.maxSeconds * 1000) return null;
    if (typeof endMs !== "number" || !Number.isFinite(endMs) || endMs < startMs) return null;
    if (typeof text !== "string" || text.length > 4_000) return null;
    if (startMs < previous) return null;
    previous = startMs;
    segments.push({ startMs: Math.round(startMs), endMs: Math.round(endMs), text: cleanTranscript(text) });
  }
  return segments;
}

// Chapter magnets need a 10 s gap and start at 00:00, as the timeline convention expects.
export function chapterMarks(segments, marks = []) {
  const labels = new Map();
  if (segments?.length) labels.set(0, timestampLabel(0));
  for (const segment of segments ?? []) {
    const at = Math.floor(segment.startMs / 1000) * 1000;
    if (at > 0 && [...labels.keys()].every(existing => Math.abs(existing - at) >= voiceDefaults.minChapterMs)) labels.set(at, timestampLabel(at));
  }
  for (const mark of marks) {
    if (!mark || typeof mark !== "object") continue;
    const at = Math.max(0, Math.round(Number(mark.atMs) || 0));
    if ([...labels.keys()].some(existing => Math.abs(existing - at) < 1000)) continue;
    labels.set(at, mark.label?.trim() ? `${timestampLabel(at)} ${cleanTranscript(mark.label).slice(0, 80)}` : timestampLabel(at));
  }
  return [...labels.entries()].sort((a, b) => a[0] - b[0]).map(([atMs, label]) => ({ atMs, label }));
}
