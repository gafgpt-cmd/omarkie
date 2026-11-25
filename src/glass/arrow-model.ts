import type { GlassAnchor } from "./anchor-map";
import type { GlassMagnet } from "./glass-model";
import {
  arrowColors, arrowHeads, arrowStyles, validArrowEnd,
  type ArrowColor, type ArrowEnd, type ArrowHead, type ArrowStyle,
} from "../../shared/glass-marks.mjs";

// G8 arrows: pure geometry, so the renderer only draws and the unit test can prove the route.
export interface Box { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }
export interface EndMark extends Box { name?: string }

export interface ArrowMark {
  id: string;
  from: ArrowEnd;
  to: ArrowEnd;
  style: ArrowStyle;
  color: ArrowColor;
  head: ArrowHead;
  label: string;
}

export interface ArrowRoute {
  id: string;
  d: string;
  head: string;
  filled: boolean;
  from: Point;
  to: Point;
  label: Point;
}

export interface Jump {
  far: "from" | "to";
  direction: "up" | "down";
  point: Point;
}

export const arrowDefaults = { style: "straight" as ArrowStyle, color: "ink" as ArrowColor, head: "solid" as ArrowHead, labelLimit: 240 };

export function arrowFromMagnet(magnet: GlassMagnet): ArrowMark | undefined {
  if (magnet.kind !== "arrow") return;
  const { fields } = magnet;
  if (!validArrowEnd(fields.from) || !validArrowEnd(fields.to)) return;
  const style = arrowStyles.find(value => value === fields.style) ?? arrowDefaults.style;
  const color = arrowColors.find(value => value === fields.color) ?? arrowDefaults.color;
  const head = arrowHeads.find(value => value === fields.head) ?? arrowDefaults.head;
  return { id: magnet.id, from: fields.from as ArrowEnd, to: fields.to as ArrowEnd, style, color, head,
    label: typeof fields.label === "string" ? fields.label : "" };
}

export function arrowFields(arrow: ArrowMark): Record<string, unknown> {
  return { kind: "arrow", from: arrow.from, to: arrow.to, style: arrow.style, color: arrow.color, head: arrow.head, label: arrow.label };
}

// The arrow touches the box edge, never its centre: an arrowhead sits on the paragraph, not over its words.
export function edgePoint(box: Box, toward: Point): Point {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const dx = toward.x - cx, dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const tx = dx ? box.width / 2 / Math.abs(dx) : Infinity;
  const ty = dy ? box.height / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty, 1);
  return { x: cx + dx * t, y: cy + dy * t };
}

function bezier(from: Point, to: Point, bend: number) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!length) return null;
  const nx = -dy / length, ny = dx / length;
  const offset = Math.sign(bend) * Math.min(Math.abs(bend), length * 0.22);
  return {
    c1: { x: from.x + dx * 0.32 + nx * offset, y: from.y + dy * 0.32 + ny * offset },
    c2: { x: from.x + dx * 0.68 + nx * offset, y: from.y + dy * 0.68 + ny * offset },
  };
}

export function arrowPath(from: Point, to: Point, style: ArrowStyle, bend = 56): { d: string; end: Point; angle: number } {
  if (style === "curved") {
    const curve = bezier(from, to, bend);
    if (curve) {
      const angle = Math.atan2(to.y - curve.c2.y, to.x - curve.c2.x);
      return {
        d: `M ${round(from.x)} ${round(from.y)} C ${round(curve.c1.x)} ${round(curve.c1.y)} ${round(curve.c2.x)} ${round(curve.c2.y)} ${round(to.x)} ${round(to.y)}`,
        end: to, angle,
      };
    }
  }
  return { d: `M ${round(from.x)} ${round(from.y)} L ${round(to.x)} ${round(to.y)}`, end: to, angle: Math.atan2(to.y - from.y, to.x - from.x) };
}

