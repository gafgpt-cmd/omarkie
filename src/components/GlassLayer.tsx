import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import interact from "interactjs";
import { ArrowUpRight, Highlighter, MousePointer2, PenLine, Scissors, SquareStack, Star, StickyNote as StickyIcon, Trash2 } from "lucide-react";
import type { EditorHandle, ReadingContext } from "../editor/MarkdownEditor";
import { captureAnchor, indexBlocks, liveBlocks, matchIndexed, placeAnchor, type BlockIndex, type GlassBlock, type GlassPlacement } from "../glass/anchor-map";
import { fixtureAnchor, glassFixture, rememberFixtureAnchor } from "../glass/glass-state";
import GlassLandmarks, { landmarkSeeds } from "./GlassLandmarks";
import type { StudyOverlay } from "./learning-overlays";
import {
  anchorOf, nearestBlock, newStickyId, offsetIn, snapped, stickyDefaults, stickyFields, stickyFromMagnet, stickyColors,
  type GlassMagnet, type StickyNote,
} from "../glass/glass-model";
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
  { id: "card", label: "Card", icon: SquareStack },
  { id: "scissors", label: "Scissors", icon: Scissors },
] as const;
async function glassCall(request: Record<string, unknown>): Promise<GlassReply> {
  const api = window.desktop?.glass;
  if (!api) throw new Error("Glass storage is not available here.");
  const reply: Reply = await api(request);
  if (!reply?.ok) throw new Error(reply?.error ?? "Glass storage refused the change.");
  return reply.value ?? {};
}

const storable = (magnets: GlassMagnet[] | undefined) => (magnets ?? []).flatMap(magnet => stickyFromMagnet(magnet) ?? []);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

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

