import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorHandle } from "../editor/MarkdownEditor";
import { captureAnchor, liveBlocks, normalizeText, placeAnchor, placeLandmarks, type GlassAnchor, type GlassPlacement, type GlassResolution } from "../glass/anchor-map";
import { anchorFrom, fixtureAnchor, glassFixture, rememberFixtureAnchor } from "../glass/glass-state";
import "./glass.css";

interface Box { id: string; placement: GlassPlacement }
interface Magnet { id: string; kind: string | null; fields: Record<string, unknown> }
interface Item { id: string; line: number; label: string; context: string; state: "placed" | "check" | "tray"; x: number; y: number; confidence: number; tier: GlassResolution["tier"] }
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

function anchorChar(anchor: GlassAnchor | undefined) {
  if (!anchor) return undefined;
  for (const landmark of anchor.landmarks) if (landmark.kind === "position") return landmark.value.char;
  return undefined;
}

export default function GlassLayer({ editor, scroller, note, saved = false }: { editor(): EditorHandle | undefined; scroller: HTMLElement; note?: string; saved?: boolean }) {
  const layer = useRef<HTMLDivElement>(null), fingerprint = useRef(""), mounted = useRef(false);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [magnets, setMagnets] = useState<Magnet[]>([]);
  const [revision, setRevision] = useState(0);
  const [placing, setPlacing] = useState<string>();
  const frame = useRef(0), seeded = useRef(false), saving = useRef(false), dirty = useRef(false), previousSaved = useRef(saved);
  const stopTracking = useRef<(() => void) | undefined>(undefined);
  const mapped = useRef(new Map<string, number>()), live = useRef(new Set<string>());
  const fixture = useMemo(glassFixture, []);
  const seeds = useMemo(testMagnets, []);
  const schedule = useEffectEvent(() => { if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; measure(); }); });

  function reload() { setRevision(value => value + 1); }
  async function store(request: Record<string, unknown>) {
    if (!note || !window.desktop?.glass) return;
    await window.desktop.glass({ ...request, note });
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
    for (const magnet of magnets) {
      const char = anchorChar(magnetAnchor(magnet));
      if (char !== undefined) mapped.current.set(magnet.id, char);
    }
  }, [magnets, note]);

  useEffect(() => () => { stopTracking.current?.(); stopTracking.current = undefined; }, []);

  useEffect(() => {
    if (!placing) return;
    const place = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-cid]") : null;
      const document = scroller.querySelector<HTMLElement>(".rich-document");
      if (!target || !document?.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      const blocks = liveBlocks(editor()?.readingContext(), document);
      const block = blocks.find(item => item.element === target) ?? blocks.find(item => !!item.element && item.element.dataset.cid === target.dataset.cid);
      if (!block) return;
      const id = placing;
      setPlacing(undefined);
      void store({ action: "add", magnet: id, anchor: captureAnchor(block, blocks) }).then(reload, () => setPlacing(id));
    };
    scroller.addEventListener("click", place, true);
    return () => scroller.removeEventListener("click", place, true);
  }, [placing, scroller, note, magnets, editor]);

  useEffect(() => {
    const changed = saved && !previousSaved.current;
    previousSaved.current = saved;
    if (!changed || !dirty.current || !note || saving.current || !magnets.length) return;
    const document = scroller.querySelector<HTMLElement>(".rich-document"), context = editor()?.readingContext();
    if (!document || !context) return;
    const blocks = liveBlocks(context, document);
    saving.current = true;
    void Promise.all(items.flatMap(item => {
      if (item.state === "tray") return [];
      const block = blocks.find(candidate => candidate.line === item.line);
      return block ? [store({ action: "add", magnet: item.id, anchor: captureAnchor(block, blocks) })] : [];
    })).finally(() => { saving.current = false; dirty.current = false; });
  }, [saved, items, magnets, note, scroller, editor]);

  const measure = useEffectEvent(async () => {
    const surface = layer.current, document = scroller.querySelector<HTMLElement>(".rich-document");
    if (!surface || !document) return;
    const context = editor()?.readingContext();
    const blocks = context ? liveBlocks(context, document) : [];
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
    for (const magnet of magnets) {
      const anchor = magnetAnchor(magnet), offset = { x: Number(magnet.fields.x) || 0, y: Number(magnet.fields.y) || 0 };
      const char = live.current.has(magnet.id) ? mapped.current.get(magnet.id) : undefined;
      const result = anchor ? placeLandmarks(anchor, offset, blocks, surface, { liveChar: char }) : { status: "orphan" as const, confidence: 0, tier: "none" as const, line: null };
      const state = result.status === "resolved" ? result.confidence >= confidenceCheck ? "placed" : result.confidence >= confidenceTray ? "check" : "tray" : "tray";
      const label = typeof magnet.fields.text === "string" && magnet.fields.text.trim() ? magnet.fields.text : magnet.kind ?? magnet.id;
      resolved.push({ id: magnet.id, line: result.line ?? 0,
        label, context: anchorContext(anchor), state,
        x: result.status === "resolved" ? result.x : 0, y: result.status === "resolved" ? result.y : 0,
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
    const document = scroller.querySelector<HTMLElement>(".rich-document");
    if (document) sizes.observe(document);
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
  }, [scroller, measure, fixture, schedule]);

  const tray = items.filter(item => item.state === "tray");
  return createPortal(<div className="glass-layer" ref={layer} data-glass="on">
    {boxes.map(box => box.placement.status === "resolved"
      ? <div className="glass-debug" key={box.id} data-glass-object={box.id} data-glass-status="resolved"
          style={{ left: `${box.placement.x}px`, top: `${box.placement.y}px`, width: `${box.placement.width}px`, height: `${box.placement.height}px` }} />
      : <div className="glass-debug" key={box.id} data-glass-object={box.id} data-glass-status="orphan" />)}
    {items.filter(item => item.state !== "tray").map(item =>
      <div className="glass-magnet" key={item.id} data-glass-object={item.id} data-glass-status="resolved"
        data-glass-confidence={item.state} data-glass-tier={item.tier} title={`${item.label} (${item.confidence.toFixed(2)})`}
        style={{ left: `${item.x}px`, top: `${item.y}px` }}><span>{item.label}</span></div>)}
    {tray.length > 0 && <aside className="glass-tray" data-glass-tray aria-label="Check placement">
      <header><h2>Check placement</h2><span>{tray.length}</span></header>
      <ul>{tray.map(item => <li key={item.id} data-glass-tray-item={item.id}>
        <p title={item.context}>{item.context || item.label}</p>
        <button type="button" onClick={() => setPlacing(placing === item.id ? undefined : item.id)}>
          {placing === item.id ? "Click a paragraph" : "Place"}
        </button>
      </li>)}</ul>
      {placing && <p role="status">Click the paragraph this magnet belongs to.</p>}
    </aside>}
  </div>, scroller);
}
