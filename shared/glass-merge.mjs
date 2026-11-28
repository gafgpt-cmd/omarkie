// Merge down and lift up: the only path from glass back into the Markdown page.
// Pure functions only; electron/glass-service.mjs owns the disk, the CLI and the tests share these.
import { normalizeText, textHash } from "./anchor-core.mjs";
import { parseCardLink } from "./glass-cards.mjs";
import { inkPath } from "./ink-core.mjs";

export const mergeableKinds = ["sticky", "image", "ink", "card"];

// A card merges as the section it links to, or as the Markdown it holds.
function cardMergeTarget(fields = {}) {
  const explicit = String(fields.section ?? "").trim();
  if (explicit) return explicit;
  const link = parseCardLink(String(fields.link ?? ""));
  if (!link?.section) return "";
  return link.target ? `${link.target}#${link.section}` : `#${link.section}`;
}

export function mergeKindLabel(kind, fields = {}) {
  if (kind === "sticky") return "Sticky note → callout";
  if (kind === "image") return "Picture → Markdown image";
  if (kind === "ink") return "Ink → SVG picture";
  if (kind === "card") {
    if (fields.card === "calc" || fields.card === "flow") return "Live card → stays on the glass";
    if (fields.card === "fold") return "Fold line → stays on the glass";
    return (fields.mode ?? (cardMergeTarget(fields) ? "embed" : "plain")) === "embed" ? "Card → section embed" : "Card → plain Markdown";
  }
  return `${kind} → Markdown`;
}

