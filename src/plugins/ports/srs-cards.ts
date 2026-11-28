// Ported from obsidian-spaced-repetition (MIT, Stephen Mwangi) src/parser.ts, question-type.ts and question.ts splitText,
// plus clozecraft 0.4.0 (MIT, MotaOcimar) cloze patterns and notes. Provenance: third-party/obsidian-ports/NOTICE.
// Read-only: review state embedded in notes (<!--SR:...-->) is stripped from card text, never interpreted or rewritten.
import { createMarkdown } from "../../../shared/markdown.mjs";
import { parserContext } from "../../../shared/parser-context.mjs";
import { headingText } from "../../../shared/wiki-syntax.mjs";
import type { ReadingTarget } from "../../../shared/reading-store.ts";

export interface CardSyntax {
  singleLine: string;
  singleLineReversed: string;
  multiline: string;
  multilineReversed: string;
  /** Empty: a blank line ends a multiline card. */
  endMarker: string;
  clozePatterns: readonly string[];
}

export const HIGHLIGHT_CLOZE = "==[123;;]answer[;;hint]==";
export const BOLD_CLOZE = "**[123;;]answer[;;hint]**";
export const CURLY_CLOZE = "{{[123;;]answer[;;hint]}}";
export const defaultSyntax: CardSyntax = { singleLine: "::", singleLineReversed: ":::", multiline: "?", multilineReversed: "??", endMarker: "", clozePatterns: [HIGHLIGHT_CLOZE] };

export type CardKind = "single" | "single-reversed" | "multi" | "multi-reversed" | "cloze";
/** One question block in the source; lines are 0-based and inclusive. */
export interface ParsedQuestion { kind: CardKind; text: string; firstLine: number; lastLine: number }
export interface CardSide { front: string; back: string; quote: string }
export type CardDraftSource = { front: string; back: string; anchor: ReadingTarget };

const SCHEDULE_COMMENT = "<!--SR:";
const METADATA_CALLOUT = "> [!sr|card-metadata]";

function insideInlineCode(text: string, marker: string, index: number) {
  let before = 0, after = 0;
  for (let i = 0; i < index; i++) if (text[i] === "`") before++;
  for (let i = index + marker.length; i < text.length; i++) if (text[i] === "`") after++;
  return before % 2 === 1 && after % 2 === 1;
}

function hasInlineMarker(text: string, marker: string) {
  if (!marker) return false;
  const index = text.indexOf(marker);
  return index !== -1 && !insideInlineCode(text, marker, index);
}

/** Replaces YAML frontmatter with blank lines so card line numbers still match the note. */
export function blankFrontmatter(text: string) {
  return text.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/, block => block.replace(/[^\r\n]/g, ""));
}

