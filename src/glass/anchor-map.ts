import type { ReadingContext } from "../editor/MarkdownEditor";
import { readingBlocks } from "../components/reading-selection.ts";
import { anchorVersion, captureAnchor, contextWidth, normalizeText, sectionKey, textHash } from "../../shared/anchor-core.mjs";

// Landmark anchors, strongest first (vision: "landmark anchors"):
// fingerprint, TextQuote, heading path, neighbours, position, spot.
// Legacy v1 anchors stored one {kind:"block"} landmark; every reader keeps it working.
// captureAnchor, normalizeText, sectionKey and textHash live in shared/anchor-core.mjs so
// omarkie-axi captures exactly what this renderer stores.
export { anchorVersion, captureAnchor, normalizeText, sectionKey, textHash };

export interface GlassFingerprint {
  tag: string;
  hash: string;
  name?: string;
}

export interface GlassQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface GlassPosition {
  line: number;
  char: number;
  word: number;
  percent: number;
}

export interface GlassSpot {
  x: number;
  y: number;
  px: number;
  py: number;
}

export type GlassLandmark =
  | { kind: "block"; block: string; headings: readonly string[]; line?: number }
  | { kind: "fingerprint"; value: GlassFingerprint }
  | { kind: "quote"; value: GlassQuote }
  | { kind: "heading"; value: { path: readonly string[] } }
  | { kind: "neighbours"; value: { before?: string; after?: string } }
  | { kind: "position"; value: GlassPosition }
  | { kind: "spot"; value: GlassSpot };

export interface GlassAnchor {
  version?: number;
  landmarks: readonly GlassLandmark[];
}

export interface GlassOffset {
  x: number;
  y: number;
}

export type GlassPlacement =
  | { status: "resolved"; x: number; y: number; width: number; height: number }
  | { status: "orphan" };

export type GlassTier = "fingerprint" | "quote" | "heading" | "neighbours" | "position" | "live" | "none";

export interface GlassResolution {
  line: number | null;
  confidence: number;
  tier: GlassTier;
}

export interface GlassDetailedPlacement {
  status: "resolved";
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  tier: GlassTier;
  line: number;
}
export type GlassPlacementResult = GlassDetailedPlacement | { status: "orphan"; confidence: number; tier: GlassTier; line: number | null };

export interface GlassBlock {
  block: string;
  headings: readonly string[];
  line: number;
  kind?: string;
  element?: HTMLElement;
  from?: number;
  to?: number;
  words?: number;
  percent?: number;
  prefix?: string;
  suffix?: string;
}

interface Candidate {
  line: number;
  confidence: number;
  tier: GlassTier;
}

