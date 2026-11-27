// Fills `.note-embed` placeholders (from `![[Note#Heading]]`) with a read-only rendering of the section.
// Live: the app feeds file stamps and open drafts; frames whose notes changed re-render, the rest stay.
import { createEmbedSource, type EmbedSection, type EmbedSource } from "../../shared/embeds.mjs";
import { renderMarkdown } from "./markdown.ts";
import { t } from "../i18n.ts";

type Note = { relative: string; content: string };
type Options = {
  read(relatives: string[]): Promise<Note[]>;
  note(documentId: string): Note | undefined;
  open(relative: string, line: number, documentId: string): void;
};

let source: EmbedSource | null = null, options: Options | null = null, paths = 0, timer = 0;
const versions = new Map<string, number>(), listeners = new Set<() => void>(), ownText = new WeakMap<HTMLElement, string>(), drawn = new WeakMap<HTMLElement, string[]>();

export function configureEmbeds(next: Options) {
  options = next; source = createEmbedSource({ read: next.read });
  versions.clear(); changed({ changed: [], paths: true });
}
function changed(result: { changed: string[]; paths: boolean }) {
  for (const relative of result.changed) versions.set(relative, (versions.get(relative) ?? 0) + 1);
  if (result.paths) paths += 1;
  if (!result.changed.length && !result.paths) return;
  clearTimeout(timer);
  timer = window.setTimeout(() => { for (const listener of listeners) listener(); }, 150);
}
export function updateEmbedFiles(files: { relative: string; modified?: string; isDirectory?: string }[]) { if (source) changed(source.setFiles(files)); }
export function updateEmbedDrafts(drafts: Note[]) { if (source) changed(source.setDrafts(drafts)); }
export function onEmbedsChanged(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const vaultFiles = () => source?.files() ?? [];
export const vaultNotes = (relatives: string[]) => source ? source.notes(relatives) : Promise.resolve([]);
export function openVaultNote(relative: string, line = 1) { options?.open(relative, line, ""); }

const stamp = (deps: string[]) => `${paths}|${deps.map(relative => `${relative}:${versions.get(relative) ?? 0}`).join("|")}`;
const outer = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>(".note-embed[data-embed]")].filter(frame => !frame.parentElement?.closest(".note-embed"));

function message(result: EmbedSection) {
  switch (result.state) {
    case "missing": return t("Embedded note not found.");
    case "ambiguous": return t("Several notes match this name: {{names}}. Write the folder path.", { names: (result.candidates ?? []).join(", ") });
    case "missing-heading": return t("Heading not found in {{note}}.", { note: result.relative ?? "" });
    case "ambiguous-heading": return t("{{total}} headings share this name. Write the parent heading too (Note#Parent#Heading) or the numbered link (Heading-1).", { total: result.matches ?? 2 });
    case "cycle": return t("This embed shows itself; stopped here.");
    case "too-deep": return t("Embeds nested too deep; stopped here.");
    case "too-large": return t("Embedded text is too long to show here.");
    case "unsupported-block": return t("Block embeds (#^id) are not supported yet.");
    default: return "";
  }
}

