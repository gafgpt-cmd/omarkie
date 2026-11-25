import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorHandle, ReadingContext } from "../editor/MarkdownEditor";
import { captureAnchor, liveBlocks, normalizeText, placeAnchor, resolveAnchor, type GlassAnchor, type GlassPlacement, type GlassResolution } from "../glass/anchor-map";
import { anchorFrom, fixtureAnchor, glassFixture, rememberFixtureAnchor } from "../glass/glass-state";
import { LearningOverlays, type StudyOverlay } from "./learning-overlays";
import "./glass.css";

interface Box { id: string; placement: GlassPlacement }
interface Magnet { id: string; kind: string | null; fields: Record<string, unknown> }
interface Item { id: string; line: number; label: string; context: string; state: "placed" | "check" | "tray"; confidence: number; tier: GlassResolution["tier"] }
interface Seed { text: string; label?: string }

const magnetsKey = "omarkie-glass-magnets";
const confidenceCheck = 0.8, confidenceTray = 0.5;

function testMagnets(): Seed[] | undefined {
  if (!glassFixture()) return;
  try {
    const value = JSON.parse(localStorage.getItem(magnetsKey) || "null");
    if (!Array.isArray(value) || !value.length || value.length > 20) return;
    const seeds = value.flatMap(item => {
      const text = typeof item === "string" ? item : item && typeof item.text === "string" ? item.text : undefined;
      if (!text?.trim()) return [];
      return [{ text, ...(typeof item?.label === "string" ? { label: item.label } : {}) }];
    });
    return seeds.length === value.length ? seeds : undefined;
  } catch { return; }
}

function magnetAnchor(magnet: Magnet) {
  return anchorFrom(magnet.fields.anchor);
}

function anchorContext(anchor: GlassAnchor | undefined) {
  if (!anchor) return "";
  for (const landmark of anchor.landmarks) {
    if (landmark.kind === "quote") return normalizeText(landmark.value.exact);
    if (landmark.kind === "block") return normalizeText(landmark.block);
  }
  return "";
}

