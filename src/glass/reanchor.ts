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
    return {
      id: entry.id,
      line: hit.line,
      confidence: hit.confidence,
      tier: hit.tier,
      state: hit.line !== null && hit.confidence >= reanchorThresholds.placed ? "placed"
        : hit.line !== null && hit.confidence >= reanchorThresholds.check ? "check" : "tray",
      old: oldContext(entry.anchor),
      ...(candidate ? { candidate: quoteContext(candidate) } : {}),
    };
  });
}

// A magnet with no landmarks stays a free object at its stored absolute spot.
export function isFreeObject(anchor: GlassAnchor | undefined) {
  return !anchor || anchor.landmarks.length === 0;
}
