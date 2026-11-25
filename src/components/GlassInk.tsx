import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorHandle } from "../editor/MarkdownEditor";
import { liveBlocks, type GlassBlock } from "../glass/anchor-map";
import {
  inkFields, inkStrokeFromMagnet, liveBoxes, newInkId, placeInk, splitStroke,
  type InkPart, type InkPlacement, type InkSample, type InkStroke,
} from "../glass/ink-model";
import { biteRuns, drawsPointer, inkPath, pressureOf, quantizePoint, type InkTool } from "../../shared/ink-core.mjs";
import "./glass.css";

// The pencil. Strokes live in the journal like any magnet, split per element box, drawn on
// a content-anchored SVG; the pointer surface and the in-progress stroke are viewport-fixed,
// so a stroke can start anywhere on screen and still land on the page under it.
type InkMode = InkTool | "eraser";
export interface InkHistoryApi { undo(): void; redo(): void }

type InkOp =
  | { type: "add"; id: string; fields: Record<string, unknown> }
  | { type: "del"; id: string; fields: Record<string, unknown> }
  | { type: "set"; id: string; before: InkPart[]; after: InkPart[] };

interface Pending { pointerId: number; points: InkSample[]; eraser: boolean }

const eraserRadius = 14;
const historyLimit = 50;

async function glassCall(request: Record<string, unknown>) {
  const api = window.desktop?.glass;
  if (!api) throw new Error("Glass storage is not available here.");
  const reply = await api(request);
  if (!reply?.ok) throw new Error(reply?.error ?? "Glass storage refused the change.");
  return reply.value ?? {};
}

const sampleOf = (event: PointerEvent | React.PointerEvent): InkSample => ({
  x: event.clientX, y: event.clientY, pressure: pressureOf(event.pointerType || "mouse", event.pressure),
});

// Untrusted events (tests, some remote desktops) report no coalesced samples; the event itself is one.
const coalesced = (event: PointerEvent) => {
  const samples = event.getCoalescedEvents?.() ?? [];
  return samples.length ? samples : [event];
};

// Keeps only points that actually move: a resting finger must not flood the journal.
function appendSample(points: InkSample[], sample: InkSample) {
  const last = points.at(-1);
  if (last && Math.hypot(sample.x - last.x, sample.y - last.y) < 1.2 && Math.abs(sample.pressure - last.pressure) < 0.05) return;
  points.push(sample);
}

const inkPoints = (points: readonly InkSample[]) => points.map(point => [point.x, point.y, point.pressure] as [number, number, number]);

// The layer re-renders whenever the page re-renders; the committed paths only change
// when placements change, so keep React from reconciling thousands of nodes per render.
const InkPaths = memo(function InkPaths({ placed, pathOf }: { placed: InkPlacement[]; pathOf: (placement: InkPlacement) => string }) {
  return <>
    {placed.map(placement => <path key={`${placement.stroke.id}:${placement.part}`} d={pathOf(placement)}
      data-ink={placement.stroke.id} data-ink-part={placement.part} data-ink-tool={placement.stroke.tool}
      data-ink-colour={placement.stroke.color}
      data-ink-box={placement.stroke.parts[placement.part]?.box.kind ?? "block"}
      transform={`translate(${placement.x} ${placement.y})`}
      fill={placement.stroke.color} fillOpacity={placement.stroke.tool === "highlighter" ? 0.42 : 1}
      style={{ mixBlendMode: placement.stroke.tool === "highlighter" ? "multiply" : "normal" }} />)}
  </>;
});

