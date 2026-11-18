import { markdownImageReferences } from "./markdown.ts";
export interface ImageReference { from: number; to: number; source: string; url: string; alt: string; width: string; height: string; table?: boolean }
export function imageReferences(text: string): ImageReference[] { return markdownImageReferences(text); }
export function imageMarkdown(url: string, alt: string, width = "", height = "", table = false) {
  const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const source = width || height
    ? `<img src="${escape(url)}" alt="${escape(alt)}"${width ? ` width="${escape(width)}"` : ""}${height ? ` height="${escape(height)}"` : ""} />`
    : `![${alt.replace(/[\[\]\\]/g, c => "\\" + c)}](<${url.replaceAll(">", "%3E")}>)`;
  return table ? source.replaceAll("|", "\\|") : source;
}
export function updateImageReferences(text: string, mapping: Record<string, string>) {
  for (const image of imageReferences(text).reverse()) if (Object.hasOwn(mapping, image.url)) {
    text = text.slice(0, image.from) + (mapping[image.url] ? imageMarkdown(mapping[image.url], image.alt, image.width, image.height, image.table) : "") + text.slice(image.to);
  }
  return text;
}
