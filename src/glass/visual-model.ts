import {
  validCompareFields, validMeasureFields, validSheetLabelFields,
  validTraceFields, type CompareDirection, type MeasureKind, type Point2,
  type TraceTool,
} from "../../shared/glass-visual.mjs";
import { anchorFrom } from "./glass-state";
import type { GlassAnchor } from "./anchor-map";
import type { GlassMagnet } from "./glass-model";

export interface TraceMark {
  id: string;
  image: string;
  sheet: string;
  tool: TraceTool;
  color: string;
  size: number;
  refWidth: number;
  points: [number, number, number][];
}

export interface SheetLabel {
  id: string;
  image: string;
  sheet: string;
  x: number;
  y: number;
  text: string;
  size: number;
}

export interface MeasureMark {
  id: string;
  image: string;
  type: MeasureKind;
  points: Point2[];
}

export interface CompareMark {
  id: string;
  left: string;
  right: string;
  value: number;
  direction: CompareDirection;
  before: string;
  after: string;
  anchor: GlassAnchor;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function newVisualId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
export function traceFromMagnet(magnet: GlassMagnet): TraceMark | undefined {
  const fields = magnet.fields ?? {};
  if ((fields.kind ?? magnet.kind) !== "trace") return;
  const valid = validTraceFields({ ...fields, kind: "trace", layer: "trace" });
  if (!valid) return;
  return {
    id: magnet.id, image: valid.image as string, sheet: valid.sheet as string,
    tool: valid.tool as TraceTool, color: valid.color as string, size: valid.size as number,
    refWidth: valid.refWidth as number, points: valid.points as [number, number, number][],
  };
}

export function traceFields(trace: TraceMark): Record<string, unknown> {
  return { kind: "trace", layer: "trace", image: trace.image, sheet: trace.sheet, tool: trace.tool,
    color: trace.color, size: trace.size, refWidth: trace.refWidth, points: trace.points };
}

export function sheetLabelFromMagnet(magnet: GlassMagnet): SheetLabel | undefined {
  const fields = magnet.fields ?? {};
  if ((fields.kind ?? magnet.kind) !== "sheet-label") return;
  const valid = validSheetLabelFields({ ...fields, kind: "sheet-label", layer: "trace" });
  if (!valid) return;
  return { id: magnet.id, image: valid.image as string, sheet: valid.sheet as string,
    x: valid.x as number, y: valid.y as number, text: valid.text as string, size: valid.size as number };
}

export function sheetLabelFields(label: SheetLabel): Record<string, unknown> {
  return { kind: "sheet-label", layer: "trace", image: label.image, sheet: label.sheet,
    x: label.x, y: label.y, text: label.text, size: label.size };
}

export function measureFromMagnet(magnet: GlassMagnet): MeasureMark | undefined {
  const fields = magnet.fields ?? {};
  if ((fields.kind ?? magnet.kind) !== "measure") return;
  const valid = validMeasureFields({ ...fields, kind: "measure", layer: "measure" });
  if (!valid) return;
  return { id: magnet.id, image: valid.image as string, type: valid.type as MeasureKind, points: valid.points as Point2[] };
}

export function measureFields(measure: MeasureMark): Record<string, unknown> {
  return { kind: "measure", layer: "measure", image: measure.image, type: measure.type, points: measure.points };
}

export function compareFromMagnet(magnet: GlassMagnet): CompareMark | undefined {
  const fields = magnet.fields ?? {};
  if ((fields.kind ?? magnet.kind) !== "compare") return;
  const valid = validCompareFields({ ...fields, kind: "compare", layer: "compare" });
  if (!valid) return;
  const anchor = anchorFrom(valid.anchor);
  if (!anchor) return;
  return {
    id: magnet.id, left: valid.left as string, right: valid.right as string, value: valid.value as number,
    direction: valid.direction as CompareDirection, before: valid.before as string, after: valid.after as string,
    anchor, x: valid.x as number, y: valid.y as number, w: valid.w as number, h: valid.h as number,
  };
}

export function compareFields(compare: CompareMark): Record<string, unknown> {
  return { kind: "compare", layer: "compare", left: compare.left, right: compare.right, value: compare.value,
    direction: compare.direction, before: compare.before, after: compare.after, anchor: compare.anchor,
    x: compare.x, y: compare.y, w: compare.w, h: compare.h };
}

export function compareSides(left: string, right: string) {
  return { left: right, right: left };
}