export default function GlassInk({ editor, root, note, tool, color, size, eraser, api, onHistory, onNotice }: {
  editor(): EditorHandle | undefined;
  root: HTMLElement;
  note?: string;
  tool: InkMode | null;
  color: string;
  size: number;
  eraser: "bite" | "stroke";
  api?: { current: InkHistoryApi | null };
  onHistory?(canUndo: boolean, canRedo: boolean): void;
  onNotice?(text: string): void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const live = useRef<SVGPathElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const [strokes, setStrokes] = useState<InkStroke[]>([]);
  const [placed, setPlaced] = useState<InkPlacement[]>([]);
  const [orphans, setOrphans] = useState(0);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const blocks = useRef<GlassBlock[]>([]);
  const paths = useRef(new Map<string, { key: string; path: string }>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef<Pending | null>(null);
  const penSeen = useRef(false);
  const drawing = useRef(false);
  const placedRef = useRef<InkPlacement[]>([]);
  const latest = useRef({ strokes, note, tool, color, size, eraser });
  const callbacks = useRef({ onHistory, onNotice });
  const history = useRef<{ undo: InkOp[][]; redo: InkOp[][] }>({ undo: [], redo: [] });
  const reload = useRef(false);
  latest.current = { strokes, note, tool, color, size, eraser };
  callbacks.current = { onHistory, onNotice };
  placedRef.current = placed;

  const measure = useCallback(() => {
    const element = svg.current;
    if (!element) { setPlaced([]); return; }
    blocks.current = liveBlocks(editor()?.readingContext(), root);
    const origin = element.getBoundingClientRect();
    const result = placeInk(latest.current.strokes, blocks.current, origin);
    setPlaced(result.placed);
    setOrphans(result.orphans);
  }, [editor, root]);

  const send = useCallback((request: Record<string, unknown>) => {
    const path = latest.current.note;
    if (!path) return Promise.resolve(undefined);
    const run = queue.current.then(async () => {
      setSaved("saving");
      try {
        await glassCall({ note: path, ...request });
        setSaved("saved");
      } catch (error) {
        setSaved("error");
        callbacks.current.onNotice?.(error instanceof Error ? error.message : String(error));
      }
    });
    queue.current = run;
    return run;
  }, []);

  const load = useCallback(() => {
    const path = latest.current.note;
    if (!path) { setStrokes([]); return; }
    const run = queue.current.then(async () => {
      try {
        const value = await glassCall({ note: path, action: "list" }) as { magnets?: { id: string; fields: Record<string, unknown>; kind?: string | null }[] };
        setStrokes((value.magnets ?? []).flatMap(magnet => inkStrokeFromMagnet(magnet) ?? []));
        setSaved("saved");
      } catch (error) {
        setSaved("error");
        callbacks.current.onNotice?.(error instanceof Error ? error.message : String(error));
      }
    });
    queue.current = run;
    void run;
  }, []);

  useEffect(() => {
    setStrokes([]);
    setPlaced([]);
    paths.current = new Map();
    history.current = { undo: [], redo: [] };
    callbacks.current.onHistory?.(false, false);
    load();
    const subscribe = window.desktop?.onGlassChanged;
    if (!subscribe) return;
    return subscribe((event: { note?: string } | undefined) => {
      if (!event || event.note !== latest.current.note) return;
      if (drawing.current) { reload.current = true; return; }
      load();
    });
  }, [note, load]);

  useEffect(() => {
    measure();
  }, [strokes, measure]);

  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    let scheduled = 0;
    const schedule = () => { if (!scheduled) scheduled = requestAnimationFrame(() => { scheduled = 0; measure(); }); };
    const sizes = new ResizeObserver(schedule);
    sizes.observe(root);
    sizes.observe(root.parentElement ?? root);
    const edits = new MutationObserver(() => schedule());
    edits.observe(root, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (scheduled) cancelAnimationFrame(scheduled);
      sizes.disconnect();
      edits.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [root, measure]);

  const pushHistory = useCallback((ops: InkOp[]) => {
    const log = history.current;
    log.undo.push(ops);
    if (log.undo.length > historyLimit) log.undo.shift();
    log.redo = [];
    callbacks.current.onHistory?.(log.undo.length > 0, log.redo.length > 0);
  }, []);

  const addStroke = useCallback((stroke: InkStroke) => {
    setStrokes(current => [...current, stroke]);
    void send({ action: "add", magnet: stroke.id, fields: inkFields(stroke) });
  }, [send]);

  const applyForward = useCallback((op: InkOp) => {
    if (op.type === "add") {
      const stroke = inkStrokeFromMagnet({ id: op.id, fields: op.fields });
      if (stroke) addStroke(stroke);
      return;
    }
    if (op.type === "del") {
      setStrokes(current => current.filter(stroke => stroke.id !== op.id));
      void send({ action: "delete", magnet: op.id });
      return;
    }
    setStrokes(current => current.map(stroke => stroke.id === op.id ? { ...stroke, parts: op.after } : stroke));
    void send({ action: "set", magnet: op.id, fields: { parts: op.after } });
  }, [addStroke, send]);

  const applyBackward = useCallback((op: InkOp) => {
    if (op.type === "add") {
      setStrokes(current => current.filter(stroke => stroke.id !== op.id));
      void send({ action: "delete", magnet: op.id });
      return;
    }
    if (op.type === "del") {
      const stroke = inkStrokeFromMagnet({ id: op.id, fields: op.fields });
      if (!stroke) return;
      setStrokes(current => [...current, stroke]);
      void send({ action: "restore", magnet: stroke.id });
      return;
    }
    setStrokes(current => current.map(stroke => stroke.id === op.id ? { ...stroke, parts: op.before } : stroke));
    void send({ action: "set", magnet: op.id, fields: { parts: op.before } });
  }, [addStroke, send]);

  const undo = useCallback(() => {
    const log = history.current, entry = log.undo.pop();
    if (!entry) return;
    log.redo.push(entry);
    for (const op of [...entry].reverse()) applyBackward(op);
    callbacks.current.onHistory?.(log.undo.length > 0, true);
  }, [applyBackward]);

  const redo = useCallback(() => {
    const log = history.current, entry = log.redo.pop();
    if (!entry) return;
    log.undo.push(entry);
    for (const op of entry) applyForward(op);
    callbacks.current.onHistory?.(true, log.redo.length > 0);
  }, [applyForward]);

  useEffect(() => {
    if (!api) return;
    api.current = { undo, redo };
    return () => { api.current = null; };
  }, [api, undo, redo]);

  const flushLive = useCallback(() => {
    const gesture = pending.current, path = live.current;
    if (!gesture || !path) return;
    const tool = latest.current.tool === "eraser" ? "pen" : latest.current.tool ?? "pen";
    path.setAttribute("d", inkPath(inkPoints(gesture.points), { tool, size: latest.current.size }));
  }, []);

  const finishDraw = useCallback((gesture: Pending) => {
    const points = gesture.points;
    if (!points.length || !latest.current.note) return;
    const list = liveBlocks(editor()?.readingContext(), root);
    blocks.current = list;
    const parts = splitStroke(points, liveBoxes(list), list);
    if (!parts.length) { callbacks.current.onNotice?.("Draw over the page so ink can follow a paragraph."); return; }
    const tool = latest.current.tool;
    if (!tool || tool === "eraser") return;
    const stroke: InkStroke = { id: newInkId(), tool, color: latest.current.color, size: latest.current.size, parts };
    addStroke(stroke);
    pushHistory([{ type: "add", id: stroke.id, fields: inkFields(stroke) }]);
  }, [addStroke, editor, pushHistory, root]);

  const applyErase = useCallback((point: { x: number; y: number }) => {
    const current = latest.current.strokes;
    const hits = new Map<string, Set<number>>();
    for (const placement of placedRef.current) {
      const near = placement.points.some(([x, y]) => Math.hypot(placement.rect.left + x - point.x, placement.rect.top + y - point.y) <= eraserRadius + placement.stroke.size / 2);
      if (!near) continue;
      const set = hits.get(placement.stroke.id) ?? new Set<number>();
      set.add(placement.part);
      hits.set(placement.stroke.id, set);
    }
    if (!hits.size) return;
    const ops: InkOp[] = [];
    for (const [id, parts] of hits) {
      const stroke = current.find(item => item.id === id);
      if (!stroke) continue;
      if (latest.current.eraser === "stroke") {
        ops.push({ type: "del", id, fields: inkFields(stroke) });
        continue;
      }
      const next: InkPart[] = [];
      let changed = false;
      stroke.parts.forEach((part, index) => {
        const placement = placedRef.current.find(item => item.stroke.id === id && item.part === index);
        if (!parts.has(index) || !placement) { next.push(part); return; }
        const rect = placement.rect;
        const points = placement.points.map(([x, y, pressure]) => [rect.left + x, rect.top + y, pressure] as [number, number, number]);
        const runs = biteRuns(points, point, eraserRadius);
        if (runs.length === 1 && runs[0].length === points.length) { next.push(part); return; }
        changed = true;
        const width = Math.max(rect.width, 1), height = Math.max(rect.height, 1);
        for (const run of runs) next.push({ box: part.box, anchor: part.anchor,
          points: run.map(([x, y, pressure]) => quantizePoint([(x - rect.left) / width, (y - rect.top) / height, pressure]) as [number, number, number]) });
      });
      if (changed) ops.push({ type: "set", id, before: stroke.parts, after: next });
    }
    if (!ops.length) return;
    for (const op of ops) applyForward(op);
    pushHistory(ops);
  }, [applyForward, pushHistory]);

  const stopGesture = useCallback(() => {
    const gesture = pending.current;
    pending.current = null;
    drawing.current = false;
    live.current?.setAttribute("d", "");
    if (gesture && !gesture.eraser) finishDraw(gesture);
    if (reload.current) { reload.current = false; load(); }
  }, [finishDraw, load]);

  const moveGesture = useCallback((event: PointerEvent) => {
    const gesture = pending.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (latest.current.tool === "eraser") { applyErase({ x: event.clientX, y: event.clientY }); return; }
    for (const item of coalesced(event)) appendSample(gesture.points, sampleOf(item));
    flushLive();
  }, [applyErase, flushLive]);

  const endGesture = useCallback((event: PointerEvent) => {
    const gesture = pending.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (latest.current.tool !== "eraser") for (const item of coalesced(event)) appendSample(gesture.points, sampleOf(item));
    stopGesture();
  }, [stopGesture]);

  const startGesture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const type = event.pointerType || "mouse";
    if (type === "pen") penSeen.current = true;
    if (pending.current || !latest.current.note) return;
    if (!drawsPointer(type, { penSeen: penSeen.current, drawing: drawing.current })) return;
    if (type === "mouse" && event.button !== 0) return;
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* synthetic pointers have no capture */ }
    drawing.current = true;
    pending.current = { pointerId: event.pointerId, points: [sampleOf(event)], eraser: latest.current.tool === "eraser" };
    if (latest.current.tool === "eraser") applyErase({ x: event.clientX, y: event.clientY });
    else flushLive();
  }, [applyErase, flushLive]);

  const trackCursor = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const element = cursor.current;
    if (!element) return;
    element.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0)`;
  }, []);

  const pathOf = useCallback((placement: InkPlacement) => {
    const key = `${placement.stroke.tool}:${placement.stroke.size}:${Math.round(placement.width * 10)}:${Math.round(placement.height * 10)}`;
    const id = `${placement.stroke.id}:${placement.part}`;
    const cached = paths.current.get(id);
    if (cached?.key === key) return cached.path;
    if (paths.current.size > 4096) paths.current.clear();
    const path = inkPath(placement.points, { tool: placement.stroke.tool, size: placement.stroke.size });
    paths.current.set(id, { key, path });
    return path;
  }, []);

  const active = tool !== null && !!note;
  return <>
    <svg ref={svg} className="glass-ink" data-glass-layer="ink" data-glass-ink={strokes.length} data-ink-orphans={orphans || undefined}
      data-ink-saved={saved} aria-hidden="true">
      <InkPaths placed={placed} pathOf={pathOf} />
    </svg>
    {active && createPortal(<>
      <div ref={surface} className="glass-ink-surface" data-ink-surface data-ink-tool={tool} data-ink-mode={tool === "eraser" ? eraser : undefined}
        onPointerDown={startGesture}
        onPointerMove={event => { trackCursor(event); moveGesture(event.nativeEvent); }}
        onPointerUp={event => endGesture(event.nativeEvent)}
        onPointerCancel={event => endGesture(event.nativeEvent)}
        onWheel={event => root.scrollBy({ top: event.deltaY, left: event.deltaX })} onPointerLeave={() => { if (cursor.current) cursor.current.style.transform = "translate3d(-999px,-999px,0)"; }} />
      <svg className="glass-ink-live" aria-hidden="true"><path ref={live} data-ink-live={tool} data-ink-colour={tool === "eraser" ? undefined : color}
        fill={tool === "eraser" ? "none" : color} fillOpacity={tool === "highlighter" ? 0.42 : 1}
        style={{ mixBlendMode: tool === "highlighter" ? "multiply" : "normal" }} /></svg>
      {tool === "eraser" && <div ref={cursor} className="glass-ink-eraser" data-ink-eraser aria-hidden="true" />}
    </>, document.body)}
  </>;
}
