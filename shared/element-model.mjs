// One element model for the page: the halo (UI) and omarkie-axi (agents) read the same boxes,
// so what you hover is exactly what an agent can list, show, and later swap.
// A box is text only; the UI adds the on-screen rect from the matching DOM node.
import { captureAnchor, contextWidth, normalizeText, textHash } from "./anchor-core.mjs";
import { createMarkdown } from "./markdown.mjs";
import { sourceLines } from "./source-lines.mjs";
import { headingText } from "./wiki-syntax.mjs";

export const elementKinds = [
  "paragraph", "heading", "list", "list-item", "table", "table-cell", "image", "embed", "formula", "code", "callout", "quote", "html", "divider",
];

const mediaPattern = /!\[[^\]\n]*\]\([^) \n]*(?:[ \n][^)\n]*)?\)|!\[\[[^\]\n]+\]\]/gu;
const idLength = 8;
let parser;

export function elementId(kind, markdown, ordinal = 0) {
  const hash = textHash(`${kind}\u0001${normalizeText(markdown)}`).slice(0, idLength);
  return ordinal > 1 ? `${kind}-${hash}-${ordinal}` : `${kind}-${hash}`;
}

export function elementById(elements, id) {
  return elements.find(element => element.id === id);
}

// Table cells live on the row's line; offsets are relative to that line.
export function tableCells(line) {
  const cells = [];
  let start = /^\s*\|/.test(line) ? line.indexOf("|") + 1 : 0;
  for (let index = start; index <= line.length; index++) {
    if (line[index] === "\\" && index + 1 < line.length) { index++; continue; }
    if (index === line.length || line[index] === "|") {
      if (index === line.length && !line.slice(start).trim() && /\|\s*$/u.test(line)) break;
      const original = line.slice(start, index), raw = original.trim();
      const from = start + (raw ? original.length - original.trimStart().length : Math.min(1, original.length));
      cells.push({ markdown: raw, start: from, end: from + raw.length });
      start = index + 1;
    }
  }
  return cells;
}

function mediaKind(token) {
  if (token.type === "image") return "image";
  if (token.type === "wiki_embed") return "embed";
  return undefined;
}

function inlineSource(source, inline) {
  // The inline token spans the block source minus a trailing newline; ranges are scanned in it.
  const children = inline?.children ?? [];
  const media = children.filter(token => mediaKind(token));
  if (!media.length) return [];
  const found = [...source.matchAll(mediaPattern)].map(match => ({ markdown: match[0], start: match.index, end: match.index + match[0].length }));
  if (found.length !== media.length) return [];
  return found.map((match, index) => ({ kind: mediaKind(media[index]), ...match }));
}

function isMediaOnly(children) {
  let media = 0;
  for (const token of children) {
    if (mediaKind(token)) { media++; continue; }
    if (["text", "softbreak", "hardbreak"].includes(token.type) && !token.content.trim()) continue;
    return 0;
  }
  return media;
}

export function markdownElements(markdown, options = {}) {
  if (typeof markdown !== "string" || !markdown) return [];
  const md = options.parser ?? (parser ??= createMarkdown());
  const { lines, offsets } = sourceLines(markdown);
  const end = map => (map && offsets[map[1]] !== undefined ? offsets[map[1]] : markdown.length);
  const span = map => ({ from: offsets[map[0]], to: end(map), line: map[0] + 1, endLine: map[1] });
  const drafts = [];
  const headings = [];
  const tokens = md.parse(markdown, {});
  const push = draft => {
    const source = markdown.slice(draft.from, draft.to).trimEnd();
    drafts.push({ ...draft, to: draft.from + source.length, markdown: source });
    return drafts.at(-1);
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.level !== 0 && !["list_item_open", "tr_open", "bullet_list_open", "ordered_list_open"].includes(token.type)) continue;
    const map = token.map;
    switch (token.type) {
      case "heading_open": {
        const text = headingText(tokens[index + 1]?.children ?? []);
        headings.push({ level: Number(token.tag.slice(1)), text, line: map[0] + 1 });
        push({ kind: "heading", level: Number(token.tag.slice(1)), ...span(map) });
        break;
      }
      case "paragraph_open": {
        const inline = tokens[index + 1], block = markdown.slice(offsets[map[0]], end(map));
        const media = inlineSource(block, inline);
        if (media.length && media.length === isMediaOnly(inline?.children ?? [])) {
          for (const item of media) push({ kind: item.kind, from: offsets[map[0]] + item.start, to: offsets[map[0]] + item.end, line: map[0] + 1, endLine: map[1] });
          break;
        }
        if (/^\s*\$\$/.test(block) && /\$\$\s*$/u.test(block)) { push({ kind: "formula", ...span(map) }); break; }
        push({ kind: "paragraph", ...span(map) });
        for (const item of media) push({ kind: item.kind, from: offsets[map[0]] + item.start, to: offsets[map[0]] + item.end, line: map[0] + 1, endLine: map[1] });
        break;
      }
      case "math_block": push({ kind: "formula", ...span(map) }); break;
      case "fence": push({ kind: "code", language: token.info.trim().split(/\s/)[0] || undefined, ...span(map) }); break;
      case "blockquote_open": push({ kind: token.attrGet("data-alert") ? "callout" : "quote", ...span(map) }); break;
      case "bullet_list_open":
      case "ordered_list_open": push({ kind: "list", ordered: token.type === "ordered_list_open", ...span(map) }); break;
      case "list_item_open": push({ kind: "list-item", ...span(map) }); break;
      case "table_open": push({ kind: "table", ...span(map) }); break;
      case "tr_open": {
        if (!map) break;
        const row = tableCells(lines[map[0]] ?? "");
        row.forEach((cell, column) => push({ kind: "table-cell", row: map[0] + 1, column: column + 1,
          from: offsets[map[0]] + cell.start, to: offsets[map[0]] + cell.end, line: map[0] + 1, endLine: map[0] + 1 }));
        break;
      }
      case "html_block": push({ kind: "html", ...span(map) }); break;
      case "hr": push({ kind: "divider", ...span(map) }); break;
      case "footnote_definition": push({ kind: "paragraph", ...span(map) }); break;
      // Frontmatter is metadata, not page text: a swap or a lift must never rewrite it as prose.
      case "frontmatter": break;
      default:
        if (map && !token.nesting && !token.type.endsWith("_close")) push({ kind: "paragraph", ...span(map) });
    }
  }
  return finish(markdown, drafts, headings);
}