export default function GlassLayer({ editor, root, nodes, groups, note, saved: documentSaved }: {
  editor(): EditorHandle | undefined; root: HTMLElement; nodes: ReadingContext["nodes"]; groups: StudyOverlay[]; note?: string; saved: boolean;
}) {
  const scroller = root.parentElement!;
  const layer = useRef<HTMLDivElement>(null);
  const fixture = useMemo(glassFixture, []);
  const seeds = useMemo(landmarkSeeds, []);
  const [landmarks, setLandmarks] = useState<GlassMagnet[]>([]);
  const [magnets, setMagnets] = useState<StickyNote[]>([]);
  const [trash, setTrash] = useState<StickyNote[]>([]);
  const [layout, setLayout] = useState<Layout>({ places: {} });
  const [tool, setTool] = useState<"select" | "sticky">("select");
  const [selected, setSelected] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const [openTrash, setOpenTrash] = useState(false);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [notice, setNotice] = useState("");
  const blocks = useRef<GlassBlock[]>([]), index = useRef<BlockIndex>(indexBlocks([]));
  const latest = useRef({ magnets, note, tool });
  const fingerprint = useRef(""), mounted = useRef(false), ready = useRef(false), loaded = useRef(!note), dragging = useRef(false);
  const queue = useRef(Promise.resolve<unknown>(undefined));
  latest.current = { magnets, note, tool };

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
  }, [editor, fixture, root, seeds]);

  useLayoutEffect(() => {
    if (layout.loaded && !ready.current) { ready.current = true; performance.mark("omarkie:glass-ready"); }
  }, [layout.loaded]);

  // One write at a time, in the order the hand made them: a fresh note must exist before its text lands.
  const send = useCallback((request: Record<string, unknown>) => {
    const path = latest.current.note;
    if (!path) return Promise.resolve(undefined);
    const run = queue.current.then(async () => {
      setSaved("saving");
      try {
        const value = await glassCall({ note: path, ...request });
        if (Array.isArray(value.trash)) setTrash(storable(value.trash));
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
        const value = await glassCall({ note: path, action: "list" });
        loaded.current = true;
        setMagnets(storable(value.magnets));
        const incoming = (value.magnets ?? []).filter(magnet => magnet.kind !== "sticky" && magnet.kind !== "comment");
        setLandmarks(previous => JSON.stringify(previous) === JSON.stringify(incoming) ? previous : incoming);
        setTrash(storable(value.trash));
        setSaved("saved");
      } catch (error) { setSaved("error"); setNotice(message(error)); }
    });
    queue.current = run;
    return run;
  }, []);

  useEffect(() => {
    void load();
    const subscribe = window.desktop?.onGlassChanged;
    if (!subscribe) return;
    return subscribe((event: { note?: string; action?: string } | undefined) => {
      if (event && (event.note === latest.current.note || event.action === "bring" && !event.note)) void load();
    });
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

  useEffect(() => { measure(); }, [magnets, measure]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const update = useCallback((id: string, patch: Partial<StickyNote>) => {
    setMagnets(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
  }, []);

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

  const remove = useCallback((stickie: StickyNote) => {
    setMagnets(current => current.filter(item => item.id !== stickie.id));
    setTrash(current => [stickie, ...current]);
    if (selected === stickie.id) setSelected(undefined);
    void send({ action: "delete", magnet: stickie.id });
  }, [selected, send]);

  const restore = useCallback(async (stickie: StickyNote) => {
    const value = await send({ action: "restore", magnet: stickie.id });
    if (!value) return;
    const magnet = value.magnet && stickyFromMagnet(value.magnet);
    if (magnet) setMagnets(current => [...current, magnet]);
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
  const visible = magnets.filter(stickie => layout.places[stickie.id]?.status === "resolved");
  const statusLabel = !note ? "Save this note first" : saved === "saving" ? "Saving" : saved === "error" ? "Not saved" : saved === "saved" ? "Saved" : "Glass";
  const tray = <div className="glass-tray" role="toolbar" aria-label="Pencil case" data-glass-tray>
    <button type="button" data-glass-tool="select" aria-pressed={tool === "select"} aria-label="Select" title="Select, move, resize" onClick={() => setTool("select")}><MousePointer2 size={15} /></button>
    <button type="button" data-glass-tool="sticky" aria-pressed={tool === "sticky"} aria-label="Sticky note" title="Sticky note (N)" onClick={() => setTool("sticky")}><StickyIcon size={15} /></button>
    <span className="glass-tray-rule" aria-hidden="true" />
    {comingSoon.map(({ id, label, icon: Icon }) => <button type="button" key={id} data-glass-coming={id} aria-disabled="true"
      aria-label={label} title={`${label} — coming soon`} onClick={() => setNotice(`${label} is coming soon.`)}><Icon size={15} /></button>)}
    <span className="glass-tray-rule" aria-hidden="true" />
    <button type="button" data-glass-trash aria-expanded={openTrash} aria-haspopup="dialog" aria-label={`Glass trash, ${trash.length}`}
      title="Glass trash" onClick={() => setOpenTrash(open => !open)}><Trash2 size={15} /><span className="glass-tray-count" data-glass-trash-count>{trash.length}</span></button>
    <span className="glass-tray-status" data-glass-saved={saved} role="status">{statusLabel}</span>
  </div>;
  const panel = <>{tray}{openTrash && <div className="glass-trash" role="dialog" aria-label="Glass trash">
    <strong>Glass trash</strong>
    {trash.length ? <ul>{trash.map(stickie => <li key={stickie.id}>
      <span>{stickie.text.trim() ? stickie.text.trim().slice(0, 48) : "Empty note"}</span>
      <button type="button" data-glass-restore={stickie.id} onClick={() => void restore(stickie)}>Undo</button>
    </li>)}</ul> : <p>Nothing deleted.</p>}
  </div>}{orphans.length > 0 && <div className="glass-orphans" role="group" aria-label="Notes whose paragraph is gone">
    <strong>Anchor lost</strong>
    {orphans.map(stickie => <span key={stickie.id} data-glass-orphan={stickie.id}>
      <span>{stickie.text.trim().slice(0, 32) || "Empty note"}</span>
      <button type="button" aria-label="Move orphan to trash" onClick={() => remove(stickie)}>×</button>
    </span>)}
  </div>}{notice && <p className="glass-notice" role="status">{notice}</p>}</>;

  return <>
    <GlassLandmarks editor={editor} root={root} nodes={nodes} groups={groups} note={note}
      saved={documentSaved} magnets={landmarks} seeds={seeds} />
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
    </div>, scroller)}
    {createPortal(panel, document.body)}
  </>;
}
