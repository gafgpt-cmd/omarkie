import type { Token } from "markdown-it";
import { createMarkdown } from "../shared/markdown.mjs";
import { parserContext } from "../shared/parser-context.mjs";
import { sourceLines } from "../shared/source-lines.mjs";
import { headingText } from "../shared/wiki-syntax.mjs";

const parser = createMarkdown();

export interface CollectedReadingItem {
  kind: "highlight" | "callout";
  target: { block: string; headings: readonly string[]; line: number; quote: string };
}

function inlineText(token: Token): string {
  if (token.type === "softbreak" || token.type === "hardbreak") return " ";
  if (token.nesting || token.hidden || token.type === "comment" || token.type.startsWith("html_")) return "";
  return token.content;
}

function standaloneCallout(block: string, depth: number): string {
  return block.split(/\r\n|\r|\n/).map(line => {
    const prefix = /[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)*>/y;
    for (let i = 0; i < depth; i++) {
      const match = prefix.exec(line);
      // CommonMark permits lazy paragraph continuations without a quote marker.
      if (!match) return `> ${line.trimStart()}`;
      if (i === depth - 1) return line.slice(match.index + match[0].length - 1);
    }
    return line;
  }).join("\n");
}
export function collectReadingItems(markdown: string): CollectedReadingItem[] {
  const { offsets } = sourceLines(markdown);
  const { tokens } = parserContext(parser, markdown);
  const items: CollectedReadingItem[] = [];
  const outline: { level: number; text: string }[] = [];
  let headings: readonly string[] = [], row: number[] | null = null, depth = 0;
  const source = ([start, end]: number[]) => markdown.slice(offsets[start], offsets[end]).trimEnd();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "heading_open" && token.level === 0) {
      const level = Number(token.tag.slice(1));
      while (outline.length && outline.at(-1)!.level >= level) outline.pop();
      outline.push({ level, text: headingText(tokens[i + 1].children ?? []) });
      headings = outline.map(entry => entry.text);
    } else if (token.type === "blockquote_open") {
      depth++;
      if (token.map && token.attrGet("data-alert")) {
        const block = source(token.map);
        items.push({ kind: "callout", target: { block, headings, line: token.map[0] + 1, quote: standaloneCallout(block, depth) } });
      }
    } else if (token.type === "blockquote_close") depth--;
    else if (token.type === "tr_open") row = token.map;
    else if (token.type === "tr_close") row = null;
    else if (token.type === "inline") {
      const map = token.map ?? row;
      if (!map || !token.children) continue;
      let text = "", marks = 0, block: string | undefined;
      for (const child of token.children) {
        if (child.type === "mark_open") {
          if (marks++ === 0) text = "";
        } else if (child.type === "mark_close") {
          if (--marks > 0) continue;
          const quote = text.trim();
          if (quote) items.push({ kind: "highlight", target: { block: block ??= source(map), headings, line: map[0] + 1, quote } });
        } else if (marks) text += inlineText(child);
      }
    }
  }
  return items;
}
export function readingSummary(items: readonly CollectedReadingItem[], title: string, source: string): string {
  const literal = (text: string) => text.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "\\$&");
  return [`# ${literal(title)}`, literal(source), ...items.map(({ kind, target }) => kind === "callout" ? target.quote : `- ${literal(target.quote)}`)].join("\n\n") + "\n";
}
