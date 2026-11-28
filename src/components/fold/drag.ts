// Drag-out contract for a fold line (D8, §9.5): one payload, four types on the DataTransfer.
// Shape adapted from TextFold `docs/drag-format.md` (Apache-2.0, Xia Chen) at 7dedb2d; see third-party/textfold/PORTED.md.
import { isLevelId } from "../../../shared/fold-format.mjs";

export const foldDragType = "application/x-omarkie-fold+json";
export const foldDragFormat = "omarkie/fold-drag";
const limits = { note: 1_024, title: 200, heading: 400, text: 4_000, quote: 24_000, line: 20_000_000 };

// One fold line and the author words behind it. `note` is vault-relative ("" while unsaved);
// `by` is whose words `text` holds: local stops cut the author's own text, Estudio lines are written.
export interface FoldPayload {
  format: typeof foldDragFormat;
  version: 1;
  note: string;
  title: string;
  stop: string;
  by: "author" | "model";
  line: number;
  endLine: number;
  headings: string[];
  text: string;
  quote: string;
}

export interface FoldTarget { kind: "page" | "sheet" | "tray"; id: string; label: string }
export interface FoldSent { message: string; undo?(): Promise<void>; line?: number }
// Filled by Learning mode while the study sheets are live; Fold view asks it where a line can go.
export interface FoldOut {
  targets(): FoldTarget[];
  send(payload: FoldPayload, target: FoldTarget): Promise<FoldSent>;
}

const clip = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit - 1).toWellFormed()}…` : value;

export function foldPayload(input: Omit<FoldPayload, "format" | "version">): FoldPayload {
  return {
    format: foldDragFormat, version: 1, note: input.note, title: clip(input.title, limits.title), stop: input.stop, by: input.by,
    line: input.line, endLine: Math.max(input.line, input.endLine), headings: input.headings.slice(-6).map(heading => clip(heading, limits.heading)),
    text: clip(input.text.trim(), limits.text), quote: clip(input.quote.trim(), limits.quote),
  };
}

// Anything off the clipboard or another window is untrusted: wrong shape means no payload.
export function readFoldPayload(value: unknown): FoldPayload | null {
  let data: unknown = value;
  if (typeof value === "string") { try { data = JSON.parse(value); } catch { return null; } }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const item = data as Record<string, unknown>;
  const text = (field: string, limit: number, empty = false) => typeof item[field] === "string" && (item[field] as string).length <= limit
    && (empty || !!(item[field] as string).trim());
  const line = (field: string) => Number.isSafeInteger(item[field]) && (item[field] as number) >= 1 && (item[field] as number) <= limits.line;
  if (item.format !== foldDragFormat || item.version !== 1) return null;
  if (!text("note", limits.note, true) || !text("title", limits.title, true) || !text("text", limits.text) || !text("quote", limits.quote)) return null;
  if (typeof item.stop !== "string" || !isLevelId(item.stop) || (item.by !== "author" && item.by !== "model")) return null;
  if (!line("line") || !line("endLine") || (item.endLine as number) < (item.line as number)) return null;
  const note = item.note as string;
  if (note && (note.startsWith("/") || note.includes("\\") || note.split("/").some(part => part === ".." || part === "." || !part))) return null;
  if (!Array.isArray(item.headings) || item.headings.length > 6 || item.headings.some(heading => typeof heading !== "string" || heading.length > limits.heading)) return null;
  return { format: foldDragFormat, version: 1, note, title: item.title as string, stop: item.stop, by: item.by, line: item.line as number,
    endLine: item.endLine as number, headings: [...item.headings as string[]], text: item.text as string, quote: item.quote as string };
}

// `[[folder/Note#Heading]]`: the link Omarkie and Obsidian both follow back to the source section.
export function foldWikiLink(payload: FoldPayload) {
  if (!payload.note) return "";
  const name = payload.note.replace(/\.(?:md|markdown|mdown)$/i, "");
  const heading = payload.headings.at(-1)?.replace(/[[\]|#^]+/g, " ").replace(/\s+/g, " ").trim();
  return `[[${name}${heading ? `#${heading}` : ""}]]`;
}

// Opens the note at the line in Omarkie from another app.
export function foldLink(payload: FoldPayload) {
  if (!payload.note) return "";
  return `omarkie://open?${new URLSearchParams({ note: payload.note, line: String(payload.line), stop: payload.stop })}`;
}

const flat = (value: string) => value.replace(/\s+/g, " ").trim();

// Linked excerpt: the fold line, its evidence quoted under it, and the way back to the source.
export function foldMarkdown(payload: FoldPayload) {
  const lines: string[] = [];
  if (flat(payload.text) !== flat(payload.quote)) lines.push(`> **${flat(payload.text)}**`, ">");
  for (const line of payload.quote.replace(/\r\n?/g, "\n").split("\n")) lines.push(line.trim() ? `> ${line}` : ">");
  lines.push(">", `> — ${foldWikiLink(payload) || payload.title} · L${payload.line}`);
  return `${lines.join("\n")}\n`;
}

// The excerpt as a block pasted after `before` (the text up to the cursor): blank line above, blank line below.
export function foldBlock(payload: FoldPayload, before: string) {
  const lead = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  return `${lead}${foldMarkdown(payload)}\n`;
}

export function foldPlain(payload: FoldPayload) {
  const parts = flat(payload.text) === flat(payload.quote) ? [] : [flat(payload.text), ""];
  return [...parts, `“${payload.quote}”`, `— ${payload.title}${payload.headings.length ? ` › ${payload.headings.at(-1)}` : ""}, L${payload.line}`].join("\n");
}

export function writeFoldTransfer(data: DataTransfer, payload: FoldPayload) {
  data.setData("text/plain", foldPlain(payload));
  data.setData("text/markdown", foldMarkdown(payload));
  data.setData(foldDragType, JSON.stringify(payload));
  const link = foldLink(payload);
  if (link) data.setData("text/uri-list", link);
}

export function readFoldTransfer(data: DataTransfer | null | undefined) {
  return data?.types.includes(foldDragType) ? readFoldPayload(data.getData(foldDragType)) : null;
}
