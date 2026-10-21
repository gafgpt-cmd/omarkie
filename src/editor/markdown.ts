import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { configureMath } from "./mathMarkdown.ts";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import mark from "markdown-it-mark";
import sub from "markdown-it-sub";
import sup from "markdown-it-sup";
import { full as emoji } from "markdown-it-emoji";
import { configureDocumentSyntax } from "./markdownExtensions.ts";
import type { Token } from "markdown-it";
import { t } from "../i18n.ts";
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
const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
  highlight(code, language): string {
    return language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : md.utils.escapeHtml(code);
  },
})
  .use(taskLists, { enabled: false })
  .use(configureMath)
  .use(mark).use(sub).use(sup).use(emoji, { shortcuts: {} })
  .use(configureDocumentSyntax).disable("html_inline");
// Bumped on every option change so cached block renders are invalidated.
export let markdownOptionsVersion = 0;
export function setMarkdownOptions(options: { highlight: boolean; subscript: boolean; superscript: boolean; emoji: boolean; inlineMath: boolean }) {
  markdownOptionsVersion++;
  allowRemoteImages = (options as { remoteImages?: boolean }).remoteImages === true;
  for (const [rule, enabled] of [["mark", options.highlight], ["sub", options.subscript], ["sup", options.superscript], ["emoji", options.emoji], ["math_inline", options.inlineMath]] as const)
    enabled ? md.enable(rule, true) : md.disable(rule, true);
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
    const image = event.target;
    if (image instanceof HTMLImageElement && image.naturalWidth) imageSizes.set(image.getAttribute("src") || "", [image.naturalWidth, image.naturalHeight]);
  }, true);
