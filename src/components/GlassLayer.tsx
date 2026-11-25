import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import interact from "interactjs";
import { ArrowUpRight, Eraser, Grid3x3, Highlighter, Image as ImageIcon, MousePointer2, PenLine, Redo2, Scissors, SquareStack, Star, StickyNote as StickyIcon, Trash2, Undo2 } from "lucide-react";
import type { EditorHandle, ReadingContext } from "../editor/MarkdownEditor";
import type { PageElement } from "../../shared/element-model.mjs";
import { markdownElements } from "../../shared/element-model.mjs";
import { captureAnchor, indexBlocks, liveBlocks, matchIndexed, placeAnchor, type BlockIndex, type GlassBlock, type GlassPlacement } from "../glass/anchor-map";
import { arrowEndKey, customStickerBytes, type ArrowColor, type ArrowHead, type ArrowStyle } from "../../shared/glass-marks.mjs";
import { fixtureAnchor, glassFixture, rememberFixtureAnchor } from "../glass/glass-state";
import GlassLandmarks, { landmarkSeeds } from "./GlassLandmarks";
import BubbleLayer from "./BubbleLayer";
import ArrowOverlay, { type Hit } from "./ArrowOverlay";
import StickerView from "./StickerView";
import StickerArt from "./StickerArt";
import type { LiveTutor } from "./tutor-live";
import type { TutorReply } from "./tutor-verbs";
import GlassInk, { type InkHistoryApi } from "./GlassInk";
import { inkColors, inkDefaults, inkWidths, type InkTool } from "../../shared/ink-core.mjs";
import type { StudyOverlay } from "./learning-overlays";
import {
  anchorOf, nearestBlock, newStickyId, offsetIn, stickyDefaults, stickyFields, stickyFromMagnet, stickyColors,
  type GlassMagnet, type StickyNote,
} from "../glass/glass-model";
import { displayNeeded, imageDefaults, imageTypeOf } from "../../shared/glass-images.mjs";
import { imageFromMagnet, type GlassImage } from "../glass/image-model";
import { imageCopy } from "../glass/glass-assets";
import { cardAnchor, cardFieldsOf, cardFromMagnet, newCardId, pillPlacement, type GlassCard } from "../glass/card-model";
import GlassCardView, { NewCardDialog } from "./GlassCard";
import GlassImageFrame from "./GlassImage";
import { stickerIds, stickerAt, stickerFields, stickerFromMagnet, stickerName, type StickerMark } from "../glass/sticker-model";
import { arrowDefaults, arrowFields, arrowFromMagnet, routeArrows, type ArrowEndContext, type ArrowMark, type ArrowRoute, type EndMark } from "../glass/arrow-model";
import { elementNode } from "../glass/element-node";
import { elementKindName } from "../glass/element-label";
import { snapBox, snapDefaults, snapSetting, type SnapBox, type SnapColumn, type SnapGuide, type SnapLine } from "../../shared/glass-snap.mjs";
import "./glass.css";

interface SnapContext { others: SnapBox[]; column?: SnapColumn; lines: SnapLine[] }

interface Layout {
  places: Record<string, GlassPlacement>;
  routes: ArrowRoute[];
  names: Record<string, { from: string; to: string }>;
  orphanArrows: string[];
  fixture?: GlassPlacement;
  loaded?: boolean;
}
interface Reply { ok: boolean; value?: GlassReply; error?: string }
interface MergeRow { kind: "context" | "add" | "remove"; text: string }
interface MergePreview {
  note: string; magnet: string; kind: string; label: string; baseHash: string; baseSize: number; eol: string; bom: boolean;
  diff: MergeRow[]; added: string[]; removed: string[]; attachment: string | null; linkStyle: string; attachmentFolder: string;
  element: { id: string; kind: string; line: number; headings: string[] }; confidence: number; tier: string;
}
interface MergeHistoryEntry { id: string; magnet: string | null; kind: string | null; undone: boolean; at: string | null; attachment: string | null }
interface GlassReply {
  magnets?: GlassMagnet[];
  trash?: GlassMagnet[];
  magnet?: GlassMagnet | null;
  saved?: boolean;
  merge?: MergePreview;
  preview?: MergePreview;
  history?: MergeHistoryEntry[];
  merges?: MergeHistoryEntry[];
  merged?: boolean;
  stale?: boolean;
  undone?: boolean;
  undoStale?: boolean;
  needsUser?: boolean;
  message?: string;
}
interface Viewport { top: number; height: number; width: number; page: number }
const comingSoon = [
  { id: "scissors", label: "Scissors", icon: Scissors },
] as const;
const imageFile = /\.(?:png|jpe?g|gif|webp|avif|heic|heif|tiff?)$/i;
async function glassCall(request: Record<string, unknown>): Promise<GlassReply> {
  const api = window.desktop?.glass;
  if (!api) throw new Error("Glass storage is not available here.");
  const reply: Reply = await api(request);
  if (!reply?.ok) throw new Error(reply?.error ?? "Glass storage refused the change.");
  return reply.value ?? {};
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const glassGridKey = "omarkie-glass-grid";
type GlassGrid = { on: boolean; size: number };
function readGlassGrid(): GlassGrid {
  const off: GlassGrid = { on: false, size: snapDefaults.grid };
  try { return snapSetting(JSON.parse(localStorage.getItem(glassGridKey) ?? "null") ?? off); } catch { return off; }
}
const imageFiles = (data: DataTransfer | null) => {
  if (!data) return [];
  const files = [...data.files];
  if (!files.length) for (const item of [...data.items]) {
    const file = item.kind === "file" && item.type.startsWith("image/") ? item.getAsFile() : null;
    if (file) files.push(file);
  }
  return files.filter(file => file.type.startsWith("image/") || imageFile.test(file.name));
};
async function fileBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = "";
  for (let index = 0; index < bytes.length; index += 32_768) text += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  return btoa(text);
}
const snippet = (text: string) => text.length > 28 ? `${text.slice(0, 28).toWellFormed()}…` : text;
const magnetLabel = (magnet: GlassMagnet) => {
  if (magnet.kind === "image") return typeof magnet.fields.name === "string" && magnet.fields.name.trim() ? magnet.fields.name.slice(0, 48) : "Image";
  if (magnet.kind === "card") return typeof magnet.fields.title === "string" && magnet.fields.title.trim() ? magnet.fields.title.slice(0, 48) : "Card";
  if (magnet.kind === "sticky") return typeof magnet.fields.text === "string" && magnet.fields.text.trim() ? magnet.fields.text.trim().slice(0, 48) : "Empty note";
  if (magnet.kind === "sticker") return stickerName({ sticker: typeof magnet.fields.sticker === "string" ? magnet.fields.sticker : undefined,
    image: typeof magnet.fields.image === "string" ? magnet.fields.image : undefined });
  if (magnet.kind === "arrow") return typeof magnet.fields.label === "string" && magnet.fields.label.trim() ? `Arrow: ${snippet(magnet.fields.label.trim())}` : "Arrow";
  if (typeof magnet.fields.text === "string" && magnet.fields.text.trim()) return snippet(magnet.fields.text.trim());
  return magnet.kind ? `${magnet.kind[0].toUpperCase()}${magnet.kind.slice(1)}` : "Glass mark";
};

// One sticky note: paper, six colours, fold to a dot, delete to the trash, typing saved as it settles.
function StickyView({ note, place, selected, editing, onSelect, onEdit, onText, onFold, onColor, onDelete, onMerge, onJump }: {
  note: StickyNote; place: GlassPlacement; selected: boolean; editing: boolean; onSelect(): void; onEdit(editing: boolean): void;
  onText(text: string): void; onFold(folded: boolean): void; onColor(color: StickyNote["color"]): void; onDelete(): void;
  onMerge(): void; onJump?(): void;
}) {
  const [draft, setDraft] = useState(note.text);
  const committed = useRef(note.text), latest = useRef(note.text), text = useRef<HTMLTextAreaElement>(null);
  const writeText = useRef(onText);
  writeText.current = onText;
  latest.current = draft;
  const flush = useCallback(() => {
    if (latest.current === committed.current) return;
    committed.current = latest.current;
    writeText.current(latest.current);
  }, []);
  useEffect(() => flush, [flush]);
  useEffect(() => {
    if (draft === committed.current) return;
    const timer = setTimeout(flush, 400);
    return () => clearTimeout(timer);
  }, [draft, flush]);
  // Another hand (an agent, another device) can rewrite the note; adopt it unless typing is pending here.
  useEffect(() => {
    if (note.text === committed.current || latest.current !== committed.current) return;
    committed.current = note.text;
    setDraft(note.text);
  }, [note.text]);
  useEffect(() => { if (editing) text.current?.focus(); }, [editing]);
  if (place.status === "orphan") return null;
  return <div className="glass-note" data-magnet={note.id} data-colour={note.color} data-folded={note.folded || undefined}
    data-selected={selected || undefined} data-editing={editing || undefined} tabIndex={0} aria-label={`Sticky note, ${note.color}`}
    style={{ left: `${place.x}px`, top: `${place.y}px`, width: `${note.folded ? stickyDefaults.folded : place.width}px`, height: `${note.folded ? stickyDefaults.folded : place.height}px` }}
    onPointerDown={onSelect} onDoubleClick={() => onEdit(true)} onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter") { event.preventDefault(); onEdit(true); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); onDelete(); }
      else if (event.key === "f" || event.key === "F") { event.preventDefault(); onFold(!note.folded); }
      else if (event.key === "Escape") event.currentTarget.blur();
    }}>
    {note.folded ? <button type="button" className="glass-note-dot" aria-label="Unfold note" title="Unfold note" onClick={() => onFold(false)} /> : <>
      <span className="glass-note-head" aria-hidden="true" />
      <span className="glass-note-mark" aria-hidden="true" />
      <textarea ref={text} className="glass-note-text" aria-label="Sticky note text" value={draft} maxLength={stickyDefaults.textLimit} placeholder="Write a note"
        onChange={event => setDraft(event.target.value)} onBlur={flush} onFocus={() => onEdit(true)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.currentTarget.blur(); } }} />
      <div className="glass-note-tools" role="group" aria-label="Sticky note">
        {stickyColors.map(colour => <button type="button" key={colour} className="glass-note-colour" data-colour={colour}
          aria-label={`${colour} note`} aria-pressed={note.color === colour} onClick={() => onColor(colour)} />)}
        <button type="button" className="glass-note-tool" aria-label="Fold note" title="Fold note" onClick={() => onFold(true)}>–</button>
        {onJump && note.source && <button type="button" className="glass-note-tool" data-glass-jump aria-label="Jump to source" title="Jump to source" onClick={onJump}>↩</button>}
        <button type="button" className="glass-note-tool" data-glass-merge={note.id} aria-label="Merge down" title="Merge down into the page" onClick={onMerge}>⇩</button>
        <button type="button" className="glass-note-tool" aria-label="Move note to trash" title="Move to trash" onClick={onDelete}>×</button>
      </div>
      <span className="glass-note-grip glass-note-grip-right" data-grip="right" aria-hidden="true" />
      <span className="glass-note-grip glass-note-grip-bottom" data-grip="bottom" aria-hidden="true" />
    </>}
  </div>;
}

