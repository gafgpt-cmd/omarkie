import type { GlassAnchor } from "./anchor-map";
import { voiceDefaults, type SpeakerSegment } from "../../shared/voice.mjs";
import type { GlassMagnet } from "./glass-model";

// G21: a voice memo is audio in the vault's assets folder plus its transcript, on the Media layer.
export interface VoiceMemo {
  id: string;
  text: string;
  audio: string;
  mime: string;
  duration: number;
  lang: string;
  segments: SpeakerSegment[];
  anchor: GlassAnchor;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const voiceMemoDefaults = { w: 320, h: 64, minW: 220, minH: 48 } as const;

const number = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;

function anchorValue(value: unknown): GlassAnchor | undefined {
  if (!value || typeof value !== "object" || !("landmarks" in value)) return;
  const landmarks = value.landmarks;
  if (!Array.isArray(landmarks) || !landmarks.length) return;
  const parsed = landmarks.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const { kind, block, headings, line } = item as Record<string, unknown>;
    if (kind !== "block" || typeof block !== "string" || !block.trim()) return [];
    if (!Array.isArray(headings) || headings.some(heading => typeof heading !== "string")) return [];
    return [{ kind: "block" as const, block, headings: headings as string[], ...(Number.isInteger(line) ? { line: line as number } : {}) }];
  });
  return parsed.length === landmarks.length ? { landmarks: parsed } : undefined;
}

export function voiceFromMagnet(magnet: GlassMagnet): VoiceMemo | undefined {
  const fields = magnet.fields ?? {};
  if ((fields.kind ?? magnet.kind) !== "voice") return;
  if (typeof fields.audio !== "string" || !fields.audio) return;
  const anchor = anchorValue(fields.anchor);
  if (!anchor) return;
  const segments = Array.isArray(fields.segments)
    ? fields.segments.flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const { startMs, endMs, text } = item as Record<string, unknown>;
      return typeof startMs === "number" && typeof endMs === "number" && typeof text === "string"
        ? [{ startMs, endMs, text }] : [];
    }) : [];
  return {
    id: magnet.id,
    text: typeof fields.text === "string" ? fields.text.slice(0, voiceDefaults.textLimit) : "",
    audio: fields.audio,
    mime: typeof fields.mime === "string" ? fields.mime : "audio/webm",
    duration: number(fields.duration, 0),
    lang: typeof fields.lang === "string" ? fields.lang : "auto",
    segments,
    anchor,
    x: number(fields.x, 0),
    y: number(fields.y, 0),
    w: number(fields.w, voiceMemoDefaults.w),
    h: number(fields.h, voiceMemoDefaults.h),
  };
}

export function newVoiceId() {
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
