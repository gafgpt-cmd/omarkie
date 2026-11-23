import { createMarkdown, setSyntaxOptions } from "../../shared/markdown.mjs";
import { collectImages } from "../../shared/image-references.mjs";
import { parserContext } from "../../shared/parser-context.mjs";
import { sourceLines } from "../../shared/source-lines.mjs";
let hljs: typeof import("highlight.js/lib/common")["default"] | undefined;
let highlighting: Promise<void> | undefined;
export function loadHighlighting() { return highlighting ??= import("highlight.js/lib/common").then(module => { hljs = module.default; }); }
import DOMPurify from "dompurify";
import { configureDocumentRendering } from "./markdownExtensions.ts";
import type { Token } from "markdown-it";
import { t } from "../i18n.ts";
import { bundledImageUrls, normalizedURL, remoteURL } from "./htmlResources.ts";
let allowRemoteImages = false;
export interface Block {
  fromLine: number;
  toLine: number;
  source: string;
  kind: string;
}
export interface Heading {
  line: number;
  level: number;
  text: string;
  id: string;
}
const md = createMarkdown({
  highlight(code, language): string {
    return language && hljs?.getLanguage(language)
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : md.utils.escapeHtml(code);
  },
}).use(configureDocumentRendering);
// Bumped on every option change so cached block renders are invalidated.
export let markdownOptionsVersion = 0;
export function setMarkdownOptions(options: { highlight: boolean; subscript: boolean; superscript: boolean; emoji: boolean; inlineMath: boolean }) {
  markdownOptionsVersion++;
  allowRemoteImages = (options as { remoteImages?: boolean }).remoteImages === true;
  setSyntaxOptions(md, options);
}
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, index, options, env, self) =>
  /^(mermaid|sequence|flow)$/.test(tokens[index].info.trim())
    ? `<div class="mermaid-block" data-diagram-language="${tokens[index].info.trim()}">${md.utils.escapeHtml(tokens[index].content)}</div>`
    : defaultFence(tokens, index, options, env, self);
// Natural sizes of images seen so far: later renders reserve the box and the page does not jump.
const imageSizes = new Map<string, [number, number]>();
if (typeof document !== "undefined")
  document.addEventListener("load", event => {
    // Tag check, not instanceof: DOM test environments expose document without the HTMLImageElement global.
    const image = event.target as HTMLImageElement | null;
    if (image?.tagName === "IMG" && image.naturalWidth && !image.currentSrc?.includes("?preview=")) imageSizes.set(image.getAttribute("src") || "", [image.naturalWidth, image.naturalHeight]);
  }, true);
// Sizes announced by the host before a document's first render, keyed like the image rule keys
// them: by the raw source and by its Markdown-normalized form.
export function rememberImageSizes(documentId: string, sizes: Record<string, [number, number]>) {
  let changed = false;
  for (const [source, size] of Object.entries(sizes)) {
    if (!Array.isArray(size) || !(size[0] > 0) || !(size[1] > 0)) continue;
    for (const key of new Set([source, md.normalizeLink(source)])) {
      const url = `omarkie-asset://local/${encodeURIComponent(documentId)}/${encodeURIComponent(key)}`;
      const previous = imageSizes.get(url);
      if (previous?.[0] === size[0] && previous[1] === size[1]) continue;
      imageSizes.set(url, [size[0], size[1]]);
      changed = true;
    }
  }
  if (changed) markdownOptionsVersion++;
}
export function markdownImageReferences(text: string) { return collectImages(md, text); }
export function localImageSources(text: string) {
  return [...new Set(markdownImageReferences(text).map(image => image.url).filter(source => {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(source)?.[1].toLowerCase();
    return !scheme || scheme.length === 1 || scheme === "file";
  }))];
}
// One <img> for Markdown images and Obsidian embeds. Explicit sizes ({width=300}, |300x200) win;
// a lone width keeps the natural aspect ratio when the natural size is known.
function imageHtml(source: string, alt: string, documentId: string | undefined, alone: boolean, width?: string, height?: string) {
  const classified = normalizedURL(source);
  if (remoteURL(source) && !allowRemoteImages)
    return `<span class="remote-image">${alt}${t("（远程图片：{{source}}）", { source: md.utils.escapeHtml(source) })}</span>`;
  const url = remoteURL(classified) || /^data:image\/(?:png|jpeg|gif|webp);/i.test(classified)
    ? classified
    : documentId
      ? `omarkie-asset://local/${encodeURIComponent(documentId)}/${encodeURIComponent(source)}`
      : "";
  if (!url) return `<span class="remote-image">${alt}（${md.utils.escapeHtml(source)}）</span>`;
  const natural = imageSizes.get(url), size = width && !width.endsWith("%") && !height && natural ? [width, String(Math.round(Number(width) * natural[1] / natural[0]))] : width || height ? [width, height] : natural?.map(String);
  return `<img src="${url}" alt="${alt}" loading="lazy" decoding="async"${size?.[0] ? ` width="${md.utils.escapeHtml(size[0])}"` : ""}${size?.[1] ? ` height="${md.utils.escapeHtml(size[1])}"` : ""}${alone ? ` class="md-standalone${width || height ? "" : " md-fit-image"}"` : ""} />`;
}
// An image alone on its line is laid out as a centred figure.
// The rich editor renders each image on its own and says whether it fills its line.
const standalone = (tokens: Token[], index: number, env: Record<string, unknown> | undefined) =>
  typeof env?.standalone === "boolean" ? env.standalone : tokens.every((other, at) => at === index || other.type === "softbreak" || (other.type === "text" && !other.content.trim()));
