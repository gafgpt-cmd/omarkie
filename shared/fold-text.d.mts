import type { Level } from "./fold-format.mjs";

export type LocalLevelId = "full" | "brief" | "key" | "takeaway" | "topic";
export type FoldBlockKind = "frontmatter" | "heading" | "code" | "list" | "table" | "quote" | "para" | "rule" | "art";

export interface FoldBlock {
  kind: FoldBlockKind;
  lines: string[];
}

export interface SentenceCut {
  head: string;
  more: boolean;
  rest: string;
}

export interface SentencePrefix {
  text: string;
  more: boolean;
}

export interface FoldResult {
  text: string;
  total: number;
  shown: number;
}

export declare const LOCAL_LEVELS: readonly Level[];
export declare const MIN_WORDS: 80;
export declare const MIN_HIDDEN: 0.25;

export declare function blocks(md: string): FoldBlock[];
export declare function firstSentence(text: string): SentenceCut;
export declare function sentences(text: string, n: number): SentencePrefix;
export declare function words(md: string): number;
export declare function worthFolding(md: string, folded: string): boolean;
export declare function fold(md: string, level: number | LocalLevelId): FoldResult;