// A head is a triangle (solid), two strokes (open) or nothing.
export function headPath(tip: Point, angle: number, head: ArrowHead, size = 9): string {
  if (head === "none") return "";
  const wing = 0.5, back = { x: tip.x - Math.cos(angle) * size, y: tip.y - Math.sin(angle) * size };
  const left = { x: back.x + Math.cos(angle + Math.PI / 2 - wing) * size * 0.62, y: back.y + Math.sin(angle + Math.PI / 2 - wing) * size * 0.62 };
  const right = { x: back.x + Math.cos(angle - Math.PI / 2 + wing) * size * 0.62, y: back.y + Math.sin(angle - Math.PI / 2 + wing) * size * 0.62 };
  if (head === "open") return `M ${round(left.x)} ${round(left.y)} L ${round(tip.x)} ${round(tip.y)} L ${round(right.x)} ${round(right.y)}`;
  return `M ${round(tip.x)} ${round(tip.y)} L ${round(left.x)} ${round(left.y)} L ${round(right.x)} ${round(right.y)} Z`;
}

export function midpoint(from: Point, to: Point, style: ArrowStyle, bend = 44): Point {
  if (style !== "curved") return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
  if (!length) return from;
  const nx = -dy / length, ny = dx / length, offset = Math.sign(bend) * Math.min(Math.abs(bend), length * 0.22);
  return { x: (from.x + to.x) / 2 + nx * offset * 0.75, y: (from.y + to.y) / 2 + ny * offset * 0.75 };
}

export function routeArrow(arrow: ArrowMark, fromBox: Box, toBox: Box): ArrowRoute {
  const rawFrom = { x: fromBox.x + fromBox.width / 2, y: fromBox.y + fromBox.height / 2 };
  const rawTo = { x: toBox.x + toBox.width / 2, y: toBox.y + toBox.height / 2 };
  const from = edgePoint(fromBox, rawTo), to = edgePoint(toBox, rawFrom);
  const path = arrowPath(from, to, arrow.style);
  return { id: arrow.id, d: path.d, head: headPath(path.end, path.angle, arrow.head), filled: arrow.head === "solid",
    from, to, label: midpoint(from, to, arrow.style) };
}

// A long arrow whose other end is off-screen becomes a connector to a jump chip on the visible end.
export function jumpFor(view: { top: number; height: number }, ends: { from: Point; to: Point }, margin = 24): Jump | null {
  const bottom = view.top + view.height;
  const inside = (point: Point) => point.y >= view.top + margin && point.y <= bottom - margin;
  const fromIn = inside(ends.from), toIn = inside(ends.to);
  if (fromIn === toIn) return null;
  const visible = fromIn ? ends.from : ends.to, far = fromIn ? ends.to : ends.from;
  const travel = far.y < view.top ? "up" as const : "down" as const;
  return { far: fromIn ? "to" : "from", direction: travel,
    point: { x: visible.x, y: Math.min(Math.max(visible.y, view.top + 18), bottom - 18) } };
}

export interface ArrowEndContext {
  line(anchor: GlassAnchor): number | null;
  elementAt(line: number, id?: string): EndMark | undefined;
  magnet(id: string): EndMark | undefined;
}

// Both ends stay anchored: an element end re-finds its paragraph, a magnet end reads the magnet's box.
export function resolveArrowEnd(end: ArrowEnd, context: ArrowEndContext): EndMark | undefined {
  if (end.kind === "magnet") return context.magnet(end.magnet);
  const line = context.line(end.anchor);
  if (line === null) return;
  return context.elementAt(line, end.element);
}

export function routeArrows(arrows: readonly ArrowMark[], context: ArrowEndContext): { routes: ArrowRoute[]; orphans: string[] } {
  const routes: ArrowRoute[] = [], orphans: string[] = [], lines = new Map<string, number | null>();
  const line = (anchor: GlassAnchor) => {
    const key = JSON.stringify(anchor.landmarks);
    if (!lines.has(key)) lines.set(key, context.line(anchor));
    return lines.get(key) ?? null;
  };
  const ends = { ...context, line };
  for (const arrow of arrows) {
    const from = resolveArrowEnd(arrow.from, ends), to = resolveArrowEnd(arrow.to, ends);
    if (!from || !to) { orphans.push(arrow.id); continue; }
    routes.push(routeArrow(arrow, from, to));
  }
  return { routes, orphans };
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
