import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorHandle } from "../editor/MarkdownEditor";
import { indexBlocks, liveBlocks, matchIndexed, type GlassAnchor } from "../glass/anchor-map";
import { kindOf, magnetLabel } from "../../shared/glass-labels.mjs";
import { host } from "../host";
import "./shared-glass.css";

interface SharedMagnet { id: string; fields: Record<string, unknown> & { anchor?: GlassAnchor }; kind?: string | null }
interface Place { x: number; y: number }

// G18: another person's journal is a layer, not an edit surface. Cards show their text and
// anchor, scroll with the page, and never write to that journal.
export default function SharedGlassLayer({ root, editor, note }: {
  root: HTMLElement; editor: () => EditorHandle | undefined; note?: string;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [magnets, setMagnets] = useState<SharedMagnet[]>([]);
  const [places, setPlaces] = useState<Record<string, Place>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    if (!note || !host.sharedGlass) return;
    let live = true;
    void host.sharedGlass(note).then(value => { if (live) setMagnets(Array.isArray(value?.magnets) ? value.magnets : []); },
      failure => { if (live) setError((failure as Error).message); });
    return () => { live = false; };
  }, [note]);
  useEffect(() => {
    const surface = layer.current;
    if (!surface || !root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const blocks = liveBlocks(editor()?.readingContext(), root);
      const index = indexBlocks(blocks);
      const byLine = new Map(blocks.map(block => [block.line, block]));
      const box = surface.getBoundingClientRect();
      const next: Record<string, Place> = {};
      const used: { x: number; y: number; w: number; h: number }[] = [];
      const cardWidth = 236, cardHeight = 88;
      for (const magnet of magnets) {
        const anchor = magnet.fields?.anchor;
        const line = anchor ? matchIndexed(index, anchor) : null;
        const element = line === null ? undefined : byLine.get(line)?.element;
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.left - box.left + (Number(magnet.fields?.x) || 0), surface.clientWidth - cardWidth - 8));
        let y = Math.max(0, rect.top - box.top + (Number(magnet.fields?.y) || 0));
        while (used.some(item => x < item.x + item.w && x + cardWidth > item.x && y < item.y + item.h && y + cardHeight > item.y)) y += cardHeight + 8;
        next[magnet.id] = { x, y };
        used.push({ x, y, w: cardWidth, h: cardHeight });
      }
      setPlaces(next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => { if (frame) cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); };
  }, [magnets, root]);
  const shown = magnets.filter(magnet => places[magnet.id]);
  return createPortal(<div className="shared-glass-layer" ref={layer} data-shared-glass="on" aria-label="Shared glass (read-only)">
    {error && <p role="alert">{error}</p>}
    {shown.map(magnet => {
      const kind = kindOf(magnet), fields = magnet.fields ?? {};
      const text = kind === "sticky" ? String(fields.text ?? "") : kind === "comment"
        ? (Array.isArray(fields.thread) ? fields.thread.filter(entry => entry && typeof entry.text === "string").map(entry => entry.text).join("\n") : String(fields.text ?? ""))
        : kind === "card" ? [fields.question, fields.answer].filter(value => typeof value === "string" && value.trim()).join("\n")
        : kind === "image" ? String(fields.name ?? "") : "";
      const label = magnetLabel(kind, fields);
      return <aside key={magnet.id} className="shared-glass-card" style={{ left: places[magnet.id].x, top: places[magnet.id].y }} data-kind={kind}>
        <strong>{label}</strong>
        {text && text.trim() !== label && <p>{text}</p>}
        <small>Shared · read-only</small>
      </aside>;
    })}
  </div>, root);
}