function MergeDiff({ rows, stamp }: { rows: MergeRow[]; stamp: string }) {
  return <pre className="glass-merge-diff" data-glass-merge-diff={stamp}>
    {rows.map((row, index) => <div key={index} data-diff={row.kind}>
      <span aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}</span>{row.text || " "}
    </div>)}
  </pre>;
}

export default function GlassLayer({ editor, root, nodes, groups, note, saved: documentSaved, live, reloadNote }: {
  editor(): EditorHandle | undefined; root: HTMLElement; nodes: ReadingContext["nodes"]; groups: StudyOverlay[]; note?: string; saved: boolean;
  live?: LiveTutor; reloadNote?(): void | Promise<unknown>;
}) {
  const scroller = root.parentElement!;
  const layer = useRef<HTMLDivElement>(null);
  const fixture = useMemo(glassFixture, []);
  const seeds = useMemo(landmarkSeeds, []);
  const [landmarks, setLandmarks] = useState<GlassMagnet[]>([]);
  const [comments, setComments] = useState<GlassMagnet[]>([]);
  const [magnets, setMagnets] = useState<StickyNote[]>([]);
  const [images, setImages] = useState<GlassImage[]>([]);
  const [ink, setInk] = useState<GlassMagnet[]>([]);
  const [inkTool, setInkTool] = useState<InkTool | "eraser">("pen");
  const [inkSize, setInkSize] = useState(inkDefaults("pen").size);
  const [inkColor, setInkColor] = useState(inkDefaults("pen").color);
  const [eraserMode, setEraserMode] = useState<"bite" | "stroke">("bite");
  const [inkHistory, setInkHistory] = useState({ undo: false, redo: false });
  const inkApi = useRef<InkHistoryApi | null>(null);
  const [stickers, setStickers] = useState<StickerMark[]>([]);
  const [arrows, setArrows] = useState<ArrowMark[]>([]);
  const [cards, setCards] = useState<GlassCard[]>([]);
  const [trash, setTrash] = useState<GlassMagnet[]>([]);
  const [layout, setLayout] = useState<Layout>({ places: {}, routes: [], names: {}, orphanArrows: [] });
  const [tool, setTool] = useState<"select" | "sticky" | "ink" | "sticker" | "arrow" | "grid">("select");
  const [stickerChoice, setStickerChoice] = useState<string>(stickerIds[0]);
  const [customImage, setCustomImage] = useState<string>();
  const [arrowStyle, setArrowStyle] = useState<ArrowStyle>(arrowDefaults.style);
  const [arrowColor, setArrowColor] = useState<ArrowColor>(arrowDefaults.color);
  const [arrowHead, setArrowHead] = useState<ArrowHead>(arrowDefaults.head);
  const [cardOpen, setCardOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [selectedArrow, setSelectedArrow] = useState<string>();
  const [grid, setGrid] = useState<GlassGrid>(readGlassGrid);
  const guidesEl = useRef<HTMLDivElement>(null);
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const snapCache = useRef<{ id: string; context: SnapContext } | undefined>(undefined);
  useEffect(() => { try { localStorage.setItem(glassGridKey, JSON.stringify(grid)); } catch { /* storage unavailable */ } }, [grid]);
  const [viewport, setViewport] = useState<Viewport>({ top: 0, height: 0, width: 0, page: 0 });
  const [editing, setEditing] = useState<string>();
  const [openTrash, setOpenTrash] = useState(false);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [notice, setNotice] = useState("");
  const [mergeOpen, setMergeOpen] = useState<MergePreview>();
  const [mergeStale, setMergeStale] = useState<MergePreview>();
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeHistory, setMergeHistory] = useState<MergeHistoryEntry[]>([]);
  const [mergeDone, setMergeDone] = useState<MergeHistoryEntry>();
  const [undoPending, setUndoPending] = useState<string>();
  const [underHost, setUnderHost] = useState<HTMLDivElement | null>(null);
  const blocks = useRef<GlassBlock[]>([]), index = useRef<BlockIndex>(indexBlocks([]));
  const spacers = useRef(new Map<string, HTMLSpanElement>());
  const picker = useRef<HTMLInputElement>(null);
  const elements = useRef<{ text: string; list: PageElement[] }>({ text: "", list: [] });
  const elementBoxes = useRef<Record<string, EndMark>>({});
  const placesRef = useRef<Record<string, GlassPlacement>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef({ magnets, images, stickers, arrows, cards, note, tool });
  const fingerprint = useRef(""), mounted = useRef(false), ready = useRef(false), loaded = useRef(!note), dragging = useRef(false);
  const queue = useRef(Promise.resolve<unknown>(undefined));
  const localAt = useRef(0), revision = useRef(0);
  latest.current = { magnets, images, stickers, arrows, cards, note, tool };

  // A wrapped picture reserves its box in the paragraph, so the page text flows around it.
  const flow = useCallback((image: GlassImage, element: HTMLElement, width = image.w, height = image.h) => {
    let spacer = spacers.current.get(image.id);
    if (!spacer) {
      spacer = document.createElement("span");
      spacer.className = "glass-flow";
      spacer.dataset.glassFlow = image.id;
      spacer.contentEditable = "false";
      spacer.setAttribute("aria-hidden", "true");
      spacers.current.set(image.id, spacer);
    }
    if (spacer.parentElement !== element) element.prepend(spacer);
    const side = image.wrap === "left" ? "left" : "right";
    if (spacer.style.cssFloat !== side) spacer.style.cssFloat = side;
    if (spacer.style.width !== `${width}px`) spacer.style.width = `${width}px`;
    if (spacer.style.height !== `${height}px`) spacer.style.height = `${height}px`;
    return spacer;
  }, []);

  const dropSpacers = useCallback((keep: Set<string>) => {
    for (const [id, spacer] of spacers.current) if (!keep.has(id)) { spacer.remove(); spacers.current.delete(id); }
  }, []);

  const measure = useCallback(() => {
    const surface = layer.current;
    if (!surface) return;
    blocks.current = liveBlocks(editor()?.readingContext(), root);
    index.current = indexBlocks(blocks.current);
    const byLine = new Map(blocks.current.map(block => [block.line, block]));
    const frame = surface.getBoundingClientRect();
    const places: Record<string, GlassPlacement> = {};
    const needsArrows = latest.current.arrows.length > 0 || latest.current.tool === "arrow";
    const lines = new Map<string, number | null>();
    const matchLine = (anchor: Parameters<typeof matchIndexed>[1]) => {
      const key = JSON.stringify(anchor.landmarks);
      let line = lines.get(key);
      if (line === undefined) { line = matchIndexed(index.current, anchor); lines.set(key, line); }
      return line;
    };
    const paragraphRects = new Map<HTMLElement, DOMRect>();
    for (const mark of [...latest.current.magnets, ...latest.current.stickers]) {
      const line = matchLine(mark.anchor);
      const element = line === null ? undefined : byLine.get(line)?.element;
      if (!element) { places[mark.id] = { status: "orphan" }; continue; }
      let rect = paragraphRects.get(element);
      if (!rect) { rect = element.getBoundingClientRect(); paragraphRects.set(element, rect); }
      places[mark.id] = { status: "resolved", x: rect.left - frame.left + mark.x, y: rect.top - frame.top + mark.y, width: mark.w, height: mark.h };
    }
    const flowing = new Set<string>();
    for (const image of latest.current.images) {
      const line = matchIndexed(index.current, image.anchor);
      const element = line === null ? undefined : byLine.get(line)?.element;
      if (!element) { places[image.id] = { status: "orphan" }; continue; }
      if (image.wrap === "left" || image.wrap === "right") {
        // A float may use at most 60% of the measure, so its text keeps a readable column.
        const limit = Math.round((element.clientWidth || 0) * 0.6);
        const width = limit > 0 ? Math.max(imageDefaults.minW, Math.min(image.w, limit)) : image.w;
        const height = width === image.w ? image.h : Math.max(imageDefaults.minH, Math.round(width / image.aspect));
        const spacer = flow(image, element, width, height);
        const rect = spacer.getBoundingClientRect();
        flowing.add(image.id);
        places[image.id] = { status: "resolved", x: rect.left - frame.left, y: rect.top - frame.top, width, height };
      } else {
        const rect = element.getBoundingClientRect();
        places[image.id] = { status: "resolved", x: rect.left - frame.left + image.x, y: rect.top - frame.top + image.y, width: image.w, height: image.h };
      }
    }
    let cardRow = 0;
    for (const card of latest.current.cards) {
      const line = matchLine(card.anchor);
      const element = line === null ? undefined : byLine.get(line)?.element;
      if (!element) { places[card.id] = { status: "orphan" }; continue; }
      let rect = paragraphRects.get(element);
      if (!rect) { rect = element.getBoundingClientRect(); paragraphRects.set(element, rect); }
      const spot = pillPlacement(rect, frame);
      places[card.id] = { status: "resolved", x: spot.x + card.x, y: spot.y + card.y + cardRow * 24, width: spot.width, height: 0 };
      cardRow += 1;
    }
    dropSpacers(flowing);
    placesRef.current = places;
    let routed: { routes: ArrowRoute[]; orphans: string[] } = { routes: [], orphans: [] };
    const names: Record<string, { from: string; to: string }> = {};
    // Element boxes and arrow routing cost one rect per paragraph; skip them until arrows need the page.
    if (needsArrows) {
      const text = editor()?.readingContext()?.text;
      if (text !== undefined && text !== elements.current.text) elements.current = { text, list: markdownElements(text) };
      const list = elements.current.list;
      const boxes: Record<string, EndMark> = {};
      for (const element of list) {
        const node = elementNode(root, element, list);
        const rect = node?.getBoundingClientRect();
        if (!rect?.width || !rect.height) continue;
        boxes[element.id] = { x: rect.left - frame.left, y: rect.top - frame.top, width: rect.width, height: rect.height };
      }
      elementBoxes.current = boxes;
      const ends: ArrowEndContext = {
        line: matchLine,
        elementAt: (line, id) => {
          const at = list.filter(element => element.blockLine === line);
          const chosen = (id ? at.find(element => element.id === id) : undefined) ?? at[0];
          return chosen ? boxes[chosen.id] : undefined;
        },
        magnet: id => { const place = places[id]; return place?.status === "resolved" ? place : undefined; },
      };
      routed = routeArrows(latest.current.arrows, ends);
      for (const arrow of latest.current.arrows)
        names[arrow.id] = { from: endName(arrow.from, list, ends, latest.current), to: endName(arrow.to, list, ends, latest.current) };
    } else elementBoxes.current = {};
    let marker: GlassPlacement | undefined;
    if (fixture && !seeds?.length) {
      let anchor = fixtureAnchor();
      if (!anchor) {
        const paragraph = blocks.current.find(block => block.element?.tagName === "P" && !!block.element.textContent?.trim());
        if (paragraph) { anchor = captureAnchor(paragraph, blocks.current); rememberFixtureAnchor(anchor); }
      }
      if (anchor) marker = placeAnchor(anchor, { x: 0, y: 0 }, blocks.current, surface);
    }
    // Size the paper grid after the measurements, so this write never forces a second layout.
    const page = `${Math.max(scroller.scrollHeight, frame.height)}px`;
    if (surface.style.getPropertyValue("--glass-page") !== page) surface.style.setProperty("--glass-page", page);
    if (!mounted.current) { mounted.current = true; performance.mark("omarkie:glass-mounted"); }
    const serialized = JSON.stringify([places, routed.routes, names, routed.orphans, marker ?? null, loaded.current]);
    if (serialized === fingerprint.current) return;
    fingerprint.current = serialized;
    setLayout({ places, routes: routed.routes, names, orphanArrows: routed.orphans, fixture: marker, loaded: loaded.current });
  }, [dropSpacers, editor, fixture, flow, root, scroller, seeds]);

  useEffect(() => () => { for (const spacer of spacers.current.values()) spacer.remove(); spacers.current.clear(); }, []);

  useLayoutEffect(() => {
    if (layout.loaded && !ready.current) { ready.current = true; performance.mark("omarkie:glass-ready"); }
  }, [layout.loaded]);

  // One write at a time, in the order the hand made them: a fresh note must exist before its text lands.
  const send = useCallback((request: Record<string, unknown>) => {
    const path = latest.current.note;
    if (!path) return Promise.resolve(undefined);
    localAt.current = Date.now();
    revision.current += 1;
    const run = queue.current.then(async () => {
      setSaved("saving");
      try {
        const value = await glassCall({ note: path, ...request });
        if (Array.isArray(value.trash)) setTrash(value.trash);
        setSaved("saved");
        return value;
      } catch (error) {
        setSaved("error");
        setNotice(message(error));
        return undefined;
      }
    });
    queue.current = run;
    return run;
  }, []);

  const load = useCallback(() => {
    const path = latest.current.note;
    if (!path) return;
    const run = queue.current.then(async () => {
      try {
        const startedAt = revision.current;
        const value = await glassCall({ note: path, action: "list" });
        // A write that landed while this list was in flight wins; its optimistic state is newer.
        if (revision.current !== startedAt) return;
        loaded.current = true;
        const stickies: StickyNote[] = [], nextImages: GlassImage[] = [], nextStickers: StickerMark[] = [], nextArrows: ArrowMark[] = [], nextCards: GlassCard[] = [];
        const incoming: GlassMagnet[] = [], nextComments: GlassMagnet[] = [], nextInk: GlassMagnet[] = [];
        for (const magnet of value.magnets ?? []) {
          if (magnet.kind === "sticky") {
            const sticky = stickyFromMagnet(magnet);
            if (sticky) stickies.push(sticky);
          } else if (magnet.kind === "image") {
            const picture = imageFromMagnet(magnet);
            if (picture) nextImages.push(picture);
          } else if (magnet.kind === "sticker") {
            const stamp = stickerFromMagnet(magnet);
            if (stamp) nextStickers.push(stamp);
          } else if (magnet.kind === "arrow") {
            const arrow = arrowFromMagnet(magnet);
            if (arrow) nextArrows.push(arrow);
          } else if (magnet.kind === "card") {
            const card = cardFromMagnet(magnet);
            if (card) nextCards.push(card);
          } else if (magnet.kind === "comment") nextComments.push(magnet);
          else if (magnet.kind === "ink") nextInk.push(magnet);
          else incoming.push(magnet);
        }
        setMagnets(stickies);
        setImages(nextImages);
        setStickers(nextStickers);
        setArrows(nextArrows);
        setCards(previous => JSON.stringify(previous) === JSON.stringify(nextCards) ? previous : nextCards);
        setLandmarks(previous => JSON.stringify(previous) === JSON.stringify(incoming) ? previous : incoming);
        setComments(previous => JSON.stringify(previous) === JSON.stringify(nextComments) ? previous : nextComments);
        setInk(previous => !previous.length && !nextInk.length ? previous : nextInk);
        setTrash(value.trash ?? []);
        setSaved("saved");
        const history = await glassCall({ note: path, action: "merge-history" }).catch(() => undefined);
        if (Array.isArray(history?.merges)) setMergeHistory(history.merges);
      } catch (error) { setSaved("error"); setNotice(message(error)); }
    });
    queue.current = run;
    return run;
  }, []);

  useLayoutEffect(() => {
    void load();
    const subscribe = window.desktop?.onGlassChanged;
    const stop = subscribe?.((event: { note?: string; action?: string } | undefined) => {
      if (event && (event.note === latest.current.note || event.action === "bring" && !event.note)) {
        setMergeDone(undefined);
        void load();
      }
    });
    // A focus reload must not clobber a click that just started writing; the journal echo is authoritative.
    const onFocus = () => { if (loaded.current && Date.now() - localAt.current > 500) void load(); };
    window.addEventListener("focus", onFocus);
    return () => { stop?.(); window.removeEventListener("focus", onFocus); };
  }, [load]);

  useEffect(() => {
    const surface = layer.current;
    if (!surface) return;
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    const sizes = new ResizeObserver(schedule);
    sizes.observe(scroller);
    sizes.observe(root);
    // Our own boxes are React output; their mutations must not schedule another pass.
    const edits = new MutationObserver(records => { if (records.every(record => surface.contains(record.target))) return; schedule(); });
    edits.observe(scroller, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      sizes.disconnect();
      edits.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [scroller, root, measure]);

  const showingArrows = arrows.length > 0 || tool === "arrow";
  useLayoutEffect(() => { measure(); }, [magnets, images, stickers, arrows, cards, showingArrows, measure]);

  // The arrow jump chip needs the visible band in content coordinates; it changes with scroll, not with layout.
  useEffect(() => {
    if (!showingArrows) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = { top: scroller.scrollTop, height: scroller.clientHeight, width: scroller.clientWidth, page: Math.max(scroller.scrollHeight, scroller.clientHeight) };
      setViewport(previous => previous.top === next.top && previous.height === next.height && previous.width === next.width && previous.page === next.page ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const sizes = new ResizeObserver(schedule);
    sizes.observe(scroller);
    sizes.observe(root);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      sizes.disconnect();
    };
  }, [scroller, root, showingArrows]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3_000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (selected && !magnets.some(item => item.id === selected) && !images.some(item => item.id === selected) && !stickers.some(item => item.id === selected)) setSelected(undefined);
  }, [magnets, images, stickers, selected]);

  useEffect(() => {
    if (selectedArrow && !arrows.some(item => item.id === selectedArrow)) setSelectedArrow(undefined);
  }, [arrows, selectedArrow]);

  const patchImage = useCallback((id: string, patch: Partial<GlassImage>, persist = false) => {
    setImages(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
    if (persist) void send({ action: "set", magnet: id, fields: patch as Record<string, unknown> });
  }, [send]);

  const patchCard = useCallback((id: string, patch: Partial<GlassCard>, persist = true) => {
    setCards(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
    if (!persist) return;
    const fields: Record<string, unknown> = {};
    if (patch.folded !== undefined) fields.folded = patch.folded;
    if (patch.answer !== undefined) fields.answer = patch.answer;
    if (patch.answerAt !== undefined) fields.answerAt = patch.answerAt;
    if (patch.title !== undefined) fields.title = patch.title;
    if (Object.keys(fields).length) void send({ action: "set", magnet: id, fields });
  }, [send]);

  const createCard = useCallback((card: GlassCard) => {
    const closing = card.folded ? [] : latest.current.cards.filter(item => !item.folded);
    setCards(current => [...current.map(item => closing.some(open => open.id === item.id) ? { ...item, folded: true } : item)
      .filter(item => item.id !== card.id), card]);
    for (const open of closing) void send({ action: "set", magnet: open.id, fields: { folded: true } });
    const fields = cardFieldsOf(card);
    if (card.answer) { fields.answer = card.answer; fields.answerAt = card.answerAt; }
    return send({ action: "add", magnet: card.id, fields });
  }, [send]);

  // One card unfolds at a time: a popup must not bury its neighbours under a stack of panels.
  const toggleCard = useCallback((id: string) => {
    const target = latest.current.cards.find(item => item.id === id);
    if (!target) return;
    const folded = !target.folded;
    const closing = folded ? [] : latest.current.cards.filter(item => item.id !== id && !item.folded);
    setCards(current => current.map(item => item.id === id ? { ...item, folded }
      : closing.some(open => open.id === item.id) ? { ...item, folded: true } : item));
    void send({ action: "set", magnet: id, fields: { folded } });
    for (const open of closing) void send({ action: "set", magnet: open.id, fields: { folded: true } });
  }, [send]);

  // A bubble pins its answer as an AI card on the glass; the markdown note keeps only the comment.
  const pinCard = useCallback(async (reply: TutorReply) => {
    const question = reply.question.trim() || reply.anchor.quote || reply.anchor.block.slice(0, 240);
    const card: GlassCard = {
      id: newCardId(), card: "ai", title: question.split(/\r?\n/)[0]?.slice(0, 200) ?? "",
      link: "", question, answer: reply.body, answerAt: new Date().toISOString(),
      choices: [], anchor: cardAnchor(reply.anchor), x: 0, y: 0, w: 300, folded: false,
    };
    return !!(await createCard(card))?.magnet;
  }, [createCard]);

  // Guides measure what the hand can see: every placed magnet in the frame, the page text
  // column, and the line boxes of the paragraphs on screen. Built once per pick-up.
  const snapContext = useCallback((skip: string): SnapContext => {
    const surface = layer.current;
    if (!surface) return { others: [], lines: [] };
    const frame = surface.getBoundingClientRect();
    const others = Object.entries(placesRef.current).flatMap(([id, place]) =>
      id === skip || place.status !== "resolved" ? [] : [{ x: place.x, y: place.y, w: place.width, h: place.height }]);
    const column = root.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const lines: SnapLine[] = [];
    for (const block of blocks.current) {
      const element = block.element;
      if (!element || lines.length >= 400) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || rect.bottom < view.top || rect.top > view.bottom) continue;
      const range = document.createRange();
      range.selectNodeContents(element);
      for (const line of range.getClientRects())
        if (line.width > 8 && line.height > 0) lines.push({ y: line.top - frame.top, x: line.left - frame.left, width: line.width });
    }
    return { others, column: { left: column.left - frame.left, right: column.right - frame.left }, lines };
  }, [root, scroller]);

  const paintGuides = useCallback((guides: readonly SnapGuide[], cost: number) => {
    const holder = guidesEl.current;
    if (!holder) return;
    const shown = new Map<string, SnapGuide>();
    for (const guide of guides) {
      const key = guide.kind === "spacing" ? "spacing" : guide.axis;
      if (!shown.has(key)) shown.set(key, guide);
    }
    for (const node of holder.querySelectorAll<HTMLElement>("[data-guide]")) {
      const guide = shown.get(node.dataset.guide!);
      node.hidden = !guide;
      if (!guide) continue;
      node.dataset.kind = guide.kind;
      const cross = guide.from !== undefined && guide.to !== undefined;
      if (guide.axis === "y") {
        node.style.top = `${guide.at}px`;
        node.style.left = `${guide.from ?? 0}px`;
        node.style.width = cross ? `${Math.max(4, guide.to! - guide.from!)}px` : "100%";
        node.style.height = "1px";
      } else {
        node.style.left = `${guide.at}px`;
        node.style.top = `${guide.from ?? 0}px`;
        node.style.height = cross ? `${Math.max(4, guide.to! - guide.from!)}px` : "100%";
        node.style.width = guide.kind === "spacing" ? `${Math.max(2, guide.gap ?? 0)}px` : "1px";
        if (guide.kind === "spacing") node.dataset.label = `${guide.gap ?? 0}`;
      }
    }
    holder.dataset.snapMs = cost.toFixed(2);
    holder.dataset.snap = guides.length ? "on" : "off";
  }, []);

  // The one rule every magnet follows: align to a neighbour or the column, glue the top to a
  // text line, else round to the grid. Alt skips it all.
  const resolveSnap = useCallback((box: SnapBox, context: SnapContext, alt: boolean) => {
    const setting = gridRef.current;
    const started = performance.now();
    const result = snapBox({ box, others: context.others, column: context.column, lines: context.lines,
      grid: setting.on ? setting.size : 0, disabled: alt });
    paintGuides(alt ? [] : result.guides, performance.now() - started);
    return result;
  }, [paintGuides]);

  const settle = useCallback((element: HTMLElement) => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    element.classList.add("is-settling");
    window.setTimeout(() => element.classList.remove("is-settling"), snapDefaults.settleMs + 80);
  }, []);

  useEffect(() => {
    const surface = layer.current;
    if (!surface) return;
    // interact hands listeners the interactable element, not the mark under the pointer, so remember it.
    let downSource: Element | null = null;
    const track = (event: Event) => { downSource = event.target as Element; };
    surface.addEventListener("pointerdown", track, true);
    const markElement = (target: Element) => ((downSource ?? target).closest?.(".glass-note, .glass-sticker") ?? target) as HTMLElement;
    const findMark = (id: string) => {
      const sticky = latest.current.magnets.find(item => item.id === id);
      if (sticky) return { kind: "sticky" as const, x: sticky.x, y: sticky.y, w: sticky.w, h: sticky.h };
      const sticker = latest.current.stickers.find(item => item.id === id);
      return sticker ? { kind: "sticker" as const, x: sticker.x, y: sticker.y, w: sticker.w, h: sticker.h } : undefined;
    };
    const place = (id: string, patch: { x: number; y: number; w?: number; h?: number }) => {
      setMagnets(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
      setStickers(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
      const fields: Record<string, number> = { x: patch.x, y: patch.y };
      if (patch.w !== undefined) fields.w = patch.w;
      if (patch.h !== undefined) fields.h = patch.h;
      void send({ action: "set", magnet: id, fields });
    };
    const instance = interact(surface);
    let drag: { element: HTMLElement; id: string; x: number; y: number; pageX: number; pageY: number;
      place?: SnapBox; context: SnapContext } | undefined;
    instance.draggable({
      allowFrom: ".glass-note, .glass-note-head, .glass-sticker",
      ignoreFrom: ".glass-note-text, .glass-note-tools, .glass-note-grip, .glass-note-dot, .glass-sticker-grip, .glass-sticker-rotate, .glass-sticker-delete",
      listeners: {
        start(event) {
          const element = markElement(event.target);
          const id = element.dataset.magnet ?? "";
          const mark = findMark(id);
          if (!mark) return;
          const placed = placesRef.current[id];
          dragging.current = true;
          element.classList.add("is-lifting");
          drag = { element, id, x: mark.x, y: mark.y, pageX: event.pageX, pageY: event.pageY,
            ...(placed?.status === "resolved" ? { place: { x: placed.x, y: placed.y, w: placed.width, h: placed.height } } : {}),
            context: snapContext(id) };
        },
        move(event) {
          if (!drag) return;
          const startedAt = performance.now();
          const dx = event.pageX - drag.pageX, dy = event.pageY - drag.pageY;
          let x = dx, y = dy;
          if (drag.place) {
            const proposal = { x: drag.place.x + dx, y: drag.place.y + dy, w: drag.place.w, h: drag.place.h };
            const result = resolveSnap(proposal, drag.context, event.altKey);
            x += result.x - proposal.x;
            y += result.y - proposal.y;
          }
          drag.element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
          surface.dataset.dragMs = (performance.now() - startedAt).toFixed(2);
        },
        end(event) {
          const start = drag;
          drag = undefined;
          dragging.current = false;
          if (!start) return;
          start.element.classList.remove("is-lifting");
          start.element.style.removeProperty("transform");
          const dx = event.pageX - start.pageX, dy = event.pageY - start.pageY;
          let x = start.x + dx, y = start.y + dy;
          if (start.place) {
            const proposal = { x: start.place.x + dx, y: start.place.y + dy, w: start.place.w, h: start.place.h };
            const result = resolveSnap(proposal, start.context, event.altKey);
            x = start.x + result.x - start.place.x;
            y = start.y + result.y - start.place.y;
          } else if (gridRef.current.on) {
            x = Math.round(x / gridRef.current.size) * gridRef.current.size;
            y = Math.round(y / gridRef.current.size) * gridRef.current.size;
          }
          paintGuides([], 0);
          place(start.id, { x: Math.round(x), y: Math.round(y) });
          settle(start.element);
        },
      },
    }).resizable({
      edges: { right: ".glass-note-grip-right, .glass-sticker-grip", bottom: ".glass-note-grip-bottom" },
      listeners: {
        start(event) {
          const element = markElement(event.target);
          const mark = findMark(element.dataset.magnet ?? "");
          if (!mark) return;
          dragging.current = true;
          const rect = element.getBoundingClientRect();
          element.dataset.resize = JSON.stringify({ id: element.dataset.magnet, kind: mark.kind, width: rect.width, height: rect.height, pageX: event.pageX, pageY: event.pageY });
        },
        move(event) {
          const element = markElement(event.target), data = element.dataset.resize;
          if (!data) return;
          const start = JSON.parse(data);
          if (start.kind === "sticker") {
            const size = Math.max(24, Math.min(1200, Math.round(start.width + event.pageX - start.pageX)));
            element.style.width = `${size}px`;
            element.style.height = `${size}px`;
            element.dataset.size = String(size);
            return;
          }
          const width = Math.max(stickyDefaults.minW, start.width + event.pageX - start.pageX), height = Math.max(stickyDefaults.minH, start.height + event.pageY - start.pageY);
          element.style.width = `${width}px`;
          element.style.height = `${height}px`;
          element.dataset.size = JSON.stringify({ width, height });
        },
        end(event) {
          const element = markElement(event.target), data = element.dataset.resize;
          dragging.current = false;
          if (!data) return;
          const start = JSON.parse(data), size = element.dataset.size;
          const step = gridRef.current.on ? gridRef.current.size : 1;
          delete element.dataset.resize;
          delete element.dataset.size;
          if (size === undefined) return;
          if (start.kind === "sticker") {
            const id = element.dataset.magnet!;
            const edge = Math.round(Math.max(24, Number(size)) / step) * step;
            place(id, { x: findMark(id)?.x ?? 0, y: findMark(id)?.y ?? 0, w: edge, h: edge });
            return;
          }
          const id = element.dataset.magnet!;
          const box = JSON.parse(size);
          place(id, { x: findMark(id)?.x ?? 0, y: findMark(id)?.y ?? 0, w: Math.round(box.width / step) * step, h: Math.round(box.height / step) * step });
        },
      },
    });
    return () => { surface.removeEventListener("pointerdown", track, true); instance.unset(); };
  }, [paintGuides, resolveSnap, send, settle, snapContext]);

  const create = useCallback((point: { x: number; y: number }) => {
    const surface = layer.current;
    if (!surface || !latest.current.note) return;
    const block = nearestBlock(blocks.current, point);
    if (!block) return;
    const offset = offsetIn(block, point);
    const stickie: StickyNote = {
      id: newStickyId(), text: "", color: stickyColors[0], anchor: anchorOf(block),
      x: offset.x, y: offset.y, w: stickyDefaults.w, h: stickyDefaults.h, folded: false,
    };
    setMagnets(current => [...current, stickie]);
    setSelected(stickie.id);
    setSelectedArrow(undefined);
    setEditing(stickie.id);
    void send({ action: "add", magnet: stickie.id, fields: stickyFields(stickie) });
  }, [send]);

  const chooseInk = useCallback((next: InkTool | "eraser") => {
    setTool("ink");
    setInkTool(next);
    if (next === "eraser") return;
    setInkSize(current => inkWidths[next].includes(current) ? current : inkDefaults(next).size);
    setInkColor(current => inkColors[next].includes(current) ? current : inkDefaults(next).color);
  }, []);

  const inkHistoryChange = useCallback((undo: boolean, redo: boolean) => {
    setInkHistory(current => current.undo === undo && current.redo === redo ? current : { undo, redo });
  }, []);

  const createAtCenter = useCallback(() => {
    const surface = layer.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    create({ x: rect.left + rect.width / 2 - stickyDefaults.w / 2, y: rect.top + Math.min(rect.height / 2, 320) });
  }, [create]);

  // Drop, paste or choose a file: the original is kept and a light copy is made for big photos.
  const addImages = useCallback(async (files: File[], point: { x: number; y: number }) => {
    if (!latest.current.note) { setNotice("Save this note first."); return; }
    for (const file of files) {
      if (file.size > imageDefaults.maxBytes) { setNotice(`${file.name} is larger than ${Math.round(imageDefaults.maxBytes / 1024 / 1024)} MB.`); continue; }
      const block = nearestBlock(blocks.current, point) ?? blocks.current[0];
      if (!block) { setNotice("Put the picture on a paragraph."); continue; }
      const box = block.element?.getBoundingClientRect();
      const width = Math.round(Math.max(180, Math.min(360, (box?.width ?? 640) / 2)));
      const type = imageTypeOf(new Uint8Array(await file.slice(0, 32).arrayBuffer()));
      if (!type) { setNotice(`${file.name} is not an image Omarkie can store.`); continue; }
      const size = await imageCopy(file, dimensions => displayNeeded({ ...dimensions, bytes: file.size, type }));
      const display = size?.base64;
      const aspect = size && size.width > 0 && size.height > 0 ? size.width / size.height : 4 / 3;
      const id = newStickyId();
      const wrap = point.x < (box?.left ?? 0) + (box?.width ?? 0) / 2 ? "left" : "right";
      const draft: GlassImage = { id, name: file.name || "Image", asset: "", display: null, bytes: file.size, w: width,
        h: Math.max(imageDefaults.minH, Math.round(width / aspect)), aspect, rot: 0, wrap, tape: false, locked: false,
        anchor: anchorOf(block), x: 0, y: 0 };
      setImages(current => [...current, draft]);
      setSelected(id);
      setSelectedArrow(undefined);
      try {
        const value = await send({ action: "add", magnet: id, fields: { anchor: draft.anchor, w: width, aspect },
          image: { base64: await fileBase64(file), name: file.name, displayBase64: display, wrap } });
        const stored = value?.magnet && imageFromMagnet(value.magnet);
        if (stored) setImages(current => current.map(item => item.id === id ? stored : item));
      } catch (error) {
        setImages(current => current.filter(item => item.id !== id));
        setNotice(message(error));
      }
    }
  }, [send]);

  useEffect(() => {
    if (!note) return;
    const images = (data: DataTransfer | null) => imageFiles(data);
    const over = (event: DragEvent) => {
      if (!event.dataTransfer || event.dataTransfer.types.includes("application/x-omarkie-scrap")) return;
      if (!images(event.dataTransfer).length) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer || event.dataTransfer.types.includes("application/x-omarkie-scrap")) return;
      const files = images(event.dataTransfer);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      void addImages(files, { x: event.clientX, y: event.clientY });
    };
    const paste = (event: ClipboardEvent) => {
      const files = images(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      const box = (layer.current?.getBoundingClientRect() ?? { left: 0, top: 0 });
      void addImages(files, { x: box.left + 120, y: box.top + 160 });
    };
    scroller.addEventListener("dragover", over, true);
    scroller.addEventListener("drop", drop, true);
    window.addEventListener("paste", paste, true);
    return () => {
      scroller.removeEventListener("dragover", over, true);
      scroller.removeEventListener("drop", drop, true);
      window.removeEventListener("paste", paste, true);
    };
  }, [addImages, note, scroller]);

  const imageDrop = useCallback((image: GlassImage, drop: { dx: number; dy: number; clientX: number; clientY: number }) => {
    if (image.wrap === "left" || image.wrap === "right") {
      const block = nearestBlock(blocks.current, { x: drop.clientX, y: drop.clientY });
      if (!block) return;
      patchImage(image.id, { anchor: anchorOf(block), x: 0, y: 0 }, true);
      return;
    }
    const step = gridRef.current.on ? gridRef.current.size : 1;
    patchImage(image.id, { x: Math.round((image.x + drop.dx) / step) * step, y: Math.round((image.y + drop.dy) / step) * step }, true);
    paintGuides([], 0);
  }, [patchImage, paintGuides]);

  // Pictures follow the same guides as paper: a floating photo aligns and glues while it moves.
  const imageSnap = useCallback((image: GlassImage, dx: number, dy: number, alt: boolean) => {
    const place = placesRef.current[image.id];
    if (!place || place.status !== "resolved" || image.wrap === "left" || image.wrap === "right") { paintGuides([], 0); return { dx, dy }; }
    if (snapCache.current?.id !== image.id) snapCache.current = { id: image.id, context: snapContext(image.id) };
    const proposal = { x: place.x + dx, y: place.y + dy, w: place.width, h: place.height };
    const result = resolveSnap(proposal, snapCache.current.context, alt);
    return { dx: dx + result.x - proposal.x, dy: dy + result.y - proposal.y };
  }, [paintGuides, resolveSnap, snapContext]);

  const liveImageSize = useCallback((id: string, width: number, height: number) => {
    const spacer = spacers.current.get(id);
    if (spacer) { spacer.style.width = `${width}px`; spacer.style.height = `${height}px`; }
  }, []);

  // A sticker lands on the Notes & stickers layer: built-in sheet art or one custom image.
  const placeSticker = useCallback((point: { x: number; y: number }) => {
    if (!latest.current.note) return;
    const block = nearestBlock(blocks.current, point);
    if (!block) return;
    const offset = offsetIn(block, point);
    const mark = stickerAt(block, offset);
    if (stickerChoice === "custom") {
      if (!customImage) { setNotice("Choose a custom image first."); fileInput.current?.click(); return; }
      mark.image = customImage;
      delete mark.sticker;
    } else mark.sticker = stickerChoice;
    setStickers(current => [...current, mark]);
    setSelected(mark.id);
    setSelectedArrow(undefined);
    void send({ action: "add", magnet: mark.id, fields: stickerFields(mark) });
  }, [customImage, send, stickerChoice]);

  const pickSticker = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!/^image\/(?:png|jpeg|webp|gif)$/.test(file.type)) { setNotice("Sticker images must be PNG, JPEG, WebP or GIF."); return; }
    if (file.size > customStickerBytes) { setNotice("Sticker image is too large (max 300 KB)."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const image = typeof reader.result === "string" ? reader.result : "";
      if (!image.startsWith("data:image/") || image.length > customStickerBytes) { setNotice("That image could not be used as a sticker."); return; }
      setCustomImage(image);
      setStickerChoice("custom");
    };
    reader.onerror = () => setNotice("That image could not be read.");
    reader.readAsDataURL(file);
  }, []);

  // An arrow joins two marks or page elements; both ends stay anchored.
  const createArrow = useCallback((from: ArrowMark["from"], to: ArrowMark["to"]) => {
    if (!latest.current.note || arrowEndKey(from) === arrowEndKey(to)) return;
    const arrow: ArrowMark = { id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      from, to, style: arrowStyle, color: arrowColor, head: arrowHead, label: "" };
    setArrows(current => [...current, arrow]);
    setSelectedArrow(arrow.id);
    setSelected(undefined);
    void send({ action: "add", magnet: arrow.id, fields: arrowFields(arrow) });
  }, [arrowColor, arrowHead, arrowStyle, send]);

  const updateArrow = useCallback((id: string, patch: Partial<ArrowMark>) => {
    setArrows(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
    const fields: Record<string, unknown> = {};
    for (const key of ["style", "color", "head", "label", "from", "to"] as const)
      if (patch[key] !== undefined) fields[key] = patch[key];
    if (Object.keys(fields).length) void send({ action: "set", magnet: id, fields });
  }, [send]);

  const hitTest = useCallback((clientX: number, clientY: number, known?: DOMRect): Hit | undefined => {
    const surface = layer.current;
    if (!surface) return;
    // A drag frame already read this rect; the second read would force another layout.
    const frame = known ?? surface.getBoundingClientRect();
    const x = clientX - frame.left, y = clientY - frame.top;
    let best: { hit: Hit; area: number } | undefined;
    const inside = (box: { x: number; y: number; width: number; height: number }) =>
      x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
    // No per-frame allocation: this runs inside every drag frame over the whole page.
    for (const id in placesRef.current) {
      const mark = placesRef.current[id];
      if (!mark || mark.status !== "resolved" || !inside(mark)) continue;
      const sticky = latest.current.magnets.find(item => item.id === id);
      const sticker = latest.current.stickers.find(item => item.id === id);
      const area = mark.width * mark.height;
      if (!best || area < best.area) best = { area, hit: { end: { kind: "magnet", magnet: id }, box: mark,
        name: sticky ? (sticky.text.trim() ? snippet(sticky.text.trim()) : "Sticky note") : sticker ? stickerName(sticker) : "Glass mark" } };
    }
    for (const id in elementBoxes.current) {
      const box = elementBoxes.current[id];
      if (!box || !inside(box)) continue;
      const area = box.width * box.height;
      if (best && area >= best.area) continue;
      const element = elements.current.list.find(item => item.id === id);
      if (!element) continue;
      const block = blocks.current.find(item => item.element?.dataset.cid === id) ?? blocks.current.find(item => item.line === element.blockLine);
      const anchor = block ? anchorOf(block) : { landmarks: [{ kind: "block" as const, block: element.text, headings: element.headings, line: element.line }] };
      best = { area, hit: { end: { kind: "element", element: id, anchor }, box, name: `${elementKindName(element.kind)}: ${snippet(element.text)}` } };
    }
    return best?.hit;
  }, []);

  const forget = useCallback((id: string) => {
    setMagnets(current => current.filter(item => item.id !== id));
    setImages(current => current.filter(item => item.id !== id));
    setStickers(current => current.filter(item => item.id !== id));
    setArrows(current => current.filter(item => item.id !== id));
    setCards(current => current.filter(item => item.id !== id));
    setSelected(current => current === id ? undefined : current);
    setSelectedArrow(current => current === id ? undefined : current);
  }, []);

  const removeMark = useCallback((id: string) => {
    forget(id);
    void send({ action: "delete", magnet: id });
  }, [forget, send]);

  const restore = useCallback(async (magnet: GlassMagnet) => {
    const value = await send({ action: "restore", magnet: magnet.id });
    if (!value?.magnet) return;
    const restored = value.magnet;
    if (restored.kind === "sticky") {
      const note = stickyFromMagnet(restored);
      if (note) setMagnets(current => [...current, note]);
    } else if (restored.kind === "image") {
      const picture = imageFromMagnet(restored);
      if (picture) setImages(current => [...current, picture]);
    } else if (restored.kind === "sticker") {
      const mark = stickerFromMagnet(restored);
      if (mark) setStickers(current => [...current, mark]);
    } else if (restored.kind === "arrow") {
      const arrow = arrowFromMagnet(restored);
      if (arrow) setArrows(current => [...current, arrow]);
    } else if (restored.kind === "card") {
      const card = cardFromMagnet(restored);
      if (card) setCards(current => [...current, card]);
    } else void load();
    setOpenTrash(false);
  }, [load, send]);

  // Merge down is the only path into the page: preview first, the user presses Accept, the page is reloaded.
  const openMerge = useCallback(async (magnet: string) => {
    if (!latest.current.note) return;
    if (!documentSaved) { setNotice("Save the note before merging down."); return; }
    setMergeBusy(true);
    try {
      const value = await glassCall({ note: latest.current.note, action: "merge-preview", magnet });
      if (value?.merge) { setMergeOpen(value.merge); setMergeStale(undefined); setUndoPending(undefined); }
    } catch (error) { setNotice(message(error)); }
    finally { setMergeBusy(false); }
  }, [documentSaved]);

  const acceptMerge = useCallback(async (preview: MergePreview) => {
    if (!latest.current.note) return;
    setMergeBusy(true);
    try {
      const value = await glassCall({ note: latest.current.note, action: "merge-accept", magnet: preview.magnet,
        expectedHash: preview.baseHash, approved: true });
      if (value?.stale && value.preview) { setMergeStale(value.preview); return; }
      if (!value?.merged) return;
      setMergeOpen(undefined);
      setMergeStale(undefined);
      setMergeDone(Array.isArray(value.history) ? value.history.find(entry => !entry.undone) : undefined);
      setMergeHistory(Array.isArray(value.history) ? value.history : []);
      await reloadNote?.();
      await load();
    } catch (error) { setNotice(message(error)); }
    finally { setMergeBusy(false); }
  }, [load, reloadNote]);

  const undoMerge = useCallback(async (id?: string) => {
    if (!latest.current.note) return;
    const key = id ?? "latest";
    const force = undoPending === key;
    try {
      const value = await glassCall({ note: latest.current.note, action: "merge-undo", ...(id ? { merge: id } : {}), ...(force ? { force: true } : {}) });
      if (value?.undoStale) {
        setUndoPending(key);
        setNotice("The note changed after the merge. Press Undo again to restore it anyway.");
        return;
      }
      if (!value?.undone) return;
      setNotice("Merge undone. The page is byte-identical to before.");
      setMergeDone(undefined);
      setUndoPending(undefined);
      setMergeHistory(Array.isArray(value.history) ? value.history : []);
      await reloadNote?.();
      await load();
    } catch (error) { setNotice(message(error)); }
  }, [load, reloadNote, undoPending]);

  const jumpToSource = useCallback((source: { line: number }) => {
    editor()?.jump(source.line);
  }, [editor]);

  const liftUp = useCallback(async (detail: { id?: string }) => {
    if (!latest.current.note || !detail.id) return;
    if (!documentSaved) { setNotice("Save the note before lifting an element."); return; }
    try {
      const value = await glassCall({ note: latest.current.note, action: "lift-up", element: detail.id });
      if (!value?.magnet) return;
      await load();
      setNotice("Lifted onto the glass. The page is unchanged.");
    } catch (error) { setNotice(message(error)); }
  }, [documentSaved, load]);

  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.action === "lift") void liftUp(detail);
    };
    window.addEventListener("omarkie:element-action", onAction);
    return () => window.removeEventListener("omarkie:element-action", onAction);
  }, [liftUp]);

  useEffect(() => {
    if (!documentSaved && mergeOpen) {
      setMergeOpen(undefined);
      setMergeStale(undefined);
      setNotice("Save the note before merging down.");
    }
  }, [documentSaved, mergeOpen]);

  useEffect(() => {
    if (!mergeOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMergeOpen(undefined);
      setMergeStale(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mergeOpen]);

  useEffect(() => {
    if (!mergeDone) return;
    const timer = setTimeout(() => setMergeDone(undefined), 8_000);
    return () => clearTimeout(timer);
  }, [mergeDone]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, [contenteditable='true'], .cm-content")) return;
      if (event.key === "n" || event.key === "N") { event.preventDefault(); createAtCenter(); }
      else if (event.key === "p" || event.key === "P") { event.preventDefault(); chooseInk("pen"); }
      else if (event.key === "h" || event.key === "H") { event.preventDefault(); chooseInk("highlighter"); }
      else if (event.key === "e" || event.key === "E") { event.preventDefault(); chooseInk("eraser"); }
      else if (event.key === "Escape") { setTool(current => current === "ink" ? "select" : current); setSelected(undefined); setSelectedArrow(undefined); setEditing(undefined); setOpenTrash(false); }
      else if ((event.key === "Delete" || event.key === "Backspace") && selectedArrow) { event.preventDefault(); removeMark(selectedArrow); }
      else if ((event.key === "Delete" || event.key === "Backspace") && selected && stickers.some(item => item.id === selected)) {
        event.preventDefault();
        removeMark(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chooseInk, createAtCenter, removeMark, selected, selectedArrow, stickers]);

  const orphans = [...magnets, ...images, ...stickers, ...cards].filter(mark => layout.places[mark.id]?.status === "orphan");
  const visible = magnets.filter(stickie => layout.places[stickie.id]?.status === "resolved");
  const shown = images.filter(image => layout.places[image.id]?.status === "resolved");
  const shownCards = cards.filter(card => layout.places[card.id]?.status === "resolved");
  const under = shown.filter(image => image.wrap === "behind");
  const above = shown.filter(image => image.wrap !== "behind");
  const visibleStickers = stickers.filter(mark => layout.places[mark.id]?.status === "resolved");
  const orphanArrows = arrows.filter(arrow => layout.orphanArrows.includes(arrow.id));
  const statusLabel = !note ? "Save this note first" : saved === "saving" ? "Saving" : saved === "error" ? "Not saved" : saved === "saved" ? "Saved" : "Glass";

  useEffect(() => {
    if (!under.length) return;
    root.classList.add("glass-above");
    return () => root.classList.remove("glass-above");
  }, [under.length, root]);

  const frame = (image: GlassImage) => {
    const place = layout.places[image.id];
    if (place?.status !== "resolved") return null;
    const line = matchIndexed(index.current, image.anchor);
    const column = image.wrap === "behind" || image.wrap === "front" ? 0 : blocks.current.find(block => block.line === line)?.element?.clientWidth ?? 0;
    const maxWidth = column ? Math.max(imageDefaults.minW, Math.round(column * 0.6)) : undefined;
    return <GlassImageFrame key={image.id} image={image} place={place} selected={selected === image.id} note={note} scroller={scroller}
      paintHost={underHost} maxWidth={maxWidth} onSelect={() => { setSelected(image.id); setSelectedArrow(undefined); setEditing(undefined); }}
      onPatch={(patch, persist) => patchImage(image.id, patch, persist)}
      onDrop={drop => imageDrop(image, drop)}
      onSnap={(dx, dy, alt) => imageSnap(image, dx, dy, alt)}
      onSnapEnd={() => { snapCache.current = undefined; paintGuides([], 0); }}
      onSettle={settle}
      onLiveSize={(width, height) => liveImageSize(image.id, width, height)}
      onMerge={() => void openMerge(image.id)}
      {...(image.source ? { onJump: () => jumpToSource(image.source!) } : {})}
      onDelete={() => removeMark(image.id)} />;
  };

  const marksPalette = tool === "sticker" ? <div className="glass-palette" role="group" aria-label="Stickers" data-glass-palette="sticker">
    <p className="glass-palette-title">Stickers</p>
    <div className="glass-palette-row">
      {stickerIds.map(id => <button type="button" key={id} data-sticker={id} aria-pressed={stickerChoice === id}
        aria-label={stickerName({ sticker: id })} title={stickerName({ sticker: id })}
        onClick={() => { setStickerChoice(id); setCustomImage(undefined); }}>
        <StickerArt id={id} label={stickerName({ sticker: id })} />
      </button>)}
    </div>
    <div className="glass-palette-row">
      <button type="button" className="glass-palette-custom" data-sticker-custom aria-pressed={stickerChoice === "custom"}
        onClick={() => fileInput.current?.click()}>Custom image…</button>
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden data-sticker-file onChange={pickSticker} />
      {customImage && <span className="glass-palette-hint">Custom sticker ready</span>}
    </div>
    <p className="glass-palette-hint">Pick a sticker, then click a paragraph.</p>
  </div> : tool === "arrow" ? <div className="glass-palette" role="group" aria-label="Arrows" data-glass-palette="arrow">
    <p className="glass-palette-title">Arrows</p>
    <div className="glass-palette-row">
      <button type="button" data-arrow-style="straight" aria-pressed={arrowStyle === "straight"} aria-label="Straight arrow" title="Straight"
        onClick={() => setArrowStyle("straight")}>╱</button>
      <button type="button" data-arrow-style="curved" aria-pressed={arrowStyle === "curved"} aria-label="Curved arrow" title="Curved"
        onClick={() => setArrowStyle("curved")}>⌒</button>
      <span className="glass-tray-rule" aria-hidden="true" />
      {(["ink", "red", "blue", "green"] as const).map(colour => <button type="button" key={colour} data-arrow-pick-colour={colour}
        aria-pressed={arrowColor === colour} aria-label={`${colour} arrow`} title={colour} className="glass-arrow-swatch"
        style={{ color: colour === "red" ? "#cf3b32" : colour === "blue" ? "#2f6fb5" : colour === "green" ? "#2f9e5f" : "var(--ink, #333)" }}
        onClick={() => setArrowColor(colour)}>●</button>)}
      <span className="glass-tray-rule" aria-hidden="true" />
      {(["solid", "open", "none"] as const).map(shape => <button type="button" key={shape} data-arrow-pick-head={shape}
        aria-pressed={arrowHead === shape} aria-label={`${shape} head`} title={shape} onClick={() => setArrowHead(shape)}>
        {shape === "solid" ? "▸" : shape === "open" ? "›" : "—"}</button>)}
    </div>
    <p className="glass-palette-hint">Drag from a paragraph or sticker to another; the far end scrolls into view.</p>
  </div> : tool === "grid" ? <div className="glass-palette" role="group" aria-label="Grid" data-glass-palette="grid">
    <p className="glass-palette-title">Grid</p>
    <div className="glass-palette-row">
      <button type="button" data-grid-size="off" aria-pressed={!grid.on} onClick={() => setGrid(current => ({ ...current, on: false }))}>Off</button>
      {snapDefaults.sizes.map(size => <button type="button" key={size} data-grid-size={size} aria-pressed={grid.on && grid.size === size}
        aria-label={`Grid ${size}`} onClick={() => setGrid({ on: true, size })}>{size}</button>)}
    </div>
    <p className="glass-palette-hint">Magnets line up with the grid, each other and the text column. Hold Alt to move free.</p>
  </div> : null;
  const cardPoint = () => {
    const surface = scroller.getBoundingClientRect();
    const view = editor()?.view();
    const line = view ? view.state.doc.lineAt(view.state.selection.main.head).number : -1;
    const block = blocks.current.find(item => item.line === line && item.element)
      ?? nearestBlock(blocks.current, { x: surface.left + 160, y: surface.top + 140 });
    const rect = block?.element?.getBoundingClientRect();
    return rect ? { x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + 4 } : { x: surface.left + 160, y: surface.top + 140 };
  };

  const tray = <div className="glass-tray" role="toolbar" aria-label="Pencil case" data-glass-tray>
    <button type="button" data-glass-tool="select" aria-pressed={tool === "select"} aria-label="Select" title="Select, move, resize" onClick={() => setTool("select")}><MousePointer2 size={15} /></button>
    <button type="button" data-glass-tool="sticky" aria-pressed={tool === "sticky"} aria-label="Sticky note" title="Sticky note (N)" onClick={() => setTool("sticky")}><StickyIcon size={15} /></button>
    <button type="button" data-glass-tool="image" aria-label="Image" title="Image: drop, paste or choose a file" onClick={() => picker.current?.click()}><ImageIcon size={15} /></button>
    <input ref={picker} type="file" accept="image/*,.heic,.heif,.tif,.tiff" multiple hidden data-glass-file
      onChange={event => {
        const files = [...(event.target.files ?? [])];
        event.target.value = "";
        const surface = layer.current?.getBoundingClientRect();
        if (files.length) void addImages(files, { x: (surface?.left ?? 0) + 120, y: (surface?.top ?? 0) + 160 });
      }} />
    <span className="glass-tray-rule" aria-hidden="true" />
    <button type="button" data-glass-tool="ink" aria-pressed={tool === "ink" && inkTool !== "eraser"} aria-label="Pen" title="Pen (P)" onClick={() => chooseInk("pen")}><PenLine size={15} /></button>
    <button type="button" data-glass-tool="highlighter" aria-pressed={tool === "ink" && inkTool === "highlighter"} aria-label="Highlighter" title="Highlighter (H)" onClick={() => chooseInk("highlighter")}><Highlighter size={15} /></button>
    <button type="button" data-glass-tool="eraser" aria-pressed={tool === "ink" && inkTool === "eraser"} aria-label="Eraser" title="Eraser (E)" onClick={() => chooseInk("eraser")}><Eraser size={15} /></button>
    <button type="button" data-glass-tool="sticker" aria-pressed={tool === "sticker"} aria-label="Sticker" title="Stickers" onClick={() => setTool("sticker")}><Star size={15} /></button>
    <button type="button" data-glass-tool="arrow" aria-pressed={tool === "arrow"} aria-label="Arrow" title="Arrow between two things" onClick={() => setTool("arrow")}><ArrowUpRight size={15} /></button>
    <button type="button" data-glass-grid aria-pressed={grid.on} aria-expanded={tool === "grid"} aria-label="Grid" title="Grid: line magnets up with the paper" onClick={() => setTool(current => current === "grid" ? "select" : "grid")}><Grid3x3 size={15} /></button>
    <span className="glass-tray-rule" aria-hidden="true" />
    <button type="button" data-glass-tool="card" aria-haspopup="dialog" aria-label="Card" title="Card: section, tutor answer or quiz"
      onClick={() => setCardOpen(true)}><SquareStack size={15} /></button>
    {comingSoon.map(({ id, label, icon: Icon }) => <button type="button" key={id} data-glass-coming={id} aria-disabled="true"
      aria-label={label} title={`${label} — coming soon`} onClick={() => setNotice(`${label} is coming soon.`)}><Icon size={15} /></button>)}
    <span className="glass-tray-rule" aria-hidden="true" />
    <button type="button" data-ink-undo aria-label="Undo ink" title="Undo ink" disabled={!inkHistory.undo}
      onClick={() => inkApi.current?.undo()}><Undo2 size={15} /></button>
    <button type="button" data-ink-redo aria-label="Redo ink" title="Redo ink" disabled={!inkHistory.redo}
      onClick={() => inkApi.current?.redo()}><Redo2 size={15} /></button>
    <span className="glass-tray-rule" aria-hidden="true" />
    {ink.length > 0 && <button type="button" data-glass-merge-ink aria-label="Merge ink down" title="Merge the newest ink stroke into the page"
      onClick={() => void openMerge(ink[ink.length - 1].id)}>⇩</button>}
    {mergeHistory.some(entry => !entry.undone) && <button type="button" data-glass-merge-undo aria-label="Undo last merge" title="Undo the last merge down"
      onClick={() => void undoMerge()}>↺</button>}
    <span className="glass-tray-rule" aria-hidden="true" />
    <button type="button" data-glass-trash aria-expanded={openTrash} aria-haspopup="dialog" aria-label={`Glass trash, ${trash.length}`}
      title="Glass trash" onClick={() => setOpenTrash(open => !open)}><Trash2 size={15} /><span className="glass-tray-count" data-glass-trash-count>{trash.length}</span></button>
    <span className="glass-tray-status" data-glass-saved={saved} role="status">{statusLabel}</span>
  </div>;
  const inkPalette = tool === "ink" ? <div className="glass-palette" role="group" aria-label="Ink colours and widths" data-ink-palette>
    {inkTool === "eraser" ? <>
      <button type="button" data-ink-eraser="bite" aria-pressed={eraserMode === "bite"} title="Rub out part of a stroke" onClick={() => setEraserMode("bite")}>Bite</button>
      <button type="button" data-ink-eraser="stroke" aria-pressed={eraserMode === "stroke"} title="Rub out whole strokes" onClick={() => setEraserMode("stroke")}>Whole stroke</button>
    </> : <>
      {inkColors[inkTool].map(colour => <button type="button" key={colour} className="glass-palette-colour" data-ink-colour={colour}
        aria-label={`Ink ${colour}`} aria-pressed={inkColor === colour} style={{ background: colour }} onClick={() => setInkColor(colour)} />)}
      {inkTool === "pen" && <span className="glass-tray-rule" aria-hidden="true" />}
      {inkTool === "pen" && inkWidths.pen.map(width => <button type="button" key={width} data-ink-width={width}
        aria-label={`Pen width ${width}`} aria-pressed={inkSize === width} onClick={() => setInkSize(width)}>
        <span className="glass-palette-tip" style={{ height: `${width}px` }} />
      </button>)}
    </>}
  </div> : null;
  const panel = <>{tray}{inkPalette ?? marksPalette}{openTrash && <div className="glass-trash" role="dialog" aria-label="Glass trash">
    <strong>Glass trash</strong>
    {trash.length ? <ul>{trash.map(magnet => <li key={magnet.id}>
      <span>{magnetLabel(magnet)}</span>
      <button type="button" data-glass-restore={magnet.id} onClick={() => void restore(magnet)}>Undo</button>
    </li>)}</ul> : <p>Nothing deleted.</p>}
  </div>}{(orphans.length > 0 || orphanArrows.length > 0) && <div className="glass-orphans" role="group" aria-label="Marks whose paragraph is gone">
    <strong>Anchor lost</strong>
    {orphans.map(mark => <span key={mark.id} data-glass-orphan={mark.id}>
      <span>{"text" in mark ? mark.text.trim().slice(0, 32) || "Empty note" : "name" in mark ? mark.name.slice(0, 32) : "card" in mark ? mark.title.slice(0, 32) || "Card" : stickerName(mark)}</span>
      <button type="button" aria-label="Move orphan to trash" onClick={() => removeMark(mark.id)}>×</button>
    </span>)}
    {orphanArrows.map(arrow => <span key={arrow.id} data-glass-orphan-arrow={arrow.id}>
      <span>{arrow.label.trim() ? `Arrow: ${snippet(arrow.label.trim())}` : "Arrow with a lost end"}</span>
      <button type="button" aria-label="Move orphan arrow to trash" onClick={() => removeMark(arrow.id)}>×</button>
    </span>)}
  </div>}{cardOpen && note && <NewCardDialog blocks={blocks.current}
    point={cardPoint()}
    close={() => setCardOpen(false)} create={card => { void createCard(card); setCardOpen(false); }} />}{notice && <p className="glass-notice" role="status">{notice}</p>}
  {mergeDone && <div className="glass-merge-done" role="status" data-glass-merge-done>
    <span>Merged into the page.</span>
    <button type="button" data-glass-merge-undo={mergeDone.id} onClick={() => void undoMerge(mergeDone.id)}>Undo</button>
  </div>}</>;
  const mergeDialog = mergeOpen && <div className="glass-merge-dialog" role="dialog" aria-modal="true" aria-label="Merge down preview" data-glass-merge-dialog>
    <header>
      <div><strong>{mergeOpen.label}</strong><span>{mergeOpen.element.kind} · line {mergeOpen.element.line}</span></div>
      <button type="button" className="glass-merge-close" aria-label="Cancel merge" data-glass-merge-cancel
        onClick={() => { setMergeOpen(undefined); setMergeStale(undefined); }}>×</button>
    </header>
    <p className="glass-merge-meta">
      {["image", "ink"].includes(mergeOpen.kind) ? `${mergeOpen.linkStyle === "wikilink" ? "Vault links use ![[…]]" : "Vault links use ![](…)"} · attachment folder ${mergeOpen.attachmentFolder || "next to the note"} · ` : ""}{Math.round((mergeOpen.confidence <= 1 ? mergeOpen.confidence * 100 : mergeOpen.confidence))}% match
    </p>
    <p className="glass-merge-counts">{mergeOpen.added.length} line{mergeOpen.added.length === 1 ? "" : "s"} added, {mergeOpen.removed.length} removed, everything else stays byte-identical.</p>
    <MergeDiff rows={mergeOpen.diff} stamp="preview" />
    {mergeStale ? <section className="glass-merge-stale" data-glass-merge-stale>
      <p role="alert">The note changed since this preview. Nothing has been written. Choose which version to merge into.</p>
      <p className="glass-merge-counts">Your preview was based on {mergeOpen.baseSize} bytes; the note now has {mergeStale.baseSize} bytes.</p>
      <h4>Your preview</h4>
      <MergeDiff rows={mergeOpen.diff} stamp="old" />
      <h4>The note now</h4>
      <MergeDiff rows={mergeStale.diff} stamp="current" />
      <div className="glass-merge-actions">
        <button type="button" className="glass-merge-accept" disabled={mergeBusy} data-glass-merge-accept={mergeStale.magnet}
          onClick={() => void acceptMerge(mergeStale)}>Merge into the updated note</button>
        <button type="button" data-glass-merge-cancel onClick={() => { setMergeOpen(undefined); setMergeStale(undefined); }}>Cancel</button>
      </div>
    </section> : <div className="glass-merge-actions">
      <button type="button" className="glass-merge-accept" disabled={mergeBusy} data-glass-merge-accept={mergeOpen.magnet}
        onClick={() => void acceptMerge(mergeOpen)}>Accept</button>
      <button type="button" data-glass-merge-cancel onClick={() => { setMergeOpen(undefined); setMergeStale(undefined); }}>Cancel</button>
    </div>}
  </div>;

  return <>
    <GlassLandmarks editor={editor} root={root} nodes={nodes} groups={groups} note={note}
      saved={documentSaved} magnets={landmarks} seeds={seeds} />
    {note && <BubbleLayer editor={editor} root={root} note={note} live={live} pin={pinCard} magnets={comments} reload={load} />}
    {createPortal(<><div className="glass-layer" ref={layer} data-glass="on" data-grid={grid.on ? grid.size : "off"}>
      {grid.on && <div className="glass-grid" aria-hidden="true" data-glass-grid={grid.size} />}
      <div className="glass-guides" ref={guidesEl} aria-hidden="true" data-snap="off">
        <span className="glass-guide" data-guide="x" hidden />
        <span className="glass-guide" data-guide="y" hidden />
        <span className="glass-guide" data-guide="spacing" hidden />
      </div>
      {(ink.length > 0 || tool === "ink" || inkHistory.undo || inkHistory.redo) && <GlassInk
        editor={editor} root={root} note={note} tool={tool === "ink" ? inkTool : null} color={inkColor} size={inkSize}
        magnets={ink} send={send} reloadInk={load} saved={saved} eraser={eraserMode} api={inkApi} onHistory={inkHistoryChange} onNotice={setNotice} />}
      {(tool === "sticky" || tool === "sticker") && note && <div className="glass-surface" data-glass-surface onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        if (tool === "sticker") placeSticker({ x: event.clientX, y: event.clientY });
        else create({ x: event.clientX, y: event.clientY });
      }} />}
      {layout.fixture && (layout.fixture.status === "resolved"
        ? <div className="glass-debug" data-glass-object="fixture" data-glass-status="resolved"
            style={{ left: `${layout.fixture.x}px`, top: `${layout.fixture.y}px`, width: `${layout.fixture.width}px`, height: `${layout.fixture.height}px` }} />
        : <div className="glass-debug" data-glass-object="fixture" data-glass-status="orphan" />)}
      {visible.map(stickie => <StickyView key={stickie.id} note={stickie} place={layout.places[stickie.id]} selected={selected === stickie.id}
        editing={editing === stickie.id} onSelect={() => { setSelected(stickie.id); setSelectedArrow(undefined); setEditing(undefined); }}
        onEdit={editingNow => setEditing(editingNow ? stickie.id : undefined)}
        onText={text => { setMagnets(current => current.map(item => item.id === stickie.id ? { ...item, text } : item)); void send({ action: "set", magnet: stickie.id, fields: { text } }); }}
        onFold={folded => { setMagnets(current => current.map(item => item.id === stickie.id ? { ...item, folded } : item)); void send({ action: "set", magnet: stickie.id, fields: { folded } }); }}
        onColor={color => { setMagnets(current => current.map(item => item.id === stickie.id ? { ...item, color } : item)); void send({ action: "set", magnet: stickie.id, fields: { color } }); }}
        onMerge={() => void openMerge(stickie.id)}
        {...(stickie.source ? { onJump: () => jumpToSource(stickie.source!) } : {})}
        onDelete={() => removeMark(stickie.id)} />)}
      {shownCards.map(card => { const place = layout.places[card.id]; return place?.status !== "resolved" ? null :
        <GlassCardView key={card.id} card={card} place={{ x: place.x, y: place.y, width: place.width }} note={note!} live={live}
          onToggle={() => toggleCard(card.id)}
          onCached={(answer, answerAt) => patchCard(card.id, { answer, answerAt })}
          onDelete={() => removeMark(card.id)} onMerge={() => void openMerge(card.id)} />; })}
      {above.map(frame)}
      {under.map(frame)}
      {visibleStickers.map(sticker => <StickerView key={sticker.id} sticker={sticker} place={layout.places[sticker.id]} selected={selected === sticker.id}
        onSelect={() => { setSelected(sticker.id); setSelectedArrow(undefined); }}
        onRotate={rotate => { setStickers(current => current.map(item => item.id === sticker.id ? { ...item, rotate } : item)); void send({ action: "set", magnet: sticker.id, fields: { rotate } }); }}
        onNudge={(dx, dy) => {
          const step = grid.on ? grid.size : 1;
          const x = Math.round((sticker.x + dx) / step) * step, y = Math.round((sticker.y + dy) / step) * step;
          setStickers(current => current.map(item => item.id === sticker.id ? { ...item, x, y } : item));
          void send({ action: "set", magnet: sticker.id, fields: { x, y } });
        }}
        onDelete={() => removeMark(sticker.id)} />)}
      {note && (arrows.length > 0 || tool === "arrow") && <ArrowOverlay routes={layout.routes} arrows={arrows} selected={selectedArrow} view={viewport} names={layout.names}
        tool={tool === "arrow"} style={arrowStyle} color={arrowColor} scroller={scroller} hitTest={hitTest}
        onCreate={createArrow} onSelect={id => { setSelectedArrow(id); if (id) setSelected(undefined); }}
        onDelete={removeMark} onUpdate={updateArrow} onMissing={() => setNotice("Start on a paragraph or a sticker.")} />}
    </div></>, scroller)}
    {mergeDialog && createPortal(mergeDialog, document.body)}
    {createPortal(<div className="glass-under" data-glass-under><div className="glass-under-host" ref={setUnderHost} /></div>, scroller)}
    {createPortal(panel, document.body)}
  </>;
}

// The jump chip names the far end: a page element's kind and words, or the mark itself.
function endName(end: ArrowMark["from"], list: readonly PageElement[], ends: ArrowEndContext,
  latest: { magnets: StickyNote[]; stickers: StickerMark[] }) {
  if (end.kind === "magnet") {
    const sticky = latest.magnets.find(item => item.id === end.magnet);
    if (sticky) return sticky.text.trim() ? snippet(sticky.text.trim()) : "Sticky note";
    const sticker = latest.stickers.find(item => item.id === end.magnet);
    return sticker ? stickerName(sticker) : "Glass mark";
  }
  const line = ends.line(end.anchor);
  const candidates = line === null ? [] : list.filter(element => element.blockLine === line);
  const element = candidates.find(item => item.id === end.element) ?? candidates[0];
  return element ? `${elementKindName(element.kind)}: ${snippet(element.text)}` : "Page element";
}