function foldText(text: string) {
  return normalizeText(text).normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
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

// Approximate substring match. In-repo Bitap-sized code instead of a dependency: no telemetry,
// no install weight; tests/glass-anchor.test.mjs pins the scores.
export function quoteScore(exact: string, candidate: string) {
  const quote = foldText(exact), text = foldText(candidate);
  if (!quote || !text) return 0;
  if (text.includes(quote)) return 1;
  const counts = grams(quote), span = quote.length + 12;
  let best = 0, at = -1, seeds = 0;
  const seed = quote.slice(0, Math.min(8, quote.length));
  while ((at = text.indexOf(seed, at + 1)) >= 0 && seeds < 8) {
    seeds += 1;
    best = Math.max(best, similarity(quote, text.slice(at, at + span), counts));
  }
  if (!seeds) best = similarity(quote, text, counts);
  return Math.min(best, 0.99);
}

function candidateOf(line: number, confidence: number, tier: GlassTier): Candidate {
  return { line, confidence: Math.max(0, Math.min(1, confidence)), tier };
}

function unique(candidates: readonly Candidate[]) {
  return candidates.length === 1 ? candidates[0] : null;
}

function landmark<K extends GlassLandmark["kind"]>(anchor: GlassAnchor, kind: K) {
  return anchor.landmarks.find((item): item is Extract<GlassLandmark, { kind: K }> => item.kind === kind);
}

function legacyBlock(anchor: GlassAnchor) {
  return landmark(anchor, "block");
}

function blockHash(block: GlassBlock) {
  return textHash(block.block);
}

function byFingerprint(anchor: GlassAnchor, blocks: readonly GlassBlock[]): Candidate | null {
  const fingerprint = landmark(anchor, "fingerprint")?.value, legacy = legacyBlock(anchor);
  const hash = fingerprint?.hash ?? (legacy ? textHash(legacy.block) : undefined);
  const exact = legacy ? normalizeText(legacy.block) : undefined;
  if (!hash && !exact) return null;
  const matches = blocks.filter(block => (hash && blockHash(block) === hash) || (exact && normalizeText(block.block) === exact));
  if (!matches.length) return null;
  const headingPath = landmark(anchor, "heading")?.value.path ?? legacy?.headings;
  if (matches.length === 1) return candidateOf(matches[0].line, headingPath && sectionKey(headingPath) === sectionKey(matches[0].headings) ? 1 : 0.85, "fingerprint");
  if (!headingPath) return null;
  const same = matches.filter(block => sectionKey(block.headings) === sectionKey(headingPath));
  if (same.length === 1) return candidateOf(same[0].line, 0.95, "fingerprint");
  // A copied paragraph in the same section never guesses.
  return null;
}

function byQuote(anchor: GlassAnchor, blocks: readonly GlassBlock[]): Candidate | null {
  const quote = landmark(anchor, "quote")?.value ?? (legacyBlock(anchor)
    ? { exact: legacyBlock(anchor)!.block, prefix: "", suffix: "" } : undefined);
  if (!quote) return null;
  const exact = foldText(quote.exact);
  if (exact.length < 4) return null;
  const exactMatches = blocks.filter(block => foldText(block.block).includes(exact));
  if (exactMatches.length === 1) {
    const headingPath = landmark(anchor, "heading")?.value.path ?? legacyBlock(anchor)?.headings;
    return candidateOf(exactMatches[0].line, headingPath && sectionKey(headingPath) !== sectionKey(exactMatches[0].headings) ? 0.9 : 0.95, "quote");
  }
  if (exactMatches.length > 1) {
    const scored = exactMatches.map(block => {
      const text = foldText(block.block), prefix = foldText(quote.prefix), suffix = foldText(quote.suffix);
      return { block, overlap: Number(!!prefix && text.includes(prefix)) + Number(!!suffix && text.includes(suffix)) };
    });
    const top = Math.max(...scored.map(item => item.overlap));
    if (top > 0) {
      const best = scored.filter(item => item.overlap === top);
      if (best.length === 1) return candidateOf(best[0].block.line, 0.85, "quote");
    }
    return null;
  }
  const scored = blocks.map(block => ({ block, score: quoteScore(quote.exact, block.block) })).sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best || best.score < 0.45) return null;
  if (scored[1] && scored[1].score > best.score - 0.08) return null;
  return candidateOf(best.block.line, Math.min(0.86, 0.5 + 0.42 * ((best.score - 0.45) / 0.55)), "quote");
}

function byHeading(anchor: GlassAnchor, blocks: readonly GlassBlock[]): Candidate | null {
  const path = landmark(anchor, "heading")?.value.path ?? legacyBlock(anchor)?.headings;
  const neighbours = landmark(anchor, "neighbours")?.value;
  if (!path && !neighbours) return null;
  const section = path ? blocks.filter(block => sectionKey(block.headings) === sectionKey(path)) : blocks;
  if (!neighbours?.before && !neighbours?.after) {
    return unique(section.map(block => candidateOf(block.line, 0.55, "heading")));
  }
  const hits = section.flatMap(block => {
    const index = blocks.indexOf(block);
    const before = index > 0 ? blocks[index - 1] : undefined, after = index + 1 < blocks.length ? blocks[index + 1] : undefined;
    const beforeHit = !neighbours.before || (before && blockHash(before) === neighbours.before);
    const afterHit = !neighbours.after || (after && blockHash(after) === neighbours.after);
    if (!beforeHit || !afterHit) return [];
    return [candidateOf(block.line, neighbours.before && neighbours.after ? 0.85 : 0.8, "neighbours")];
  });
  return unique(hits);
}

