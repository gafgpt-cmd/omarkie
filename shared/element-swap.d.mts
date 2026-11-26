export type SwapAction = "enhance" | "find" | "generate" | "rewrite" | "redraw";
export type SwapMode = "cover" | "replace";

export const swapActionList: SwapAction[];
export const swapActionLabels: Record<SwapAction, string>;
export const swapDestinations: Record<SwapMode, { label: string; hint: string }>;
export const swapDefaults: {
  candidates: number; minEdge: number; complaintLimit: number; textLimit: number;
  proposalBatch: number; proposalNote: number; proposalHour: number; searchResults: number;
  previewBytes: number; voiceSeconds: number;
};
export const allowedLicences: string[];

export interface SwapLicence { code: string; version: string | null; url: string | null; attribution: string; required: boolean }
export interface SwapCandidate {
  id?: string;
  kind: SwapAction;
  title?: string;
  text?: string;
  markdown?: string;
  source?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  creator?: string;
  width?: number;
  height?: number;
  bytes?: number;
  licence?: SwapLicence | Record<string, unknown> | null;
  notes?: string;
  online?: boolean;
  preview?: { base64: string; mime: string } | null;
}
export interface SwapIssue { code: string; hint: string }

export function swapActionsFor(element: { kind?: string; language?: string } | undefined): SwapAction[];
export function swapSupports(kind: string): boolean;
export function isSwapId(value: unknown): boolean;
export function normalLicence(value: unknown): SwapLicence | null;
export function licenceVerdict(licence: SwapLicence | null): { allowed: boolean; code?: string | null; reason: string };
export function isOnlineSource(source: unknown): boolean;
export function candidateIssues(candidate: SwapCandidate | null | undefined): SwapIssue[];
export function candidateAllowed(candidate: SwapCandidate | null | undefined): { ok: boolean; code: string | null; hint: string };
export function attributionText(candidate: SwapCandidate, options?: { accessed?: number | string; operations?: string[] }): string;
export function swapFootnoteId(swapId: string): string;
export function swapFootnote(swapId: string, text: string): string;
export function swapFootnoteRef(swapId: string): string;
export function replacementLines(candidate: SwapCandidate, options: { imageMarkdown?: string; swapId: string; accessed?: number | string; operations?: string[] }): string[];
export function compareSet<T extends object>(original: T | undefined, candidates?: T[]): (T & { current: boolean; compareIndex: number })[];
export function onlineAllowed(options?: { requested?: boolean; neverOnline?: boolean }): { allowed: boolean; code: string | null; reason: string };
export function capProposals<T extends { element?: string; candidateId?: string; title?: string; at?: number; dismissed?: boolean; applied?: boolean }>(
  proposals: T[] | null | undefined, options?: { now?: number; hourMs?: number }): T[];
export interface SwapRecord { swapId: string; op: string; element?: { id?: string }; at?: number }
export function replaySwaps(text: string | null | undefined): { applied: SwapRecord[]; proposals: SwapRecord[]; dismissed: Set<string> };
export function latestSwaps(applied: SwapRecord[] | null | undefined): SwapRecord[];
export function swapDiff(text: string, element: { from: number; to: number }, lines: string[], eol?: string): {
  rows: { kind: "context" | "add" | "remove"; text: string }[]; added: string[]; removed: string[]; next: string;
};
