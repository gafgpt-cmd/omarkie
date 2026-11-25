import type { GlassAnchor } from "../src/glass/anchor-map";

export const stickerIds: readonly string[];
export const stickerLayer: "notes";
export const customStickerBytes: number;
export const arrowStyles: readonly ["straight", "curved"];
export const arrowColors: readonly ["ink", "red", "blue", "green"];
export const arrowHeads: readonly ["solid", "open", "none"];
export type ArrowStyle = (typeof arrowStyles)[number];
export type ArrowColor = (typeof arrowColors)[number];
export type ArrowHead = (typeof arrowHeads)[number];
export type ArrowEnd =
  | { kind: "element"; element: string; anchor: GlassAnchor }
  | { kind: "magnet"; magnet: string };
export function validStickerImage(value: unknown): boolean;
export function validArrowEnd(value: unknown): boolean;
export function arrowEndKey(end: ArrowEnd): string;
