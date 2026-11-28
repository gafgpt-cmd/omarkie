// Presentation-only typography for reading and export; the Markdown source never changes.
// Quote pairing is ported from markdown-it 15.0.3 smartquotes (MIT, third-party/markdown-it/PORTED.md).
import type { Token } from "markdown-it";

export const smartStyles = ["off", "en", "es", "ca"] as const;
export type SmartStyle = (typeof smartStyles)[number];
// Double open/close, single open/close. Apostrophes are always ’.
const quotes: Record<Exclude<SmartStyle, "off">, readonly [string, string, string, string]> = {
  en: ["“", "”", "‘", "’"],
  es: ["«", "»", "‘", "’"],
  ca: ["«", "»", "‘", "’"],
};
const apostrophe = "’";

// One inline run (paragraph, heading, cell). Literal segments give context but never change;
// atoms (code, math, links shown as URLs, embeds) read as a word character on both hosts.
export interface SmartSegment { text: string; literal?: boolean; level?: number; break?: boolean }
export interface SmartEdit { segment: number; at: number; length: number; glyph: string }

const whitespace = (char: string) => char === "" || /\s/u.test(char);
const punctuation = (char: string) => /[\p{P}\p{S}]/u.test(char);
const digit = (char: string) => /\d/.test(char);
const letter = (char: string) => /\p{L}/u.test(char);