md.renderer.rules.image = (tokens, index, _options, env) => {
  const token = tokens[index];
  return imageHtml(String(token.attrGet("src") || ""), md.utils.escapeHtml(token.content || t("图片")), typeof env?.documentId === "string" ? env.documentId : undefined, standalone(tokens, index, env), String(token.attrGet("width") ?? "") || undefined, String(token.attrGet("height") ?? "") || undefined);
};
// Obsidian embeds resolve like Obsidian: next to the note first, then anywhere in the vault (host side).
md.renderer.rules.wiki_embed = (tokens, index, _options, env) => {
  const token = tokens[index], meta = (token.meta || {}) as { target?: string; width?: string; height?: string }, target = (meta.target || "").split("#")[0], documentId = typeof env?.documentId === "string" ? env.documentId : undefined;
  const name = md.utils.escapeHtml(token.content || target), source = md.normalizeLink(target.replaceAll("%", "%25"));
  if (/\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(target)) return imageHtml(source, name, documentId, standalone(tokens, index, env), meta.width, meta.height);
  const media = /\.(?:mp3|wav|m4a|ogg)$/i.test(target) ? "audio" : /\.(?:mp4|webm)$/i.test(target) ? "video" : "";
  return media && documentId
    ? `<${media} controls preload="metadata" src="omarkie-asset://local/${encodeURIComponent(documentId)}/${encodeURIComponent(source)}"${meta.width ? ` width="${md.utils.escapeHtml(meta.width)}"` : ""}></${media}>`
    : `<span class="wiki-embed">${name}</span>`;
};
function cleanHtml(html: string, documentId?: string, standalone?: boolean) {
  const safe = DOMPurify.sanitize(html, { FORBID_TAGS: allowRemoteImages ? [] : ["style"], ADD_URI_SAFE_ATTR: ["src"], ADD_TAGS: ["video", "audio", "source", "iframe"], ADD_ATTR: ["controls", "poster", "allowfullscreen", "sandbox"], ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|sms|cid|xmpp|omarkie-wiki|omarkie-tag):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i });
  const template = document.createElement("template"); template.innerHTML = safe;
  if (!allowRemoteImages) for (const element of template.content.querySelectorAll("[style]")) {
    const declarations = (element.getAttribute("style") || "").split(";").filter(value => {
      const normalized = value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\\(?:([0-9a-f]{1,6})\s?|([^\r\n\f]))/gi, (_, hex, char) => {
        const code = hex ? parseInt(hex, 16) : 0;
        return hex ? String.fromCodePoint(code > 0 && code <= 0x10ffff ? code : 0xfffd) : char;
      });
      return !/\b(?:url|src|image|(?:-webkit-)?image-set|attr)\s*\(|(?:https?:|\/\/)/i.test(normalized);
    });
    if (declarations.length) element.setAttribute("style", declarations.join(";"));
    else element.removeAttribute("style");
  }
  for (const image of template.content.querySelectorAll("img")) {
    const source = image.getAttribute("src") || "";
    if (remoteURL(source) && !allowRemoteImages) { image.replaceWith(document.createTextNode(image.alt || t("远程图片"))); continue; }
    if (documentId && source && !remoteURL(source) && !/^(?:data:|omarkie-asset:)/i.test(normalizedURL(source))) image.src = `omarkie-asset://local/${encodeURIComponent(documentId)}/${encodeURIComponent(source)}`;
    for (const attribute of ["width", "height"]) if (image.hasAttribute(attribute) && !/^\d+(?:\.\d+)?%?$/.test(image.getAttribute(attribute)!)) image.removeAttribute(attribute);
    if (standalone === true && !image.classList.contains("md-standalone") &&
        !image.hasAttribute("width") && !image.hasAttribute("height") &&
        !image.style.width && !image.style.height && !image.style.inlineSize && !image.style.blockSize) {
      const parent = image.parentElement ?? template.content;
      if ((parent === template.content || image.parentElement?.tagName === "P") &&
          parent.children.length === 1 && !parent.textContent?.trim()) image.classList.add("md-fit-image");
    }
    const size = imageSizes.get(image.getAttribute("src") || "");
    // Without header dimensions, let the original provide the intrinsic width, not a JPEG preview.
    if ((size || standalone !== true || !image.classList.contains("md-fit-image")) && typeof navigator !== "undefined" && /Electron\//.test(navigator.userAgent) && /^omarkie-asset:/.test(image.src) && /\.jpe?g$/i.test(decodeURIComponent(new URL(image.src).pathname))) {
      image.loading = "lazy"; image.decoding = "async";
      image.setAttribute("sizes", "auto");
      image.setAttribute("srcset", [800, 1200, 1600, 2400].map(width => `${image.src}?preview=${width} ${width}w`).join(", "));
    }
    if (size && !image.hasAttribute("height")) {
      const width = image.getAttribute("width");
      if (width === null) {
        image.setAttribute("width", String(size[0]));
        image.setAttribute("height", String(size[1]));
      } else if (!image.style.aspectRatio) {
        image.style.aspectRatio = `${size[0]} / ${size[1]}`;
      }
    }
    const bundled = bundledImageUrls.get(image.getAttribute("src") || "");
    if (bundled) image.src = bundled;
  }
  if (!allowRemoteImages) for (const element of template.content.querySelectorAll<Element>("[srcset],[poster],[style],[background],input[src],image")) {
    if ((element.getAttribute("srcset") || "").split(",").some(remoteURL)) element.removeAttribute("srcset");
    for (const attribute of ["poster", "background", ...(element.localName === "input" ? ["src"] : []), ...(element.localName === "image" ? ["href", "xlink:href"] : [])])
      if (remoteURL(element.getAttribute(attribute) || "")) element.removeAttribute(attribute);
  }
  if (!allowRemoteImages) for (const media of template.content.querySelectorAll("video,audio,iframe,source,track")) {
    const source = [media, ...media.querySelectorAll("source,track")].map(item => normalizedURL(item.getAttribute("src") || "")).find(remoteURL);
    if (source === undefined) continue;
    const placeholder = document.createElement("span"); placeholder.className = "remote-image"; placeholder.textContent = t("（远程图片：{{source}}）", { source: source.trim() }).trim();
    media.replaceWith(placeholder);
  }
  for (const frame of template.content.querySelectorAll("iframe")) {
    if (!/^https:\/\//i.test(normalizedURL(frame.getAttribute("src") || ""))) { frame.remove(); continue; }
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation"); frame.setAttribute("referrerpolicy", "no-referrer"); frame.setAttribute("loading", "lazy");
  }
  for (const media of template.content.querySelectorAll("video,audio,source")) {
    const source = media.getAttribute("src") || ""; if (source && documentId && !remoteURL(source) && !/^(?:data:|omarkie-asset:)/i.test(normalizedURL(source))) media.setAttribute("src", `omarkie-asset://local/${encodeURIComponent(documentId)}/${encodeURIComponent(source)}`);
  }
  return template.innerHTML;
}
export function renderMarkdown(
  source: string,
  documentId?: string,
  environment: Record<string, unknown> = {},
) {
  return cleanHtml(md.render(source, { ...environment, documentId }), documentId, typeof environment.standalone === "boolean" ? environment.standalone : undefined);
}

