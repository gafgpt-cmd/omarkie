import { inlineDestination } from "./link-destination.mjs";
import { parserContext } from "./parser-context.mjs";
import { decodeHTMLAttribute } from "entities";

export function collectImages(md, source) {
  const context = parserContext(md, source), { text, sourceOffset } = context, result = [];
  const state = new md.inline.State(text, md, context.environment, []);
  let blocked = context.blockCursor();
  for (const match of text.matchAll(/!\[|<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const html = match[0].startsWith("<");
    if (blocked(match.index, html)) continue;
    let url = "", alt = "", width = "", height = "", end = match.index + match[0].length;
    if (html) {
      const attribute = name => {
        const value = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\x60]+))`, "i").exec(match[0]);
        return decodeHTMLAttribute(value?.[1] ?? value?.[2] ?? value?.[3] ?? "");
      };
      url = attribute("src"); alt = attribute("alt"); width = attribute("width"); height = attribute("height");
    } else {
      if (text[match.index + 2] === "[") continue;
      const labelEnd = md.helpers.parseLinkLabel(state, match.index + 1, false);
      if (labelEnd < 0) continue;
      const destination = inlineDestination(md, text, labelEnd + 1);
      if (!destination) continue;
      url = destination.target; alt = text.slice(match.index + 2, labelEnd).replace(/\\([\[\]])/g, "$1"); end = destination.end;
    }
    const attributes = !html && /^\{([^{}\n]*\b(?:width|height)\s*=[^{}\n]*)\}/.exec(text.slice(end));
    if (attributes) {
      for (const [, key, value] of attributes[1].matchAll(/\b(width|height)\s*=\s*["']?(\d+(?:\.\d+)?(?:px|%)?)["']?/g)) { if (key === "width") width = value.replace(/px$/, ""); else height = value.replace(/px$/, ""); }
      end += attributes[0].length;
    }
    if (url) result.push({ from: match.index, to: end, url, alt, width, height });
  }
  blocked = context.blockCursor();
  for (const match of text.matchAll(/!\[\[([^\[\]\n|#]+)(?:\|([^\[\]\n]*))?\]\]/g)) {
    if (blocked(match.index) || !/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(match[1].trim())) continue;
    const size = /^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/i.exec(match[2] || "");
    let end = match.index + match[0].length, width = size?.[1] || "", height = size?.[2] || "";
    const attributes = /^\{([^{}\n]*\b(?:width|height)\s*=[^{}\n]*)\}/.exec(text.slice(end));
    if (attributes) {
      for (const [, key, value] of attributes[1].matchAll(/\b(width|height)\s*=\s*["']?(\d+(?:\.\d+)?(?:px|%)?)["']?/g)) { if (key === "width") width = value.replace(/px$/, ""); else height = value.replace(/px$/, ""); }
      end += attributes[0].length;
    }
    result.push({ from: match.index, to: end, url: match[1].trim().replaceAll("%", "%25"), alt: size ? match[1].trim() : match[2]?.trim() || match[1].trim(), width, height });
  }
  const table = context.tableCursor();
  return result.sort((a, b) => a.from - b.from).map(image => {
    const from = sourceOffset(image.from), to = sourceOffset(image.to);
    return { ...image, from, to, source: source.slice(from, to), table: table(image.from) };
  });
}
