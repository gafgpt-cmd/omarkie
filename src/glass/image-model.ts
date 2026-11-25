import { imageDefaults, imageWraps, validSource, type ImageWrap } from "../../shared/glass-images.mjs";
import { anchorFrom } from "./glass-state";
import type { GlassAnchor } from "./anchor-map";
import type { GlassMagnet, GlassSource } from "./glass-model";

export type { ImageWrap };
export const imageWrapModes = imageWraps;

export interface GlassImage {
  id: string;
  name: string;
  asset: string;
  display: string | null;
  bytes: number;
  w: number;
  h: number;
  aspect: number;
  rot: number;
  wrap: ImageWrap;
  tape: boolean;
  locked: boolean;
  anchor: GlassAnchor;
  x: number;
  y: number;
  source?: GlassSource;
}

const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

export function imageFromMagnet(magnet: GlassMagnet): GlassImage | undefined {
  const fields = magnet.fields ?? {};
  if ((fields.kind ?? magnet.kind) !== "image") return;
  const asset = typeof fields.asset === "string" && fields.asset && !/[/\\]/.test(fields.asset) ? fields.asset : undefined;
  if (!asset) return;
  const w = number(fields.w, imageDefaults.w, imageDefaults.minW, imageDefaults.maxW);
  const aspect = typeof fields.aspect === "number" && Number.isFinite(fields.aspect) && fields.aspect > 0 ? fields.aspect : w / 180;
  const source = validSource(fields.source) ?? undefined;
  return {
    id: magnet.id,
    name: typeof fields.name === "string" && fields.name.trim() ? fields.name.slice(0, imageDefaults.nameLimit) : asset,
    asset,
    display: typeof fields.display === "string" && fields.display && !/[/\\]/.test(fields.display) ? fields.display : null,
    bytes: typeof fields.bytes === "number" && fields.bytes >= 0 ? fields.bytes : 0,
    w,
    h: number(fields.h, Math.round(w / aspect), imageDefaults.minH, imageDefaults.maxH),
    aspect,
    rot: typeof fields.rot === "number" && Number.isFinite(fields.rot) ? Math.min(imageDefaults.rotateLimit, Math.max(-imageDefaults.rotateLimit, fields.rot)) : 0,
    wrap: imageWraps.includes(fields.wrap as ImageWrap) ? fields.wrap as ImageWrap : "left",
    tape: fields.tape === true,
    locked: fields.locked === true,
    anchor: anchorFrom(fields.anchor) ?? { landmarks: [] },
    x: number(fields.x, 0, -imageDefaults.offsetLimit, imageDefaults.offsetLimit),
    y: number(fields.y, 0, -imageDefaults.offsetLimit, imageDefaults.offsetLimit),
    ...(source ? { source } : {}),
  };
}

export function imageFieldsOf(image: GlassImage): Record<string, unknown> {
  return {
    kind: "image", name: image.name, asset: image.asset, display: image.display, bytes: image.bytes,
    w: image.w, h: image.h, aspect: image.aspect, rot: image.rot, wrap: image.wrap,
    tape: image.tape, locked: image.locked, anchor: image.anchor, x: image.x, y: image.y,
    ...(image.source ? { source: image.source } : {}),
  };
}

// The frame's on-glass box follows the intrinsic ratio until a person resizes it.
export function imageBox({ aspect, width }: { aspect: number; width: number }) {
  const w = Math.round(Math.min(imageDefaults.maxW, Math.max(imageDefaults.minW, width)));
  return { w, h: Math.max(imageDefaults.minH, Math.round(w / aspect)) };
}
