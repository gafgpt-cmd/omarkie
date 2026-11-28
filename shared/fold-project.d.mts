export type ProjectedKind = "highlight" | "ink" | "sticky" | "magnet";

export interface ProjectedUnit {
  line: number;
  endLine?: number;
  sectionId?: string | null;
}

export interface ProjectedMark {
  id: string;
  kind: ProjectedKind;
  line: number | null;
}

export interface Projection<M extends ProjectedMark> {
  /** Marks riding their own line, by unit index. */
  own: Map<number, M[]>;
  /** Dropped marks by the unit index of the line that absorbed them (-1: no line shows). */
  out: Map<number, M[]>;
  /** Magnets, one deck per section, by the unit index of the section's first shown line. */
  decks: Map<number, M[]>;
  /** Stickies in their own "tus palabras" fold, by absorbing unit index. */
  words: Map<number, M[]>;
  /** Marks no line holds: the re-anchor tray. */
  orphans: M[];
  ticks: { shown: number; total: number };
}

export declare function squash(text: string): string;
export declare function quoteSentences(list: readonly string[], quote: string): number[];
export declare function unitAtLine(units: readonly { line: number; endLine?: number }[], line: number | null | undefined): number;
export declare function projectAt<M extends ProjectedMark>(units: readonly ProjectedUnit[], marks: readonly M[], present: readonly boolean[],
  shown?: (mark: M, unit: number) => boolean): Projection<M>;
export declare function projectMarks<M extends ProjectedMark>(units: readonly (ProjectedUnit & { present: readonly boolean[] })[], marks: readonly M[],
  shown?: (mark: M, unit: number, stop: number) => boolean): Projection<M>[];
