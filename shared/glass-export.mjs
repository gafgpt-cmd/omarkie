// G18: Markdown-native export. Pure functions; electron/glass-export.mjs writes the files,
// tests/glass-export.test.mjs proves every mapping. GitHub alerts, block footnotes, relative
// image paths only: no HTML layout, no wikilinks, no inline footnotes (they break portable bundles).
import { markdownElements } from "./element-model.mjs";
import { extractSection, parseCardLink } from "./glass-cards.mjs";
import { inkSvg, insertBlock, mergeAnchorOf, noteLineEnding, resolveMergeElement } from "./glass-merge.mjs";
import { stickerName, stickerSvg } from "./glass-art.mjs";
import { arrowConnections, kindOf, magnetLabel, readingOrder, sourceQuote } from "./glass-labels.mjs";
export { magnetLabel, readingOrder, sourceQuote } from "./glass-labels.mjs";

export const glassExportModes = ["page", "flat", "handout", "cheatsheet", "bundle"];
export const glassExportTargets = ["github", "obsidian"];
const slug = value => String(value ?? "magnet").replace(/^m-/, "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "magnet";

// Callouts are the only GitHub-safe block primitive: five types, never nested, one short paragraph.
const calloutType = kind => kind === "comment" ? "TIP" : kind === "card" ? "IMPORTANT" : "NOTE";

export function escapeText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/([\\[\]|<>`])/g, "\\$1")
    .split("\n")
    .map(line => line.replace(/^(\s*)(#{1,6}\s|[-+*]\s|\d+\.\s|>\s)/, (_, indent, marker) => `${indent}\\${marker}`))
    .join("\n");
}

function bodyLines(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").split("\n").map(line => line.trimEnd());
}

export function calloutLines(type, bodyLines, title = "") {
  const lines = [`> [!${type}]${title ? ` **${title}**` : ""}`];
  for (const line of bodyLines) lines.push(line ? `> ${escapeText(line)}` : ">");
  return lines;
}

function headingAnchor(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/\s+/g, "-");
}

function connectionsLines(connections, footnotes) {
  if (!connections.length) return [];
  const lines = ["## Connections", ""];
  for (const edge of connections) {
    const note = edge.label ? footnotes.add(edge.label) : "";
    lines.push(`- **${escapeText(edge.from)}** → **${escapeText(edge.to)}**${note ? `: ${escapeText(edge.label)}${note}` : ""}`);
  }
  return lines;
}

function footnotes(prefix = "", start = 1) {
  const entries = [];
  let counter = start - 1;
  return {
    add(text) {
      counter += 1;
      entries.push({ id: `${prefix}${counter}`, text: String(text ?? "").replace(/\r\n?/g, "\n") });
      return `[^${prefix}${counter}]`;
    },
    get size() { return entries.length; },
    lines() {
      if (!entries.length) return [];
      const rows = [""];
      for (const entry of entries) {
        const parts = entry.text.split("\n");
        rows.push(`[^${entry.id}]: ${escapeText(parts[0])}`);
        for (const line of parts.slice(1)) rows.push(`  ${escapeText(line)}`);
      }
      return rows;
    },
  };
}

function imageAsset(magnet, assets) {
  const source = assets?.images?.(magnet.id);
  return source?.name ? source : null;
}

// One magnet becomes Markdown lines, plus any file the export must write beside the page.
function magnetMarkdown(magnet, { noteName, noteText, assets, target = "github" }) {
  const kind = kindOf(magnet), fields = magnet.fields ?? {}, files = [];
  if (kind === "sticky") {
    const text = bodyLines(fields.text).filter(line => line.trim());
    if (!text.length) return { lines: [], files };
    return { lines: calloutLines(calloutType(kind), text), files };
  }
  if (kind === "comment") {
    const thread = Array.isArray(fields.thread) ? fields.thread.filter(entry => entry && typeof entry.text === "string" && entry.text.trim()) : [];
    const body = thread.length
      ? thread.flatMap(entry => [`**${entry.role === "agent" ? "A" : "Q"}:** ${escapeText(entry.text)}`, ""])
      : bodyLines(fields.text).filter(line => line.trim());
    if (!body.length) return { lines: [], files };
    return { lines: calloutLines(calloutType(kind), body), files };
  }
  if (kind === "card") {
    const section = String(fields.section ?? "").trim() || (() => {
      const link = parseCardLink(String(fields.link ?? ""));
      return link?.section ?? "";
    })();
    const embed = (fields.mode ?? (section ? "embed" : "plain")) === "embed";
    if (embed && section) {
      const extracted = extractSection(noteText, section);
      const quote = extracted.markdown ? bodyLines(extracted.markdown).filter(line => line.trim()).slice(0, 6) : [];
      const target = String(fields.link ?? noteName).split("#")[0] || noteName;
      const lines = calloutLines("IMPORTANT", quote, String(fields.title ?? "").trim() || section);
      // A note name can hold spaces or parentheses; only an angle-bracket destination survives both.
      lines.push("", `[Read the section](<${encodeURI(target).replaceAll(">", "%3E")}#${headingAnchor(section)}>)`);
      return { lines, files };
    }
    const title = String(fields.title ?? "").trim();
    const body = bodyLines(fields.body ?? fields.text).filter(line => line.trim());
    const answer = bodyLines(fields.answer).filter(line => line.trim());
    const question = String(fields.question ?? "").trim();
    const choices = Array.isArray(fields.choices) ? fields.choices : [];
    const inner = [];
    if (body.length) inner.push(...body);
    else if (question) { inner.push(`**${escapeText(question)}**`); if (answer.length) inner.push("", ...answer); }
    else if (answer.length) inner.push(...answer);
    else if (choices.length) inner.push(...choices.map(choice => `- ${escapeText(choice.label)}${choice.body ? ` — ${escapeText(choice.body)}` : ""}`));
    if (!inner.length) return { lines: [], files };
    return { lines: calloutLines(calloutType(kind), inner, title), files };
  }
  if (kind === "image") {
    const asset = imageAsset(magnet, assets);
    if (!asset) return { lines: [], files };
    files.push({ name: asset.name, path: `${assets.folder}/${asset.name}`, magnetId: magnet.id, kind: "image", from: asset.from, bytes: asset.bytes });
    const alt = magnetLabel(kind, fields).replaceAll("[", "\\[").replaceAll("]", "\\]");
    // GitHub Markdown has no image width. Obsidian's pipe width keeps the magnet size.
    const width = target === "obsidian" ? `|${Math.round(Math.min(Math.max(Number(fields.w) || 320, 80), 960))}` : "";
    return { lines: [`![${alt}${width}](<${assets.folder}/${asset.name}>)`], files };
  }
  if (kind === "ink") {
    let svg;
    try { svg = inkSvg(fields); } catch { return { lines: [], files }; }
    const name = `ink-${slug(magnet.id)}.svg`;
    files.push({ name, path: `${assets.folder}/${name}`, magnetId: magnet.id, kind: "svg", bytes: Buffer.from(svg, "utf8") });
    return { lines: [`![Ink](<${assets.folder}/${name}>)`], files };
  }
  if (kind === "sticker") {
    const custom = typeof fields.image === "string" && fields.image.startsWith("data:image/");
    if (custom) {
      const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+=*)$/.exec(fields.image);
      if (!match) return { lines: [], files };
      const extension = match[1] === "jpeg" ? "jpg" : match[1];
      const name = `sticker-${slug(magnet.id)}.${extension}`;
      files.push({ name, path: `${assets.folder}/${name}`, magnetId: magnet.id, kind: "image", bytes: Buffer.from(match[2], "base64") });
      return { lines: [`![Sticker](<${assets.folder}/${name}>)`], files };
    }
    const id = typeof fields.sticker === "string" ? fields.sticker : "";
    if (!id) return { lines: [], files };
    const name = `sticker-${slug(magnet.id)}.svg`;
    files.push({ name, path: `${assets.folder}/${name}`, magnetId: magnet.id, kind: "svg", bytes: Buffer.from(stickerSvg(id, { size: 72 }), "utf8") });
    return { lines: [`![${escapeText(stickerName(id))}](<${assets.folder}/${name}>)`], files };
  }
  if (kind === "arrow") {
    // Markdown has no connector: the arrow lives in the Connections list, its label as a footnote.
    return { lines: [], files };
  }
  return { lines: [], files };
}

