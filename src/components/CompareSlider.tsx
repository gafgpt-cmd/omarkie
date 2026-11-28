import { useRef } from "react";
import type { CompareDirection } from "../../shared/glass-visual.mjs";
import "./compare-slider.css";

interface Props {
  // Picture panes; an overlay divider (`overlay`) has none and lets the page underneath take the pointer.
  left?: string | null;
  right?: string | null;
  leftAlt?: string;
  rightAlt?: string;
  overlay?: boolean;
  value: number;
  direction: CompareDirection;
  before: string;
  after: string;
  hint?: string;
  label?: string;
  valueText?(value: number): string;
  onChange(value: number): void;
  onCommit(value: number): void;
  onSwap?(): void;
  onDelete?(): void;
}

// One compare widget for before/after pictures and, as an overlay divider, two layouts of one page.
// The reference library has no ARIA value; this one is a real slider: arrows ±1,
// Shift ±10, Home/End, and a spoken percentage.
export default function CompareSlider({ left, right, leftAlt = "", rightAlt = "", overlay, value, direction, before, after, hint, label, valueText,
  onChange, onCommit, onSwap, onDelete }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number } | undefined>(undefined);
  const shown = Math.round(Math.min(100, Math.max(0, value)));
  const latest = useRef(shown);
  latest.current = shown;
  const vertical = direction === "vertical";
  const move = (clientX: number, clientY: number) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    const raw = vertical ? (clientY - box.top) / box.height : (clientX - box.left) / box.width;
    latest.current = Math.round(Math.max(0, Math.min(1, raw)) * 100);
    onChange(latest.current);
  };
  const step = (delta: number) => {
    latest.current = Math.round(Math.min(100, Math.max(0, latest.current + delta)));
    onChange(latest.current);
    onCommit(latest.current);
  };
  const key = (event: React.KeyboardEvent) => {
    if (event.key === "Home") { event.preventDefault(); step(-100); return; }
    if (event.key === "End") { event.preventDefault(); step(100); return; }
    const coarse = event.shiftKey ? 10 : 1;
    if (event.key === (vertical ? "ArrowUp" : "ArrowLeft")) { event.preventDefault(); step(-coarse); }
    else if (event.key === (vertical ? "ArrowDown" : "ArrowRight")) { event.preventDefault(); step(coarse); }
    else if (vertical && event.key === "ArrowLeft") { event.preventDefault(); step(-coarse); }
    else if (vertical && event.key === "ArrowRight") { event.preventDefault(); step(coarse); }
  };
  return <div ref={frame} className="glass-compare" data-compare data-compare-direction={direction} data-compare-overlay={overlay || undefined}
    data-compare-value={shown} onPointerDown={event => {
      if (event.button !== 0 || overlay) return;
      const target = event.target as HTMLElement;
      if (target.closest("button, [data-compare-handle]")) return;
      event.preventDefault();
      frame.current?.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId };
      move(event.clientX, event.clientY);
    }} onPointerMove={event => {
      if (drag.current?.pointer !== event.pointerId) return;
      move(event.clientX, event.clientY);
    }} onPointerUp={event => {
      if (drag.current?.pointer !== event.pointerId) return;
      drag.current = undefined;
      move(event.clientX, event.clientY);
      onCommit(latest.current);
    }} onLostPointerCapture={() => { drag.current = undefined; }}>
    {overlay ? <span className="glass-compare-line" aria-hidden="true" style={vertical ? { top: `${shown}%` } : { left: `${shown}%` }} /> : <>
      <div className="glass-compare-pane" data-compare-side="after">
        {right ? <img src={right} alt={rightAlt} draggable={false} /> : <span className="glass-compare-missing">{rightAlt} missing</span>}
      </div>
      <div className="glass-compare-pane" data-compare-side="before" style={{ clipPath: vertical
        ? `inset(0 0 ${100 - shown}% 0)` : `inset(0 ${100 - shown}% 0 0)` }}>
        {left ? <img src={left} alt={leftAlt} draggable={false} /> : <span className="glass-compare-missing">{leftAlt} missing</span>}
      </div>
    </>}
    <span className="glass-compare-label" data-compare-label="before" aria-hidden="true">{before}</span>
    <span className="glass-compare-label" data-compare-label="after" aria-hidden="true">{after}</span>
    <button type="button" className="glass-compare-handle" data-compare-handle tabIndex={0}
      role="slider" aria-label={label ?? "Compare before and after"} aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown} aria-valuetext={valueText ? valueText(shown) : `${shown} percent ${before}`}
      style={vertical ? { top: `${shown}%`, left: "50%" } : { left: `${shown}%`, top: "50%" }}
      onKeyDown={key} onClick={event => event.preventDefault()} onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId };
        event.currentTarget.focus();
      }} onPointerMove={event => {
        if (drag.current?.pointer !== event.pointerId) return;
        event.stopPropagation();
        move(event.clientX, event.clientY);
      }} onPointerUp={event => {
        if (drag.current?.pointer !== event.pointerId) return;
        event.stopPropagation();
        drag.current = undefined;
        move(event.clientX, event.clientY);
        onCommit(latest.current);
      }}>
      <span aria-hidden="true">◂▸</span>
    </button>
    {!overlay && <div className="glass-compare-tools" role="group" aria-label="Compare">
      {onSwap && <button type="button" data-compare-swap aria-label="Swap before and after" title="Swap sides"
        onClick={onSwap}>⇆</button>}
      {onDelete && <button type="button" data-compare-delete aria-label="Delete compare" title="Delete compare"
        onClick={onDelete}>×</button>}
    </div>}
    {hint && <span className="glass-compare-hint">{hint}</span>}
  </div>;
}
