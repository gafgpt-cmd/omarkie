import { createMarkdown, setSyntaxOptions } from "../../shared/markdown.mjs";
import { collectImages } from "../../shared/image-references.mjs";
import { parserContext } from "../../shared/parser-context.mjs";
import { sourceLines } from "../../shared/source-lines.mjs";
import { audioEmbed, baseEmbed, noteEmbed } from "../../shared/embeds.mjs";
import { markdownBlocks, plainProposal } from "../../shared/markdown-blocks.mjs";
let hljs: typeof import("highlight.js/lib/common")["default"] | undefined;
let highlighting: Promise<void> | undefined;
export function loadHighlighting() { return highlighting ??= import("highlight.js/lib/common").then(module => { hljs = module.default; }); }
import { configureDocumentRendering } from "./markdownExtensions.ts";
import type { Token } from "markdown-it";
import { t } from "../i18n.ts";
import { bundledImageUrls, normalizedURL, remoteURL, sanitizeDocumentMedia } from "./htmlResources.ts";
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
export function setMarkdownOptions(options: { highlight: boolean; subscript: boolean; superscript: boolean; emoji: boolean; inlineMath: boolean; remoteImages?: boolean }) {
  markdownOptionsVersion++;
  allowRemoteImages = options.remoteImages === true;
  setSyntaxOptions(md, options);
}
const defaultFence = md.renderer.rules.fence!;
export function diagramLanguage(token: Token) {
  const language = token.info.trim();
  return /^(mermaid|sequence|flow)$/.test(language) ? language : undefined;
}
md.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index], language = diagramLanguage(token);
  return language ? `<div class="mermaid-block" data-diagram-language="${language}">${md.utils.escapeHtml(token.content)}</div>`
    : defaultFence(tokens, index, options, env, self);
};
export function exportDiagramBlocks(source: string) {
  const { lines, offsets } = sourceLines(source);
  return md.parse(source, {}).flatMap((token, index, tokens) => {
    const language = token.type === "fence" && diagramLanguage(token);
    if (!language || !token.map) return [];
    const [start, end] = token.map, paragraph = tokens[index - 3];
    const afterParagraph = tokens[index - 1]?.type === "paragraph_close" && paragraph?.type === "paragraph_open"
      && paragraph.level === token.level && paragraph.map?.[1] === start;
    return [{ language, body: token.content, prefix: lines[start].slice(0, lines[start].indexOf(token.markup)),
      from: offsets[start], to: offsets[end] ?? source.length, afterParagraph }];
  });
}
// Natural sizes of images seen so far: later renders reserve the box and the page does not jump.
const imageSizes = new Map<string, [number, number]>();
if (typeof document !== "undefined")
  document.addEventListener("load", event => {
    // Tag check, not instanceof: DOM test environments expose document without the HTMLImageElement global.
    const image = event.target as HTMLImageElement | null;
    if (image?.tagName !== "IMG" || !image.naturalWidth || !image.currentSrc || image.currentSrc.includes("?preview=")) return;
    const size: [number, number] = [image.naturalWidth, image.naturalHeight];
    imageSizes.set(image.currentSrc, size);
    const source = image.getAttribute("src");
    if (source && image.src === image.currentSrc) imageSizes.set(source, size);
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
  if (!text.includes("!") && !text.includes("<")) return [];
  return [...new Set(markdownImageReferences(text).map(image => image.url).filter(source => {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(source)?.[1].toLowerCase();
    return !scheme || scheme.length === 1 || scheme === "file";
  }))];
}
function mediaURL(source: string, documentId?: string) {
  const classified = normalizedURL(source);
  if (remoteURL(classified) || /^(?:data|blob|omarkie|omarkie-asset):/i.test(classified)) return classified;
  return classified && documentId ? `omarkie-asset://local/${encodeURIComponent(documentId)}/${encodeURIComponent(source)}` : "";
}
// One <img> for Markdown images and Obsidian embeds. Explicit sizes ({width=300}, |300x200) win;
// a lone width keeps the natural aspect ratio when the natural size is known.
function imageHtml(source: string, alt: string, documentId: string | undefined, alone: boolean, width?: string, height?: string, float?: string | number | null) {
  const classified = normalizedURL(source);
  if (remoteURL(source) && !allowRemoteImages)
    return `<span class="remote-image">${alt}${t("（远程图片：{{source}}）", { source: md.utils.escapeHtml(source) })}</span>`;
  const url = /^data:/i.test(classified) && !/^data:image\/(?:png|jpeg|gif|webp);/i.test(classified) ? "" : mediaURL(source, documentId);
  if (!url) return `<span class="remote-image">${alt}（${md.utils.escapeHtml(source)}）</span>`;
  const natural = imageSizes.get(url), size = width && !width.endsWith("%") && !height && natural ? [width, String(Math.round(Number(width) * natural[1] / natural[0]))] : width || height ? [width, height] : natural?.map(String);
  const position = float === "left" || float === "right" ? ` data-image-float="${float}"` : "";
  return `<img src="${md.utils.escapeHtml(url)}" alt="${alt}" loading="lazy" decoding="async"${size?.[0] ? ` width="${md.utils.escapeHtml(size[0])}"` : ""}${size?.[1] ? ` height="${md.utils.escapeHtml(size[1])}"` : ""}${position}${alone && !position ? ` class="md-standalone${width || height ? "" : " md-fit-image"}"` : ""} />`;
}
// An image alone on its line is laid out as a centred figure.
// The rich editor renders each image on its own and says whether it fills its line.
const standalone = (tokens: Token[], index: number, env: Record<string, unknown> | undefined) =>
  typeof env?.standalone === "boolean" ? env.standalone : tokens.every((other, at) => at === index || other.type === "softbreak" || (other.type === "text" && !other.content.trim()));
md.renderer.rules.image = (tokens, index, _options, env) => {
  const token = tokens[index];
  return imageHtml(String(token.attrGet("src") || ""), md.utils.escapeHtml(token.content || t("图片")), typeof env?.documentId === "string" ? env.documentId : undefined, standalone(tokens, index, env), String(token.attrGet("width") ?? "") || undefined, String(token.attrGet("height") ?? "") || undefined, token.attrGet("data-image-float"));
};
// The asset URL an Obsidian embed target resolves to; Fold's lecture player plays the same file.
export function embedURL(target: string, documentId: string) {
  return `omarkie-asset://local/${encodeURIComponent(documentId)}/${encodeURIComponent(md.normalizeLink(target.replaceAll("%", "%25")))}`;
}
// Obsidian embeds resolve like Obsidian: next to the note first, then anywhere in the vault (host side).
md.renderer.rules.wiki_embed = (tokens, index, _options, env) => {
  const token = tokens[index], meta = (token.meta || {}) as { target?: string; width?: string; height?: string }, target = (meta.target || "").split("#")[0], documentId = typeof env?.documentId === "string" ? env.documentId : undefined;
  const name = md.utils.escapeHtml(token.content || target), source = md.normalizeLink(target.replaceAll("%", "%25"));
  if (/\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(target)) return imageHtml(source, name, documentId, standalone(tokens, index, env), meta.width, meta.height, token.attrGet("data-image-float"));
  const media = audioEmbed(target) ? "audio" : /\.(?:mp4|webm)$/i.test(target) ? "video" : "";
  return media && documentId
    ? `<${media} controls preload="metadata" src="${embedURL(target, documentId)}"${meta.width ? ` width="${md.utils.escapeHtml(meta.width)}"` : ""}></${media}>`
    : noteEmbed(meta.target || "") || baseEmbed(meta.target || "") ? `<span class="note-embed" data-embed="${md.utils.escapeHtml(meta.target || "")}">${name}</span>` : `<span class="wiki-embed">${name}</span>`;
};
function imageCandidates(value: string, documentId?: string) {
  const tokens = /[\t\n\f\r ,]*([^\t\n\f\r ]+)(?:(?<=,)|([\t\n\f\r ]+(?:\([^)]*\)|[^,(])*)(?:,|$)|$)/gy;
  const candidates: string[] = [];
  for (const [, raw, suffix] of value.matchAll(tokens)) {
    const source = raw.replace(/,+$/, ""), descriptor = suffix?.trim() || "";
    if (!source || (descriptor && !/^(?:\d+[wh]|(?:\d+(?:\.\d+)?|\.\d+)x)(?:[\t\n\f\r ]+\d+h)?$/.test(descriptor))) continue;
    if (!allowRemoteImages && remoteURL(source)) continue;
    const url = mediaURL(source, documentId) || source;
    candidates.push(descriptor ? `${url} ${descriptor}` : url);
  }
  return candidates.join(", ");
}
function cleanHtml(html: string, documentId?: string, standalone?: boolean) {
  const safe = sanitizeDocumentMedia(html, { FORBID_TAGS: allowRemoteImages ? [] : ["style"], ADD_TAGS: ["video", "audio", "source", "iframe"], ADD_ATTR: ["controls", "poster", "allowfullscreen", "sandbox"], ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|sms|cid|xmpp|omarkie-wiki|omarkie-tag):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i });
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
  for (const element of template.content.querySelectorAll("img[srcset],source[srcset]")) {
    const candidates = imageCandidates(element.getAttribute("srcset") || "", documentId);
    if (candidates) element.setAttribute("srcset", candidates);
    else element.removeAttribute("srcset");
  }
  for (const image of template.content.querySelectorAll("img")) {
    const source = image.getAttribute("src") || "";
    if (remoteURL(source) && !allowRemoteImages) {
      if (!image.hasAttribute("srcset") && !image.parentElement?.matches("picture:has(source[srcset])")) {
        image.replaceWith(document.createTextNode(image.alt || t("远程图片"))); continue;
      }
      image.removeAttribute("src");
      continue;
    }
    const url = mediaURL(source, documentId);
    if (url && url !== source) image.setAttribute("src", url);
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
    for (const attribute of ["poster", "background", ...(element.localName === "input" ? ["src"] : []), ...(element.localName === "image" ? ["href", "xlink:href"] : [])])
      if (remoteURL(element.getAttribute(attribute) || "")) element.removeAttribute(attribute);
  }
  if (!allowRemoteImages) for (const media of template.content.querySelectorAll("video,audio,iframe,source[src],track[src]")) {
    if (!template.content.contains(media)) continue;
    const items = [media, ...media.querySelectorAll("source[src],track[src]")];
    const remote = items.filter(item => remoteURL(item.getAttribute("src") || ""));
    if (!remote.length) continue;
    if (media.hasAttribute("poster") || items.some(item => !remote.includes(item) && item.hasAttribute("src"))) {
      for (const item of remote) if (item === media) item.removeAttribute("src"); else item.remove();
    } else {
      const source = normalizedURL(remote[0].getAttribute("src") || "");
      const placeholder = document.createElement("span"); placeholder.className = "remote-image"; placeholder.textContent = t("（远程图片：{{source}}）", { source }).trim();
      if (media.matches("source,track")) media.remove(); else media.replaceWith(placeholder);
    }
  }
  for (const video of template.content.querySelectorAll("video[poster]")) {
    const url = mediaURL(video.getAttribute("poster") || "", documentId);
    if (url) video.setAttribute("poster", url);
  }
  for (const frame of template.content.querySelectorAll("iframe")) {
    if (!/^https:\/\//i.test(normalizedURL(frame.getAttribute("src") || ""))) { frame.remove(); continue; }
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation"); frame.setAttribute("referrerpolicy", "no-referrer"); frame.setAttribute("loading", "lazy");
  }
  for (const media of template.content.querySelectorAll("video,audio,source")) {
    const source = media.getAttribute("src") || "";
    const url = mediaURL(source, documentId);
    if (url && url !== source) media.setAttribute("src", url);
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
/** renderMarkdown for many small sources with one sanitizer pass; a source with unbalanced HTML sends the batch one by one. */
export function renderMarkdownEach(sources: readonly string[], documentId?: string) {
  const template = document.createElement("template");
  template.innerHTML = cleanHtml(sources.map(source => `<div>${md.render(source, { documentId })}</div>`).join(""), documentId);
  const parts = [...template.content.children];
  return parts.length === sources.length && parts.every(part => part.localName === "div")
    ? parts.map(part => part.innerHTML)
    : sources.map(source => renderMarkdown(source, documentId));
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
  return markdownBlocks(md, source, environment);
}
export function safeProposal(text: string) { return plainProposal(md, text); }
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
  return sanitizeDocumentMedia(html, {
    ADD_TAGS: ["video", "audio", "source"],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|sms|cid|xmpp|omarkie-wiki|omarkie-tag):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    ADD_URI_SAFE_ATTR: ["srcset"],
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