function appendFootnotes(text, rows, eol) {
  if (!rows.length) return text;
  return `${text.replace(/\s+$/, "")}${eol}${eol}${rows.join(eol)}${eol}`;
}

// Flatten: the page with glass baked in at reading order, or the glass alone as a handout.
export function buildMarkdownExport({ noteName, noteText, magnets, mode = "flat", order = [], target = "github", assets = { folder: "assets" } }) {
  if (!glassExportModes.includes(mode)) throw new Error("Unknown Glass export mode.");
  if (!glassExportTargets.includes(target)) throw new Error("Unknown Glass export target.");
  const eol = noteLineEnding(noteText);
  const visible = (Array.isArray(magnets) ? magnets : []).filter(magnet => magnet && !magnet.deleted);
  const byId = new Map(visible.map(magnet => [magnet.id, magnet]));
  const ordered = order.length ? order.flatMap(id => byId.get(id) ?? []) : readingOrder(visible);
  if (mode === "page") return { markdown: noteText, files: [], mode, target };
  if (mode === "bundle") {
    const files = [...ordered].flatMap(magnet => magnetMarkdown(magnet, { noteName, noteText, assets, target }).files);
    return { markdown: noteText, files, mode, target };
  }
  // Flat output shares the page's footnote namespace, so start after any label the note already defines.
  const labels = new Set([...String(noteText ?? "").matchAll(/\[\^([^\]\s]+)\]/g)].map(match => match[1]));
  const numbered = mode === "flat" ? [...labels].filter(label => /^\d+$/.test(label)).map(Number) : [];
  const foot = footnotes("", numbered.length ? Math.max(...numbered) + 1 : 1);
  // An arrow never names a magnet the export left out (cheatsheet selection, caller order).
  const included = new Set(ordered.map(magnet => magnet.id));
  const connections = arrowConnections(visible).filter(edge => included.has(edge.magnet.id)
    && [edge.magnet.fields?.from, edge.magnet.fields?.to].every(end => end?.kind !== "magnet" || included.has(end.magnet)));
  const parts = ordered.map(magnet => ({ magnet, ...magnetMarkdown(magnet, { noteName, noteText, assets, target }) }));
  const files = parts.flatMap(part => part.files);
  if (mode === "handout") {
    const lines = [`# ${String(noteName).replace(/\.(?:md|markdown|mdown)$/i, "")} — Glass handout`, "",
      `> Page text is left out. [Open the note](<${encodeURI(noteName).replaceAll(">", "%3E")}>).`, ""];
    let index = 0;
    for (const part of parts) {
      if (!part.lines.length) continue;
      index += 1;
      const kind = kindOf(part.magnet), fields = part.magnet.fields ?? {};
      const source = sourceQuote(fields);
      const ref = foot.add(`${noteName}${source.line ? `:${source.line}` : ""}${source.quote ? ` — "${source.quote}"` : ""}`);
      lines.push(`## ${index}. ${magnetLabel(kind, fields)}${ref}`, "", ...part.lines, "");
    }
    lines.push(...connectionsLines(connections, foot));
    return { markdown: appendFootnotes(lines.join("\n"), foot.lines(), eol), files, mode, target };
  }
  if (mode === "cheatsheet") {
    if (!ordered.length) throw new Error("No magnets to export.");
    const lines = [`# ${String(noteName).replace(/\.(?:md|markdown|mdown)$/i, "")} — Cheatsheet`, ""];
    let index = 0;
    for (const part of parts) {
      if (!part.lines.length) continue;
      index += 1;
      const kind = kindOf(part.magnet), fields = part.magnet.fields ?? {};
      const source = sourceQuote(fields);
      const ref = foot.add(`${noteName}${source.line ? `:${source.line}` : ""}${source.quote ? ` — "${source.quote}"` : ""}`);
      lines.push(`## ${index}. ${magnetLabel(kind, fields)}${ref}`, "", ...part.lines, "");
    }
    lines.push(...connectionsLines(connections, foot));
    return { markdown: appendFootnotes(lines.join("\n"), foot.lines(), eol), files, mode, target };
  }
  // flat: insert each block after the paragraph it is anchored to, bottom-up, so offsets stay valid.
  const elements = markdownElements(noteText);
  const placed = [];
  const unplaced = [];
  for (const [index, part] of parts.entries()) {
    if (!part.lines.length) continue;
    const anchor = mergeAnchorOf(part.magnet.fields ?? {});
    const resolved = anchor ? resolveMergeElement(elements, anchor) : null;
    if (resolved) placed.push({ ...part, at: resolved.element.to, index });
    else unplaced.push(part);
  }
  let text = noteText;
  // Bottom-up keeps offsets valid; at one paragraph later inserts land above earlier ones, so the
  // reading order goes in reverse for a shared anchor.
  for (const part of placed.sort((left, right) => right.at - left.at || right.index - left.index)) {
    text = insertBlock(text, part.at, part.lines, eol);
  }
  if (unplaced.length) {
    const extra = ["## Glass notes", ""];
    for (const part of unplaced) extra.push(...part.lines, "");
    text = insertBlock(text, text.length, extra, eol);
  }
  const connectionsBlock = connectionsLines(connections, foot);
  if (connectionsBlock.length) text = insertBlock(text, text.length, connectionsBlock, eol);
  return { markdown: appendFootnotes(text, foot.lines(), eol), files, mode, target };
}