export function speechText(source: string) {
  const content = (tokens: Token[]): string => tokens.map(token => {
    if (token.children) return content(token.children);
    if (token.type === "softbreak" || token.type === "hardbreak") return "\n";
    return ["text", "code_inline", "math_inline", "wiki_link", "wiki_embed", "emoji", "fence", "code_block"].includes(token.type) ? token.content : "";
  }).join("");
  return md.parse(source, {}).filter(token => token.type === "inline" || token.type === "fence" || token.type === "code_block").map(token => content([token])).filter(Boolean).join("\n").trim();
}
export function parseBlocks(
  source: string,
  environment: Record<string, unknown> = {},
): Block[] {
  const { lines, offsets } = sourceLines(source), span = (from: number, to: number) => source.slice(offsets[from], offsets[to - 1] + lines[to - 1].length);
  const blocks: Block[] = [];
  let covered = 0;
  if (/^(?:\uFEFF)?---[ \t]*$/.test(lines[0])) {
    const end = lines
      .slice(1)
      .findIndex((line) => /^(?:---|\.\.\.)[ \t]*$/.test(line));
    if (end >= 0) {
      covered = end + 2;
      blocks.push({
        fromLine: 1,
        toLine: covered,
        source: span(0, covered),
        kind: "frontmatter",
      });
    }
  }
  for (const token of md.parse(source, environment)) {
    if (
      !token.map ||
      token.level !== 0 ||
      token.map[0] < covered ||
      token.type.endsWith("_close")
    )
      continue;
    const [from, to] = token.map;
    covered = to;
    blocks.push({
      fromLine: from + 1,
      toLine: to,
      source: span(from, to),
      kind: token.type,
    });
  }
  return blocks;
}
export function inlineTokens(
  source: string,
  environment: Record<string, unknown> = {},
) {
  return md.parseInline(source, { ...environment, fragment: true })[0].children || [];
}
export function decodeMarkdownText(source: string) {
  return md.utils.unescapeAll(source);
}
export function highlightCode(source: string, language: string) {
  return language && hljs?.getLanguage(language)
    ? hljs.highlight(source, { language, ignoreIllegals: true }).value
    : md.utils.escapeHtml(source);
}
export function editableHtml(
  source: string,
  documentId: string,
  inline: (token: Token) => string,
  fence: (token: Token) => string,
  environment: Record<string, unknown> = {},
) {
  const renderer = Object.create(md.renderer) as typeof md.renderer;
  renderer.rules = {
    ...md.renderer.rules,
    fence: (tokens, index) => fence(tokens[index]),
  };
  const env = { ...environment, documentId, fragment: true };
  const context = source.includes("|") ? parserContext(md, source, env) : null;
  const tokens = context?.tokens || md.parse(source, env);
  if (context) Object.assign(env, context.environment);
  const html = tokens
    .map((token, index) => {
      if (token.type === "inline") return inline(token);
      if (
        token.type === "list_item_open" &&
        tokens[index + 1]?.type === "list_item_close"
      )
        return (
          renderer.renderToken(tokens, index, md.options) +
          inline(
            Object.assign(Object.create(token), {
              content: "",
              type: "inline",
            }),
          )
        );
      return renderer.rules[token.type]
        ? renderer.rules[token.type]!(tokens, index, md.options, env, renderer)
        : renderer.renderToken(tokens, index, md.options);
    })
    .join("");
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ["video", "audio", "source"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|sms|cid|xmpp|omarkie-wiki|omarkie-tag):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    ADD_URI_SAFE_ATTR: ["src", "srcset"],
    ADD_ATTR: [
      "controls",
      "contenteditable",
      "data-leaf",
      "data-task",
      "data-inline-from",
      "data-inline-to",
      "data-mark",
    ],
  });
}
// Fences and inline images a block renders, mirroring the rich renderer's branches; keyed by kind and source.
let blockCounts = new Map<string, { fences: number; images: number }>();
function countBlock(kind: string, source: string) {
  if (["empty", "frontmatter", "toc"].includes(kind) || ((kind === "fence" || /^\$\$\s*$/.test(source)) && !source.includes("\n"))) return { fences: 0, images: 0 };
  if (["html_preview", "html_block"].includes(kind) || /^\$\$/.test(source)) return { fences: 1, images: 0 };
  if (!/!\[|<|```|~~~/.test(source)) return { fences: 0, images: 0 };
  let fences = 0, images = 0;
  for (const token of md.parse(source, { fragment: true })) {
    if (token.type === "fence" && source.includes("\n")) fences++;
    for (const child of token.children || []) if (["image", "html_embed", "wiki_embed"].includes(child.type)) images++;
  }
  return { fences, images };
}
// What auto_number's CSS counters count, by block start line: top-level headings (`#write > hN`), `.md-fence` and `.md-image`.
export function numberedBlocks(nodes: { line: number; kind: string; source: string }[], headings: { line: number; level: number }[]) {
  const top = new Set(nodes.filter(node => node.kind === "heading_open").map(node => node.line));
  const items = headings.filter(heading => top.has(heading.line)).map(heading => ({ line: heading.line, counter: `content-h${heading.level}` }));
  const counts = new Map<string, { fences: number; images: number }>();
  for (const node of nodes) {
    const key = `${node.kind}\u0000${node.source}`, count = counts.get(key) || blockCounts.get(key) || countBlock(node.kind, node.source);
    counts.set(key, count);
    for (let index = 0; index < count.fences; index++) items.push({ line: node.line, counter: "fence" });
    for (let index = 0; index < count.images; index++) items.push({ line: node.line, counter: "image" });
  }
  blockCounts = counts;
  return items;
}
export function extractHeadings(source: string): Heading[] {
  const env: { headings?: Heading[] } = {};
  md.parse(source.replace(/\r\n/g, "\n"), env);
  return env.headings || [];
}
