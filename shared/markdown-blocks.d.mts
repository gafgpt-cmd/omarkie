import type { MarkdownIt } from "markdown-it";

export function markdownBlocks(md: MarkdownIt, source: string, environment?: Record<string, unknown>): {
  fromLine: number; toLine: number; source: string; kind: string;
}[];
export function plainProposal(md: MarkdownIt, text: string): boolean;
