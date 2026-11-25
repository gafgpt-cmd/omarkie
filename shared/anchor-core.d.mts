export const anchorVersion: number;
export const contextWidth: number;

export interface AnchorFingerprint {
  tag: string;
  hash: string;
  name?: string;
}
export interface AnchorQuote {
  exact: string;
  prefix: string;
  suffix: string;
}
export interface AnchorPosition {
  line: number;
  char: number;
  word: number;
  percent: number;
}
export interface AnchorSpot {
  x: number;
  y: number;
  px: number;
  py: number;
}
export type AnchorLandmark =
  | { kind: "block"; block: string; headings: readonly string[]; line?: number }
  | { kind: "fingerprint"; value: AnchorFingerprint }
  | { kind: "quote"; value: AnchorQuote }
  | { kind: "heading"; value: { path: readonly string[] } }
  | { kind: "neighbours"; value: { before?: string; after?: string } }
  | { kind: "position"; value: AnchorPosition }
  | { kind: "spot"; value: AnchorSpot };
export interface Anchor {
  version?: number;
  landmarks: readonly AnchorLandmark[];
}
export interface AnchorBlock {
  block: string;
  headings: readonly string[];
  line: number;
  kind?: string;
  from?: number;
  to?: number;
  words?: number;
  percent?: number;
  prefix?: string;
  suffix?: string;
}

export function normalizeText(text: string): string;
export function sectionKey(headings: readonly string[]): string;
export function textHash(text: string): string;
export function captureAnchor(block: AnchorBlock, blocks: readonly AnchorBlock[]): Anchor;
