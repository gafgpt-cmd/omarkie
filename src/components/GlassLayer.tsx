import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import interact from "interactjs";
import { ArrowUpRight, Highlighter, Image as ImageIcon, MousePointer2, PenLine, Scissors, SquareStack, Star, StickyNote as StickyIcon, Trash2 } from "lucide-react";
import type { EditorHandle, ReadingContext } from "../editor/MarkdownEditor";
import { captureAnchor, indexBlocks, liveBlocks, matchIndexed, placeAnchor, type BlockIndex, type GlassBlock, type GlassPlacement } from "../glass/anchor-map";
import { fixtureAnchor, glassFixture, rememberFixtureAnchor } from "../glass/glass-state";
import GlassLandmarks, { landmarkSeeds } from "./GlassLandmarks";
import BubbleLayer from "./BubbleLayer";
import type { LiveTutor } from "./tutor-live";
import type { TutorReply } from "./tutor-verbs";
import type { StudyOverlay } from "./learning-overlays";
import {
  anchorOf, nearestBlock, newStickyId, offsetIn, snapped, stickyDefaults, stickyFields, stickyFromMagnet, stickyColors,
  type GlassMagnet, type StickyNote,
} from "../glass/glass-model";
import { displayNeeded, imageDefaults, imageTypeOf } from "../../shared/glass-images.mjs";
import { imageFromMagnet, type GlassImage } from "../glass/image-model";
import { imageCopy } from "../glass/glass-assets";
import { cardAnchor, cardFieldsOf, cardFromMagnet, newCardId, pillPlacement, type GlassCard } from "../glass/card-model";
import GlassCardView, { NewCardDialog } from "./GlassCard";
import GlassImageFrame from "./GlassImage";
import "./glass.css";

