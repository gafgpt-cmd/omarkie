import { imageReferences } from "../../editor/images.ts";
export function imageRange(text: string, from: number) {
  return imageReferences(text).find(image => image.from === from);
}
function dimensions(attributes: string, width: number, height: number) {
  let found = false;
  const next = attributes.replace(/(^|\s)(width|height)(\s*=\s*)(["']?)(\d+(?:\.\d+)?)(px|%)?\4/gi, (_match, prefix: string, key: string, space: string, quote: string, _value: string, unit: string) => {
    if (key.toLowerCase() === "width") found = true;
    return `${prefix}${key}${space}${quote}${key.toLowerCase() === "width" ? width : height}${unit === "px" ? "px" : ""}${quote}`;
  });
  return found ? next : `${next.trimEnd()} width=${width}`;
}
export function resizedImage(source: string, width: number, height: number) {
  width = Math.max(16, Math.min(10000, Math.round(width))); height = Math.max(1, Math.min(10000, Math.round(height)));
  if (source.startsWith("![[")) {
    const end = source.indexOf("]]"), inner = source.slice(3, end), pipe = inner.indexOf("|"), size = /^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/i.exec(inner.slice(pipe + 1));
    const suffix = source.slice(end + 2);
    if (suffix) {
      const base = pipe >= 0 && size ? source.slice(0, 3 + pipe + 1) + width + (size[2] ? `x${height}` : "") + "]]" : source.slice(0, end + 2);
      return base + `{${dimensions(suffix.slice(1, -1), width, height)}}`;
    }
    if (pipe >= 0 && size) return source.slice(0, 3 + pipe + 1) + width + (size[2] ? `x${height}` : "") + source.slice(end);
    if (pipe < 0) return source.slice(0, end) + `|${width}` + source.slice(end);
    return source + `{width=${width}}`;
  }
  if (/^<img\b/i.test(source)) {
    let hasWidth = false;
    let changed = source.replace(/(\s+)([\w:-]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g, (match, space: string, name: string, equals: string, double: string | undefined, single: string | undefined, bare: string | undefined) => {
      const key = name.toLowerCase(), quote = double !== undefined ? '"' : single !== undefined ? "'" : "", value = double ?? single ?? bare ?? "";
      if (key === "width") hasWidth = true;
      const next = key === "width" ? String(width) : key === "height" ? String(height) : key === "style" ? value.replace(/(^|;)(\s*)(width|height)(\s*:\s*)[\d.]+(?:px|%)/gi, (_part, prefix: string, space: string, dimension: string, colon: string) => `${prefix}${space}${dimension}${colon}${dimension.toLowerCase() === "width" ? width : height}px`) : undefined;
      return next === undefined ? match : `${space}${name}${equals}${quote}${next}${quote}`;
    });
    if (!hasWidth) changed = changed.replace(/(\s*\/?>)$/, ` width="${width}"$1`);
    return changed;
  }
  const attrs = /\{([^{}\n]*)\}$/.exec(source);
  return attrs ? source.slice(0, attrs.index) + `{${dimensions(attrs[1], width, height)}}` : source + `{width=${width}}`;
}