// Heading path of a line. Lines come in reading order, so one sweep serves them all; a step back restarts it.
function headingPaths(headings) {
  const stack = [];
  let next = 0, last = -Infinity;
  return (line) => {
    if (line < last) { stack.length = 0; next = 0; }
    last = line;
    for (; next < headings.length && headings[next].line <= line; next++) {
      const heading = headings[next];
      while (stack.length && stack.at(-1).level >= heading.level) stack.pop();
      stack.push(heading);
    }
    return stack.map(heading => heading.text);
  };
}

// How many entries of a `from`-sorted list start at or before `at`.
function startingBy(list, at) {
  let low = 0, high = list.length;
  while (low < high) { const middle = (low + high) >> 1; if (list[middle].from <= at) low = middle + 1; else high = middle; }
  return low;
}

function finish(markdown, drafts, headings) {
  drafts.sort((left, right) => left.from - right.from || left.to - right.to);
  const paths = headingPaths(headings), ordinals = new Map();
  for (const draft of drafts) {
    const key = `${draft.kind}\u0001${normalizeText(draft.markdown)}`, ordinal = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, ordinal);
    draft.id = elementId(draft.kind, draft.markdown, ordinal);
    draft.headings = paths(draft.line);
  }
  const byId = new Map(drafts.map(draft => [draft.id, draft]));
  const nested = new Set(["list-item", "table-cell", "image", "embed"]);
  // A nested element's block is its earliest-starting container: in `from` order, the first that reaches its end.
  const containers = drafts.filter(draft => !nested.has(draft.kind)), reach = [];
  for (const container of containers) reach.push(Math.max(reach.at(-1) ?? -Infinity, container.to));
  for (const draft of drafts) {
    if (!nested.has(draft.kind)) { draft.blockLine = draft.line; continue; }
    const end = startingBy(containers, draft.from);
    let low = 0, high = end;
    while (low < high) { const middle = (low + high) >> 1; if (reach[middle] >= draft.to) high = middle; else low = middle + 1; }
    draft.blockLine = low < end ? containers[low].line : draft.line;
  }
  // Its parent is the smallest enclosing element of the matching kind, the first one on ties.
  const ofKind = new Map();
  for (const draft of drafts) { const list = ofKind.get(draft.kind); if (list) list.push(draft); else ofKind.set(draft.kind, [draft]); }
  for (const draft of drafts) {
    if (draft.parent && byId.has(draft.parent)) continue;
    if (!nested.has(draft.kind)) continue;
    const candidates = ofKind.get(draft.kind === "list-item" ? "list" : draft.kind === "table-cell" ? "table" : "paragraph") ?? [];
    let parent, size = Infinity;
    // Walking back from the nearest start, no earlier candidate can be smaller once the gap alone exceeds the best size.
    for (let index = startingBy(candidates, draft.from) - 1; index >= 0 && draft.to - candidates[index].from <= size; index--) {
      const candidate = candidates[index];
      if (candidate.id === draft.id || candidate.to < draft.to || candidate.to - candidate.from > size) continue;
      parent = candidate; size = candidate.to - candidate.from;
    }
    if (parent) draft.parent = parent.id;
  }
  const blocks = drafts.map(draft => ({ block: draft.markdown, headings: draft.headings, line: draft.line }));
  // captureAnchor finds a block by its line in `blocks`: hand it that block and its two neighbours only.
  const firstOnLine = new Map();
  blocks.forEach((block, index) => { if (!firstOnLine.has(block.line)) firstOnLine.set(block.line, index); });
  return drafts.map(draft => {
    const element = { ...draft }, at = firstOnLine.get(element.line);
    const prefix = markdown.slice(Math.max(0, element.from - contextWidth), element.from);
    const suffix = markdown.slice(element.to, element.to + contextWidth);
    element.landmarks = captureAnchor({ block: element.markdown, headings: element.headings, line: element.line, kind: element.kind,
      from: element.from, to: element.to, prefix, suffix }, blocks.slice(Math.max(0, at - 1), at + 2));
    element.text = normalizeText(element.markdown);
    return element;
  });
}