function byPosition(anchor: GlassAnchor, blocks: readonly GlassBlock[], liveChar?: number): Candidate | null {
  if (liveChar !== undefined) {
    const exact = blocks.find(block => block.from !== undefined && block.to !== undefined && liveChar >= block.from && liveChar < block.to);
    if (exact) return candidateOf(exact.line, 0.95, "live");
    const nearest = nearestByOffset(blocks, liveChar, 80);
    if (nearest) return candidateOf(nearest.line, 0.9, "live");
  }
  const position = landmark(anchor, "position")?.value;
  if (!position) {
    const line = legacyBlock(anchor)?.line;
    if (line === undefined) return null;
    const hit = blocks.find(block => block.line === line);
    return hit ? candidateOf(hit.line, 0.5, "position") : null;
  }
  const headingPath = landmark(anchor, "heading")?.value.path ?? legacyBlock(anchor)?.headings;
  if (headingPath && !blocks.some(block => sectionKey(block.headings) === sectionKey(headingPath))) return null;
  if (Number.isFinite(position.char)) {
    const exact = blocks.find(block => block.from !== undefined && block.to !== undefined && position.char >= block.from && position.char < block.to);
    if (exact) return candidateOf(exact.line, 0.65, "position");
    const nearest = nearestByOffset(blocks, position.char, 80);
    if (nearest) return candidateOf(nearest.line, 0.55, "position");
  }
  if (Number.isFinite(position.line)) {
    const hit = blocks.find(block => block.line === position.line);
    if (hit) return candidateOf(hit.line, 0.6, "position");
  }
  const length = blocks.reduce((end, block) => Math.max(end, block.to ?? 0), 0);
  if (Number.isFinite(position.percent) && length > 0) {
    const percent = Math.max(0, Math.min(1, position.percent));
    const nearest = nearestByOffset(blocks, percent * length, Math.max(120, length * 0.08));
    if (nearest) return candidateOf(nearest.line, 0.5, "position");
  }
  return null;
}

function nearestByOffset(blocks: readonly GlassBlock[], offset: number, tolerance: number) {
  let best: { block: GlassBlock; distance: number } | undefined;
  for (const block of blocks) {
    if (block.from === undefined) continue;
    const distance = offset < block.from ? block.from - offset : offset > (block.to ?? block.from) ? offset - (block.to ?? block.from) : 0;
    if (!best || distance < best.distance) best = { block, distance };
  }
  return best && best.distance <= tolerance ? best.block : null;
}

export function resolveAnchor(anchor: GlassAnchor, blocks: readonly GlassBlock[], options: { liveChar?: number } = {}): GlassResolution {
  const tiers = [
    byFingerprint(anchor, blocks),
    byQuote(anchor, blocks),
    byHeading(anchor, blocks),
    byPosition(anchor, blocks, options.liveChar),
  ];
  const winner = tiers.find((candidate): candidate is Candidate => candidate !== null);
  if (!winner) return { line: null, confidence: 0, tier: "none" };
  let confidence = winner.confidence;
  if (tiers.some(candidate => candidate && candidate !== winner && candidate.line === winner.line)) confidence += 0.05;
  if (tiers.some(candidate => candidate && candidate !== winner && candidate.line !== winner.line)) confidence -= 0.1;
  return { line: winner.line, confidence: Math.max(0.05, Math.min(1, confidence)), tier: winner.tier };
}

// G1 contract: exact block text in its section, then exact elsewhere, then a 0.8 fuzzy match.
export function matchBlock(anchor: GlassAnchor, blocks: readonly GlassBlock[]): number | null {
  const block = legacyBlock(anchor);
  const fingerprint = landmark(anchor, "fingerprint");
  if (!block && !fingerprint) return null;
  const text = normalizeText(block?.block ?? ""), hash = fingerprint?.value.hash;
  const headingPath = landmark(anchor, "heading")?.value.path ?? block?.headings;
  const section = headingPath ? sectionKey(headingPath) : "";
  const exact = new Set<number>(), elsewhere = new Set<number>();
  for (const candidate of blocks) {
    const same = (hash && blockHash(candidate) === hash) || (text && normalizeText(candidate.block) === text);
    if (!same) continue;
    elsewhere.add(candidate.line);
    if (section && sectionKey(candidate.headings) === section) exact.add(candidate.line);
  }
  if (exact.size === 1) return [...exact][0];
  if (exact.size > 1) return null;
  if (elsewhere.size === 1) return [...elsewhere][0];
  if (elsewhere.size > 1) return null;
  if (!block) return null;
  return matchFuzzy(text, blocks.filter(candidate => !!section && sectionKey(candidate.headings) === section));
}

// One index per measure pass: 200 magnets on a long note must not rescan every block.
export interface BlockIndex {
  texts: Map<string, GlassBlock[]>;
  sections: Map<string, GlassBlock[]>;
}

