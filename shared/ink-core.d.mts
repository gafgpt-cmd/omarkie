export type InkTool = "pen" | "highlighter";
export type InkPoint = [number, number, number];
export type InkBoxRef =
  | { kind: "block" }
  | { kind: "item"; index: number; text?: string }
  | { kind: "cell"; row: number; col: number; text?: string };

export declare const inkTools: InkTool[];
export declare const inkWidths: Record<InkTool, number[]>;
export declare const inkColors: Record<InkTool, string[]>;
export declare const inkLimits: { parts: number; partPoints: number; points: number; size: number; reach: number };

export declare function inkDefaults(tool?: string): { tool: InkTool; color: string; size: number };
export declare function validInkTool(value: unknown): value is InkTool;
export declare function validInkColor(tool: unknown, value: unknown): value is string;
export declare function validInkSize(tool: unknown, value: unknown): value is number;
export declare function validInkPoint(point: unknown): boolean;
export declare function validInkPoints(points: unknown): boolean;
export declare function validInkBox(box: unknown): box is InkBoxRef;
export declare function validInkPart(part: unknown): boolean;
export declare function validInkParts(parts: unknown): boolean;
export declare function quantizePoint(point: readonly number[]): InkPoint;
export declare function quantizePoints(points: readonly InkPoint[]): InkPoint[];
export declare function splitRuns<T>(points: readonly T[], keyOf: (point: T) => string): { key: string; points: T[] }[];
export declare function chiselOutline(points: readonly InkPoint[], size: number): number[][];
export declare function inkPath(points: readonly InkPoint[], options: { tool: string; size: number }): string;
export declare function boxHit<T extends { left: number; top: number; width: number; height: number }>(boxes: readonly T[], point: { x: number; y: number }): T | undefined;
export declare function toBoxPoints(points: readonly InkPoint[], rect: { left: number; top: number; width: number; height: number }): InkPoint[];
export declare function fromBoxPoints(points: readonly InkPoint[], rect: { left: number; top: number; width: number; height: number }): InkPoint[];
export declare function drawsPointer(type: string, state?: { penSeen?: boolean; drawing?: boolean }): boolean;
export declare function pressureOf(type: string, pressure?: number): number;
export declare function biteRuns(points: readonly InkPoint[], center: { x: number; y: number }, radius: number): InkPoint[][];