export default function GlassLayer({ editor, root, nodes, groups, note, saved = false }: {
  editor(): EditorHandle | undefined; root: HTMLElement; nodes: ReadingContext["nodes"]; groups: StudyOverlay[]; note?: string; saved?: boolean;
}) {
  const scroller = root.parentElement!;
  const layer = useRef<HTMLDivElement>(null), fingerprint = useRef(""), mounted = useRef(false);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [magnets, setMagnets] = useState<Magnet[]>([]);
  const [revision, setRevision] = useState(0);
  const [placing, setPlacing] = useState<string>();
  const [writeError, setWriteError] = useState<string>();
  const frame = useRef(0), seeded = useRef(false), saving = useRef(false), dirty = useRef(false), previousSaved = useRef(saved);
  const stopTracking = useRef<(() => void) | undefined>(undefined);
  const mapped = useRef(new Map<string, number>()), live = useRef(new Set<string>());
  const fixture = useMemo(glassFixture, []);
  const seeds = useMemo(testMagnets, []);
  const schedule = useEffectEvent(() => { if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; measure(); }); });

  function reload() { setRevision(value => value + 1); }
  async function store(request: Record<string, unknown>) {
    if (!note || !window.desktop?.glass) throw new Error("Glass storage is unavailable.");
    const response = await window.desktop.glass({ ...request, note });
    if (!response?.ok) throw new Error(response?.error || "Glass could not save the anchor.");
  }

  useEffect(() => {
    if (!note || !window.desktop?.glass) { setMagnets([]); return; }
    let current = true;
    void window.desktop.glass({ action: "list", note }).then((response: { ok?: boolean; value?: { magnets?: Magnet[] } }) => {
      if (current && response?.ok) setMagnets(response.value?.magnets ?? []);
    }).catch(() => {});
    return () => { current = false; };
  }, [note, revision]);

  useEffect(() => {
    mapped.current.clear();
    live.current.clear();
  }, [magnets, note]);

  useEffect(() => () => { stopTracking.current?.(); stopTracking.current = undefined; }, []);

  useEffect(() => {
    if (!placing) return;
    const place = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-cid]") : null;
      if (!target || !root.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      const blocks = liveBlocks(editor()?.readingContext(), root);
      const block = blocks.find(item => item.element === target) ?? blocks.find(item => !!item.element && item.element.dataset.cid === target.dataset.cid);
      if (!block) return;
      const id = placing;
      setPlacing(undefined);
      setWriteError(undefined);
      void store({ action: "add", magnet: id, anchor: captureAnchor(block, blocks) }).then(reload, error => {
        setWriteError(error.message);
        setPlacing(id);
      });
    };
    scroller.addEventListener("click", place, true);
    return () => scroller.removeEventListener("click", place, true);
  }, [placing, scroller, note, root, editor]);

  useEffect(() => {
    const changed = saved && !previousSaved.current;
    previousSaved.current = saved;
    if (!changed || !dirty.current || !note || saving.current || !magnets.length) return;
    const context = editor()?.readingContext();
    if (!context) return;
    const blocks = liveBlocks(context, root), byLine = new Map(blocks.map(block => [block.line, block]));
    saving.current = true;
    dirty.current = false;
    void Promise.all(magnets.flatMap(magnet => {
      const anchor = magnetAnchor(magnet), char = live.current.has(magnet.id) ? mapped.current.get(magnet.id) : undefined;
      if (!anchor || char === undefined) return [];
      const { line, confidence } = resolveAnchor(anchor, blocks, { liveChar: char });
      const block = line === null ? undefined : byLine.get(line);
      return block && confidence >= confidenceCheck ? [store({ action: "add", magnet: magnet.id, anchor: captureAnchor(block, blocks) })] : [];
    })).then(reload, error => { dirty.current = true; setWriteError(error.message); })
      .finally(() => { saving.current = false; });
  }, [saved, magnets, note, root, editor]);

  const measure = useEffectEvent(async () => {
    const surface = layer.current, context = editor()?.readingContext();
    if (!surface) return;
    const blocks = context ? liveBlocks(context, root) : [];
    if (!stopTracking.current) {
      const handle = editor();
      if (handle) stopTracking.current = handle.trackChanges(map => {
        if (!mapped.current.size) return;
        for (const [id, char] of mapped.current) { mapped.current.set(id, map(char)); live.current.add(id); }
        dirty.current = true;
        schedule();
      });
    }
    if (seeds?.length && note && !seeded.current && blocks.length) {
      seeded.current = true;
      const key = `omarkie-glass-seeded:${note}`;
      let done = false;
      try { done = localStorage.getItem(key) === "true"; } catch { /* storage unavailable */ }
      if (!done) {
        const created = await Promise.all(seeds.map(async (seed, index) => {
          const wanted = normalizeText(seed.text);
          const block = blocks.find(candidate => normalizeText(candidate.block) === wanted) ?? blocks.find(candidate => normalizeText(candidate.block).includes(wanted));
          if (!block) return false;
          try {
            await window.desktop!.glass({ action: "add", note, magnet: `m-g2b-${index + 1}`, kind: "debug", text: seed.label ?? seed.text, anchor: captureAnchor(block, blocks) });
            return true;
          } catch { return false; }
        }));
        try { if (created.every(Boolean)) localStorage.setItem(key, "true"); } catch { /* storage unavailable */ }
        reload();
      }
    }
    const next: Box[] = [];
    if (fixture && !seeds?.length) {
      let anchor = fixtureAnchor();
      if (!anchor) {
        const paragraph = blocks.find(block => block.element?.tagName === "P" && !!block.element.textContent?.trim());
        if (paragraph) {
          anchor = captureAnchor(paragraph, blocks);
          rememberFixtureAnchor(anchor);
        }
      }
      if (anchor) next.push({ id: "fixture", placement: placeAnchor(anchor, { x: 0, y: 0 }, blocks, surface) });
    }
    const resolved: Item[] = [];
    const byLine = magnets.length ? new Map(blocks.map(block => [block.line, block])) : undefined;
    for (const magnet of magnets) {
      const anchor = magnetAnchor(magnet);
      const char = live.current.has(magnet.id) ? mapped.current.get(magnet.id) : undefined;
      const result = anchor ? resolveAnchor(anchor, blocks, { liveChar: char }) : { confidence: 0, tier: "none" as const, line: null };
      const state = result.line === null || result.confidence < confidenceTray ? "tray" : result.confidence >= confidenceCheck ? "placed" : "check";
      if (state === "placed" && char === undefined && result.line !== null) {
        const start = byLine?.get(result.line)?.from;
        if (start !== undefined) mapped.current.set(magnet.id, start);
      }
      const label = typeof magnet.fields.text === "string" && magnet.fields.text.trim() ? magnet.fields.text : magnet.kind ?? magnet.id;
      resolved.push({ id: magnet.id, line: result.line ?? 0,
        label, context: anchorContext(anchor), state,
        confidence: result.confidence, tier: result.tier });
    }
    if (!mounted.current) {
      mounted.current = true;
      performance.mark("omarkie:glass-mounted");
    }
    const serialized = JSON.stringify([next, resolved]);
    if (serialized === fingerprint.current) return;
    fingerprint.current = serialized;
    setBoxes(next);
    setItems(resolved);
  });

  useEffect(() => {
    const scheduleLocal = () => schedule();
    measure();
    const sizes = new ResizeObserver(scheduleLocal);
    sizes.observe(scroller);
    sizes.observe(root);
    // Our own boxes are React output; their mutations must not schedule another pass.
    const edits = new MutationObserver(records => { if (records.every(record => layer.current?.contains(record.target))) return; schedule(); });
    edits.observe(scroller, { childList: true, subtree: true, characterData: true });
    scroller.addEventListener("scroll", scheduleLocal, { passive: true });
    window.addEventListener("resize", scheduleLocal);
    return () => {
      if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
      sizes.disconnect();
      edits.disconnect();
      scroller.removeEventListener("scroll", scheduleLocal);
      window.removeEventListener("resize", scheduleLocal);
    };
  }, [root, scroller, measure, fixture, schedule]);

  const tray = items.filter(item => item.state === "tray");
  const grouped = new Map<number, Item[]>();
  for (const item of items) if (item.state !== "tray") {
    const badges = grouped.get(item.line);
    if (badges) badges.push(item);
    else grouped.set(item.line, [item]);
  }
  const overlays = new Map(groups.map(group => [group.line, group]));
  for (const [line, badges] of grouped) {
    const group = overlays.get(line);
    overlays.set(line, { line, tabs: group?.tabs, marks: group?.marks ?? [], tucks: <>
      <div className="glass-magnet-row">{badges.map(item =>
        <span className="glass-magnet" key={item.id} data-glass-object={item.id} data-glass-status="resolved"
          data-glass-confidence={item.state} data-glass-tier={item.tier} title={`${item.label} (${item.confidence.toFixed(2)})`}>
          <span>{item.label}</span>{item.state === "check" && <small>check me</small>}
        </span>)}</div>
      {group?.tucks}
    </> });
  }
  return <>
    {overlays.size > 0 && <LearningOverlays root={root} nodes={nodes} groups={[...overlays.values()]} />}
    {createPortal(<div className="glass-layer" ref={layer} data-glass="on">
    {boxes.map(box => box.placement.status === "resolved"
      ? <div className="glass-debug" key={box.id} data-glass-object={box.id} data-glass-status="resolved"
          style={{ left: `${box.placement.x}px`, top: `${box.placement.y}px`, width: `${box.placement.width}px`, height: `${box.placement.height}px` }} />
      : <div className="glass-debug" key={box.id} data-glass-object={box.id} data-glass-status="orphan" />)}
    {tray.length > 0 && <aside className="glass-tray" data-glass-tray aria-label="Check placement">
      <header><h2>Check placement</h2><span>{tray.length}</span></header>
      <ul>{tray.map(item => <li key={item.id} data-glass-tray-item={item.id}>
        <p title={item.context}>{item.context || item.label}</p>
        <button type="button" onClick={() => setPlacing(placing === item.id ? undefined : item.id)}>
          {placing === item.id ? "Click a paragraph" : "Place"}
        </button>
      </li>)}</ul>
      {placing && <p role="status">Click the paragraph this magnet belongs to.</p>}
      {writeError && <p role="alert">{writeError}</p>}
    </aside>}
    </div>, scroller)}
  </>;
}
