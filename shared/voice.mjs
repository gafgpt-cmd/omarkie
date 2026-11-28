// G21: local speech-to-text. One CLI hook (OMARKIE_STT) takes a 16 kHz mono WAV and prints the
// transcript; nothing here touches the network. Pure functions only, shared by Electron, the
// renderer and omarkie-axi.

export const voiceDefaults = {
  rate: 16_000, channels: 1, bits: 16,
  textLimit: 20_000, memoBytes: 32 * 1024 * 1024, wavBytes: 120 * 1024 * 1024,
  maxSeconds: 3_600, segmentLimit: 4_000, markLimit: 400,
  languageLimit: 16, keyLimit: 40, defaultKey: "Alt+V",
  transcriptBytes: 4 * 1024 * 1024,
};
// Lecture: one archive file, utterances cut at pauses, paragraphs and sections built from them.
export const lectureDefaults = {
  seconds: 4 * 3_600, audioBytes: 64 * 1024 * 1024, segmentLimit: 12_000,
  frameMs: 20, onsetFrames: 3, pauseMs: 700, minSpeechMs: 300, maxUtteranceMs: 25_000, cutSearchMs: 5_000, paddingMs: 200,
  level: 0.004, snr: 3, floorRise: 1.001,
  paragraphPauseMs: 1_500, paragraphMs: 45_000, sectionMs: 300_000,
};
// MP4/Opus (.m4a): an audio embed in Omarkie and Obsidian alike, with a real duration for seeking.
export const lectureExtensions = { "audio/mp4": "m4a" };
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

export function timestampLabel(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  const pad = value => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

// Floors, so a label never points after the moment it names; tenths keep a seek within 100 ms.
export function clockLabel(ms, tenths = false) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 100));
  const seconds = Math.floor(total / 10), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  const pad = value => String(value).padStart(2, "0");
  const base = hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`;
  return tenths ? `${base}.${total % 10}` : base;
}

// Transcript stamp grammar shared by the Glass timeline and Fold: "[00:12] text", "1:02:03.5 text", "00:12 - text".
const stampPattern = /^\s*\[?(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)(?:\.(\d{1,3}))?\]?\s*(?:[-–—:]\s*)?(?=\S)/u;
export function transcriptStamp(text) {
  const match = typeof text === "string" ? stampPattern.exec(text) : null;
  if (!match) return null;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4] ?? 0}`);
  return { seconds, length: match[0].length };
}

export function validSpeakerSegments(value, { maxMs = voiceDefaults.maxSeconds * 1000, limit = voiceDefaults.segmentLimit } = {}) {
  if (!Array.isArray(value) || value.length > limit) return null;
  let previous = -1;
  const segments = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { startMs, endMs, text } = item;
    if (typeof startMs !== "number" || !Number.isFinite(startMs) || startMs < 0 || startMs > maxMs) return null;
    if (typeof endMs !== "number" || !Number.isFinite(endMs) || endMs < startMs) return null;
    if (typeof text !== "string" || text.length > 4_000) return null;
    if (startMs < previous) return null;
    previous = startMs;
    segments.push({ startMs: Math.round(startMs), endMs: Math.round(endMs), text: cleanTranscript(text) });
  }
  return segments;
}

// Energy VAD over 20 ms frames with an adaptive noise floor. An utterance closes after a pause, or is cut
// at its quietest frame once it runs long; each one carries padded samples for the STT hook.
export class UtteranceSegmenter {
  constructor(rate = voiceDefaults.rate, options = {}) {
    const o = this.options = { ...lectureDefaults, ...options };
    this.rate = rate;
    this.frame = Math.max(1, Math.round(rate * o.frameMs / 1000));
    this.pad = Math.round(rate * o.paddingMs / 1000);
    this.samples = new Float32Array(rate * 4);
    this.base = 0; this.length = 0; this.cursor = 0;
    this.floor = o.level / o.snr;
    this.recent = []; this.open = null; this.out = [];
  }

  push(chunk) {
    if (this.length + chunk.length > this.samples.length) {
      const keep = Math.max(0, (this.open ? this.open.start : this.cursor - this.frame * this.options.onsetFrames) - this.pad - this.base);
      this.samples.copyWithin(0, keep, this.length);
      this.base += keep; this.length -= keep;
      if (this.length + chunk.length > this.samples.length) {
        const grown = new Float32Array(Math.max(this.samples.length * 2, this.length + chunk.length));
        grown.set(this.samples.subarray(0, this.length));
        this.samples = grown;
      }
    }
    this.samples.set(chunk, this.length);
    this.length += chunk.length;
    while (this.cursor + this.frame <= this.base + this.length) this.analyse();
    return this.take();
  }

  flush() {
    if (this.open) this.emit(this.open.lastEnd);
    this.open = null; this.recent = [];
    return this.take();
  }

  take() { const out = this.out; this.out = []; return out; }

