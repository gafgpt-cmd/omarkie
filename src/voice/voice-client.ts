// G21: browser microphone capture → one canonical 16 kHz mono WAV → the local hook.
// Nothing leaves the machine; the transcript is the only text that comes back.
import { archiveLag, encodeVoiceWav, energyFrames, lectureExtensions, UtteranceSegmenter, voiceDefaults, type Utterance } from "../../shared/voice.mjs";

export interface VoiceInfo {
  configured: boolean;
  valid: boolean;
  key: string;
  language: string;
  maxSeconds: number;
}

export interface TranscribeResult {
  ok: boolean;
  code: string;
  text: string | null;
  message?: string;
  kept?: string | null;
}

export interface CapturePart { blob: Blob; wav: Uint8Array; durationMs: number }

const unavailable = { configured: false, valid: false, key: voiceDefaults.defaultKey, language: "auto", maxSeconds: voiceDefaults.maxSeconds };

let info: Promise<VoiceInfo> | undefined;

export function voiceInfo(): Promise<VoiceInfo> {
  info ??= (async () => {
    try {
      const reply = await window.desktop?.voice?.({ action: "info" });
      if (!reply?.ok || !reply.value) return unavailable;
      return { ...unavailable, ...reply.value };
    } catch { info = undefined; return unavailable; }
  })();
  return info;
}

export function microphoneAvailable() {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
}

function base64(bytes: Uint8Array) {
  let text = "";
  for (let index = 0; index < bytes.length; index += 32_768) text += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  return btoa(text);
}

export async function blobBase64(blob: Blob) {
  return base64(new Uint8Array(await blob.arrayBuffer()));
}

// Large recordings: the browser encodes off the main thread, so Save never freezes the page.
export function blobBase64Async(blob: Blob) {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
  reader.onerror = () => reject(reader.error ?? new Error("The recording could not be read."));
  reader.readAsDataURL(blob);
  return promise;
}

export async function transcribeCapture(wav: Uint8Array, options: { mode?: string; language?: string; id?: string }): Promise<TranscribeResult> {
  const reply = await window.desktop?.voice?.({ action: "transcribe", wav: base64(wav), mode: options.mode ?? "dictation",
    language: options.language ?? "auto", id: options.id });
  if (!reply?.ok) throw new Error(reply?.error ?? "Speech-to-text is unavailable.");
  return reply.value as TranscribeResult;
}

export function cancelTranscribe(id: string) {
  void window.desktop?.voice?.({ action: "cancel", id });
}

// One recorder per utterance or memo. Stop resolves with the audio blob and its WAV.
export class VoiceRecorder {
  private stream: MediaStream | undefined;
  private recorder: MediaRecorder | undefined;
  private chunks: Blob[] = [];
  private stopped: Promise<CapturePart> | undefined;
  private startedAt = 0;

  static supported() {
    return microphoneAvailable() && typeof AudioContext !== "undefined";
  }

  get durationMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  async start() {
    if (!VoiceRecorder.supported()) throw new Error("Recording is not available on this machine.");
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const type = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus") ? "audio/ogg;codecs=opus" : "";
    this.recorder = new MediaRecorder(this.stream, type ? { mimeType: type, audioBitsPerSecond: 32_000 } : undefined);
    this.chunks = [];
    this.recorder.addEventListener("dataavailable", event => { if (event.data.size) this.chunks.push(event.data); });
    this.stopped = new Promise((resolve, reject) => {
      this.recorder!.addEventListener("stop", () => {
        const blob = new Blob(this.chunks, { type: (this.recorder!.mimeType || "audio/webm").split(";")[0] });
        void decode(blob).then(resolve, reject);
      });
      this.recorder!.addEventListener("error", event => reject(new Error(String((event as ErrorEvent).message ?? "Recording failed."))));
    });
    this.startedAt = Date.now();
    this.recorder.start(500);
  }

  async stop(): Promise<CapturePart> {
    if (!this.recorder || !this.stopped) throw new Error("No recording is running.");
    if (this.recorder.state !== "inactive") this.recorder.stop();
    try { return await this.stopped; }
    finally { this.release(); }
  }

  cancel() {
    try { if (this.recorder?.state !== "inactive") this.recorder?.stop(); } catch { /* already stopped */ }
    this.release();
  }

  private release() {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
    this.recorder = undefined;
    this.stopped = undefined;
    this.chunks = [];
    this.startedAt = 0;
  }
}

// offsetMs: where the archive starts on the tap's clock; utterance and mark times subtract it to land on the word.
export interface LectureAudio { blob: Blob; mime: string; offsetMs: number }
const lectureArchive = "audio/mp4;codecs=opus";
const alignSeconds = 20;

