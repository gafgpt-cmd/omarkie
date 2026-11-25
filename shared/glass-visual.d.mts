export type MeasureUnit = "mm" | "cm" | "m" | "in" | "ft" | "px";
export type MeasurePrecision = 0 | 1 | 2 | 3;
export type MeasureKind = "line" | "angle";
export type CompareDirection = "horizontal" | "vertical";
export type TraceTool = "pen" | "highlighter";

export interface TraceSheet {
  id: string;
  name: string;
  opacity: number;
  visible: boolean;
  locked: boolean;
}
export interface ImageScale {
  unit: MeasureUnit;
  precision: MeasurePrecision;
  length: number;
  line: [[number, number], [number, number]];
  frame: [number, number];
}
export type Point2 = [number, number];
export type Point3 = [number, number, number];

export const visualDefaults: {
  maxSheets: number; sheetNameLimit: number; labelLimit: number; labelSize: readonly number[];
  maxTracePoints: number; maxMeasures: number; compareGap: number; units: readonly MeasureUnit[];
  precisions: readonly MeasurePrecision[]; minCompare: number; maxCompare: number;
  minCompareHeight: number; maxCompareHeight: number; offsetLimit: number; traceLimit: number;
};
export const measureUnits: readonly MeasureUnit[];
export const measurePrecisions: readonly MeasurePrecision[];
export const compareDirections: readonly CompareDirection[];
export const measureKinds: readonly MeasureKind[];
export const traceLayers: { trace: string; measure: string; compare: string };

export function validMeasureUnit(value: unknown): value is MeasureUnit;
export function validPrecision(value: unknown): value is MeasurePrecision;
export function validSheetId(value: unknown): boolean;
export function validImageId(value: unknown): boolean;
export function validFrame(value: unknown): [number, number] | null;
export function validLine2(value: unknown): [Point2, Point2] | null;
export function validPoints2(value: unknown, count: number): Point2[] | null;
export function normalizeSheet(value: unknown): TraceSheet | null;
export function validSheets(value: unknown): TraceSheet[] | null;
export function validScale(value: unknown): ImageScale | null;
export function scaleFromLine(line: unknown, length: number, unit: MeasureUnit, precision: MeasurePrecision, frame: unknown): ImageScale;
export function pointInFrame(point: Point2, frame: [number, number]): [number, number];
export function planeDistance(first: Point2, second: Point2, frame: [number, number]): number;
export function unitsPerPixel(scale: ImageScale | null | undefined): number;
export function lineLength(points: Point2[], scale: ImageScale | null | undefined, frame: [number, number]): number | null;
export function formatMeasure(value: number, unit: MeasureUnit, precision: number): string;
export function formatAngle(degrees: number): string;
export function angleDegrees(points: Point2[], frame: [number, number]): number | null;
export function snapLinePoint(start: Point2, end: Point2, frame: [number, number], step?: number): Point2;
export function snapAnglePoint(vertex: Point2, arm: Point2, point: Point2, frame: [number, number], step?: number): Point2;
export function validTraceFields(fields: Record<string, unknown>): Record<string, unknown> | null;
export function validSheetLabelFields(fields: Record<string, unknown>): Record<string, unknown> | null;
export function validMeasureFields(fields: Record<string, unknown>): Record<string, unknown> | null;
export function validCompareFields(fields: Record<string, unknown>, options?: { partial?: boolean }): Record<string, unknown> | null;
export function compareValue(value: unknown): number;
export function compareDirection(leftAspect: unknown, rightAspect: unknown): CompareDirection;
export function measureLabel(measure: { type: MeasureKind; points: Point2[] } | null | undefined, scale: ImageScale | null | undefined, frame: [number, number]): string;
