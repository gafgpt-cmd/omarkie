import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { EditorHandle, ReadingContext } from "../editor/MarkdownEditor";
import { captureAnchor, liveBlocks, normalizeText, resolveAnchor, type GlassAnchor, type GlassResolution } from "../glass/anchor-map";
import type { GlassMagnet } from "../glass/glass-model";
import { anchorFrom, glassFixture } from "../glass/glass-state";
import { LearningOverlays, type StudyOverlay } from "./learning-overlays";

interface Item { id: string; line: number; label: string; context: string; state: "placed" | "check" | "tray"; confidence: number; tier: GlassResolution["tier"] }
interface Seed { text: string; label?: string }
const confidenceCheck = 0.8, confidenceTray = 0.5;

export function landmarkSeeds(): Seed[] | undefined {
  if (!glassFixture()) return;
  try {
    const value = JSON.parse(localStorage.getItem("omarkie-glass-magnets") || "null");
    if (!Array.isArray(value) || !value.length || value.length > 20) return;
    const seeds = value.flatMap(item => {
      const text = typeof item === "string" ? item : item && typeof item.text === "string" ? item.text : undefined;
      if (!text?.trim()) return [];
      return [{ text, ...(typeof item?.label === "string" ? { label: item.label } : {}) }];
    });
    return seeds.length === value.length ? seeds : undefined;
  } catch { return; }
}

function anchorContext(anchor: GlassAnchor | undefined) {
  if (!anchor) return "";
  for (const landmark of anchor.landmarks) {
    if (landmark.kind === "quote") return normalizeText(landmark.value.exact);
    if (landmark.kind === "block") return normalizeText(landmark.block);
  }
  return "";
}

export default function GlassLandmarks({ editor, root, nodes, groups, note, saved, magnets, seeds }: {
  editor(): EditorHandle | undefined; root: HTMLElement; nodes: ReadingContext["nodes"]; groups: StudyOverlay[];
  note?: string; saved: boolean; magnets: GlassMagnet[]; seeds?: Seed[];
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [placing, setPlacing] = useState<string>();
  const [writeError, setWriteError] = useState<string>();
  const frame = useRef(0), seeded = useRef(false), previousSaved = useRef(saved), fingerprint = useRef("");
  const saving = useRef(false), dirty = useRef(false);
  const mapped = useRef(new Map<string, number>()), live = useRef(new Set<string>());
  const enabled = magnets.length > 0 || !!seeds?.length;

  async function store(request: Record<string, unknown>) {
    if (!note || !window.desktop?.glass) throw new Error("Glass storage is unavailable.");
    const response = await window.desktop.glass({ ...request, note });
    if (!response?.ok) throw new Error(response?.error || "Glass could not save the anchor.");
  }

  const measure = useEffectEvent(async () => {
    const blocks = liveBlocks(editor()?.readingContext(), root);
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
            await store({ action: "add", magnet: `m-g2b-${index + 1}`, kind: "debug", text: seed.label ?? seed.text, anchor: captureAnchor(block, blocks) });
            return true;
          } catch { return false; }
        }));
        try { if (created.every(Boolean)) localStorage.setItem(key, "true"); } catch { /* storage unavailable */ }
        return;
      }
    }
    const byLine = new Map(blocks.map(block => [block.line, block]));
    const resolved = magnets.map((magnet): Item => {
      const anchor = anchorFrom(magnet.fields.anchor);
      const char = live.current.has(magnet.id) ? mapped.current.get(magnet.id) : undefined;
      const result = anchor ? resolveAnchor(anchor, blocks, { liveChar: char }) : { confidence: 0, tier: "none" as const, line: null };
      const state = result.line === null || result.confidence < confidenceTray ? "tray" : result.confidence >= confidenceCheck ? "placed" : "check";
      if (state === "placed" && char === undefined && result.line !== null) {
        const start = byLine.get(result.line)?.from;
        if (start !== undefined) mapped.current.set(magnet.id, start);
      }
      const label = typeof magnet.fields.text === "string" && magnet.fields.text.trim() ? magnet.fields.text : magnet.kind ?? magnet.id;
      return { id: magnet.id, line: result.line ?? 0, label, context: anchorContext(anchor), state, confidence: result.confidence, tier: result.tier };
    });
    const next = JSON.stringify(resolved);
    if (next === fingerprint.current) return;
    fingerprint.current = next;
    setItems(resolved);
  });

  const schedule = useEffectEvent(() => {
    if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; void measure(); });
  });
  useEffect(() => {
    mapped.current.clear();
    live.current.clear();
    schedule();
  }, [magnets]);
  useEffect(() => {
    if (!enabled) return;
    const handle = editor();
    const stopTracking = handle?.trackChanges(map => {
      if (!mapped.current.size) return;
      for (const [id, char] of mapped.current) { mapped.current.set(id, map(char)); live.current.add(id); }
      dirty.current = true;
      schedule();
    });
    const edits = new MutationObserver(() => schedule());
    edits.observe(root, { childList: true, subtree: true, characterData: true });
    return () => { stopTracking?.(); edits.disconnect(); };
  }, [editor, enabled, root]);
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);

  const place = useEffectEvent((event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-cid]") : null;
    if (!placing || !target || !root.contains(target)) return;
    const blocks = liveBlocks(editor()?.readingContext(), root);
    const block = blocks.find(item => item.element === target || item.element?.dataset.cid === target.dataset.cid);
    if (!block) return;
    event.preventDefault();
    event.stopPropagation();
    setPlacing(undefined);
    setWriteError(undefined);
    void store({ action: "add", magnet: placing, anchor: captureAnchor(block, blocks) }).catch(error => {
      setWriteError(error.message);
      setPlacing(placing);
    });
  });
  useEffect(() => {
    if (!placing) return;
    const select = (event: MouseEvent) => place(event);
    root.addEventListener("click", select, true);
    return () => root.removeEventListener("click", select, true);
  }, [placing, root]);

  const recapture = useEffectEvent(() => {
    if (!dirty.current || !note || saving.current || !magnets.length) return;
    const context = editor()?.readingContext();
    if (!context) return;
    const blocks = liveBlocks(context, root), byLine = new Map(blocks.map(block => [block.line, block]));
    saving.current = true;
    dirty.current = false;
    void Promise.all(magnets.flatMap(magnet => {
      const anchor = anchorFrom(magnet.fields.anchor), char = live.current.has(magnet.id) ? mapped.current.get(magnet.id) : undefined;
      if (!anchor || char === undefined) return [];
      const { line, confidence } = resolveAnchor(anchor, blocks, { liveChar: char });
      const block = line === null ? undefined : byLine.get(line);
      return block && confidence >= confidenceCheck ? [store({ action: "add", magnet: magnet.id, anchor: captureAnchor(block, blocks) })] : [];
    })).catch(error => { dirty.current = true; setWriteError(error.message); }).finally(() => { saving.current = false; });
  });
  useEffect(() => {
    const changed = saved && !previousSaved.current;
    previousSaved.current = saved;
    if (changed) recapture();
  }, [saved]);

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
    {tray.length > 0 && <aside className="glass-landmark-tray" data-glass-tray aria-label="Check placement">
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
  </>;
}
