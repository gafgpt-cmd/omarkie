// The marks the Fold view projects: study highlights and Glass magnets, read from where they live.
// Learning mode publishes them; the fold never copies or writes a mark itself, it asks the publisher.
import type { SheetColour } from "../../../shared/reading-store.ts";
import type { InkTool } from "../../../shared/ink-core.mjs";
import type { InkPart } from "../../glass/ink-model";
import type { StudyMark } from "../learning-overlays";

export type FoldMarkKind = "highlight" | "ink" | "sticky" | "magnet";
export type MagnetType = "clip" | "card" | "image" | "arrow" | "label" | "comment" | "voice" | "other";

export interface FoldInk { stroke: string; tool: InkTool; color: string; size: number; part: InkPart }

export interface FoldMark {
  id: string;
  kind: FoldMarkKind;
  // Source line it rides; null: no paragraph holds it any more (the re-anchor tray).
  line: number | null;
  // Glass placement the reader should confirm.
  check?: boolean;
  colour?: SheetColour;
  quote?: string;
  text?: string;
  type?: MagnetType;
  ink?: FoldInk;
}

export interface FoldMarksState {
  marks: readonly FoldMark[];
  // Study marks by source line, for the Rayos X lens.
  study: ReadonlyMap<number, readonly StudyMark[]>;
  canUndo: boolean;
  // Make a highlight from author words inside these source lines; false when it was not saved.
  highlight(line: number, endLine: number, quote: string, colour: SheetColour): Promise<boolean>;
  // Take back the last study change.
  undo(): Promise<boolean>;
  // Highlights that could still become cards (the note's card limit counted), and opening their drafts for review.
  uncarded: number;
  makeCards(): void;
}

export interface FoldMarks {
  get(): FoldMarksState;
  set(next: FoldMarksState): void;
  subscribe(listener: () => void): () => void;
}

export const emptyFoldMarks: FoldMarksState = { marks: [], study: new Map(), canUndo: false, highlight: async () => false, undo: async () => false, uncarded: 0, makeCards: () => {} };

export function createFoldMarks(): FoldMarks {
  let state = emptyFoldMarks;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) { state = next; for (const listener of listeners) listener(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
