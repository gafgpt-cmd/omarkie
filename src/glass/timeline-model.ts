// Timeline glass: media time is stored in source seconds and never rewritten.
// Pins, transcript cues and the player all speak source time.
import type { GlassAnchor, GlassPlacement } from "./anchor-map";
import type { GlassMagnet } from "./glass-model";
import { anchorFrom } from "./glass-state.ts";

export interface TranscriptCue { start: number; end: number; text: string }

export interface TimelineMark {
  id: string;
  kind: "timeline";
  src: string;
  title: string;
  media: "audio" | "video";
  duration: number;
  transcript: TranscriptCue[];
  anchor?: GlassAnchor;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TimestampMark {
  id: string;
  kind: "timestamp";
  timeline: string;
  t: number;
  label: string;
}

export const timelineDefaults = { w: 360, h: 300, duration: 0, maxTranscript: 2_000 } as const;

const clock = /^(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)(?:\.(\d{1,3}))?$/u;

// "mm:ss", "h:mm:ss" and a decimal fraction; never locale-dependent.
export function parseTime(text: string): number | null {
  const match = clock.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1] ?? 0), minutes = Number(match[2]), seconds = Number(match[3]), fraction = Number(`0.${match[4] ?? 0}`);
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

export function formatTime(seconds: number, withHours = false): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const whole = Math.floor(safe), rest = Math.floor((safe - whole) * 10);
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${withHours || h > 0 ? `${h}:` : ""}${pad(m)}:${pad(s)}${rest ? `.${rest}` : ""}`;
}

function number(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function transcriptOf(value: unknown): TranscriptCue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    if (!("start" in item) || !("text" in item)) return [];
    const start = number(item.start, Number.NaN), text = typeof item.text === "string" ? item.text.trim().slice(0, 4_000) : "";
    if (!Number.isFinite(start) || start < 0 || !text) return [];
    const end = Math.max(start + 0.05, "end" in item ? number(item.end, start + 0.05) : start + 0.05);
    return [{ start, end, text }];
  }).sort((left, right) => left.start - right.start).slice(0, timelineDefaults.maxTranscript);
}

export function timelineFromMagnet(magnet: GlassMagnet): TimelineMark | undefined {
  const fields = magnet.fields ?? {};
  if ((fields.kind ?? magnet.kind) !== "timeline") return;
  const src = typeof fields.src === "string" ? fields.src.trim().slice(0, 2_000) : "";
  if (!src) return;
  const media = fields.media === "video" || /\.(?:mp4|webm|mov)$/iu.test(src) ? "video" : "audio";
  return {
    id: magnet.id,
    kind: "timeline",
    src,
    title: typeof fields.title === "string" && fields.title.trim() ? fields.title.trim().slice(0, 120) : "Lecture",
    media,
    duration: Math.max(0, number(fields.duration)),
    transcript: transcriptOf(fields.transcript),
    anchor: anchorFrom(fields.anchor),
    x: number(fields.x), y: number(fields.y),
    w: Math.max(240, number(fields.w, timelineDefaults.w)),
    h: Math.max(160, number(fields.h, timelineDefaults.h)),
  };
}

export function timestampFromMagnet(magnet: GlassMagnet): TimestampMark | undefined {
  const fields = magnet.fields ?? {};
  if ((fields.kind ?? magnet.kind) !== "timestamp") return;
  const timeline = typeof fields.timeline === "string" ? fields.timeline : "";
  const t = number(fields.t, Number.NaN);
  if (!timeline || !Number.isFinite(t) || t < 0) return;
  return {
    id: magnet.id,
    kind: "timestamp",
    timeline,
    t,
    label: typeof fields.label === "string" ? fields.label.trim().slice(0, 500) : "",
  };
}

export function pinPercent(source: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return Math.max(0, Math.min(1, source / duration));
}

// Transcript line: "[00:12] text", "1:02:03.5 text" or "00:12 - text".
export function transcriptLine(text: string): TranscriptCue | null {
  const match = /^\s*\[?((?:\d{1,2}:)?\d{1,3}:\d{1,2}(?:\.\d{1,3})?)\]?\s*(?:[-–—:]\s*)?(.+?)\s*$/u.exec(text);
  if (!match) return null;
  const start = parseTime(match[1]);
  return start === null ? null : { start, end: start + 0.05, text: match[2].slice(0, 4_000) };
}