async function fill(frame: HTMLElement, note: Note & { base?: string }, chain: string[], budget: { bytes: number }, documentId: string): Promise<string[]> {
  const raw = frame.dataset.embed || "", result = await source!.section(note, raw, chain, budget);
  const deps = new Set(result.relative !== undefined ? [result.relative] : []);
  const head = document.createElement("span"), open = document.createElement("a");
  head.className = "note-embed-head";
  open.className = "vault-link note-embed-open"; open.dataset.embedOpen = "true";
  open.href = `omarkie-wiki:${encodeURIComponent(raw)}`;
  open.textContent = result.title || raw;
  open.title = t("Open the source note (Ctrl/Cmd+Enter on this line)");
  if (result.relative) { open.dataset.embedRelative = result.relative; open.dataset.embedLine = String(result.line ?? 1); }
  head.append(open);
  if (result.relative) { const where = document.createElement("span"); where.className = "note-embed-path"; where.textContent = result.relative; head.append(where); }
  const body = document.createElement("div");
  body.className = "note-embed-body";
  if (result.state === "ok") {
    body.innerHTML = renderMarkdown(result.markdown ?? "", documentId, { fragment: true });
    const nested = { relative: result.relative ?? "", content: result.content ?? "", base: note.base ?? note.relative };
    for (const child of outer(body)) for (const relative of await fill(child, nested, result.chain ?? [], budget, documentId)) deps.add(relative);
  } else {
    const warning = document.createElement("span");
    warning.className = "note-embed-message"; warning.setAttribute("role", "note"); warning.textContent = message(result);
    body.append(warning);
  }
  frame.dataset.embedState = result.state;
  frame.setAttribute("aria-label", t("Embedded from {{note}}", { note: result.relative || raw }));
  frame.replaceChildren(head, body);
  return [...deps];
}

// Hydrates every embed in `container` whose sources changed since it was drawn. Export and print await it, so
// HTML/PDF carry the section text with a link to its note.
export async function renderEmbeds(container: HTMLElement, documentId?: string) {
  if (!source || !options || !documentId) return;
  const frames = outer(container);
  if (!frames.length) return;
  const note = options.note(documentId);
  if (!note) return;
  await Promise.all(frames.map(async frame => {
    const deps = drawn.get(frame);
    if (deps && frame.dataset.embedStamp === stamp(deps) && (!ownText.has(frame) || ownText.get(frame) === note.content)) return;
    const found = await fill(frame, note, [`${note.relative}#`], { bytes: 0 }, documentId);
    drawn.set(frame, found);
    frame.dataset.embedStamp = stamp(found);
    if (found.includes(note.relative)) ownText.set(frame, note.content); else ownText.delete(frame);
  }));
}

const relativeTo = (from: string, to: string) => {
  const base = from.split("/").slice(0, -1), target = to.split("/");
  while (base.length && target.length > 1 && base[0] === target[0]) { base.shift(); target.shift(); }
  return [...base.map(() => ".."), ...target].map(encodeURIComponent).join("/");
};

// Export copy only: block-level frames (a `<p>` cannot hold the section's headings once serialized) and plain
// relative links to the source notes.
export function freezeEmbeds(container: HTMLElement, documentId: string) {
  const from = options?.note(documentId)?.relative ?? "";
  for (const link of container.querySelectorAll<HTMLAnchorElement>("a[data-embed-open]")) {
    const relative = link.dataset.embedRelative;
    if (relative) link.setAttribute("href", relativeTo(from, relative)); else link.removeAttribute("href");
  }
  for (const frame of [...container.querySelectorAll<HTMLElement>(".note-embed")].reverse()) {
    const block = document.createElement("div");
    for (const name of ["class", "data-embed", "data-embed-state", "aria-label"]) { const value = frame.getAttribute(name); if (value !== null) block.setAttribute(name, value); }
    const near = frame.parentElement?.closest("p, .note-embed-body"), paragraph = near?.tagName === "P" ? near : null;
    const alone = paragraph && !paragraph.textContent?.replace(frame.textContent ?? "", "").trim();
    block.replaceChildren(...frame.childNodes);
    if (alone) paragraph.replaceWith(block);
    else if (paragraph) { const holder = document.createElement("div"); holder.className = "note-embed-paragraph"; holder.replaceChildren(...paragraph.childNodes); paragraph.replaceWith(holder); frame.replaceWith(block); }
    else frame.replaceWith(block);
  }
}

export function openEmbed(link: HTMLElement, documentId: string) {
  const relative = link.dataset.embedRelative;
  if (relative && options) options.open(relative, Number(link.dataset.embedLine) || 1, documentId);
}
