import { sourceLines } from "./source-lines.mjs";

export function markdownBlocks(md, source, environment = {}) {
  const { lines, offsets } = sourceLines(source);
  const span = (from, to) => source.slice(offsets[from], offsets[to - 1] + lines[to - 1].length);
  const blocks = [];
  let covered = 0;
  if (/^(?:\uFEFF)?---[ \t]*$/.test(lines[0])) {
    const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line));
    if (end > 0) {
      covered = end + 1;
      blocks.push({ fromLine: 1, toLine: covered, source: span(0, covered), kind: "frontmatter" });
    }
  }
  for (const token of md.parse(source, environment)) {
    if (!token.map || token.level !== 0 || token.map[0] < covered || token.type.endsWith("_close")) continue;
    const [from, to] = token.map;
    covered = to;
    blocks.push({ fromLine: from + 1, toLine: to, source: span(from, to), kind: token.type });
  }
  return blocks;
}
export function plainProposal(md, text) {
  if (!text?.trim() || text.length > 24_000 || /[\r\n\x00-\x08\x0b-\x1f[<]/.test(text)) return false;
  const tokens = md.parse(text, {});
  return tokens.length === 3 && tokens[0].type === "paragraph_open" && !tokens[1].children?.some(token => token.type === "link_open");
}
