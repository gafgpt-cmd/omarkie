import type { FoldDocumentLadder, RawMeta } from "./fold-units.mjs";

export declare const OPENING: "opening";

/** `time`: the second a lecture line starts at in the note's audio; null outside a lecture note or without a stamp. */
export interface TopicLine { kind: "line"; unitId: string; line: number; markdown: string; time: number | null }
export interface TopicRaw { kind: "raw"; unitId: string; line: number; raw: RawMeta }
export type TopicItem = TopicLine | TopicRaw;

export interface TopicSection {
  /** Heading element id, or `OPENING` for the text before the first section heading. */
  id: string;
  /** Heading words as Markdown; null for the opening. */
  heading: string | null;
  level: number;
  line: number;
  parent: string | null;
  /** Unit a card or map node opens at Key: the heading, or the opening's first item. */
  anchor: string | null;
  items: TopicItem[];
  children: string[];
  /** Second its first stamped line starts at, in a lecture note. */
  time: number | null;
}

export interface FoldLecture {
  /** The audio embed unit and its wiki target. */
  unitId: string;
  target: string;
  times: { unitId: string; time: number }[];
}

export interface FoldTopic {
  title: { unitId: string; markdown: string } | null;
  sections: TopicSection[];
  audio: FoldLecture | null;
}

export interface TopicCard { section: TopicSection; eyebrow: string | null }

export declare function headingMarkdown(markdown: string): string;
export declare function foldLecture(ladder: FoldDocumentLadder): FoldLecture | null;
export declare function foldTopic(ladder: FoldDocumentLadder): FoldTopic;
export declare function topicCards(topic: FoldTopic): TopicCard[];
export declare function topicCardAt(topic: FoldTopic, line: number): TopicSection | null;
