import { imageAttributes } from "./document-syntax.mjs";
import { parserContext } from "./parser-context.mjs";

export function collectImages(md, source) {
  const context = parserContext(md, source), { text, sourceOffset } = context, result = [];
  let blocked = context.blockCursor();
  const uses = [...context.imageUses, ...context.htmlTags.filter(tag => /^<img\b/i.test(tag.source))].sort((a, b) => a.from - b.from);
  for (const use of uses) {
    const html = use.source !== undefined;
    if (blocked(use.from, html)) continue;
    let url = "", alt = "", width = "", height = "", end = use.to;
    if (html) {
      const attribute = name => use.attributes.get(name)?.value || "";
      url = attribute("src"); alt = attribute("alt"); width = attribute("width"); height = attribute("height");
    } else {
      url = use.url; alt = use.alias.replace(/\\([\[\]])/g, "$1");
    }
    const attributes = !html && imageAttributes(text.slice(end));
    if (attributes) {
      width = attributes.width ?? width; height = attributes.height ?? height;
      end += attributes.source.length;
    }
    if (url) result.push({ from: use.from, to: end, url, alt, width, height });
  }
  blocked = context.blockCursor();
  for (const match of text.matchAll(/!\[\[([^\[\]\n|#]+)(?:\|([^\[\]\n]*))?\]\]/g)) {
    if (blocked(match.index) || !/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(match[1].trim())) continue;
    const size = /^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/i.exec(match[2] || "");
    let end = match.index + match[0].length, width = size?.[1] || "", height = size?.[2] || "";
    const attributes = imageAttributes(text.slice(end));
    if (attributes) {
      width = attributes.width ?? width; height = attributes.height ?? height;
      end += attributes.source.length;
    }
    result.push({ from: match.index, to: end, url: match[1].trim().replaceAll("%", "%25"), alt: size ? match[1].trim() : match[2]?.trim() || match[1].trim(), width, height });
  }
  const table = context.tableCursor();
  return result.sort((a, b) => a.from - b.from).map(image => {
    const from = sourceOffset(image.from), to = sourceOffset(image.to);
    return { ...image, from, to, source: source.slice(from, to), table: table(image.from) };
  });
}
