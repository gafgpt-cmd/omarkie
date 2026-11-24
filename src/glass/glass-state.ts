import type { GlassAnchor, GlassLandmark } from "./anchor-map";

const fixtureKey = "omarkie-glass-fixture";
const testKey = "omarkie-glass-test";

export function glassFixture() {
  try { return localStorage.getItem(testKey) === "1"; } catch { return false; }
}

function landmarkFrom(value: unknown): GlassLandmark | undefined {
  if (!value || typeof value !== "object") return;
  const { kind, block, headings, line } = value as Record<string, unknown>;
  if (kind !== "block" || typeof block !== "string" || !block.trim() || block.length > 262_144) return;
  if (!Array.isArray(headings) || headings.length > 6 || headings.some(heading => typeof heading !== "string")) return;
  return { kind, block, headings: headings as string[], ...(Number.isInteger(line) ? { line: line as number } : {}) };
}

function anchorFrom(value: unknown): GlassAnchor | undefined {
  if (!value || typeof value !== "object") return;
  const { landmarks } = value as Record<string, unknown>;
  if (!Array.isArray(landmarks) || !landmarks.length || landmarks.length > 8) return;
  const parsed = landmarks.map(landmarkFrom);
  return parsed.every(Boolean) ? { landmarks: parsed as GlassLandmark[] } : undefined;
}

export function fixtureAnchor(): GlassAnchor | undefined {
  try { return anchorFrom(JSON.parse(localStorage.getItem(fixtureKey) || "null")); } catch { return; }
}

export function rememberFixtureAnchor(anchor: GlassAnchor) {
  try { localStorage.setItem(fixtureKey, JSON.stringify(anchor)); } catch { /* storage unavailable */ }
}
