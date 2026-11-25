import type { GlassBlock, GlassAnchor } from "./anchor-map";
import { anchorFrom } from "./glass-state.ts";
import type { GlassMagnet } from "./glass-model";
import { stickerIds, stickerLayer } from "../../shared/glass-marks.mjs";

export { stickerIds, stickerLayer };
export type StickerId = string;

export const stickerDefaults = { w: 72, h: 72, minW: 24, maxW: 1200, grid: 8 } as const;

export interface StickerMark {
  id: string;
  sticker?: string;
  image?: string;
  anchor: GlassAnchor;
  x: number;
  y: number;
  w: number;
  h: number;
  rotate: number;
}

const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

export function stickerFromMagnet(magnet: GlassMagnet): StickerMark | undefined {
  if (magnet.kind !== "sticker") return;
  const { fields } = magnet, anchor = anchorFrom(fields.anchor);
  const image = typeof fields.image === "string" && fields.image.startsWith("data:image/") ? fields.image : undefined;
  const sticker = typeof fields.sticker === "string" ? fields.sticker : undefined;
  if (!anchor || (!image && !sticker)) return;
  return { id: magnet.id, ...(sticker && !image ? { sticker } : {}), ...(image ? { image } : {}), anchor,
    x: number(fields.x, 0, -200_000, 200_000), y: number(fields.y, 0, -200_000, 200_000),
    w: number(fields.w, stickerDefaults.w, stickerDefaults.minW, stickerDefaults.maxW),
    h: number(fields.h, stickerDefaults.h, stickerDefaults.minW, stickerDefaults.maxW),
    rotate: number(fields.rotate, 0, -360, 360) };
}

export function stickerFields(sticker: StickerMark): Record<string, unknown> {
  return { kind: "sticker", ...(sticker.image ? { image: sticker.image } : { sticker: sticker.sticker }), anchor: sticker.anchor,
    x: sticker.x, y: sticker.y, w: sticker.w, h: sticker.h, rotate: sticker.rotate, layer: stickerLayer };
}

export function newStickerId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function stickerAt(block: GlassBlock, offset: { x: number; y: number }): StickerMark {
  return { id: newStickerId(), sticker: "star", anchor: { landmarks: [{ kind: "block", block: block.block, headings: block.headings, line: block.line }] },
    x: offset.x, y: offset.y, w: stickerDefaults.w, h: stickerDefaults.h, rotate: 0 };
}

export function stickerName(sticker: Pick<StickerMark, "sticker" | "image">) {
  if (sticker.image) return "Custom sticker";
  const id = sticker.sticker ?? "";
  if (id.startsWith("number-")) return `Number ${id.slice(7)} sticker`;
  const names: Record<string, string> = { star: "Star sticker", check: "Check sticker", cross: "Red cross sticker",
    warning: "Red warning sticker", question: "Question sticker", heart: "Heart sticker", smile: "Smile sticker",
    cool: "Cool sticker", think: "Thinking sticker", fire: "Fire sticker", bulb: "Idea sticker", "thumbs-up": "Thumbs up sticker" };
  return names[id] ?? `${id || "Sticker"} sticker`;
}
