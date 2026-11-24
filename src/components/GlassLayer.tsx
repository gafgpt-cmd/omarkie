import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorHandle } from "../editor/MarkdownEditor";
import { liveBlocks, placeAnchor, type GlassPlacement } from "../glass/anchor-map";
import { fixtureAnchor, glassFixture, rememberFixtureAnchor } from "../glass/glass-state";
import "./glass.css";

interface Box { id: string; placement: GlassPlacement }

export default function GlassLayer({ editor, scroller }: { editor(): EditorHandle | undefined; scroller: HTMLElement }) {
  const layer = useRef<HTMLDivElement>(null), fingerprint = useRef(""), mounted = useRef(false);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const fixture = useMemo(glassFixture, []);
  const measure = useEffectEvent(() => {
    const surface = layer.current;
    if (!surface) return;
    const document = scroller.querySelector<HTMLElement>(".rich-document");
    const blocks = document ? liveBlocks(editor()?.readingContext(), document) : [];
    const next: Box[] = [];
    if (fixture) {
      let anchor = fixtureAnchor();
      if (!anchor) {
        const paragraph = blocks.find(block => block.element?.tagName === "P" && !!block.element.textContent?.trim());
        if (paragraph) {
          anchor = { landmarks: [{ kind: "block", block: paragraph.block, headings: paragraph.headings, line: paragraph.line }] };
          rememberFixtureAnchor(anchor);
        }
      }
      if (anchor) next.push({ id: "fixture", placement: placeAnchor(anchor, { x: 0, y: 0 }, blocks, surface) });
    }
    if (!mounted.current) {
      mounted.current = true;
      performance.mark("omarkie:glass-mounted");
    }
    const serialized = JSON.stringify(next);
    if (serialized === fingerprint.current) return;
    fingerprint.current = serialized;
    setBoxes(next);
  });
  useEffect(() => {
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    measure();
    const sizes = new ResizeObserver(schedule);
    sizes.observe(scroller);
    const document = scroller.querySelector<HTMLElement>(".rich-document");
    if (document) sizes.observe(document);
    // Our own boxes are React output; their mutations must not schedule another pass.
    const edits = new MutationObserver(records => { if (records.every(record => layer.current?.contains(record.target))) return; schedule(); });
    edits.observe(scroller, { childList: true, subtree: true, characterData: true });
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      sizes.disconnect();
      edits.disconnect();
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [scroller, measure, fixture]);
  return createPortal(<div className="glass-layer" ref={layer} data-glass="on" aria-hidden="true">
    {boxes.map(box => box.placement.status === "resolved"
      ? <div className="glass-debug" key={box.id} data-glass-object={box.id} data-glass-status="resolved"
          style={{ left: `${box.placement.x}px`, top: `${box.placement.y}px`, width: `${box.placement.width}px`, height: `${box.placement.height}px` }} />
      : <div className="glass-debug" key={box.id} data-glass-object={box.id} data-glass-status="orphan" />)}
  </div>, scroller);
}
