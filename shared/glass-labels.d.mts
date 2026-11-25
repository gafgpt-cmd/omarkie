export const labelDefaults: {
  textLimit: number; offsetLimit: number; minPin: number; maxPin: number; textMinWidth: number; hitRadius: number;
};
export const labelFieldNames: Set<string>;

export interface LabelMagnetTarget { kind: "magnet"; magnet: string }
export interface LabelElementTarget {
  kind: "element"; element: string; anchor: { version?: number; landmarks: readonly unknown[] };
}
export type LabelTarget = LabelMagnetTarget | LabelElementTarget;

export function validLabelTarget(value: unknown): value is LabelTarget;
export function labelFields(fields: Record<string, unknown>, partial?: boolean): Record<string, unknown>;
export function labelPoint(box: { x: number; y: number; width: number; height: number }, nx: number, ny: number): { x: number; y: number };
export function labelBox(pin: { x: number; y: number }, dx: number, dy: number): { left: number; top: number; width: number };
export interface GlassMagnetView { id: string; fields: Record<string, unknown>; kind?: string | null; deleted?: boolean }
export declare const kindOf: (magnet: GlassMagnetView) => string;
export declare function magnetLabel(kind: string, fields?: Record<string, unknown>): string;
export declare function sourceQuote(fields?: Record<string, unknown>): { quote: string; line: number | null };
export declare function anchorLine(fields?: Record<string, unknown>): number;
export declare function readingOrder<T extends GlassMagnetView>(magnets: T[]): T[];
export declare function arrowConnections(magnets: GlassMagnetView[]): { magnet: GlassMagnetView; from: string; to: string; label: string }[];
