// G21: browser microphone capture → one canonical 16 kHz mono WAV → the local hook.
// Nothing leaves the machine; the transcript is the only text that comes back.
import { encodeVoiceWav, voiceDefaults } from "../../shared/voice.mjs";

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

export async function transcribeCapture(wav: Uint8Array, options: { mode?: string; language?: string; id?: string }): Promise<TranscribeResult> {
  const reply = await window.desktop?.voice?.({ action: "transcribe", wav: base64(wav), mode: options.mode ?? "dictation",
    language: options.language ?? "auto", id: options.id });
  if (!reply?.ok) throw new Error(reply?.error ?? "Speech-to-text is unavailable.");
  return reply.value as TranscribeResult;
}

export function cancelTranscribe(id: string) {
  void window.desktop?.voice?.({ action: "cancel", id });
}

// One recorder per utterance or lecture chunk. Stop resolves with the audio blob and its WAV.
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
