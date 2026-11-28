import type { RawClass } from "./fold-format.mjs";
import type { LocalLevelId } from "./fold-text.mjs";
import type { DocumentUnit, FoldPin } from "./fold-units.mjs";

export type FactClass = "number" | "negation" | "condition" | "restriction" | "uncertainty" | "scope" | "attribution";
export type EditionKind = "added" | "removed" | "changed";

/** One payload change: a number old → new, a new never-do (its clause, as plain text), a condition gone. */
export interface EditionFact {
  class: FactClass;
  change: EditionKind;
  old: string | null;
  new: string | null;
}

export interface EditionSide {
  elementId: string;
  kind: string;
  raw: RawClass | null;
  line: number;
  endLine: number;
  sectionId: string | null;
  headings: string[];
  /** This side's text at each local stop; changed lines pinned through Takeaway. */
  stops: Record<LocalLevelId, string>;
}

export interface EditionChange {
  kind: EditionKind;
  old: EditionSide | null;
  new: EditionSide | null;
  facts: EditionFact[];
  /** Lines (sentences, table rows) that came, went, or were edited. */
  sentences: { added: number; removed: number; changed: number };
}

export interface Edition {
  changes: EditionChange[];
  counts: { added: number; removed: number; changed: number; unchanged: number; moved: number };
  /** Words of the new edition. */
  total: number;
  /** Words the changes show at each stop. */
  shown: Record<LocalLevelId, number>;
}

export declare const FACT_CLASSES: readonly FactClass[];
export declare function sentenceKey(text: string): string;
export declare function unitPieces(unit: DocumentUnit): string[];
export declare function factsOf(before: string | null, after: string | null): EditionFact[];
export declare function foldEdition(oldMarkdown: string, newMarkdown: string, options?: { pins?: readonly FoldPin[] }): Edition;
