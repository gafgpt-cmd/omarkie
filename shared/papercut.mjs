// Papercut clips: a Learning selection becomes a snapshot text card (the copied words plus a source
// link) or a live file card for its heading. Both are plain JSON Canvas nodes; the snapshot keeps its
// source under one extra key so Omarkie can jump back, and Obsidian simply ignores it.
import { normalizeText } from "./anchor-core.mjs";
import { canvasLimits, snapToGrid } from "./json-canvas.mjs";

export const clipKey = "x-omarkie-clip";
const noteFile = /\.(md|markdown|mdown)$/i;

// Rendered selection text and note source differ in markup; compare letters and spacing only.
const plain = text => normalizeText(String(text)
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
  .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
  .replace(/[*_~`=]+/g, "")).toLowerCase();

export function clipSource(node) {
  const source = node?.type === "text" ? node[clipKey] : undefined;
  if (!source || typeof source !== "object" || typeof source.file !== "string" || !noteFile.test(source.file) || typeof source.quote !== "string") return null;
  return {
    file: source.file, quote: source.quote,
    line: Number.isInteger(source.line) && source.line >= 1 ? source.line : 1,
    heading: typeof source.heading === "string" ? source.heading : undefined,
  };
}

// The 1-based line (the editor and Learning convention) of the block that still holds the quote,
// nearest its clipped line; null once it moved away.
export function quoteLine(markdown, source) {
  const full = plain(source.quote);
  if (!full) return null;
  const lines = String(markdown).split(/\r\n|\r|\n/), blocks = [];
  let start = -1;
  lines.forEach((line, index) => {
    if (line.trim()) { if (start < 0) start = index; }
    else if (start >= 0) { blocks.push({ start, text: lines.slice(start, index).join("\n") }); start = -1; }
  });
  if (start >= 0) blocks.push({ start, text: lines.slice(start).join("\n") });
  for (const needle of [full, full.slice(0, 60)]) {
    const hits = blocks.filter(block => plain(block.text).includes(needle)).map(block => block.start + 1);
    if (hits.length) return hits.reduce((best, line) => Math.abs(line - source.line) < Math.abs(best - source.line) ? line : best);
  }
  return null;
}

const wikiTarget = (file, heading) => `${file.replace(noteFile, "")}${heading ? `#${heading.replace(/[#|\]]/g, " ").trim()}` : ""}`;
const noteName = file => file.split("/").pop().replace(noteFile, "");

// A snapshot: immutable copied words, quoted, with a link Obsidian and Omarkie both follow.
export function snapshotNode({ file, quote, line, headings = [] }, label = "Snapshot") {
  const heading = headings.at(-1);
  const words = String(quote).trim().slice(0, 4000);
  const title = heading ? `${noteName(file)} › ${heading}` : noteName(file);
  const text = `${words.split(/\r\n|\r|\n/).map(row => `> ${row}`.trimEnd()).join("\n")}\n\n${label} · [[${wikiTarget(file, heading)}|${title.replace(/[|\]]/g, " ")}]]`;
  const rows = Math.ceil(words.length / 38) + words.split("\n").length + 2;
  return {
    id: "", type: "text", text, x: 0, y: 0, width: 320, height: Math.min(520, Math.max(canvasLimits.grid * 6, snapToGrid(rows * 22 + 40))),
    [clipKey]: { file, quote: words, line: Number.isInteger(line) && line >= 1 ? line : 1, ...(heading ? { heading } : {}) },
  };
}

// A live heading card: a JSON Canvas file node whose subpath re-reads the note on every open.
export function headingNode({ file, headings = [] }) {
  const heading = headings.at(-1);
  return { id: "", type: "file", file, ...(heading ? { subpath: `#${heading}` } : {}), x: 0, y: 0, width: 360, height: 280 };
}
