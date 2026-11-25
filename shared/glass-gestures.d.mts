export type GesturePoint = readonly [number, number] | { x: number; y: number };
export type GestureKind = "arrow" | "underline" | "circle" | "none";
export interface GestureLine { top: number; bottom: number }
export interface GestureBox { left: number; top: number; right: number; bottom: number; width: number; height: number }
export interface GestureResult {
  kind: GestureKind;
  confidence: number;
  reason: string;
  points: [number, number][];
  length?: number;
  chord?: number;
  box?: GestureBox;
  area?: number;
  crossings?: number;
  head?: { head: boolean; left: number; right: number; tip?: [number, number] };
  band?: { score: number; inside: number; line: GestureLine };
}

export declare const gestureDefaults: {
  minLength: number; minPoints: number; confident: number;
  underline: { length: number; flatness: number; inside: number };
  circle: { slack: number; factor: number; tight: number; area: number; size: number };
  arrow: { length: number; chord: number; head: number; turn: number };
};
export declare function pointsOf(points: readonly GesturePoint[]): [number, number][];
export declare function pathLength(points: readonly [number, number][]): number;
export declare function bounds(points: readonly [number, number][]): GestureBox;
export declare function centroid(points: readonly [number, number][]): { x: number; y: number };
export declare function chordOf(points: readonly [number, number][]): number;
export declare function polygonArea(points: readonly [number, number][]): number;
export declare function selfCrossings(points: readonly [number, number][], limit?: number): number;
export declare function arrowHeadOf(points: readonly [number, number][], options?: { length: number; chord: number; head: number; turn: number }): { head: boolean; left: number; right: number; tip?: [number, number] };
export declare function classifyGesture(points: readonly GesturePoint[], options?: { lines?: readonly GestureLine[] }): GestureResult;
export declare function gestureAction(result: GestureResult | undefined, options?: { hasText?: boolean; hasEnds?: boolean }): "none" | "highlight" | "connector" | "bubble";
export declare const gestureLabel: Record<"bubble" | "highlight" | "connector", string>;