/** Finds every question block, matching the Spaced Repetition plugin's note syntax. */
export function parseQuestions(source: string, syntax: CardSyntax = defaultSyntax): ParsedQuestion[] {
  const inline = [
    { separator: syntax.singleLine, kind: "single" as const },
    { separator: syntax.singleLineReversed, kind: "single-reversed" as const },
  ].sort((a, b) => b.separator.length - a.separator.length);
  const cloze = new ClozeCrafter(syntax.clozePatterns);
  const lines = blankFrontmatter(source).replaceAll("\r\n", "\n").split("\n");
  const cards: ParsedQuestion[] = [];
  let text = "", kind: CardKind | null = null, first = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], trimmed = line.trim();
    if (line.startsWith("<!--") && !line.startsWith(SCHEDULE_COMMENT)) {
      // Upstream re-tested the opening line forever; scan forward to the real closing line.
      while (i < lines.length && !lines[i].includes("-->")) i++;
      if (kind === null && !text) first = i + 1;
      continue;
    }
    const empty = trimmed.length === 0;
    if ((empty && !syntax.endMarker) || (empty && kind === null) || (syntax.endMarker && trimmed === syntax.endMarker)) {
      if (kind) cards.push({ kind, text: text.trimEnd(), firstLine: first, lastLine: i - 1 });
      kind = null; text = ""; first = i + 1;
      continue;
    }
    if (text) text += "\n";
    text += line.trimEnd();
    for (const { separator, kind: candidate } of inline) {
      if (hasInlineMarker(line, separator)) { kind = candidate; break; }
    }
    if (kind === "single" || kind === "single-reversed") {
      text = line; first = i;
      if (lines[i + 1]?.startsWith(SCHEDULE_COMMENT)) text += "\n" + lines[++i];
      else if (lines[i + 1]?.startsWith(METADATA_CALLOUT)) {
        while (i + 1 < lines.length) { text += "\n" + lines[++i]; if (lines[i].includes(SCHEDULE_COMMENT)) break; }
      }
      cards.push({ kind, text, firstLine: first, lastLine: i });
      kind = null; text = "";
    } else if (trimmed === syntax.multiline) {
      if (text.length > 1) kind = "multi";
    } else if (trimmed === syntax.multilineReversed) {
      if (text.length > 1) kind = "multi-reversed";
    } else if (line.startsWith("```") || line.startsWith("~~~")) {
      const fence = line.match(/`+|~+/)![0];
      while (i + 1 < lines.length && !lines[i + 1].startsWith(fence)) text += "\n" + lines[++i];
      text += "\n" + fence;
      i++;
    } else if (kind === null && cloze.isCloze(line)) kind = "cloze";
  }
  if (kind && text) cards.push({ kind, text: text.trimEnd(), firstLine: first, lastLine: lines.length - 1 });
  return cards;
}

/** Removes schedule comments, the metadata callout, a leading topic tag and a trailing block id. */
export function questionText(text: string) {
  const lines: string[] = [];
  let callout = false;
  for (const line of text.split("\n")) {
    if (line.startsWith(METADATA_CALLOUT)) callout = true;
    if (callout) { if (line.includes(SCHEDULE_COMMENT)) callout = false; continue; }
    lines.push(line);
  }
  let question = lines.join("\n").replace(/<!--SR:.+-->/gm, "").trimEnd();
  const trimmed = question.trimStart();
  if (/^#[^\s#]+/.test(trimmed)) question = trimmed.replace(/^#[^\s#]+/, "").trimStart();
  return question.replace(/ (\^[a-zA-Z0-9-]+)$/, "").trimEnd();
}

function lineIndex(lines: string[], marker: string) {
  return lines.findIndex(line => line.trim() === marker);
}

/** Expands one question into its card sides; reversed questions yield two, clozes one per deletion group. */
export function expandQuestion(question: ParsedQuestion, syntax: CardSyntax = defaultSyntax): CardSide[] {
  const text = questionText(question.text);
  const pair = (front: string, back: string) => ({ front: front.trim(), back: back.trim(), quote: back.trim() });
  switch (question.kind) {
    case "single":
    case "single-reversed": {
      const separator = question.kind === "single" ? syntax.singleLine : syntax.singleLineReversed;
      const index = text.indexOf(separator);
      const [front, back] = [text.slice(0, index), text.slice(index + separator.length)];
      return question.kind === "single" ? [pair(front, back)] : [pair(front, back), pair(back, front)];
    }
    case "multi":
    case "multi-reversed": {
      const lines = text.split("\n");
      const index = lineIndex(lines, question.kind === "multi" ? syntax.multiline : syntax.multilineReversed);
      const [front, back] = [lines.slice(0, index).join("\n"), lines.slice(index + 1).join("\n")];
      return question.kind === "multi" ? [pair(front, back)] : [pair(front, back), pair(back, front)];
    }
    case "cloze": return new ClozeCrafter(syntax.clozePatterns).cards(text);
  }
}

type ClozeType = "classic" | "overlapping" | "simple";
type Field = "answer" | "hint" | "seq";
/** Simple clozes are a subset of the others, so they must be tried last. */
const CLOZE_PRIORITY: readonly ClozeType[] = ["classic", "overlapping", "simple"];
interface Deletion { raw: string; answer: string; hint?: string; seq: string }

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NUMBER_PART = /\[(?:(?:\\\])?[^\]]?)+?\d+(?:(?:\\\])?[^\]]?)+?\]/;
const HINT_PART = /\[(?:(?:\\\])?[^\]]?)+?hint(?:(?:\\\])?[^\]]?)+?\]/;

/** A user cloze pattern such as `==[123;;]answer[;;hint]==`, compiled once per cloze type. */
export class ClozePattern {
  private readonly raw: string;
  private readonly number: RegExpExecArray;
  private readonly hint: RegExpExecArray;
  private readonly order: Field[];
  private readonly compiled: Partial<Record<ClozeType, RegExp>> = {};

  constructor(raw: string) {
    const number = NUMBER_PART.exec(raw), hint = HINT_PART.exec(raw);
    if (!number || !hint || !raw.includes("answer")) throw new Error(`Invalid cloze pattern: ${raw}`);
    this.raw = raw; this.number = number; this.hint = hint;
    const position: Record<Field, number> = { answer: raw.indexOf("answer"), hint: hint.index, seq: number.index };
    this.order = (["answer", "hint", "seq"] as Field[]).sort((a, b) => position[a] - position[b]);
  }

  private static part(text: string, replace: (text: string) => string) {
    return replace(escapeRegex(text.slice(1, -1).replace(/\\\[/g, "[").replace(/\\]/g, "]")));
  }

  regex(type: ClozeType): RegExp {
    const cached = this.compiled[type];
    if (cached) { cached.lastIndex = 0; return cached; }
    const hint = `(?:${ClozePattern.part(this.hint[0], text => text.replace(/hint/g, "(.+?)"))})?`;
    const number = type === "simple" ? "" : ClozePattern.part(this.number[0], text => text.replace(/\d+/g, type === "classic" ? "(\\d+)" : "([ash]+)"));
    const [first, firstRegex, second, secondRegex] = this.number.index < this.hint.index
      ? [this.number, number, this.hint, hint] : [this.hint, hint, this.number, number];
    const source = escapeRegex(this.raw.slice(0, first.index)) + firstRegex
      + escapeRegex(this.raw.slice(first.index + first[0].length, second.index)) + secondRegex
      + escapeRegex(this.raw.slice(second.index + second[0].length));
    return this.compiled[type] = new RegExp(source.replace("answer", "(.+?)"), "g");
  }

  deletions(text: string, type: ClozeType): Deletion[] {
    const fields = type === "simple" ? this.order.filter(field => field !== "seq") : this.order;
    const regex = this.regex(type);
    const found: Deletion[] = [];
    for (let match = regex.exec(text); match; match = regex.exec(text)) {
      const field = (name: Field) => match[fields.indexOf(name) + 1];
      found.push({ raw: match[0], answer: field("answer"), hint: field("hint"), seq: type === "simple" ? "" : field("seq") });
    }
    return found;
  }

  mainType(text: string): ClozeType | null {
    return CLOZE_PRIORITY.find(type => this.regex(type).test(text)) ?? null;
  }
}

class ClozeCrafter {
  private readonly patterns: ClozePattern[];
  constructor(patterns: readonly string[]) { this.patterns = patterns.map(raw => new ClozePattern(raw)); }

  type(text: string): ClozeType | null {
    let best: ClozeType | null = null;
    for (const pattern of this.patterns) {
      const type = pattern.mainType(text);
      if (type && (best === null || CLOZE_PRIORITY.indexOf(type) < CLOZE_PRIORITY.indexOf(best))) best = type;
    }
    return best;
  }

  isCloze(text: string) { return this.type(text) !== null; }

  cards(text: string): CardSide[] {
    const type = this.type(text);
    if (!type) return [];
    const deletions = this.patterns.flatMap(pattern => pattern.deletions(text, type));
    // Classic: card n asks every deletion numbered n. Overlapping: letter n of each sequence (a ask, h hide, s show).
    // Simple: each deletion is its own card.
    const total = type === "classic" ? Math.max(0, ...deletions.map(item => Number(item.seq)))
      : type === "overlapping" ? Math.max(0, ...deletions.map(item => item.seq.length)) : deletions.length;
    const action = (deletion: Deletion, index: number, card: number) =>
      type === "classic" ? (Number(deletion.seq) === card + 1 ? "a" : "s")
        : type === "overlapping" ? deletion.seq[card] ?? "s" : (index === card ? "a" : "s");
    const sides: CardSide[] = [];
    for (let card = 0; card < total; card++) {
      let front = text, back = text;
      const asked: string[] = [];
      deletions.forEach((deletion, index) => {
        const step = action(deletion, index, card);
        const hidden = deletion.hint ? `[${deletion.hint}]` : "[…]";
        if (step === "a") asked.push(deletion.answer);
        front = front.replace(deletion.raw, () => step === "s" ? deletion.answer : step === "a" ? hidden : "…");
        back = back.replace(deletion.raw, () => step === "h" ? "…" : deletion.answer);
      });
      // Upstream emits blank cards for unused classic numbers (only c2 present); skip them.
      if (asked.length) sides.push({ front: front.trim(), back: back.trim(), quote: asked.join(" · ") });
    }
    return sides;
  }
}

const markdown = createMarkdown();

/** Builds review drafts anchored to the source block and heading path the reading layer uses. */
export function cardDrafts(source: string, syntax: CardSyntax = defaultSyntax): CardDraftSource[] {
  const { tokens } = parserContext(markdown, source);
  const lines = source.split(/\r\n|\r|\n/);
  const outline: { level: number; text: string; line: number }[] = [];
  const headingsAt: { line: number; headings: string[] }[] = [];
  const blocks: [number, number][] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "heading_open" && token.map) {
      const level = Number(token.tag.slice(1));
      while (outline.length && outline.at(-1)!.level >= level) outline.pop();
      outline.push({ level, text: headingText(tokens[i + 1].children ?? []), line: token.map[0] });
      headingsAt.push({ line: token.map[0], headings: outline.map(entry => entry.text) });
    } else if (token.map && ["inline", "fence", "code_block", "html_block"].includes(token.type) && tokens[i - 1]?.type !== "heading_open") blocks.push(token.map as [number, number]);
  }
  const headings = (line: number) => headingsAt.findLast(entry => entry.line <= line)?.headings ?? [];
  const drafts: CardDraftSource[] = [];
  for (const question of parseQuestions(source, syntax)) {
    // The rendered block holding the card, as the reading layer anchors highlights to it.
    const map = blocks.find(([start, end]) => start <= question.firstLine && question.firstLine < end);
    const block = (map ? lines.slice(map[0], map[1]) : lines.slice(question.firstLine, question.lastLine + 1)).join("\n").trimEnd();
    for (const side of expandQuestion(question, syntax)) {
      if (!side.front || !side.back) continue;
      drafts.push({ front: side.front, back: side.back, anchor: { block, headings: headings(question.firstLine), line: question.firstLine + 1, quote: side.quote } });
    }
  }
  return drafts;
}
