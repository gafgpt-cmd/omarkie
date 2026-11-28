import type { AuthorText, CheckClass, Evidence, FoldLine, WrittenSection, WrittenUnit } from "./fold-format.d.mts";

export type PayloadClass =
  | "negation"
  | "restriction"
  | "condition"
  | "uncertainty"
  | "number"
  | "scope"
  | "attribution";

export declare const PAYLOAD_CLASSES: readonly PayloadClass[];
export declare const NUMBER_GAP: "—?";

export type NumberDirection = ">" | "<" | "≥" | "≤" | "↑" | "↓";

export interface NumberToken {
  raw: string;
  value: number;
  high?: number;
  unit: string | null;
  rawUnit: string | null;
  direction: NumberDirection | null;
  start: number;
  end: number;
  spelled?: boolean;
}

export interface PayloadTokens {
  negation: { raw: string; kind: "negation" | "exception" | "contraindication" }[];
  restriction: { raw: string; kind: "exclusivity" | "universality" }[];
  condition: { raw: string; kind: "conditional" | "negative_conditional" }[];
  uncertainty: { raw: string; tier: "low" | "mid" | "high" | "certainty" }[];
  number: NumberToken[];
  scope: { raw: string; canonical: string; kind: "population" | "party" | "jurisdiction" | "version" }[];
  attribution: { raw: string; canonical: string; kind: "source" | "cue" }[];
}

export type CheckAction =
  | "retry"
  | "fallback_brief"
  | "gap"
  | "out_of_fold"
  | "demote"
  | "strip";

export interface CheckFinding {
  class: CheckClass;
  code: string;
  message: string;
  missing?: string[];
  extra?: string[];
  action: CheckAction;
}

export type PinInput = string | { id?: string; quote?: string; text?: string };

export interface FormatCheckResult {
  ok: boolean;
  status: "pass" | "fail";
  findings: CheckFinding[];
  sanitized: string;
}

export interface PinsCheckResult {
  ok: boolean;
  status: "pass" | "fail";
  covered: PinInput[];
  outOfFold: PinInput[];
  findings: CheckFinding[];
}

export interface MonotonicStopsInput<T extends FoldLine | string = FoldLine | string> {
  full?: T;
  brief?: T;
  key: T;
  takeaway: T;
  topic: T;
}

export interface MonotonicCheckResult<T extends FoldLine | string = FoldLine | string> {
  ok: boolean;
  status: "pass" | "fail";
  stops: {
    brief?: T;
    key: T;
    takeaway: T;
    topic: T;
  };
  counts: {
    full?: number;
    brief?: number;
    key: number;
    takeaway: number;
    topic: number;
  };
  demoted: ("brief" | "key" | "takeaway" | "topic")[];
  findings: CheckFinding[];
}

export interface EvidenceValidationResult {
  ok: boolean;
  problems: string[];
}

export interface CheckLineOptions {
  unitText?: string;
  brief?: AuthorText | string;
  pins?: readonly PinInput[];
  retryAvailable?: boolean;
}

export interface LineCheckResult {
  ok: boolean;
  checks: Partial<Record<CheckClass, "pass" | "fail">>;
  findings: CheckFinding[];
  text: string;
  resolved: FoldLine;
  fallback: "brief" | null;
  warning: boolean;
  retryTokens: string[];
  outOfFold: PinInput[];
  evidenceValid: boolean;
}

export interface CheckWrittenUnitOptions extends CheckLineOptions {
  full?: FoldLine | string;
}

export interface WrittenUnitCheckResult {
  ok: boolean;
  checks: Record<CheckClass, "pass" | "fail">;
  stops: {
    key: LineCheckResult;
    takeaway: LineCheckResult;
    topic: LineCheckResult;
  };
  monotonic: MonotonicCheckResult<FoldLine>;
  findings: CheckFinding[];
  unit: WrittenUnit;
  warning: boolean;
}

export declare function countWords(text: string): number;
export declare function extractPayload(text: string, options?: { includeSpelled?: boolean }): PayloadTokens;
/** Negation, restriction and condition only: the payload classes that are cheap to read on every fold. */
export declare function extractPolarity(text: string): Pick<PayloadTokens, "negation" | "restriction" | "condition">;
/** Whether a sentence carries a red flag: a contraindication, never, avoid, must not, or a command not to act. */
export declare function isRedFlag(text: string): boolean;
export declare function checkFormat(text: string): FormatCheckResult;
export declare function checkPins(line: FoldLine | string, pins?: readonly PinInput[]): PinsCheckResult;
export declare function checkMonotonic<T extends FoldLine | string>(stops: MonotonicStopsInput<T>): MonotonicCheckResult<T>;
export declare function validateEvidence(unitText: string, evidenceList: readonly Evidence[]): EvidenceValidationResult;
export declare function checkLine(
  line: FoldLine | string,
  evidence?: readonly (Evidence | string)[] | string,
  options?: CheckLineOptions,
): LineCheckResult;
export declare function checkWrittenUnit(unit: WrittenUnit, options?: CheckWrittenUnitOptions): WrittenUnitCheckResult;

export interface LadderChunkUnit { elementId: string; kind: string; raw: string | null; sectionId?: string | null; text: string; markdown?: string }
export interface LadderLocalStops { full?: string; brief?: string; key?: string; takeaway?: string; topic?: string }
export interface LadderChunkContext {
  units: readonly LadderChunkUnit[];
  stops: ReadonlyMap<string, LadderLocalStops>;
  pins?: readonly { elementId: string; quote: string }[];
  sectionIds?: readonly string[];
}
export interface LadderChunkResult {
  written: WrittenUnit[];
  sections: WrittenSection[];
  warnings: number;
  /** Units the retry call named. */
  retried: string[];
}
export declare function checkLadderChunk(
  ask: (retry: Record<string, string[]> | null) => Promise<unknown>,
  context: LadderChunkContext,
): Promise<LadderChunkResult>;
