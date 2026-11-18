import { parseBlocks } from "./markdown.ts";
import { createMarkdown } from "../../shared/markdown.mjs";
import { inlineDestination } from "../../shared/link-destination.mjs";
const md = createMarkdown();
export interface ImageReference { from: number; to: number; source: string; url: string; alt: string; width: string; height: string }
export function imageReferences(text: string): ImageReference[] {
  const result: ImageReference[] = [];
  const lines = text.split("\n"), offsets = [0]; for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1);
  const blocked = parseBlocks(text).filter(block => ["fence", "code_block", "frontmatter", "math_block"].includes(block.kind)).map(block => ({ from: offsets[block.fromLine - 1], to: offsets[block.toLine] }));
  for (const code of text.matchAll(/(`+)([^`]|(?!\1)`)*?\1/g)) blocked.push({ from: code.index, to: code.index + code[0].length });
  const state = new md.inline.State(text, md, {}, []);
  const expression = /!\[|<img\b[^>]*>/gi;
  for (const match of text.matchAll(expression)) {
    if (blocked.some(range => match.index >= range.from && match.index < range.to) || /(?:^|[^\\])(?:\\\\)*\\$/.test(text.slice(0, match.index))) continue;
    let url = "", alt = "", width = "", height = "", end = match.index + match[0].length;
    if (match[0].startsWith("<")) { const attributes = new DOMParser().parseFromString(match[0], "text/html").querySelector("img"); url = attributes?.getAttribute("src") || ""; alt = attributes?.getAttribute("alt") || ""; width = attributes?.getAttribute("width") || ""; height = attributes?.getAttribute("height") || ""; }
    else {
      if (text[match.index + 2] === "[") continue;
      const labelEnd = md.helpers.parseLinkLabel(state, match.index + 1, false);
      if (labelEnd < 0) continue;
      const destination = inlineDestination(md, text, labelEnd + 1);
      if (!destination) continue;
      end = destination.end;
      const attributes = /^\{([^{}\n]*\b(?:width|height)\s*=[^{}\n]*)\}/.exec(text.slice(end));
      if (attributes) {
        for (const [, key, value] of attributes[1].matchAll(/\b(width|height)\s*=\s*["']?(\d+(?:\.\d+)?(?:px|%)?)["']?/g)) { const size = value.replace(/px$/, ""); if (key === "width") width = size; else height = size; }
        end += attributes[0].length;
      }
      url = destination.target; alt = text.slice(match.index + 2, labelEnd).replace(/\\([\[\]])/g, "$1"); }
    if (url) result.push({ from: match.index, to: end, source: text.slice(match.index, end), url, alt, width, height });
  }
  for (const match of text.matchAll(/!\[\[([^\[\]\n|#]+)(?:\|([^\[\]\n]*))?\]\]/g)) {
    if (blocked.some(range => match.index >= range.from && match.index < range.to) || /(?:^|[^\\])(?:\\\\)*\\$/.test(text.slice(0, match.index))) continue;
    if (!/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(match[1].trim())) continue;
    const size = /^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/i.exec(match[2] || "");
    let end = match.index + match[0].length, width = size?.[1] || "", height = size?.[2] || "";
    const attributes = /^\{([^{}\n]*\b(?:width|height)\s*=[^{}\n]*)\}/.exec(text.slice(end));
    if (attributes) {
      for (const [, key, value] of attributes[1].matchAll(/\b(width|height)\s*=\s*["']?(\d+(?:\.\d+)?(?:px|%)?)["']?/g)) { const dimension = value.replace(/px$/, ""); if (key === "width") width = dimension; else height = dimension; }
      end += attributes[0].length;
    }
    result.push({ from: match.index, to: end, source: text.slice(match.index, end), url: match[1].trim().replaceAll("%", "%25"), alt: size ? match[1].trim() : match[2]?.trim() || match[1].trim(), width, height });
  }
  return result.sort((a, b) => a.from - b.from);
}
export function imageMarkdown(url: string, alt: string, width = "", height = "") {
  const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  if (width || height) return `<img src="${escape(url)}" alt="${escape(alt)}"${width ? ` width="${escape(width)}"` : ""}${height ? ` height="${escape(height)}"` : ""} />`;
  return `![${alt.replace(/[\[\]\\]/g, c => "\\" + c)}](<${url.replaceAll(">", "%3E")}>)`;
}
export function updateImageReferences(text: string, mapping: Record<string, string>) {
  for (const image of imageReferences(text).reverse()) if (Object.hasOwn(mapping, image.url)) {
    text = text.slice(0, image.from) + (mapping[image.url] ? imageMarkdown(mapping[image.url], image.alt, image.width, image.height) : "") + text.slice(image.to);
  }
  return text;
}
