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
