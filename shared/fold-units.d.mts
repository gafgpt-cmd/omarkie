import type { FoldLine, FoldUnit, RawClass } from "./fold-format.mjs";
import type { LocalLevelId } from "./fold-text.mjs";

export interface TableRawMeta {
  class: "table";
  rows: number;
  columns: number;
}

export interface CodeRawMeta {
  class: "code";
  lines: number;
  language: string | null;
}

export interface MathRawMeta {
  class: "math";
}

export interface ImageRawMeta {
  class: "image";
  kind: "image" | "embed";
  alt: string;
}

export type RawMeta = TableRawMeta | CodeRawMeta | MathRawMeta | ImageRawMeta;

export interface InlineMedia {
  elementId: string;
  kind: "image" | "embed";
  markdown: string;
  from: number;
  to: number;
}

export interface DocumentUnit extends FoldUnit {
  from: number;
  to: number;
  markdown: string;
  text: string;
  headings: string[];
  sectionId: string | null;
  rawMeta: RawMeta | null;
  inlineMedia: InlineMedia[];
  level?: number;
  language?: string;
  ordered?: boolean;
}

export interface FoldUnitContext {
  hasHeadings?: boolean;
  isFirstInSection?: boolean;
  isFirstInDocument?: boolean;
  hasMoreProseInSection?: boolean;
  hasMoreProseAfter?: boolean;
  /** Sentences to keep through Takeaway; a block pin keeps the first. */
  pin?: { quotes?: readonly string[]; block?: boolean } | null;
}

/** A mark that keeps its sentence: `quote` pins those words, no quote pins the line's block. */
export interface FoldPin {
  line: number;
  quote?: string;
}

export interface LadderOptions {
  parser?: unknown;
  pins?: readonly FoldPin[];
  /** This markdown's units from `extractUnits`, to skip extracting them again. */
  units?: DocumentUnit[];
}

export interface MonotonicViolation {
  stop: LocalLevelId;
  previous: LocalLevelId;
  words: number;
  limit: number;
}

export interface MonotonicResult<T extends string | FoldLine> {
  stops: Partial<Record<LocalLevelId, T>>;
  ok: boolean;
  violations: MonotonicViolation[];
}

export interface FoldedUnitEntry {
  elementId: string;
  kind: string;
  raw: RawClass | null;
  rawMeta: RawMeta | null;
  line: number;
  endLine: number;
  hash: string;
  sectionId: string | null;
  text: string;
  visible: boolean;
  words: number;
}

export interface UnitLadder {
  unit: DocumentUnit;
  stops: Record<LocalLevelId, string>;
  words: Record<LocalLevelId, number>;
  violations: MonotonicViolation[];
  /** Stops whose text a pin changed. */
  pinned: LocalLevelId[];
  /** The stops without this unit's pins; only on pinned units. */
  plain?: Record<LocalLevelId, string>;
}

export interface FoldStopResult {
  level: LocalLevelId;
  text: string;
  total: number;
  shown: number;
  entries: FoldedUnitEntry[];
}

export interface FoldDocumentLadder {
  units: DocumentUnit[];
  byUnit: UnitLadder[];
  stops: Record<LocalLevelId, FoldStopResult>;
  total: number;
}

export interface FoldDocumentResult extends FoldStopResult {
  units: DocumentUnit[];
}

export declare function sha256(text: string): string;
export declare function unitHash(kind: string, markdown: string): string;
export declare function rawClassOf(kindOrElement: string | { kind?: string } | null | undefined): RawClass | null;
export declare function toFoldUnit(unit: FoldUnit): FoldUnit;
export declare function extractUnits(markdown: string, options?: { parser?: unknown }): DocumentUnit[];
/** The sentences a pin can keep, split as the fold splits them. */
export declare function unitSentences(unit: DocumentUnit): string[];
export declare function foldUnit(unit: DocumentUnit, level: number | LocalLevelId, context?: FoldUnitContext): string;
export declare function enforceMonotonic<T extends string | FoldLine>(stops: Partial<Record<LocalLevelId, T>>): MonotonicResult<T>;
export declare function isMonotonic(stops: Partial<Record<LocalLevelId, string | FoldLine>>): boolean;
export declare function foldDocumentLadder(markdown: string, options?: LadderOptions): FoldDocumentLadder;
export declare function foldDocument(markdown: string, level: number | LocalLevelId, options?: LadderOptions): FoldDocumentResult;
