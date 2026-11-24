import type { ReadingContext } from "../editor/MarkdownEditor";
import { readingBlocks } from "../components/reading-selection.ts";

// Mirrors shared/reading-core.cjs: block identity is normalized text plus heading path, with a
// 3-gram fallback at 0.8. tests/glass-anchor.test.mjs keeps both resolvers in agreement.
// An anchor is a strongest-first landmark list (vision: "landmark anchors"); G1 defines the
// block landmark, and later slices append quote, neighbours, position and spot kinds.
export type GlassLandmark = { kind: "block"; block: string; headings: readonly string[]; line?: number };
export interface GlassAnchor {
  landmarks: readonly GlassLandmark[];
}

export interface GlassOffset {
  x: number;
  y: number;
}

export type GlassPlacement =
  | { status: "resolved"; x: number; y: number; width: number; height: number }
  | { status: "orphan" };

export interface GlassBlock {
  block: string;
  headings: readonly string[];
  line: number;
  element?: HTMLElement;
}

export function normalizeText(text: string) {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function sectionKey(headings: readonly string[]) {
  return JSON.stringify(headings.map(normalizeText));
}

function grams(text: string) {
  const counts = new Map<string, number>();
  for (let index = 0, length = Math.max(text.length - 2, 1); index < length; index++) {
    const gram = text.slice(index, index + 3);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  return counts;
}

function similarity(text: string, candidate: string, counts: Map<string, number>) {
  const length = Math.max(text.length - 2, 1), other = Math.max(candidate.length - 2, 1);
  if (2 * Math.min(length, other) < 0.8 * (length + other)) return 0;
  let shared = 0;
  for (const [gram, count] of grams(candidate)) shared += Math.min(count, counts.get(gram) || 0);
  return (2 * shared) / (length + other);
}

export function matchBlock(anchor: GlassAnchor, blocks: readonly GlassBlock[]): number | null {
  const landmark = anchor.landmarks.find(landmark => landmark.kind === "block");
  if (!landmark) return null;
  const text = normalizeText(landmark.block), section = sectionKey(landmark.headings);
  const exact = new Set<number>(), elsewhere = new Set<number>();
  for (const block of blocks) {
    if (normalizeText(block.block) !== text) continue;
    elsewhere.add(block.line);
    if (sectionKey(block.headings) === section) exact.add(block.line);
  }
  if (exact.size === 1) return [...exact][0];
  if (exact.size > 1) return null;
  if (elsewhere.size === 1) return [...elsewhere][0];
  if (elsewhere.size > 1) return null;
  const counts = grams(text);
  let best = 0, line: number | null = null;
  for (const block of blocks) {
    if (sectionKey(block.headings) !== section) continue;
    const score = similarity(text, normalizeText(block.block), counts);
    if (score >= 0.8 && score > best) {
      line = block.line;
      best = score;
    } else if (score === best) line = null;
  }
  return line;
}

export function liveBlocks(context: ReadingContext | undefined, document: HTMLElement): GlassBlock[] {
  if (!context) return [];
  const elements = new Map<string, HTMLElement>();
  for (const child of Array.from(document.children)) {
    const element = child instanceof HTMLElement ? child : undefined, id = element?.dataset.cid;
    if (element && id) elements.set(id, element);
  }
  const byLine = new Map<number, string>();
  for (const node of context.nodes) if (node.source.trim()) byLine.set(node.line, node.id);
  return readingBlocks(context).map(block => {
    const id = byLine.get(block.line);
    return { block: block.block, headings: block.headings, line: block.line, element: id ? elements.get(id) : undefined };
  });
}

export function placeAnchor(anchor: GlassAnchor, offset: GlassOffset, blocks: readonly GlassBlock[], glass: HTMLElement): GlassPlacement {
  const line = matchBlock(anchor, blocks);
  const element = line === null ? undefined : blocks.find(block => block.line === line)?.element;
  if (!element) return { status: "orphan" };
  const rect = element.getBoundingClientRect(), frame = glass.getBoundingClientRect();
  return { status: "resolved", x: rect.left - frame.left + offset.x, y: rect.top - frame.top + offset.y, width: rect.width, height: rect.height };
}
