export type VoiceMode = "dictation" | "memo" | "lecture" | "ask";

export const voiceDefaults: {
  rate: number; channels: number; bits: number; textLimit: number; memoBytes: number; wavBytes: number;
  maxSeconds: number; segmentLimit: number; markLimit: number; languageLimit: number;
  keyLimit: number; defaultKey: string; transcriptBytes: number;
};
export const lectureDefaults: {
  seconds: number; audioBytes: number; segmentLimit: number;
  frameMs: number; onsetFrames: number; pauseMs: number; minSpeechMs: number; maxUtteranceMs: number; cutSearchMs: number; paddingMs: number;
  level: number; snr: number; floorRise: number;
  paragraphPauseMs: number; paragraphMs: number; sectionMs: number;
};
export const lectureExtensions: Record<string, string>;
export const voiceModes: readonly VoiceMode[];
export const voiceMimes: readonly string[];

export interface WavInfo { audio: number; channels: number; rate: number; bits: number; dataBytes: number; frames: number; seconds: number }
export interface VoiceKeySpec { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }
export interface SpeakerSegment { startMs: number; endMs: number; text: string }
export interface Utterance { startMs: number; endMs: number; samples: Float32Array }

export function validVoiceLanguage(value: unknown): boolean;
export function validVoiceMode(value: unknown): value is VoiceMode;
export function cleanTranscript(text: unknown): string;
export function wavInfo(bytes: ArrayBuffer | ArrayBufferView): WavInfo | null;
export function validVoiceWav(bytes: ArrayBuffer | ArrayBufferView): boolean;
export function encodeVoiceWav(samples: ArrayLike<number>, rate?: number): Uint8Array;
export function voiceKey(value: unknown): VoiceKeySpec | null;
export function voiceKeyMatches(event: { key?: string; code?: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }, value: string | VoiceKeySpec | null): boolean;
export function timestampLabel(ms: number): string;
export function clockLabel(ms: number, tenths?: boolean): string;
export function transcriptStamp(text: unknown): { seconds: number; length: number } | null;
export function validSpeakerSegments(value: unknown, limits?: { maxMs?: number; limit?: number }): SpeakerSegment[] | null;
export class UtteranceSegmenter {
  constructor(rate?: number, options?: Partial<typeof lectureDefaults>);
  push(chunk: Float32Array): Utterance[];
  flush(): Utterance[];
}
export function energyFrames(samples: Float32Array, rate: number): Float32Array;
export function archiveLag(tap: Float32Array, archive: Float32Array, options?: { min?: number; max?: number; overlap?: number; agree?: number }): number | null;
export function lectureNote(input: { title: string; audio?: string | null; segments: SpeakerSegment[]; marks?: { atMs: number }[]; at: string }): string;
