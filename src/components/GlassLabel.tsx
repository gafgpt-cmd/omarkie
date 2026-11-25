import { useEffect, useRef, useState } from "react";
import type { GlassLabel } from "../glass/label-model";

// One image label: pin, leader line, text. Hidden means the pin stays and the text is the answer.
export default function GlassLabelView({ label, box, hidden, revealed, exam, editing, selected, onSelect, onReveal, onEdit, onText, onMove, onMark, onGrade, onDelete }: {
  label: GlassLabel; box: { x: number; y: number; width: number; height: number };
  hidden: boolean; revealed: boolean; exam: boolean; editing: boolean; selected: boolean;
  onSelect(): void; onReveal(): void; onEdit(editing: boolean): void; onText(text: string): void;
  onMove(dx: number, dy: number): void; onMark(marked: boolean): void;
  onGrade(grade: "good" | "again"): void; onDelete(): void;
}) {
  const [draft, setDraft] = useState(label.text);
  const drag = useRef<{ x: number; y: number; dx: number; dy: number; moved: boolean } | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  useEffect(() => { if (!editing) setDraft(label.text); }, [label.text, editing]);

  const pinX = box.x + label.nx * box.width, pinY = box.y + label.ny * box.height;
  const textShown = !hidden || revealed;
  const commit = () => {
    const text = draft.trim();
    if (!text) { onDelete(); return; }
    if (text !== label.text) onText(text);
    onEdit(false);
  };
  function down(event: React.PointerEvent) {
    if (event.button !== 0 || editing || !textShown) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, dx: label.dx, dy: label.dy, moved: false };
    onSelect();
  }
  function move(event: React.PointerEvent) {
    const current = drag.current;
    if (!current) return;
    const dx = current.dx + event.clientX - current.x, dy = current.dy + event.clientY - current.y;
    current.moved ||= Math.abs(dx - current.dx) + Math.abs(dy - current.dy) > 2;
    (event.currentTarget as HTMLElement).style.transform = `translate3d(${dx - label.dx}px, ${dy - label.dy}px, 0)`;
  }
  function up(event: React.PointerEvent) {
    const current = drag.current;
    drag.current = undefined;
    if (!current) return;
    (event.currentTarget as HTMLElement).style.removeProperty("transform");
    if (!current.moved) return;
    onMove(current.dx + event.clientX - current.x, current.dy + event.clientY - current.y);
  }

  return <div className="glass-label" data-label={label.id} data-hidden={hidden || undefined} data-revealed={revealed || undefined}
    data-exam={exam || undefined} data-selected={selected || undefined} data-marked={label.marked || undefined}
    style={{ left: `${pinX}px`, top: `${pinY}px` }} onPointerDown={event => { event.stopPropagation(); onSelect(); }}>
    <svg className="glass-label-leader" width="1" height="1" aria-hidden="true">
      <line x1={0} y1={0} x2={label.dx} y2={label.dy} />
    </svg>
    <button type="button" className="glass-label-pin" data-label-pin={label.id}
      aria-label={textShown ? `Label pin: ${label.text || "empty"}` : "Reveal hidden label"}
      onClick={event => { event.stopPropagation(); if (!textShown) onReveal(); }}>
      {textShown ? "" : "?"}
    </button>
    {textShown && (editing
      ? <input ref={input} className="glass-label-input" data-label-input={label.id} aria-label="Label text" value={draft}
          maxLength={240} onChange={event => setDraft(event.target.value)} onBlur={commit}
          onKeyDown={event => {
            if (event.key === "Enter") { event.preventDefault(); commit(); }
            else if (event.key === "Escape") { event.preventDefault(); setDraft(label.text); onEdit(false); }
          }} />
      : <span className="glass-label-text" data-label-text={label.id}
          style={{ left: `${label.dx}px`, top: `${label.dy}px`, transform: label.dx < 0 ? "translateX(-100%)" : undefined }}
          role="button" tabIndex={0} title="Drag to move; double-click to edit"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onDoubleClick={event => { event.stopPropagation(); onEdit(true); }}
          onKeyDown={event => {
            if (event.key === "Enter") { event.preventDefault(); onEdit(true); }
            else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); onDelete(); }
            else if (event.key === "m" || event.key === "M") { event.preventDefault(); onMark(!label.marked); }
          }}>
        <span className="glass-label-name">{label.text || "Label"}</span>
        <span className="glass-label-tools">
          <button type="button" aria-label="Mark label for exam" title={label.marked ? "Marked for exam" : "Mark for exam"}
            data-label-mark={label.id} aria-pressed={label.marked} onClick={event => { event.stopPropagation(); onMark(!label.marked); }}>★</button>
          {hidden && revealed && <>
            <button type="button" data-label-right={label.id} aria-label="I named it right" title="Right"
              onClick={event => { event.stopPropagation(); onGrade("good"); }}>✓</button>
            <button type="button" data-label-wrong={label.id} aria-label="I missed it" title="Wrong"
              onClick={event => { event.stopPropagation(); onGrade("again"); }}>✗</button>
          </>}
          <button type="button" data-label-delete={label.id} aria-label="Delete label" title="Delete label"
            onClick={event => { event.stopPropagation(); onDelete(); }}>⌫</button>
        </span>
      </span>)}
  </div>;
}
