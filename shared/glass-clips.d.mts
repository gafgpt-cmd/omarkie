export const clipDefaults: {
  w: number; h: number; minW: number; minH: number; maxW: number; maxH: number;
  foldedW: number; foldedH: number; textLimit: number; titleLimit: number; offsetLimit: number;
};
export const extraPageDefaults: {
  w: number; h: number; minW: number; minH: number; maxW: number; maxH: number;
  textLimit: number; titleLimit: number; offsetLimit: number;
};
export const cutoutDefaults: {
  w: number; minW: number; maxW: number; minH: number; maxH: number;
  offsetLimit: number; nameLimit: number; lassoLimit: number; minCropPx: number;
};
export const sheetStrokeLimit: number;
export const sheetPointLimit: number;
export const sheetInkColors: readonly string[];
export const extraPagePapers: readonly ("lined" | "grid" | "dotted" | "kraft" | "plain")[];
export type SheetStroke = { color: string; size: number; points: [number, number][] };
export type CutoutRegion = { x: number; y: number; w: number; h: number };

export function validSheetStrokes(value: unknown): SheetStroke[] | null;
export function validRegion(value: unknown): CutoutRegion | null;
export function validLasso(value: unknown): [number, number][] | null;
export function clipFieldValues(fields: Record<string, unknown>, partial?: boolean): Record<string, unknown>;
export function extraPageFieldValues(fields: Record<string, unknown>, partial?: boolean): Record<string, unknown>;
export function cutoutFieldValues(fields: Record<string, unknown>, partial?: boolean): Record<string, unknown>;
export function regionOf(box: { x: number; y: number; width: number; height: number } | undefined,
  rect: { x: number; y: number; width: number; height: number } | undefined): CutoutRegion;
export function lassoOf(points: readonly (readonly [number, number])[],
  rect: { x: number; y: number; width: number; height: number }): [number, number][] | null;
export function sheetTitle(clip: { title?: string; text?: string }): string;
