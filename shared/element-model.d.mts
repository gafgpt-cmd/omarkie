import type { Anchor } from "./anchor-core.mjs";

export const elementKinds: string[];
export function elementId(kind: string, markdown: string, ordinal?: number): string;
export function tableCells(line: string): { markdown: string; start: number; end: number }[];

export interface PageElement {
  id: string;
  kind: string;
  line: number;
  endLine: number;
  blockLine: number;
  from: number;
  to: number;
  markdown: string;
  text: string;
  headings: string[];
  parent?: string;
  level?: number;
  language?: string;
  ordered?: boolean;
  row?: number;
  column?: number;
  landmarks: Anchor;
}

export function markdownElements(markdown: string, options?: { parser?: unknown }): PageElement[];
export function elementById(elements: PageElement[], id: string): PageElement | undefined;
