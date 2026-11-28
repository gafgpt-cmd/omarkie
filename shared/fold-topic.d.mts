import type { FoldDocumentLadder, RawMeta } from "./fold-units.mjs";

export declare const OPENING: "opening";

export interface TopicLine { kind: "line"; unitId: string; line: number; markdown: string }
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
}

export interface FoldTopic {
  title: { unitId: string; markdown: string } | null;
  sections: TopicSection[];
}

export interface TopicCard { section: TopicSection; eyebrow: string | null }

export declare function headingMarkdown(markdown: string): string;
export declare function foldTopic(ladder: FoldDocumentLadder): FoldTopic;
export declare function topicCards(topic: FoldTopic): TopicCard[];
export declare function topicCardAt(topic: FoldTopic, line: number): TopicSection | null;