export function smartEdits(segments: SmartSegment[], style: SmartStyle): SmartEdit[] {
  if (style === "off") return [];
  const pairs = quotes[style], edits: SmartEdit[] = [];
  const before = (segment: number, at: number) => {
    if (at > 0) return segments[segment].text[at - 1];
    for (let index = segment - 1; index >= 0; index--) {
      if (segments[index].break) return "";
      if (segments[index].text) return segments[index].text.at(-1)!;
    }
    return "";
  };
  const after = (segment: number, at: number) => {
    if (at < segments[segment].text.length) return segments[segment].text[at];
    for (let index = segment + 1; index < segments.length; index++) {
      if (segments[index].break) return "";
      if (segments[index].text) return segments[index].text[0];
    }
    return "";
  };
  segments.forEach((segment, index) => {
    if (segment.literal || segment.break) return;
    // Dashes: " -- " and word--word become en dashes, word---word an em dash. Numbers, ranges like 10--20,
    // options like --flag and longer rules stay literal.
    for (const run of segment.text.matchAll(/-{2,}|\.{3,}/g)) {
      const from = run.index, to = from + run[0].length, previous = before(index, from), next = after(index, to);
      if (digit(previous) || digit(next) || previous === "\\") continue;
      if (run[0] === "...") edits.push({ segment: index, at: from, length: 3, glyph: "…" });
      else if (run[0] === "---") edits.push({ segment: index, at: from, length: 3, glyph: "—" });
      else if (run[0] === "--" && ((whitespace(previous) && whitespace(next) && previous !== "" && next !== "") || (letter(previous) && letter(next)))) edits.push({ segment: index, at: from, length: 2, glyph: "–" });
    }
  });
  type Opener = { segment: number; at: number; single: boolean; level: number };
  const stack: Opener[] = [];
  segments.forEach((segment, index) => {
    const level = segment.level ?? 0;
    while (stack.length && stack.at(-1)!.level > level) stack.pop();
    if (segment.literal || segment.break) return;
    for (const match of segment.text.matchAll(/['"]/g)) {
      const at = match.index, single = match[0] === "'";
      const previous = before(index, at), next = after(index, at + 1);
      // Feet, inches, minutes and seconds after a number keep the straight mark; so does a backslash escape.
      if (digit(previous) || previous === "\\") continue;
      const previousSpace = whitespace(previous), nextSpace = whitespace(next);
      const previousMark = !previousSpace && punctuation(previous), nextMark = !nextSpace && punctuation(next);
      let canOpen = !nextSpace && (!nextMark || previousSpace || previousMark);
      let canClose = !previousSpace && (!previousMark || nextSpace || nextMark);
      if (canOpen && canClose) { canOpen = previousMark; canClose = nextMark; }
      if (!canOpen && !canClose) {
        if (single) edits.push({ segment: index, at, length: 1, glyph: apostrophe });
        continue;
      }
      if (canClose) {
        let opener = -1;
        for (let item = stack.length - 1; item >= 0; item--) if (stack[item].single === single) { opener = item; break; }
        if (opener >= 0 && stack[opener].level === level) {
          const open = stack[opener];
          edits.push({ segment: open.segment, at: open.at, length: 1, glyph: pairs[single ? 2 : 0] }, { segment: index, at, length: 1, glyph: pairs[single ? 3 : 1] });
          stack.length = opener;
          continue;
        }
      }
      if (canOpen) stack.push({ segment: index, at, single, level });
      else if (single) edits.push({ segment: index, at, length: 1, glyph: apostrophe });
    }
  });
  return edits.sort((a, b) => a.segment - b.segment || a.at - b.at);
}

const autolink = (token: Token) => token.type === "link_open" && (token.markup === "autolink" || token.markup === "linkify");

// markdown-it core rule for export rendering; enabled per render through env.smartPunctuation.
export function smartPunctuationRule(state: { tokens: Token[]; env: Record<string, unknown> }) {
  const style = state.env?.smartPunctuation as SmartStyle | undefined;
  if (!style || style === "off" || !smartStyles.includes(style)) return;
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    const segments: SmartSegment[] = [], owners: (Token | null)[] = [];
    let link = 0;
    for (const token of block.children) {
      if (autolink(token)) { link++; segments.push({ text: "a", literal: true, level: token.level }); owners.push(null); continue; }
      if (link) { if (token.type === "link_close") link--; continue; }
      if (token.type === "softbreak" || token.type === "hardbreak") { segments.push({ text: "", break: true }); owners.push(null); continue; }
      if (token.nesting !== 0) continue;
      if (token.type === "text") { segments.push({ text: token.content, level: token.level }); owners.push(token); continue; }
      segments.push({ text: token.type === "text_special" && token.info === "escape" ? token.content : "a", literal: true, level: token.level });
      owners.push(null);
    }
    const edits = smartEdits(segments, style);
    for (let index = edits.length - 1; index >= 0; index--) {
      const edit = edits[index], token = owners[edit.segment]!;
      token.content = token.content.slice(0, edit.at) + edit.glyph + token.content.slice(edit.at + edit.length);
    }
  }
}

const formatting = new Set(["EM", "STRONG", "A", "S", "DEL", "MARK", "U", "INS"]);
const atom = ".md-view,.md-ui,.md-object-source,code,kbd,.katex,.mathjax-node,[contenteditable=\"false\"]";
const isAutolink = (element: Element | null) => {
  const meta = element?.closest(".md-inline")?.firstElementChild;
  return !!element && !!meta?.classList.contains("md-meta") && (meta.textContent === "" || meta.textContent === "<");
};

// Reading surface: each change becomes a glyph drawn over the untouched source characters, so
// offsets, selection mapping and copied text still follow the Markdown source.
export function smartPunctuateElement(root: HTMLElement, style: SmartStyle) {
  if (style === "off") return;
  const groups = new Map<Element, { segments: SmartSegment[]; nodes: (Text | null)[]; offsets: number[]; owner?: Element }>();
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement;
    if (!parent || parent.closest(".md-meta,.md-space,.md-smart")) continue;
    const block = parent.closest("td,th,[data-leaf]");
    if (!block || !root.contains(block)) continue;
    let group = groups.get(block);
    if (!group) groups.set(block, group = { segments: [], nodes: [], offsets: [] });
    if (parent.closest(".md-newline")) { group.segments.push({ text: "", break: true }); group.nodes.push(null); group.offsets.push(0); continue; }
    let level = 0;
    for (let element: Element | null = parent; element && element !== block; element = element.parentElement) if (formatting.has(element.tagName)) level++;
    const link = parent.closest("a");
    if (parent.closest(atom) || (link && isAutolink(link))) {
      const owner = parent.closest(atom) || link!;
      const last = group.segments.at(-1);
      // One atom per element, however many text nodes it holds.
      if (!(last?.literal && group.owner === owner)) { group.segments.push({ text: "a", literal: true, level }); group.nodes.push(null); group.offsets.push(0); }
      group.owner = owner;
      continue;
    }
    group.owner = undefined;
    const escape = node.previousSibling instanceof Element && node.previousSibling.classList.contains("md-meta") && node.previousSibling.textContent!.endsWith("\\");
    if (escape && node.data) {
      group.segments.push({ text: node.data[0], literal: true, level }); group.nodes.push(null); group.offsets.push(0);
      if (node.data.length > 1) { group.segments.push({ text: node.data.slice(1), level }); group.nodes.push(node); group.offsets.push(1); }
      continue;
    }
    group.segments.push({ text: node.data, level }); group.nodes.push(node); group.offsets.push(0);
  }
  for (const { segments, nodes, offsets } of groups.values()) {
    const edits = smartEdits(segments, style);
    for (let index = edits.length - 1; index >= 0; index--) {
      const edit = edits[index], node = nodes[edit.segment]!, at = offsets[edit.segment] + edit.at;
      const target = node.splitText(at);
      target.splitText(edit.length);
      const glyph = root.ownerDocument.createElement("span"), raw = root.ownerDocument.createElement("span");
      glyph.className = "md-smart"; glyph.dataset.smart = edit.glyph;
      raw.setAttribute("aria-hidden", "true");
      target.replaceWith(glyph); raw.append(target); glyph.append(raw);
    }
  }
}
