// New-edition re-anchoring, in bulk: every magnet's landmark stack is resolved in one pass,
// exact block first, then the six-tier resolver. Nothing is deleted; low confidence is shown
// in the "check placement" tray with the old quote and the new candidate side by side.
import { matchIndexed, resolveAnchor, type BlockIndex, type GlassAnchor, type GlassBlock, type GlassTier } from "./anchor-map.ts";

export const reanchorThresholds = { placed: 0.8, check: 0.5 } as const;

export interface ReanchorEntry {
  id: string;
  anchor: GlassAnchor;
}

export interface ReanchorQuote {
  quote: string;
  prefix: string;
  suffix: string;
  heading: string;
}

export interface ReanchorRow {
  id: string;
  line: number | null;
  confidence: number;
  tier: GlassTier;
  state: "placed" | "check" | "tray";
  old: ReanchorQuote;
  candidate?: ReanchorQuote;
}

function quoteContext(block?: GlassBlock): ReanchorQuote {
  return {
    quote: block?.block.trim() ?? "",
    prefix: block?.prefix ?? "",
    suffix: block?.suffix ?? "",
    heading: (block?.headings ?? []).join(" › "),
  };
}

// Share of the old quote's meaningful words that survive in the new paragraph.
function overlap(oldQuote: string, block: string): number {
  const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
  const before = words(oldQuote), after = words(block);
  if (!before.size) return 1;
  let shared = 0;
  for (const word of before) if (after.has(word)) shared += 1;
  return shared / before.size;
}

function oldContext(anchor: GlassAnchor): ReanchorQuote {
  const quote = anchor.landmarks.find(item => item.kind === "quote")?.value;
  const block = anchor.landmarks.find(item => item.kind === "block");
  const heading = anchor.landmarks.find(item => item.kind === "heading")?.value.path ?? block?.headings ?? [];
  if (quote) return { quote: quote.exact.trim(), prefix: quote.prefix, suffix: quote.suffix, heading: heading.join(" › ") };
  return { quote: block?.block.trim() ?? "", prefix: "", suffix: "", heading: heading.join(" › ") };
}

// One pass for 200 magnets: identical landmark stacks share a result, and the exact block
// index answers before the fuzzy resolver ever scans the note.
export function bulkReanchor(entries: readonly ReanchorEntry[], blocks: readonly GlassBlock[], index?: BlockIndex): ReanchorRow[] {
  const byLine = new Map(blocks.map(block => [block.line, block]));
  const cache = new Map<string, { line: number | null; confidence: number; tier: GlassTier }>();
  return entries.map(entry => {
    const key = JSON.stringify(entry.anchor.landmarks);
    let hit = cache.get(key);
    if (!hit) {
      const exact = index ? matchIndexed(index, entry.anchor) : null;
      const resolved = { line: exact, confidence: 1, tier: "fingerprint" as GlassTier };
      if (exact === null) {
        const result = resolveAnchor(entry.anchor, blocks);
        resolved.line = result.line;
        resolved.confidence = result.confidence;
        resolved.tier = result.tier;
      }
      hit = resolved;
      cache.set(key, hit);
    }
    const candidate = hit.line === null ? undefined : byLine.get(hit.line);
    // A line-number guess is only a placement when the words there still resemble the old quote;
    // otherwise the paragraph the mark belonged to is gone and the reader has to say what happens.
    // A legacy landmark stores the paragraph's Markdown, which never equals rendered text; the word
    // test only means something when the anchor kept its exact quote.
    const weak = hit.tier === "position" && entry.anchor.landmarks.some(item => item.kind === "quote");
    const evidence = weak && candidate ? overlap(oldContext(entry.anchor).quote, candidate.block) : 1;
    const line = weak && evidence < 0.2 ? null : hit.line;
    if (weak && evidence < 0.2) return {
      id: entry.id, line: null, confidence: hit.confidence, tier: hit.tier, state: "tray",
      old: oldContext(entry.anchor), ...(candidate ? { candidate: quoteContext(candidate) } : {}),
    };
    return {
      id: entry.id,
      line,
      confidence: hit.confidence,
      tier: hit.tier,
      state: line !== null && hit.confidence >= reanchorThresholds.placed ? "placed"
        : line !== null && hit.confidence >= reanchorThresholds.check ? "check" : "tray",
      old: oldContext(entry.anchor),
      ...(candidate ? { candidate: quoteContext(candidate) } : {}),
    };
  });
}