export function indexBlocks(blocks: readonly GlassBlock[]): BlockIndex {
  const texts = new Map<string, GlassBlock[]>(), sections = new Map<string, GlassBlock[]>();
  const push = (map: Map<string, GlassBlock[]>, key: string, block: GlassBlock) => {
    const list = map.get(key);
    if (list) list.push(block); else map.set(key, [block]);
  };
  for (const block of blocks) {
    const text = normalizeText(block.block);
    if (!text) continue;
    push(texts, text, block);
    push(sections, sectionKey(block.headings), block);
  }
  return { texts, sections };
}

export function matchIndexed(index: BlockIndex, anchor: GlassAnchor): number | null {
  const landmark = anchor.landmarks.find(landmark => landmark.kind === "block");
  if (!landmark) return null;
  const text = normalizeText(landmark.block), section = sectionKey(landmark.headings);
  const exact = (index.texts.get(text) ?? []).filter(block => sectionKey(block.headings) === section);
  if (exact.length === 1) return exact[0].line;
  if (exact.length > 1) return null;
  const elsewhere = index.texts.get(text) ?? [];
  if (elsewhere.length === 1) return elsewhere[0].line;
  if (elsewhere.length > 1) return null;
  return matchFuzzy(text, index.sections.get(section) ?? []);
}

function matchFuzzy(text: string, candidates: readonly GlassBlock[]) {
  const counts = grams(text);
  let best = 0, line: number | null = null;
  for (const candidate of candidates) {
    const score = similarity(text, normalizeText(candidate.block), counts);
    if (score >= 0.8 && score > best) {
      line = candidate.line;
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
  const byLine = new Map<number, { id: string; from: number; to: number; kind: string }>();
  for (const node of context.nodes) if (node.source.trim()) byLine.set(node.line, { id: node.id, from: node.from, to: node.to, kind: node.kind });
  const length = context.text.length;
  let words = 0, cursor = 0;
  return readingBlocks(context).map(block => {
    const node = byLine.get(block.line);
    if (node) words += (context.text.slice(cursor, node.from).match(/\S+/gu) ?? []).length;
    if (node) cursor = node.to;
    const from = node?.from;
    return {
      block: block.block,
      headings: block.headings,
      line: block.line,
      kind: node?.kind,
      element: node ? elements.get(node.id) : undefined,
      ...(from === undefined ? {} : {
        from,
        to: node!.to,
        words,
        percent: length ? from / length : 0,
        prefix: context.text.slice(Math.max(0, from - contextWidth), from),
        suffix: context.text.slice(node!.to, node!.to + contextWidth),
      }),
    };
  });
}

export function placeLandmarks(anchor: GlassAnchor, offset: GlassOffset, blocks: readonly GlassBlock[], glass: HTMLElement, options: { liveChar?: number } = {}): GlassPlacementResult {
  const resolution = resolveAnchor(anchor, blocks, options), line = resolution.line;
  const element = line === null ? undefined : blocks.find(block => block.line === line)?.element;
  if (!element || line === null || resolution.confidence < 0.5) return { status: "orphan", confidence: resolution.confidence, tier: resolution.tier, line };
  const rect = element.getBoundingClientRect(), frame = glass.getBoundingClientRect();
  const spot = landmark(anchor, "spot")?.value;
  return {
    status: "resolved",
    x: rect.left - frame.left + offset.x + (spot ? spot.x * rect.width + spot.px : 0),
    y: rect.top - frame.top + offset.y + (spot ? spot.y * rect.height + spot.py : 0),
    width: rect.width,
    height: rect.height,
    confidence: resolution.confidence,
    tier: resolution.tier,
    line,
  };
}

// G1 contract unchanged: a matching block fills its box, otherwise orphan.
export function placeAnchor(anchor: GlassAnchor, offset: GlassOffset, blocks: readonly GlassBlock[], glass: HTMLElement): GlassPlacement {
  const line = matchBlock(anchor, blocks);
  const element = line === null ? undefined : blocks.find(block => block.line === line)?.element;
  if (!element) return { status: "orphan" };
  const rect = element.getBoundingClientRect(), frame = glass.getBoundingClientRect();
  return { status: "resolved", x: rect.left - frame.left + offset.x, y: rect.top - frame.top + offset.y, width: rect.width, height: rect.height };
}
