import { useLayoutEffect, useRef } from "react";
import { renderMath } from "../../editor/math";
import { t } from "../../i18n";
import { quoteRange, type StudyMark } from "../learning-overlays";

// Same reach as the Glass peek lens (G17), so both lenses feel like one tool.
export const LENS_RADIUS = 120;

// Unfold-to-evidence: the line's Full source, inline under it. Local stops quote the unit's own words.
export function FoldEvidence({ html, line, open }: { html: string; line: number; open(): void }) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { void renderMath(body.current!).catch(() => {}); }, [html]);
  return <div className="fold-peek-card" role="group" aria-label={t("Evidence")}>
    <div ref={body} className="fold-peek-quote" dangerouslySetInnerHTML={{ __html: html }} />
    <p className="fold-peek-meta">
      <span>{t("Source · line {{line}}", { line })}</span>
      <button type="button" className="fold-peek-open" onClick={open}>{t("Open in editor")} <kbd aria-hidden="true">⇧↵</kbd></button>
    </p>
  </div>;
}

// Rayos X: a circle over the folded line shows the source paragraph and its marks. It only paints; nothing under it moves.
export function FoldLens({ frame, root, html, marks, x, y }: {
  frame: HTMLElement; root: HTMLElement; html: string; marks: readonly StudyMark[]; x: number; y: number;
}) {
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { void renderMath(body.current!).catch(() => {}); }, [html]);
  useLayoutEffect(() => {
    const element = body.current!, byColour = new Map<string, Range[]>();
    for (const mark of marks) {
      const range = quoteRange(element, mark);
      if (!range) continue;
      const ranges = byColour.get(mark.colour);
      if (ranges) ranges.push(range); else byColour.set(mark.colour, [range]);
    }
    const names = [...byColour].map(([colour, ranges]) => { const name = `fold-lens-${colour}`; CSS.highlights.set(name, new Highlight(...ranges)); return name; });
    return () => { for (const name of names) CSS.highlights.delete(name); };
  }, [html, marks]);
  const box = frame.getBoundingClientRect(), rect = root.getBoundingClientRect();
  const cx = x - box.left, cy = y - box.top;
  return <>
    <div className="fold-lens" inert data-fold-lens style={{ clipPath: `circle(${LENS_RADIUS}px at ${cx}px ${cy}px)` }}>
      <article className="rich-document fold-document fold-lens-page" style={{ top: rect.top - box.top, left: rect.left - box.left, width: rect.width }}>
        <div ref={body} className="fold-unit" dangerouslySetInnerHTML={{ __html: html }} />
      </article>
    </div>
    <div className="fold-lens-ring" aria-hidden="true"
      style={{ left: cx - LENS_RADIUS, top: cy - LENS_RADIUS, width: LENS_RADIUS * 2, height: LENS_RADIUS * 2 }} />
  </>;
}
