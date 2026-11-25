import type { GlassAnchor, GlassLandmark } from "./anchor-map";

const fixtureKey = "omarkie-glass-fixture";
const testKey = "omarkie-glass-test";

export function glassFixture() {
  try { return localStorage.getItem(testKey) === "1"; } catch { return false; }
}

function text(value: unknown, limit: number) {
  return typeof value === "string" && value.length <= limit ? value : undefined;
}

function headingPath(value: unknown) {
  return Array.isArray(value) && value.length <= 12 && value.every(heading => typeof heading === "string" && heading.length <= 512) ? value as string[] : undefined;
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

function landmarkFrom(value: unknown): GlassLandmark | undefined {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.kind === "block") {
    const block = text(record.block, 262_144), headings = headingPath(record.headings);
    if (!block?.trim() || !headings) return;
    return { kind: "block", block, headings, ...(Number.isInteger(record.line) ? { line: record.line as number } : {}) };
  }
  const item = record.value;
  if (!item || typeof item !== "object") return;
  const data = item as Record<string, unknown>;
  switch (record.kind) {
    case "fingerprint": {
      const tag = text(data.tag, 64), hash = text(data.hash, 64), name = text(data.name, 512);
      if (!tag || !hash) return;
      return { kind: "fingerprint", value: { tag, hash, ...(name ? { name } : {}) } };
    }
    case "quote": {
      const exact = text(data.exact, 262_144), prefix = text(data.prefix, 256), suffix = text(data.suffix, 256);
      if (!exact || prefix === undefined || suffix === undefined) return;
      return { kind: "quote", value: { exact, prefix, suffix } };
    }
    case "heading": {
      const path = headingPath(data.path);
      return path ? { kind: "heading", value: { path } } : undefined;
    }
    case "neighbours": {
      const before = text(data.before, 64), after = text(data.after, 64);
      if (before === undefined && after === undefined) return;
      return { kind: "neighbours", value: { ...(before ? { before } : {}), ...(after ? { after } : {}) } };
    }
    case "position": {
      const { line, char, word, percent } = data;
      if (![line, char, word, percent].every(finite)) return;
      return { kind: "position", value: { line: line as number, char: char as number, word: word as number, percent: percent as number } };
    }
    case "spot": {
      const { x, y, px, py } = data;
      if (![x, y, px, py].every(finite)) return;
      return { kind: "spot", value: { x: x as number, y: y as number, px: px as number, py: py as number } };
    }
    default: return;
  }
}

export function anchorFrom(value: unknown): GlassAnchor | undefined {
  if (!value || typeof value !== "object") return;
  const { version, landmarks } = value as Record<string, unknown>;
  if (version !== undefined && (!Number.isInteger(version) || (version as number) < 1 || (version as number) > 2)) return;
  if (!Array.isArray(landmarks) || !landmarks.length || landmarks.length > 12) return;
  const parsed = landmarks.map(landmarkFrom);
  return parsed.every(Boolean) ? { ...(version !== undefined ? { version: version as number } : {}), landmarks: parsed as GlassLandmark[] } : undefined;
}

export function fixtureAnchor(): GlassAnchor | undefined {
  try { return anchorFrom(JSON.parse(localStorage.getItem(fixtureKey) || "null")); } catch { return; }
}

export function rememberFixtureAnchor(anchor: GlassAnchor) {
  try { localStorage.setItem(fixtureKey, JSON.stringify(anchor)); } catch { /* storage unavailable */ }
}