const posixJoin = (left, right) => [left, right].map(part => String(part ?? "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
const normalizeFolder = value => String(value ?? "").replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");

// `.obsidian/app.json` decides where attachments go and whether links are `![[...]]` or `![](..)`.
// A folder without `.obsidian` is not an Obsidian vault: plain Markdown links, pictures beside the note.
export function noteMergeSettings({ appJson = null, notePath = "" } = {}) {
  const noteDir = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
  const value = typeof appJson?.attachmentFolderPath === "string" ? appJson.attachmentFolderPath.trim() : "";
  let attachmentFolder = "";
  if (value && value !== "/") {
    const raw = value.replaceAll("\\", "/");
    if (raw === "." || raw === "./") attachmentFolder = noteDir;
    else if (raw.startsWith("./")) attachmentFolder = posixJoin(noteDir, raw.slice(2));
    else attachmentFolder = normalizeFolder(raw);
  }
  const obsidian = appJson !== null && appJson !== undefined;
  // A plain folder is not an Obsidian vault: pictures go beside the note, as the merge comment says.
  if (!obsidian) attachmentFolder = noteDir;
  return { attachmentFolder, noteDir, linkStyle: obsidian && appJson.useMarkdownLinks !== true ? "wikilink" : "markdown" };
}

// Markdown resolves a relative link from the note's own folder; Obsidian resolves `![[…]]` from the
// vault root. Write the link the reader's Markdown engine will resolve back to the stored file.
export function linkFor(settings, vaultPath) {
  if (settings.linkStyle === "wikilink") return vaultPath;
  const from = normalizeFolder(settings.noteDir), to = normalizeFolder(vaultPath);
  const fromParts = from ? from.split("/") : [], toParts = to ? to.split("/") : [];
  let shared = 0;
  while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) shared += 1;
  const up = fromParts.slice(shared).map(() => "..");
  const down = toParts.slice(shared);
  return [...up, ...down].join("/") || toParts.at(-1) || "";
}

function safeTitle(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "image";
}

function markdownPath(value) {
  const text = String(value).replaceAll("\\", "/");
  return /[\s()<>]/u.test(text) ? `<${text.replaceAll("<", "%3C").replaceAll(">", "%3E")}>` : text;
}

export function imageLink({ path: assetPath, name, width, linkStyle }) {
  const w = Math.round(Math.min(4000, Math.max(48, Number.isFinite(width) ? width : 320)));
  if (linkStyle === "wikilink") return `![[${assetPath}|${w}]]`;
  return `![${safeTitle(name).replaceAll("[", "\\[").replaceAll("]", "\\]")}](${markdownPath(assetPath)}){width=${w}}`;
}

function calloutLines(text) {
  const body = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  return ["> [!note]", ...body.map(line => line.trim() ? `> ${line}` : ">")];
}

// The exact Markdown lines a magnet becomes.
export function mergeLines(kind, fields, { settings, assetPath, assetName } = {}) {
  if (kind === "sticky") {
    if (!String(fields.text ?? "").trim()) throw new Error("Write something on the sticky note before merging it down.");
    return { label: mergeKindLabel(kind), lines: calloutLines(fields.text), style: "callout" };
  }
  if (kind === "image") {
    if (!assetPath) throw new Error("The picture has no stored copy to merge down.");
    return { label: mergeKindLabel(kind), style: settings.linkStyle,
      lines: [imageLink({ path: assetPath, name: assetName || fields.name || "image", width: Number(fields.w), linkStyle: settings.linkStyle })] };
  }
  if (kind === "ink") {
    if (!assetPath) throw new Error("The ink has no SVG asset to merge down.");
    return { label: mergeKindLabel(kind), style: settings.linkStyle,
      lines: [imageLink({ path: assetPath, name: assetName || "Ink", width: 640, linkStyle: settings.linkStyle })] };
  }
  if (kind === "card") {
    if (fields.card === "calc" || fields.card === "flow")
      throw new Error("A live card stays on the glass: its formula and citation are not copied into the note, and its result is never written.");
    if (fields.card === "fold") throw new Error("A fold line stays on the glass: its evidence is already in this note.");
    const target = cardMergeTarget(fields);
    const mode = fields.mode ?? (target ? "embed" : "plain");
    if (mode === "embed") {
      const section = String(fields.section ?? target).trim();
      if (!section) throw new Error("A card needs a section (for example `Note#Heading`) before it can be embedded.");
      return { label: mergeKindLabel(kind, fields), style: "embed",
        lines: [section.startsWith("![[") ? section : `![[${section.replace(/^\[\[|\]\]$/g, "")}]]`] };
    }
    const title = String(fields.title ?? "").trim();
    const question = String(fields.question ?? "").trim();
    const answer = String(fields.answer ?? "").trim();
    const choices = Array.isArray(fields.choices) ? fields.choices : [];
    const body = String(fields.body ?? fields.text ?? "").replace(/\r\n?/g, "\n").trim();
    const lines = [];
    if (title) lines.push(`## ${title}`, "");
    if (body) lines.push(...body.split("\n"));
    else if (question) { lines.push(`**${question}**`, ""); if (answer) lines.push(...answer.replace(/\r\n?/g, "\n").split("\n")); }
    else if (answer) lines.push(...answer.replace(/\r\n?/g, "\n").split("\n"));
    else if (choices.length) lines.push(...choices.map(choice => `- ${choice.label}${choice.body ? ` — ${choice.body}` : ""}`));
    if (!body && !question && !answer && !choices.length) throw new Error("A plain card needs its Markdown body.");
    return { label: mergeKindLabel(kind, fields), style: "plain", lines };
  }
  throw new Error("Only sticky notes, pictures, ink and cards can merge down.");
}

// SVG asset for one ink magnet. Points are fractions of their element box; each part is
// laid on a 1000-unit canvas so a merged sketch keeps its shape when the page reflows.
export function inkSvg(fields) {
  const parts = Array.isArray(fields?.parts) ? fields.parts : [];
  if (!parts.length) throw new Error("The ink stroke has no points.");
  const tool = fields.tool === "highlighter" ? "highlighter" : "pen";
  const size = Number.isFinite(fields.size) ? fields.size : 4;
  const scale = 1000;
  const paths = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const part of parts) {
    const points = Array.isArray(part?.points) ? part.points : [];
    if (!points.length) continue;
    const scaled = points.map(([x, y, pressure]) => [x * scale, y * scale, pressure ?? 0.5]);
    for (const [x, y] of scaled) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const d = inkPath(scaled, { tool, size: Math.max(1, size * (scale / 640)) });
    if (d) paths.push({ d, color: typeof fields.color === "string" ? fields.color : "#24292f", tool });
  }
  if (!paths.length) throw new Error("The ink stroke has no drawable points.");
  const pad = Math.max(12, size * (scale / 640) * 2);
  const width = Math.max(1, maxX - minX) + pad * 2, height = Math.max(1, maxY - minY) + pad * 2;
  const view = `${(minX - pad).toFixed(2)} ${(minY - pad).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}`;
  const display = 640, displayHeight = Math.max(40, Math.round(display * (height / width)));
  const body = paths.map(item => `<path d="${item.d}" fill="${item.color}" fill-opacity="${item.tool === "highlighter" ? 0.42 : 1}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${display}" height="${displayHeight}" viewBox="${view}" role="img" aria-label="Ink">${body}</svg>`;
}

export function noteLineEnding(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function decodeNote(buffer) {
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  try {
    return { bom, text: new TextDecoder("utf-8", { fatal: true }).decode(bom ? buffer.subarray(3) : buffer) };
  } catch {
    throw new Error("This note is not UTF-8; merge down leaves it untouched.");
  }
}

export function encodeNote({ bom = false, text = "" } = {}) {
  const body = Buffer.from(text, "utf8");
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

// Insert a block after one element, replacing only the blank separator that already sits there.
// Everything else, line endings and BOM included, is copied byte for byte.
export function insertBlock(text, at, lines, eol = "\n") {
  if (!Array.isArray(lines) || !lines.length) throw new Error("Nothing to insert.");
  if (!Number.isInteger(at) || at < 0 || at > text.length) throw new Error("The paragraph position is outside the note.");
  let cursor = at;
  while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) cursor += 1;
  while (text.startsWith(eol, cursor)) cursor += eol.length;
  const head = text.slice(0, at);
  const tail = text.slice(cursor);
  const block = lines.join(eol);
  return `${head}${eol}${eol}${block}${eol}${eol}${tail}`;
}

// The preview shows the changed block plus a little context; it is the same text insertBlock writes.
export function mergeDiff(text, at, lines, eol = "\n") {
  const next = insertBlock(text, at, lines, eol);
  const split = value => value.split(eol);
  const oldLines = split(text), newLines = split(next);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let end = 0;
  while (end < oldLines.length - start && end < newLines.length - start &&
    oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]) end += 1;
  const removed = oldLines.slice(start, oldLines.length - end);
  const added = newLines.slice(start, newLines.length - end);
  const rows = [
    ...oldLines.slice(Math.max(0, start - 2), start).map(line => ({ kind: "context", text: line })),
    ...removed.map(line => ({ kind: "remove", text: line })),
    ...added.map(line => ({ kind: "add", text: line })),
    ...oldLines.slice(oldLines.length - end, oldLines.length - end + 2).map(line => ({ kind: "context", text: line })),
  ];
  return { rows, added, removed, startLine: start + 1, addedLines: added.length, removedLines: removed.length, next };
}

const fold = text => normalizeText(String(text ?? "")).normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

function grams(text) {
  const counts = new Map();
  for (let index = 0, length = Math.max(text.length - 2, 1); index < length; index += 1) {
    const gram = text.slice(index, index + 3);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  return counts;
}

export function textSimilarity(left, right) {
  const a = fold(left), b = fold(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const short = Math.min(a.length, b.length), long = Math.max(a.length, b.length);
  if (2 * short < 0.6 * (short + long)) return 0;
  const counts = grams(a);
  let shared = 0;
  for (const [gram, count] of grams(b)) shared += Math.min(count, counts.get(gram) || 0);
  return (2 * shared) / (Math.max(a.length - 2, 1) + Math.max(b.length - 2, 1));
}

function sameSection(element, headings) {
  if (!Array.isArray(headings) || !headings.length) return true;
  const path = element.headings ?? [];
  return normalizeText(headings.join(" › ")) === normalizeText(path.join(" › "));
}

// Strongest landmark first, exactly like the glass placement stack, but on Markdown elements.
export function resolveMergeElement(elements, anchor) {
  if (!Array.isArray(elements) || !elements.length) return null;
  const landmarks = Array.isArray(anchor?.landmarks) ? anchor.landmarks : [];
  for (const item of landmarks) {
    if (item.kind !== "block" || typeof item.block !== "string") continue;
    const wanted = normalizeText(item.block);
    const found = elements.find(element => normalizeText(element.markdown) === wanted || normalizeText(element.text) === wanted);
    if (found) return { element: found, tier: "block", confidence: 1 };
  }
  const fingerprint = landmarks.find(item => item.kind === "fingerprint")?.value;
  if (fingerprint?.hash) {
    const matches = elements.filter(element => textHash(element.markdown) === fingerprint.hash || textHash(element.text) === fingerprint.hash);
    const preferred = matches.filter(element => sameSection(element, landmarks.find(item => item.kind === "heading")?.value?.path));
    if (preferred.length === 1) return { element: preferred[0], tier: "fingerprint", confidence: 0.98 };
    if (matches.length === 1) return { element: matches[0], tier: "fingerprint", confidence: 0.95 };
  }
  const quote = landmarks.find(item => item.kind === "quote")?.value;
  if (quote?.exact) {
    const wanted = fold(quote.exact);
    const matches = elements.filter(element => fold(element.text) === wanted || fold(element.markdown) === wanted);
    const preferred = matches.filter(element => sameSection(element, landmarks.find(item => item.kind === "heading")?.value?.path));
    if (preferred.length === 1) return { element: preferred[0], tier: "quote", confidence: 0.9 };
    if (matches.length === 1) return { element: matches[0], tier: "quote", confidence: 0.85 };
  }
  const position = landmarks.find(item => item.kind === "position")?.value;
  if (position && Number.isInteger(position.line)) {
    const at = elements.filter(element => element.line === position.line || element.blockLine === position.line);
    if (at.length === 1) return { element: at[0], tier: "position", confidence: 0.6 };
  }
  let best, score = 0;
  const quotes = [quote?.exact, ...landmarks.filter(item => item.kind === "block").map(item => item.block)].filter(value => typeof value === "string" && value.trim());
  for (const element of elements) {
    for (const value of quotes) {
      const candidate = Math.max(textSimilarity(value, element.text), textSimilarity(value, element.markdown));
      if (candidate > score) { score = candidate; best = element; }
    }
  }
  return best && score >= 0.5 ? { element: best, tier: "fuzzy", confidence: Math.round(score * 100) / 100 } : null;
}

export function mergeAnchorOf(fields) {
  if (fields?.anchor) return fields.anchor;
  if (Array.isArray(fields?.parts) && fields.parts[0]?.anchor) return fields.parts[0].anchor;
  return undefined;
}

// Merge history lives in the same append-only journal, so it survives a restart and syncs.
export function replayMerges(text) {
  const merges = new Map(), undone = new Set();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim() || /^(?:<<<<<<<|=======|>>>>>>>)/.test(line)) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.op === "merge" && typeof record.mergeId === "string" && typeof record.undo === "string") merges.set(record.mergeId, record);
    else if (record?.op === "merge-undo" && typeof record.mergeId === "string") undone.add(record.mergeId);
  }
  return [...merges.values()].reverse().map(record => ({
    id: record.mergeId, magnet: record.magnetId ?? null, kind: record.kind ?? null, line: record.line ?? null,
    baseHash: record.baseHash ?? null, afterHash: record.afterHash ?? null, attachment: record.attachment ?? null,
    undo: record.undo, at: record.hlc ?? null, undone: undone.has(record.mergeId),
  }));
}