interface Layout { places: Record<string, GlassPlacement>; fixture?: GlassPlacement; loaded?: boolean }
interface Reply { ok: boolean; value?: GlassReply; error?: string }
interface GlassReply {
  magnets?: GlassMagnet[];
  trash?: GlassMagnet[];
  magnet?: GlassMagnet | null;
  saved?: boolean;
}
const comingSoon = [
  { id: "ink", label: "Ink", icon: PenLine },
  { id: "highlighter", label: "Highlighter", icon: Highlighter },
  { id: "sticker", label: "Sticker", icon: Star },
  { id: "arrow", label: "Arrow", icon: ArrowUpRight },
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
const magnetLabel = (magnet: GlassMagnet) => {
  const fields = magnet.fields ?? {};
  if (fields.kind === "image") return typeof fields.name === "string" && fields.name.trim() ? fields.name : "Image";
  if (fields.kind === "card") return typeof fields.title === "string" && fields.title.trim() ? fields.title.trim() : "Card";
  return typeof fields.text === "string" && fields.text.trim() ? fields.text.trim() : "Empty note";
};
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

// One sticky note: paper, six colours, fold to a dot, delete to the trash, typing saved as it settles.
function StickyView({ note, place, selected, editing, onSelect, onEdit, onText, onFold, onColor, onDelete }: {
  note: StickyNote; place: GlassPlacement; selected: boolean; editing: boolean; onSelect(): void; onEdit(editing: boolean): void;
  onText(text: string): void; onFold(folded: boolean): void; onColor(color: StickyNote["color"]): void; onDelete(): void;
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
        <button type="button" className="glass-note-tool" aria-label="Move note to trash" title="Move to trash" onClick={onDelete}>×</button>
      </div>
      <span className="glass-note-grip glass-note-grip-right" data-grip="right" aria-hidden="true" />
      <span className="glass-note-grip glass-note-grip-bottom" data-grip="bottom" aria-hidden="true" />
    </>}
  </div>;
}

export default function GlassLayer({ editor, root, nodes, groups, note, saved: documentSaved, live }: {
  editor(): EditorHandle | undefined; root: HTMLElement; nodes: ReadingContext["nodes"]; groups: StudyOverlay[]; note?: string; saved: boolean;
  live?: LiveTutor;
}) {
  const scroller = root.parentElement!;
  const layer = useRef<HTMLDivElement>(null);
  const fixture = useMemo(glassFixture, []);
  const seeds = useMemo(landmarkSeeds, []);
  const [landmarks, setLandmarks] = useState<GlassMagnet[]>([]);
  const [comments, setComments] = useState<GlassMagnet[]>([]);
  const [magnets, setMagnets] = useState<StickyNote[]>([]);
  const [images, setImages] = useState<GlassImage[]>([]);
  const [cards, setCards] = useState<GlassCard[]>([]);
  const [trash, setTrash] = useState<GlassMagnet[]>([]);
  const [layout, setLayout] = useState<Layout>({ places: {} });
  const [tool, setTool] = useState<"select" | "sticky">("select");
  const [cardOpen, setCardOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const [openTrash, setOpenTrash] = useState(false);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [notice, setNotice] = useState("");
  const [underHost, setUnderHost] = useState<HTMLDivElement | null>(null);
  const blocks = useRef<GlassBlock[]>([]), index = useRef<BlockIndex>(indexBlocks([]));
  const spacers = useRef(new Map<string, HTMLSpanElement>());
  const picker = useRef<HTMLInputElement>(null);
  const latest = useRef({ magnets, images, cards, note, tool });
  const fingerprint = useRef(""), mounted = useRef(false), ready = useRef(false), loaded = useRef(!note), dragging = useRef(false);
  const queue = useRef(Promise.resolve<unknown>(undefined));
  const localAt = useRef(0), revision = useRef(0);
  latest.current = { magnets, images, cards, note, tool };

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
    for (const stickie of latest.current.magnets) {
      const line = matchIndexed(index.current, stickie.anchor);
      const element = line === null ? undefined : byLine.get(line)?.element;
      if (!element) { places[stickie.id] = { status: "orphan" }; continue; }
      const rect = element.getBoundingClientRect();
      places[stickie.id] = { status: "resolved", x: rect.left - frame.left + stickie.x, y: rect.top - frame.top + stickie.y, width: stickie.w, height: stickie.h };
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
      const line = matchIndexed(index.current, card.anchor);
      const element = line === null ? undefined : byLine.get(line)?.element;
      if (!element) { places[card.id] = { status: "orphan" }; continue; }
      const spot = pillPlacement(element.getBoundingClientRect(), frame);
      places[card.id] = { status: "resolved", x: spot.x + card.x, y: spot.y + card.y + cardRow * 24, width: spot.width, height: 0 };
      cardRow += 1;
    }
    dropSpacers(flowing);
    let marker: GlassPlacement | undefined;
    if (fixture && !seeds?.length) {
      let anchor = fixtureAnchor();
      if (!anchor) {
        const paragraph = blocks.current.find(block => block.element?.tagName === "P" && !!block.element.textContent?.trim());
        if (paragraph) { anchor = captureAnchor(paragraph, blocks.current); rememberFixtureAnchor(anchor); }
      }
      if (anchor) marker = placeAnchor(anchor, { x: 0, y: 0 }, blocks.current, surface);
    }
    if (!mounted.current) { mounted.current = true; performance.mark("omarkie:glass-mounted"); }
    const serialized = JSON.stringify([places, marker ?? null, loaded.current]);
    if (serialized === fingerprint.current) return;
    fingerprint.current = serialized;
    setLayout({ places, fixture: marker, loaded: loaded.current });
  }, [dropSpacers, editor, fixture, flow, root, seeds]);

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
        const stickies: StickyNote[] = [], nextImages: GlassImage[] = [], nextCards: GlassCard[] = [], incoming: GlassMagnet[] = [], nextComments: GlassMagnet[] = [];
        for (const magnet of value.magnets ?? []) {
          if (magnet.kind === "sticky") {
            const sticky = stickyFromMagnet(magnet);
            if (sticky) stickies.push(sticky);
          } else if (magnet.kind === "image") {
            const picture = imageFromMagnet(magnet);
            if (picture) nextImages.push(picture);
          } else if (magnet.kind === "card") {
            const card = cardFromMagnet(magnet);
            if (card) nextCards.push(card);
          } else if (magnet.kind === "comment") nextComments.push(magnet);
          else incoming.push(magnet);
        }
        setMagnets(stickies);
        setImages(nextImages);
        setCards(previous => JSON.stringify(previous) === JSON.stringify(nextCards) ? previous : nextCards);
        setLandmarks(previous => JSON.stringify(previous) === JSON.stringify(incoming) ? previous : incoming);
        setComments(previous => JSON.stringify(previous) === JSON.stringify(nextComments) ? previous : nextComments);
        setTrash(value.trash ?? []);
        setSaved("saved");
      } catch (error) { setSaved("error"); setNotice(message(error)); }
    });
    queue.current = run;
    return run;
  }, []);

  useEffect(() => {
    void load();
    const subscribe = window.desktop?.onGlassChanged;
    const stop = subscribe?.((event: { note?: string; action?: string; self?: boolean } | undefined) => {
      if (event?.self) return;
      if (event && (event.note === latest.current.note || event.action === "bring" && !event.note)) void load();
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
    measure();
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

  useEffect(() => { measure(); }, [magnets, images, cards, measure]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const update = useCallback((id: string, patch: Partial<StickyNote>) => {
    setMagnets(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
  }, []);

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
    return send({ action: "add", magnet: card.id, fields: cardFieldsOf(card) });
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
    await createCard(card);
    return true;
  }, [createCard]);

  useEffect(() => {
    const surface = layer.current;
    if (!surface) return;
    // interact hands listeners the interactable element, not the note under the pointer, so remember it.
    let downSource: Element | null = null;
    const track = (event: Event) => { downSource = event.target as Element; };
    surface.addEventListener("pointerdown", track, true);
    const noteElement = (target: Element) => ((downSource ?? target).closest?.(".glass-note") ?? target) as HTMLElement;
    const instance = interact(surface);
    let drag: { element: HTMLElement; id: string; x: number; y: number; pageX: number; pageY: number } | undefined;
    instance.draggable({
      allowFrom: ".glass-note, .glass-note-head",
      ignoreFrom: ".glass-note-text, .glass-note-tools, .glass-note-grip, .glass-note-dot",
      listeners: {
        start(event) {
          const element = noteElement(event.target);
          const stickie = latest.current.magnets.find(item => item.id === element.dataset.magnet);
          if (!stickie) return;
          dragging.current = true;
          element.classList.add("is-lifting");
          drag = { element, id: stickie.id, x: stickie.x, y: stickie.y, pageX: event.pageX, pageY: event.pageY };
        },
        move(event) {
          if (drag) drag.element.style.transform = `translate3d(${event.pageX - drag.pageX}px, ${event.pageY - drag.pageY}px, 0)`;
        },
        end(event) {
          const start = drag;
          drag = undefined;
          dragging.current = false;
          if (!start) return;
          start.element.classList.remove("is-lifting");
          start.element.style.removeProperty("transform");
          const x = snapped(start.x + event.pageX - start.pageX), y = snapped(start.y + event.pageY - start.pageY);
          update(start.id, { x, y });
          void send({ action: "set", magnet: start.id, fields: { x, y } });
        },
      },
    }).resizable({
      edges: { right: ".glass-note-grip-right", bottom: ".glass-note-grip-bottom" },
      listeners: {
        start(event) {
          const element = noteElement(event.target);
          const stickie = latest.current.magnets.find(item => item.id === element.dataset.magnet);
          if (!stickie) return;
          dragging.current = true;
          const rect = element.getBoundingClientRect();
          element.dataset.resize = JSON.stringify({ id: stickie.id, width: rect.width, height: rect.height, pageX: event.pageX, pageY: event.pageY });
        },
        move(event) {
          const element = noteElement(event.target), drag = element.dataset.resize;
          if (!drag) return;
          const start = JSON.parse(drag);
          const width = Math.max(stickyDefaults.minW, start.width + event.pageX - start.pageX), height = Math.max(stickyDefaults.minH, start.height + event.pageY - start.pageY);
          element.style.width = `${width}px`;
          element.style.height = `${height}px`;
          element.dataset.size = JSON.stringify({ width, height });
        },
        end(event) {
          const element = noteElement(event.target), drag = element.dataset.resize;
          dragging.current = false;
          if (!drag) return;
          const start = JSON.parse(drag), size = JSON.parse(element.dataset.size ?? "null");
          delete element.dataset.resize;
          delete element.dataset.size;
          const stickie = latest.current.magnets.find(item => item.id === start.id);
          if (!stickie || !size) return;
          const width = snapped(size.width), height = snapped(size.height);
          update(stickie.id, { w: width, h: height });
          void send({ action: "set", magnet: stickie.id, fields: { w: width, h: height } });
        },
      },
    });
    return () => { surface.removeEventListener("pointerdown", track, true); instance.unset(); };
  }, [send, update]);

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
    setEditing(stickie.id);
    void send({ action: "add", magnet: stickie.id, fields: stickyFields(stickie) });
  }, [send]);

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
    } else patchImage(image.id, { x: snapped(image.x + drop.dx), y: snapped(image.y + drop.dy) }, true);
  }, [patchImage]);

  const liveImageSize = useCallback((id: string, width: number, height: number) => {
    const spacer = spacers.current.get(id);
    if (spacer) { spacer.style.width = `${width}px`; spacer.style.height = `${height}px`; }
  }, []);

  const remove = useCallback((object: { id: string }) => {
    setMagnets(current => current.filter(item => item.id !== object.id));
    setImages(current => current.filter(item => item.id !== object.id));
    setCards(current => current.filter(item => item.id !== object.id));
    setSelected(current => current === object.id ? undefined : current);
    void send({ action: "delete", magnet: object.id });
  }, [send]);

  const restore = useCallback(async (magnet: GlassMagnet) => {
    const value = await send({ action: "restore", magnet: magnet.id });
    if (!value) return;
    const stickie = value.magnet && stickyFromMagnet(value.magnet);
    const picture = value.magnet && imageFromMagnet(value.magnet);
    const card = value.magnet && cardFromMagnet(value.magnet);
    if (stickie) setMagnets(current => [...current.filter(item => item.id !== stickie.id), stickie]);
    if (picture) setImages(current => [...current.filter(item => item.id !== picture.id), picture]);
    if (card) setCards(current => [...current.filter(item => item.id !== card.id), card]);
    setOpenTrash(false);
  }, [send]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, [contenteditable='true'], .cm-content")) return;
      if (event.key === "n" || event.key === "N") { event.preventDefault(); createAtCenter(); }
      else if (event.key === "Escape") { setSelected(undefined); setEditing(undefined); setOpenTrash(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createAtCenter]);

  const orphans = magnets.filter(stickie => layout.places[stickie.id]?.status === "orphan");
  const orphanImages = images.filter(image => layout.places[image.id]?.status === "orphan");
  const orphanCards = cards.filter(card => layout.places[card.id]?.status === "orphan");
  const visible = magnets.filter(stickie => layout.places[stickie.id]?.status === "resolved");
  const shown = images.filter(image => layout.places[image.id]?.status === "resolved");
  const shownCards = cards.filter(card => layout.places[card.id]?.status === "resolved");
  const under = shown.filter(image => image.wrap === "behind");
  const above = shown.filter(image => image.wrap !== "behind");
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
      paintHost={underHost} maxWidth={maxWidth} onSelect={() => { setSelected(image.id); setEditing(undefined); }}
      onPatch={(patch, persist) => patchImage(image.id, patch, persist)}
      onDrop={drop => imageDrop(image, drop)}
      onLiveSize={(width, height) => liveImageSize(image.id, width, height)}
      onDelete={() => remove(image)} />;
  };

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
    <button type="button" data-glass-tool="card" aria-haspopup="dialog" aria-label="Card" title="Card: section, tutor answer or quiz"
      onClick={() => setCardOpen(true)}><SquareStack size={15} /></button>
    {comingSoon.map(({ id, label, icon: Icon }) => <button type="button" key={id} data-glass-coming={id} aria-disabled="true"
      aria-label={label} title={`${label} — coming soon`} onClick={() => setNotice(`${label} is coming soon.`)}><Icon size={15} /></button>)}
    <span className="glass-tray-rule" aria-hidden="true" />
    <button type="button" data-glass-trash aria-expanded={openTrash} aria-haspopup="dialog" aria-label={`Glass trash, ${trash.length}`}
      title="Glass trash" onClick={() => setOpenTrash(open => !open)}><Trash2 size={15} /><span className="glass-tray-count" data-glass-trash-count>{trash.length}</span></button>
    <span className="glass-tray-status" data-glass-saved={saved} role="status">{statusLabel}</span>
  </div>;
  const panel = <>{tray}{openTrash && <div className="glass-trash" role="dialog" aria-label="Glass trash">
    <strong>Glass trash</strong>
    {trash.length ? <ul>{trash.map(magnet => <li key={magnet.id}>
      <span>{magnetLabel(magnet).slice(0, 48)}</span>
      <button type="button" data-glass-restore={magnet.id} onClick={() => void restore(magnet)}>Undo</button>
    </li>)}</ul> : <p>Nothing deleted.</p>}
  </div>}{orphans.length + orphanImages.length + orphanCards.length > 0 && <div className="glass-orphans" role="group" aria-label="Magnets whose paragraph is gone">
    <strong>Anchor lost</strong>
    {[...orphans, ...orphanImages, ...orphanCards].map(object => <span key={object.id} data-glass-orphan={object.id}>
      <span>{("name" in object ? object.name : "card" in object ? object.title : object.text).slice(0, 32) || "Empty note"}</span>
      <button type="button" aria-label="Move orphan to trash" onClick={() => remove(object)}>×</button>
    </span>)}
  </div>}{cardOpen && note && <NewCardDialog blocks={blocks.current}
    point={cardPoint()}
    close={() => setCardOpen(false)} create={card => { void createCard(card); setCardOpen(false); }} />}{notice && <p className="glass-notice" role="status">{notice}</p>}</>;

  return <>
    <GlassLandmarks editor={editor} root={root} nodes={nodes} groups={groups} note={note}
      saved={documentSaved} magnets={landmarks} seeds={seeds} />
    {note && <BubbleLayer editor={editor} root={root} note={note} live={live} pin={pinCard} magnets={comments} reload={load} />}
    {createPortal(<div className="glass-layer" ref={layer} data-glass="on">
      {tool === "sticky" && note && <div className="glass-surface" data-glass-surface onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        create({ x: event.clientX, y: event.clientY });
      }} />}
      {layout.fixture && (layout.fixture.status === "resolved"
        ? <div className="glass-debug" data-glass-object="fixture" data-glass-status="resolved"
            style={{ left: `${layout.fixture.x}px`, top: `${layout.fixture.y}px`, width: `${layout.fixture.width}px`, height: `${layout.fixture.height}px` }} />
        : <div className="glass-debug" data-glass-object="fixture" data-glass-status="orphan" />)}
      {visible.map(stickie => <StickyView key={stickie.id} note={stickie} place={layout.places[stickie.id]} selected={selected === stickie.id}
        editing={editing === stickie.id} onSelect={() => { setSelected(stickie.id); setEditing(undefined); }}
        onEdit={editingNow => setEditing(editingNow ? stickie.id : undefined)}
        onText={text => { update(stickie.id, { text }); void send({ action: "set", magnet: stickie.id, fields: { text } }); }}
        onFold={folded => { update(stickie.id, { folded }); void send({ action: "set", magnet: stickie.id, fields: { folded } }); }}
        onColor={color => { update(stickie.id, { color }); void send({ action: "set", magnet: stickie.id, fields: { color } }); }}
        onDelete={() => remove(stickie)} />)}
      {shownCards.map(card => { const place = layout.places[card.id]; return place?.status !== "resolved" ? null :
        <GlassCardView key={card.id} card={card} place={{ x: place.x, y: place.y, width: place.width }} note={note!} live={live}
          onToggle={() => toggleCard(card.id)}
          onCached={(answer, answerAt) => patchCard(card.id, { answer, answerAt })}
          onDelete={() => remove(card)} />; })}
      {above.map(frame)}
      {under.map(frame)}
    </div>, scroller)}
    {createPortal(<div className="glass-under" data-glass-under><div className="glass-under-host" ref={setUnderHost} /></div>, scroller)}
    {createPortal(panel, document.body)}
  </>;
}
