export type ImageWrap = "left" | "right" | "behind" | "front";

export const imageWraps: readonly ImageWrap[];
export const imageDefaults: {
  w: number; minW: number; maxW: number; minH: number; maxH: number;
  maxBytes: number; nameLimit: number; fileLimit: number;
  displayBytes: number; displayPixels: number; displayEdge: number; displayMax: number;
  rotateLimit: number; offsetLimit: number;
};
export const imageFieldNames: Set<string>;

export function imageTypeOf(bytes: string | Uint8Array | ArrayBuffer | Buffer | null | undefined): string | null;
export function extensionFor(type: string): string | null;
export function mimeFor(type: string | null): string;
export function needsPreview(type: string): boolean;
export function convertible(type: string): boolean;
export function orientationSize(input: { width?: number; height?: number; orientation?: number }): { width: number; height: number } | null;
export function displayNeeded(input: { width?: number; height?: number; bytes?: number; type?: string }): boolean;
export function displaySize(input: { width?: number; height?: number }): { width: number; height: number };
export function assetFile(wanted: unknown, extension: string, taken?: Set<string>): string;
export function displayFile(asset: string): string;
export function isAssetName(value: unknown): boolean;
export function imageFields(input?: Record<string, unknown>, options?: { partial?: boolean }): Record<string, unknown>;
export function scrapImageMagnet(input: {
  scrap: { id?: string; body?: string; image?: { side?: string; width?: number; name?: string }; anchor?: { line?: number } };
  asset: string;
  width?: number;
  height?: number;
  blockText?: string;
  headings?: string[];
  display?: string | null;
}): { id: string; fields: Record<string, unknown> };