// Sizes announced by the host before a document's first render, keyed like the image rule keys
// them: by the raw source and by its Markdown-normalized form.
export function rememberImageSizes(documentId: string, sizes: Record<string, [number, number]>) {
  for (const [source, size] of Object.entries(sizes)) {
    if (!Array.isArray(size) || !(size[0] > 0) || !(size[1] > 0)) continue;
    for (const key of new Set([source, md.normalizeLink(source)]))
      imageSizes.set(`omarkie-asset://local/${encodeURIComponent(documentId)}/${encodeURIComponent(key)}`, [size[0], size[1]]);
  }
}
// Local image sources a document references (Markdown images and <img> tags); a light scan for
// the size prefetch, so a source inside a code fence costs the host one failed lookup at most.
export function localImageSources(text: string) {
  const sources = new Set<string>();
  for (const match of text.matchAll(/!\[(?:\\.|[^\]\\])*\]\((<[^>\n]*>|(?:\\.|[^\s)\\])*)|<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)) {
    const raw = match[1] !== undefined ? match[1].replace(/^<|>$/g, "").replace(/\\([()])/g, "$1") : match[2];
    const source = raw.trim(), scheme = /^([a-z][a-z0-9+.-]*):/i.exec(source)?.[1].toLowerCase();
    if (source && (!scheme || scheme.length === 1 || scheme === "file")) sources.add(source);
  }
  return [...sources];
}
md.renderer.rules.image = (tokens, index, _options, env) => {
  const token = tokens[index],
    source = String(token.attrGet("src") || ""),
    alt = md.utils.escapeHtml(token.content || t("图片"));
  const documentId =
    typeof env?.documentId === "string" ? env.documentId : undefined;
  if (/^https?:\/\//i.test(source) && !allowRemoteImages)
    return `<span class="remote-image">${alt}${t("（远程图片：{{source}}）", { source: md.utils.escapeHtml(source) })}</span>`;
  const url = /^(?:https?:\/\/|data:image\/(?:png|jpeg|gif|webp);)/i.test(source)
    ? source
    : documentId
      ? `omarkie-asset://local/${encodeURIComponent(documentId)}/${encodeURIComponent(source)}`
      : "";
  const size = imageSizes.get(url);
  // An image alone on its line is laid out as a centred figure.
  // The rich editor renders each image on its own and says whether it fills its line.
  const alone = typeof env?.standalone === "boolean" ? env.standalone : tokens.every((other, at) => at === index || other.type === "softbreak" || (other.type === "text" && !other.content.trim()));
  return url
    ? `<img src="${url}" alt="${alt}" loading="lazy" decoding="async"${size ? ` width="${size[0]}" height="${size[1]}"` : ""}${alone ? ' class="md-standalone"' : ""} />`
    : `<span class="remote-image">${alt}（${md.utils.escapeHtml(source)}）</span>`;
};
function cleanHtml(html: string, documentId?: string) {
  const safe = DOMPurify.sanitize(html, { ADD_URI_SAFE_ATTR: ["src"], ADD_TAGS: ["video", "audio", "source", "iframe"], ADD_ATTR: ["controls", "poster", "allowfullscreen", "sandbox"] });
  const template = document.createElement("template"); template.innerHTML = safe;
  for (const image of template.content.querySelectorAll("img")) {
    const source = image.getAttribute("src") || "";
    if (/^https?:\/\//i.test(source) && !allowRemoteImages) { image.replaceWith(document.createTextNode(image.alt || t("远程图片"))); continue; }
    if (documentId && source && !/^(?:https?:|data:|omarkie-asset:)/i.test(source)) image.src = `omarkie-asset://local/${encodeURIComponent(documentId)}/${encodeURIComponent(source)}`;
    for (const attribute of ["width", "height"]) if (image.hasAttribute(attribute) && !/^\d+(?:\.\d+)?%?$/.test(image.getAttribute(attribute)!)) image.removeAttribute(attribute);
    const size = imageSizes.get(image.getAttribute("src") || "");
    if (size && !image.hasAttribute("width") && !image.hasAttribute("height")) { image.setAttribute("width", String(size[0])); image.setAttribute("height", String(size[1])); }
  }
  if (!allowRemoteImages) for (const element of template.content.querySelectorAll<Element>("[srcset],[poster],[style],[background],input[src],image")) {
    if (/https?:/i.test(element.getAttribute("srcset") || "")) element.removeAttribute("srcset");
    for (const attribute of ["poster", "background", ...(element.localName === "input" ? ["src"] : []), ...(element.localName === "image" ? ["href", "xlink:href"] : [])])
      if (/^\s*https?:/i.test(element.getAttribute(attribute) || "")) element.removeAttribute(attribute);
    if (/url\s*\(/i.test(element.getAttribute("style") || "")) element.removeAttribute("style");
  }
  if (!allowRemoteImages) for (const media of template.content.querySelectorAll("video,audio,iframe,source,track")) {
    const source = [media, ...media.querySelectorAll("source,track")].map(item => item.getAttribute("src") || "").find(item => /^\s*https?:/i.test(item));
    if (source === undefined) continue;
    const placeholder = document.createElement("span"); placeholder.className = "remote-image"; placeholder.textContent = t("（远程图片：{{source}}）", { source: source.trim() }).trim();
    media.replaceWith(placeholder);
  }
  for (const frame of template.content.querySelectorAll("iframe")) {
    if (!/^https:\/\//i.test(frame.getAttribute("src") || "")) { frame.remove(); continue; }
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation"); frame.setAttribute("referrerpolicy", "no-referrer"); frame.setAttribute("loading", "lazy");
  }
  for (const media of template.content.querySelectorAll("video,audio,source")) {
    const source = media.getAttribute("src"); if (source && documentId && !/^(?:https?:|data:|omarkie-asset:)/i.test(source)) media.setAttribute("src", `omarkie-asset://local/${encodeURIComponent(documentId)}/${encodeURIComponent(source)}`);
  }
  return template.innerHTML;
}
export function renderMarkdown(
  source: string,
  documentId?: string,
  environment: Record<string, unknown> = {},
) {
  return cleanHtml(md.render(source, { ...environment, documentId }), documentId);
}
export function parseBlocks(
  source: string,
  environment: Record<string, unknown> = {},
): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let covered = 0;
  if (lines[0] === "---") {
    const end = lines
      .slice(1)
      .findIndex((line) => line === "---" || line === "...");
    if (end >= 0) {
      covered = end + 2;
      blocks.push({
        fromLine: 1,
        toLine: covered,
        source: lines.slice(0, covered).join("\n"),
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
      source: lines.slice(from, to).join("\n"),
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
  return language && hljs.getLanguage(language)
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
  const env = { ...environment, documentId, fragment: true },
    tokens = md.parse(source, env);
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
    ADD_URI_SAFE_ATTR: ["src"],
    ADD_ATTR: [
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
    for (const child of token.children || []) if (child.type === "image" || child.type === "html_embed") images++;
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
