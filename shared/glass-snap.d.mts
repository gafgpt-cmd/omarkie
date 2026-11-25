export interface SnapBox { x: number; y: number; w: number; h: number }
export interface SnapLine { y: number; x?: number; width?: number }
export interface SnapColumn { left?: number; right?: number }
export type SnapGuideKind = "edge" | "center" | "column" | "line" | "spacing";
export interface SnapGuide {
  axis: "x" | "y";
  kind: SnapGuideKind;
  at: number;
  from?: number;
  to?: number;
  gap?: number;
}
export type SnapGridSize = 8 | 16 | 24;

export declare const snapDefaults: {
  readonly grid: 8;
  readonly sizes: readonly SnapGridSize[];
  readonly threshold: 6;
  readonly lineThreshold: 12;
  readonly spacing: 8;
  readonly liftScale: 1.02;
  readonly settleMs: 150;
};

export declare function snapSetting(value: unknown): { on: boolean; size: SnapGridSize };
export declare function gridValue(value: unknown, fallback?: number): SnapGridSize;

export declare function snapBox(options: {
  box: SnapBox;
  others?: readonly SnapBox[];
  column?: SnapColumn;
  lines?: readonly SnapLine[];
  grid?: number;
  threshold?: number;
  lineThreshold?: number;
  spacing?: number;
  disabled?: boolean;
}): { x: number; y: number; guides: SnapGuide[]; snapped: { x: boolean; y: boolean } };

export declare function settleDelta(from: { x: number; y: number } | undefined, to: { x: number; y: number } | undefined): { x: number; y: number };
