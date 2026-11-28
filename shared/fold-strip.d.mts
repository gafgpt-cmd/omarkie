import type { DocumentUnit, FoldDocumentLadder, FoldPin } from "./fold-units.mjs";
import type { LocalLevelId } from "./fold-format.mjs";

export type StripGroup = "highlight" | "ink" | "card" | "magnet" | "navigation" | "redflag";
export type KeptClass = "negation" | "condition" | "restriction" | "number";

/** The fields of a fold mark the strip reads. */
export interface StripMark {
  kind: "highlight" | "ink" | "sticky" | "magnet";
  line: number | null;
  quote?: string;
  type?: string;
}

export interface StripChoice {
  seen: boolean;
  keep: Partial<Record<StripGroup, boolean>>;
}

export declare const STRIP_GROUPS: readonly StripGroup[];
export declare function markGroup(mark: StripMark): Exclude<StripGroup, "redflag"> | null;
export declare function redFlags(units: readonly DocumentUnit[]): FoldPin[];
export declare function stripGroups(marks: readonly StripMark[], flags: readonly FoldPin[]): { group: StripGroup; count: number }[];
export declare function readChoice(raw: string | null | undefined): StripChoice;
export declare function suggested(group: StripGroup): boolean;
export declare function keeps(choice: StripChoice, group: StripGroup): boolean;
export declare function setKeep(choice: StripChoice, groups: readonly StripGroup[], value: boolean): StripChoice;
export declare function markPins(marks: readonly StripMark[], choice: StripChoice): FoldPin[];
export declare function droppedPayload(plain: string, evidence: string): KeptClass | null;
export declare function keptPayload(ladder: FoldDocumentLadder, pins: readonly FoldPin[]): Map<number, Partial<Record<LocalLevelId, KeptClass>>>;