// Lecture: one continuous archive recording plus a 16 kHz PCM tap cut into utterances at pauses. Utterance times
// count from the tap's first sample; the archive starts on that first buffer, and stop() measures by how much.
export class LectureRecorder {
  private stream: MediaStream | undefined;
  private recorder: MediaRecorder | undefined;
  private context: AudioContext | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private processor: ScriptProcessorNode | undefined;
  private segmenter = new UtteranceSegmenter(voiceDefaults.rate);
  private chunks: Blob[] = [];
  private samples = 0;
  // The tap's first seconds, matched against the archive's; lead is the fallback offset when they do not agree.
  private head = new Float32Array(voiceDefaults.rate * alignSeconds);
  private lead = 0;
  private stopped: Promise<LectureAudio | null> | undefined;

  constructor(private readonly onUtterance: (utterance: Utterance) => void) {}

  get durationMs() {
    return this.samples * 1000 / voiceDefaults.rate;
  }

  async start() {
    if (!VoiceRecorder.supported()) throw new Error("Recording is not available on this machine.");
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const context = this.context = new AudioContext({ sampleRate: voiceDefaults.rate });
    this.source = context.createMediaStreamSource(this.stream);
    this.processor = context.createScriptProcessor(1024, 1, 1);
    const archive = MediaRecorder.isTypeSupported(lectureArchive) ? lectureArchive : undefined;
    this.processor.onaudioprocess = event => {
      const chunk = event.inputBuffer.getChannelData(0);
      if (archive && !this.recorder) { this.record(archive); this.lead = this.samples + chunk.length; }
      if (this.samples < this.head.length) this.head.set(chunk.subarray(0, this.head.length - this.samples), this.samples);
      this.samples += chunk.length;
      for (const utterance of this.segmenter.push(chunk)) this.onUtterance(utterance);
    };
    this.source.connect(this.processor);
    this.processor.connect(context.destination);
    await context.resume();
  }

  private record(type: string) {
    const recorder = this.recorder = new MediaRecorder(this.stream!, { mimeType: type, audioBitsPerSecond: 32_000 });
    recorder.addEventListener("dataavailable", event => { if (event.data.size) this.chunks.push(event.data); });
    const { promise, resolve } = Promise.withResolvers<LectureAudio | null>();
    this.stopped = promise;
    recorder.addEventListener("stop", () => {
      const mime = type.split(";")[0];
      if (!this.chunks.length || !lectureExtensions[mime]) { resolve(null); return; }
      void this.offsetMs(mime).then(offsetMs => resolve({ blob: new Blob(this.chunks, { type: mime }), mime, offsetMs }));
    }, { once: true });
    recorder.start(1_000);
  }

  // The recorder starts a variable delay after the tap; matching the first seconds of both measures it.
  private async offsetMs(mime: string) {
    const fallback = this.lead * 1000 / voiceDefaults.rate;
    try {
      const head = new Blob(this.chunks.slice(0, alignSeconds + 1), { type: mime });
      const decoded = await new OfflineAudioContext(1, 1, voiceDefaults.rate).decodeAudioData(await head.arrayBuffer());
      const tap = energyFrames(this.head.subarray(0, Math.min(this.samples, this.head.length)), voiceDefaults.rate);
      const lag = archiveLag(tap, energyFrames(decoded.getChannelData(0), voiceDefaults.rate));
      return lag === null ? fallback : lag * 10;
    } catch { return fallback; }
  }

  // Flushes the last utterance, then resolves with the archive (null when this browser cannot record one).
  async stop(): Promise<LectureAudio | null> {
    if (this.processor) this.processor.onaudioprocess = null;
    for (const utterance of this.segmenter.flush()) this.onUtterance(utterance);
    if (this.recorder?.state !== "inactive") this.recorder?.stop();
    try { return this.stopped ? await this.stopped : null; }
    finally { this.release(); }
  }

  cancel() {
    if (this.processor) this.processor.onaudioprocess = null;
    try { if (this.recorder?.state !== "inactive") this.recorder?.stop(); } catch { /* already stopped */ }
    this.release();
  }

  private release() {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.source?.disconnect();
    this.processor?.disconnect();
    void this.context?.close().catch(() => {});
    this.stream = undefined; this.recorder = undefined; this.context = undefined; this.source = undefined; this.processor = undefined;
    this.stopped = undefined; this.chunks = [];
  }
}

// Any browser recording (Opus in WebM/OGG) is decoded and resampled once, to the hook's one shape.
async function decode(blob: Blob): Promise<CapturePart> {
  if (!blob.size) throw new Error("The recording was empty.");
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (!decoded.length) throw new Error("The recording was empty.");
  } finally { await context.close().catch(() => {}); }
  const frames = Math.max(1, Math.ceil(decoded.duration * voiceDefaults.rate));
  const offline = new OfflineAudioContext(1, frames, voiceDefaults.rate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return { blob, wav: encodeVoiceWav(rendered.getChannelData(0), voiceDefaults.rate), durationMs: Math.round(decoded.duration * 1000) };
}
