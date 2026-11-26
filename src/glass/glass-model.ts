import type { GlassAnchor, GlassBlock } from "./anchor-map";
import { stickyColors } from "../../shared/glass-core.mjs";
import { validSource } from "../../shared/glass-images.mjs";
import { anchorFrom } from "./glass-state.ts";

// Same six colours the storage core accepts; tests/glass-sticky.test.mjs checks the journal round-trip.
export { stickyColors };
export type StickyColor = (typeof stickyColors)[number];
export const stickyDefaults = { w: 232, h: 168, minW: 152, minH: 104, folded: 46, textLimit: 20_000, grid: 8 } as const;

export interface GlassSource { element: string; line: number; path: string; kind?: string }

export interface StickyNote {
  id: string;
  text: string;
  color: StickyColor;
  anchor: GlassAnchor;
  x: number;
  y: number;
  w: number;
  h: number;
  folded: boolean;
  source?: GlassSource;
}

export interface GlassMagnet {
  id: string;
  fields: Record<string, unknown>;
  kind?: string | null;
  deleted?: boolean;
}

const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

export function stickyFromMagnet(magnet: GlassMagnet): StickyNote | undefined {
  const fields = magnet.fields ?? {};
  if ((fields.kind ?? magnet.kind) !== "sticky") return;
  const anchor = anchorFrom(fields.anchor);
  const color = stickyColors.find(item => item === fields.color) ?? stickyColors[0];
  const source = validSource(fields.source) ?? undefined;
  return {
    id: magnet.id,
    text: typeof fields.text === "string" ? fields.text.slice(0, stickyDefaults.textLimit) : "",
    color,
    anchor: anchor ?? { landmarks: [] },
    x: number(fields.x, 0, -200_000, 200_000),
    y: number(fields.y, 0, -200_000, 200_000),
    w: number(fields.w, stickyDefaults.w, stickyDefaults.minW, 4000),
    h: number(fields.h, stickyDefaults.h, stickyDefaults.minH, 4000),
    folded: fields.folded === true,
    ...(source ? { source } : {}),
  };
}

export function stickyFields(note: StickyNote): Record<string, unknown> {
  return { kind: "sticky", text: note.text, color: note.color, anchor: note.anchor, x: note.x, y: note.y, w: note.w, h: note.h, folded: note.folded,
    ...(note.source ? { source: note.source } : {}) };
}

export function newStickyId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function snapped(value: number) {
  return Math.round(value / stickyDefaults.grid) * stickyDefaults.grid;
}

export function anchorOf(block: GlassBlock): GlassAnchor {
  return { landmarks: [{ kind: "block", block: block.block, headings: block.headings, line: block.line }] };
}

// Creation point → the paragraph it lands on: inside the block, else the nearest one vertically.
export function nearestBlock(blocks: readonly GlassBlock[], point: { x: number; y: number }): GlassBlock | undefined {
  let inside: GlassBlock | undefined, nearest: GlassBlock | undefined, distance = Infinity;
  for (const block of blocks) {
    const element = block.element;
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (point.y >= rect.top && point.y <= rect.bottom && point.x >= rect.left && point.x <= rect.right) inside = block;
    const gap = point.y < rect.top ? rect.top - point.y : point.y > rect.bottom ? point.y - rect.bottom : 0;
    if (gap < distance) { nearest = block; distance = gap; }
  }
  return inside ?? nearest;
}

// Content-space offset of a point from its paragraph; the layer scrolls with the page,
// so both rectangles move together and only their difference matters.
export function offsetIn(block: GlassBlock, point: { x: number; y: number }, rtl = false) {
  const element = block.element;
  if (!element) return { x: 0, y: 0 };
  const rect = element.getBoundingClientRect();
  return { x: snapped(rtl ? rect.right - point.x : point.x - rect.left), y: snapped(point.y - rect.top) };
}
