// Landmark anchors shared by the renderer (src/glass/anchor-map.ts) and omarkie-axi:
// one capture path, so a magnet stored from the UI reads back the same from the CLI.

export const anchorVersion = 2;
export const contextWidth = 32;

export function normalizeText(text) {
  const trimmed = text.trim();
  // Fast path: most paragraphs are plain single-spaced ASCII; skip two full scans.
  if (!/[^\x00-\x7F]/u.test(trimmed) && !/\s{2}|[\t\n\r\f\v]/u.test(trimmed)) return trimmed;
  return trimmed.normalize("NFC").replace(/\s+/gu, " ");
}

export function sectionKey(headings) {
  return JSON.stringify(headings.map(normalizeText));
}

function foldText(text) {
  return normalizeText(text).normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

// 64-bit FNV-1a in two 32-bit halves: the prime is 2^40 + 0x1b3, so each step is
// hash * 0x1b3 plus the low half shifted into the high half. Same digest as BigInt, without its cost.
export function textHash(text) {
  const value = foldText(text);
  let high = 0xcbf29ce4, low = 0x84222325;
  for (let index = 0; index < value.length; index += 1) {
    low = (low ^ value.charCodeAt(index)) >>> 0;
    const product = low * 0x1b3;
    high = (high * 0x1b3 + Math.floor(product / 0x100000000) + low * 0x100) >>> 0;
    low = product >>> 0;
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}

export function captureAnchor(block, blocks) {
  const index = blocks.findIndex(item => item.line === block.line);
  const before = index > 0 ? blocks[index - 1] : undefined;
  const after = index >= 0 && index + 1 < blocks.length ? blocks[index + 1] : undefined;
  const kind = block.kind ?? "block";
  const name = kind === "image" ? block.block.match(/!\[[^\]]*\]\(([^)]+)\)/u)?.[1]?.split("/").at(-1) : undefined;
  return {
    version: anchorVersion,
    landmarks: [
      { kind: "fingerprint", value: { tag: kind, hash: textHash(block.block), ...(name ? { name } : {}) } },
      { kind: "quote", value: { exact: normalizeText(block.block), prefix: normalizeText(block.prefix ?? "").slice(-contextWidth), suffix: normalizeText(block.suffix ?? "").slice(0, contextWidth) } },
      { kind: "heading", value: { path: [...block.headings] } },
      { kind: "neighbours", value: { ...(before ? { before: textHash(before.block) } : {}), ...(after ? { after: textHash(after.block) } : {}) } },
      { kind: "position", value: { line: block.line, char: block.from ?? 0, word: block.words ?? 0, percent: block.percent ?? 0 } },
      { kind: "spot", value: { x: 0.5, y: 0.5, px: 0, py: 0 } },
    ],
  };
}
