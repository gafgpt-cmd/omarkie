export type VoiceMode = "dictation" | "memo" | "lecture" | "ask";

export const voiceDefaults: {
  rate: number; channels: number; bits: number; textLimit: number; memoBytes: number; wavBytes: number;
  maxSeconds: number; chunkMs: number; segmentLimit: number; markLimit: number; languageLimit: number;
  keyLimit: number; defaultKey: string; minChapterMs: number; transcriptBytes: number;
};
export const voiceModes: readonly VoiceMode[];
export const voiceMimes: readonly string[];

export interface WavInfo { audio: number; channels: number; rate: number; bits: number; dataBytes: number; frames: number; seconds: number }
export interface VoiceKeySpec { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }
export interface SpeakerSegment { startMs: number; endMs: number; text: string }
export interface ChapterMark { atMs: number; label: string }

export function validVoiceLanguage(value: unknown): boolean;
export function validVoiceMode(value: unknown): value is VoiceMode;
export function cleanTranscript(text: unknown): string;
export function wavInfo(bytes: ArrayBuffer | ArrayBufferView): WavInfo | null;
export function validVoiceWav(bytes: ArrayBuffer | ArrayBufferView): boolean;
export function encodeVoiceWav(samples: ArrayLike<number>, rate?: number): Uint8Array;
export function voiceKey(value: unknown): VoiceKeySpec | null;
export function voiceKeyMatches(event: { key?: string; code?: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }, value: string | VoiceKeySpec | null): boolean;
export function timestampLabel(ms: number): string;
export function lectureChunks(totalMs: number, chunkMs?: number): { startMs: number; endMs: number }[];
export function validSpeakerSegments(value: unknown): SpeakerSegment[] | null;
export function chapterMarks(segments?: SpeakerSegment[] | null, marks?: { atMs: number; label?: string }[]): ChapterMark[];