  analyse() {
    const o = this.options, at = this.cursor, from = at - this.base;
    let sum = 0;
    for (let index = from; index < from + this.frame; index += 1) sum += this.samples[index] * this.samples[index];
    const level = Math.sqrt(sum / this.frame);
    const speech = level > Math.max(o.level, this.floor * o.snr);
    this.floor = level < this.floor ? Math.max(level, 1e-5) : this.floor * o.floorRise;
    this.cursor += this.frame;
    const record = { at, level, speech };
    if (!this.open) {
      this.recent = speech ? [...this.recent, record] : [];
      if (this.recent.length >= o.onsetFrames) {
        this.open = { start: this.recent[0].at, lastEnd: this.cursor, silence: 0, frames: this.recent };
        this.recent = [];
      }
      return;
    }
    const open = this.open;
    open.frames.push(record);
    if (speech) { open.silence = 0; open.lastEnd = this.cursor; } else open.silence += 1;
    if (open.silence * o.frameMs >= o.pauseMs) {
      this.emit(open.lastEnd);
      this.open = null;
    } else if ((this.cursor - open.start) * 1000 / this.rate >= o.maxUtteranceMs) {
      const after = this.cursor - Math.round(this.rate * o.cutSearchMs / 1000);
      let best = null;
      for (const frame of open.frames) if (frame.at >= after && (!best || frame.level < best.level)) best = frame;
      const cut = best.at;
      this.emit(cut);
      const rest = open.frames.filter(frame => frame.at >= cut), spoken = rest.filter(frame => frame.speech);
      if (!spoken.length) { this.open = null; return; }
      let silence = 0;
      for (let index = rest.length - 1; index >= 0 && !rest[index].speech; index -= 1) silence += 1;
      this.open = { start: cut, lastEnd: spoken.at(-1).at + this.frame, silence, frames: rest };
    }
  }

  emit(end) {
    const open = this.open, o = this.options;
    const speechMs = open.frames.filter(frame => frame.speech && frame.at < end).length * o.frameMs;
    if (end <= open.start || speechMs < o.minSpeechMs) return;
    const from = Math.max(this.base, open.start - this.pad), to = Math.min(this.base + this.length, end + this.pad);
    this.out.push({
      startMs: open.start * 1000 / this.rate, endMs: end * 1000 / this.rate,
      samples: this.samples.slice(from - this.base, to - this.base),
    });
  }
}

// 10 ms frames of log energy, so a quiet room and loud speech weigh alike when two takes are compared.
export function energyFrames(samples, rate) {
  const size = Math.max(1, Math.round(rate / 100)), frames = new Float32Array(Math.floor(samples.length / size));
  for (let frame = 0; frame < frames.length; frame += 1) {
    let sum = 0;
    for (let index = frame * size; index < (frame + 1) * size; index += 1) sum += samples[index] * samples[index];
    frames[frame] = Math.log(Math.sqrt(sum / size) + 1e-4);
  }
  return frames;
}

// Where the archive starts on the PCM tap's clock, in 10 ms frames: archive[i] matches tap[i + lag].
// The recorder starts a variable 0-250 ms after the tap; null when the takes do not clearly agree (silence).
export function archiveLag(tap, archive, { min = -20, max = 50, overlap = 100, agree = 0.6 } = {}) {
  let best = null, score = agree;
  for (let lag = min; lag <= max; lag += 1) {
    const from = Math.max(0, -lag), to = Math.min(archive.length, tap.length - lag), count = to - from;
    if (count < overlap) continue;
    let sa = 0, st = 0, saa = 0, stt = 0, sat = 0;
    for (let index = from; index < to; index += 1) {
      const a = archive[index], b = tap[index + lag];
      sa += a; st += b; saa += a * a; stt += b * b; sat += a * b;
    }
    const r = (sat - sa * st / count) / Math.sqrt((saa - sa * sa / count) * (stt - st * st / count));
    if (r > score) { score = r; best = lag; }
  }
  return best;
}

// One Markdown note per lecture: audio embed, a "## mm:ss" section at 0, at each mark and every ~5 minutes,
// and "mm:ss.d text" paragraphs that the Glass timeline and Fold both read back as seek targets.
export function lectureNote({ title, audio = null, segments, marks = [], at }) {
  const o = lectureDefaults;
  const spoken = segments.map(segment => ({ ...segment, text: cleanTranscript(segment.text).replace(/\s+/gu, " ") })).filter(segment => segment.text);
  const cuts = new Set();
  for (const mark of marks) {
    const atMs = Number(mark?.atMs);
    if (!Number.isFinite(atMs)) continue;
    const index = spoken.findIndex(segment => segment.endMs >= atMs);
    if (index >= 0) cuts.add(index);
  }
  const blocks = [];
  let sectionStart = -Infinity, paragraph = null;
  const close = () => { if (paragraph) blocks.push(`${clockLabel(paragraph.startMs, true)} ${paragraph.texts.join(" ")}`); paragraph = null; };
  spoken.forEach((segment, index) => {
    if (index === 0 || cuts.has(index) || segment.startMs - sectionStart >= o.sectionMs) {
      close();
      sectionStart = segment.startMs;
      blocks.push(`## ${clockLabel(segment.startMs)}`);
    } else if (segment.startMs - paragraph.endMs >= o.paragraphPauseMs || segment.endMs - paragraph.startMs > o.paragraphMs) close();
    if (!paragraph) paragraph = { startMs: segment.startMs, endMs: segment.endMs, texts: [] };
    paragraph.texts.push(segment.text);
    paragraph.endMs = segment.endMs;
  });
  close();
  const head = [
    "---", "type: Reference", `title: ${JSON.stringify(title)}`, "tags: [lecture]",
    `generated: { by: "process:voice", at: ${JSON.stringify(at)} }`, "---", "", `# ${title}`, "",
  ];
  if (audio) head.push(`![[${audio}]]`, "");
  return `${head.join("\n")}\n${blocks.join("\n\n")}\n`;
}
