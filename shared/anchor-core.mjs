// Landmark anchors shared by the renderer (src/glass/anchor-map.ts) and omarkie-axi:
// one capture path, so a magnet stored from the UI reads back the same from the CLI.

export const anchorVersion = 2;
export const contextWidth = 32;

export function normalizeText(text) {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function sectionKey(headings) {
  return JSON.stringify(headings.map(normalizeText));
}

function foldText(text) {
  return normalizeText(text).normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

export function textHash(text) {
  const value = foldText(text);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
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
