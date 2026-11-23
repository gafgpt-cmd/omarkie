import MarkdownIt from "markdown-it";
import { setProperties } from "../shared/frontmatter.mjs";
import { sourceLines } from "../shared/source-lines.mjs";

const parser = new MarkdownIt({ html: true });
const pageBreak = /^\s*(?:\f|<!--\s*(?:pagebreak|page(?:\s*[:=]\s*|\s+)\d+)\s*-->)\s*$/i;
const pageNumber = /^(?:page\s+(\d+)(?:\s+of\s+\d+)?|[-–—]?\s*(\d+)\s*[-–—]?)$/i;
const caption = /^(?:figure|fig\.|table|figura|taula|tabelul)\s+[\p{L}]?\d+[\d.a-z–-]*[.:\s]/iu;
const image = /^!\[[^\]]*\](?:\(.+\)|\[[^\]]*\])(?:\{[^}]*\})?$|^!\[\[[^\]]+\]\]$/;
const protectedTypes = { fence: true, code_block: true, html_block: true, blockquote_open: true, bullet_list_open: true, ordered_list_open: true, table_open: true, heading_open: true };
const section = /^(?:abstract|introduction|background|methods|materials and methods|results|discussion|conclusions?|references|bibliography|appendix|resumen|introducción|resultados|discusión|conclusiones|referencias)$/iu;
const furniture = /^[\p{L}\p{N}][\p{L}\p{N} .,:;©()/'’–—-]{0,99}$/u;
const plain = /^[\p{L}\p{N}]/u;
const normalize = (text: string) => text.replace(/\r\n?/g, "\n");

function splitFrontmatter(source: string) {
  const open = /^(?:\uFEFF)?---[ \t]*(?:\r\n|\r|\n)/.exec(source);
  if (!open) return ["", source] as const;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r\n|\r|\n|$)/gm;
  closing.lastIndex = open[0].length;
  const end = closing.exec(source);
  return end ? [source.slice(0, closing.lastIndex), source.slice(closing.lastIndex)] as const : [source, ""] as const;
}

export async function cleanWithEngine(source: string, name: string, run?: (body: string) => Promise<string | null>) {
  const [metadata, body] = splitFrontmatter(source);
  if (!body.trim()) return source;
  let converted = body;
  const result = await run?.(body);
  if (result != null) {
    const output = normalize(result);
    if (output !== normalize(body)) converted = output.replaceAll("\n", source.match(/\r\n|\r|\n/)?.[0] ?? "\n");
  }
  const cleaned = metadata + cleanBody(converted);
  if (metadata || /^(?:\uFEFF)?---[ \t]*(?:\r\n|\r|\n|$)/.test(cleaned)) return cleaned;
  return setProperties(cleaned, { type: "Reference", title: name.replace(/\.(?:md|markdown|mdown)$/i, ""), tags: [] });
}

function cleanBody(source: string) {
  const { lines, offsets } = sourceLines(source);
  const rows = lines.map((text, i) => ({ text, ending: source.slice(offsets[i] + text.length, offsets[i + 1]), locked: /^ {4}|^\t/.test(text), omit: false }));
  for (const token of parser.parse(source, {})) {
    if (!token.map || !Object.hasOwn(protectedTypes, token.type)) continue;
    if (token.type === "html_block" && token.map[1] - token.map[0] === 1 && pageBreak.test(rows[token.map[0]].text)) continue;
    for (let i = token.map[0]; i < token.map[1]; i++) rows[i].locked = true;
  }
  // Display math may contain lines that look like page numbers or headings.
  let math = false;
  for (const row of rows) {
    if (!row.locked && /^ {0,3}\$\$\s*$/.test(row.text)) { math = !math; row.locked = true; }
    else if (math) row.locked = true;
  }

  const pages: number[][] = [[]];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.locked && pageBreak.test(row.text)) { row.text = ""; pages.push([]); }
    else if (row.text.trim()) pages.at(-1)!.push(i);
  }
  const nonempty = pages.filter(page => page.length);
  if (nonempty.length > 1) {
    for (const edge of [(page: number[]) => page.slice(0, 2), (page: number[]) => page.slice(-2)]) {
      const repeated = new Map<string, number>();
      for (const page of nonempty) {
        const candidates = new Set(edge(page).map(i => !rows[i].locked ? rows[i].text.trim() : "").filter(text => furniture.test(text) && !section.test(text) && !pageNumber.test(text)));
        for (const text of candidates) repeated.set(text, (repeated.get(text) ?? 0) + 1);
      }
      for (const page of nonempty) {
        if (page.length < 3) continue;
        for (const i of edge(page)) {
          const row = rows[i], text = row.text.trim();
          if (!row.locked && ((repeated.get(text) ?? 0) >= 2 || pageNumber.test(text))) row.omit = true;
        }
        // A short page can consist only of repeated edge text. Keep its body rather than erase it.
        if (page.every(i => rows[i].omit)) for (const i of page) rows[i].omit = false;
      }
    }
  }

  const active = rows.filter(row => !row.omit);
  const blank = (i: number) => !active[i]?.text.trim();
  const pipeCells = (text: string) => {
    if (!/^\s*\|.*\|\s*$/.test(text) || /[`\\]/.test(text)) return [];
    return text.trim().slice(1, -1).split("|").map(cell => cell.trim());
  };
  for (let i = 0; i < active.length; i++) {
    const row = active[i];
    if (row.locked || blank(i)) continue;
    const text = row.text.trim(), next = active[i + 1];
    if (next && !next.locked && plain.test(text) && !/[`\\<>{}\[\]|*_]/.test(text) && /^\p{Ll}{2}/u.test(next.text)) {
      const match = /(\p{L}{3,})[-\u00ad]$/u.exec(row.text);
      if (match) {
        next.text = row.text.slice(0, -1) + next.text;
        row.omit = true;
        continue;
      }
    }
    if (/^\s{0,3}[•‣▪◦]\s*\S/u.test(row.text)) {
      row.text = row.text.replace(/^( {0,3})[•‣▪◦]\s*/u, "$1- ");
    } else if (/^ {0,3}\d{1,3}[.)]\p{L}/u.test(row.text) && [active[i - 1], next].some(neighbor => /^ {0,3}\d{1,3}[.)][ \p{L}]/u.test(neighbor?.text ?? ""))) {
      row.text = row.text.replace(/^( {0,3}\d{1,3}[.)])/, "$1 ");
    } else if ((i === 0 || blank(i - 1)) && blank(i + 1) && (section.test(text) || (/^[\p{Lu}][\p{Lu}\d &–-]{3,59}$/u.test(text) && /\p{Lu} +\p{Lu}/u.test(text)))) {
      row.text = `## ${text}`;
    } else if ((i === 0 || blank(i - 1)) && next && !next.locked) {
      const cells = pipeCells(row.text), following = pipeCells(next.text);
      if (cells.length >= 2 && cells.every(Boolean) && following.length === cells.length && !following.every(cell => /^:?-+:?$/.test(cell))) {
        row.text += row.ending + `| ${cells.map(() => "---").join(" | ")} |`;
      }
    }
    const afterGap = active[i + 2];
    if (next && !next.locked && afterGap && !afterGap.locked && blank(i + 1)) {
      if (caption.test(text) && image.test(afterGap.text.trim())) {
        row.text = afterGap.text;
        afterGap.text = text;
        next.omit = true;
      } else if (image.test(text) && caption.test(afterGap.text.trim())) next.omit = true;
    }
  }
  return active.map(row => row.omit ? "" : row.text + row.ending).join("");
}
