import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SrsGrade } from "../glass/srs-model";

export interface ExamItem {
  id: string;
  kind: "label" | "card" | "bubble";
  cue: string;
  answer: string;
  marked: boolean;
}

// Exam mode: every mark on the note becomes a cue. Reveal one by one; a grade here is a
// preview and never writes a review, so a mock exam leaves the real due dates alone.
export default function ExamPanel({ items, revealed, index, markedOnly, onIndex, onReveal, onMarkedOnly, onGrade, onClose }: {
  items: ExamItem[]; revealed: Set<string>; index: number; markedOnly: boolean;
  onIndex(index: number): void; onReveal(id: string): void; onMarkedOnly(value: boolean): void;
  onGrade(grade: SrsGrade, item: ExamItem): void; onClose(): void;
}) {
  const shown = useMemo(() => items.filter(item => !markedOnly || item.marked), [items, markedOnly]);
  const [filtered, setFiltered] = useState(markedOnly);
  const position = Math.max(0, Math.min(index, shown.length - 1));
  const item = shown[position];
  const isRevealed = !!item && revealed.has(item.id);
  const state = useRef({ shown, index, item, isRevealed, onIndex, onReveal, onGrade, onClose });
  state.current = { shown, index: position, item, isRevealed, onIndex, onReveal, onGrade, onClose };

  useEffect(() => { setFiltered(markedOnly); }, [markedOnly]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const current = state.current;
      if (!current.item) return;
      if (event.key === "Escape") { event.preventDefault(); current.onClose(); return; }
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        if (!current.isRevealed) current.onReveal(current.item.id);
        else if (current.index < current.shown.length - 1) current.onIndex(current.index + 1);
        return;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        const next = current.index + (event.key === "ArrowRight" ? 1 : -1);
        if (next >= 0 && next < current.shown.length) current.onIndex(next);
        return;
      }
      if (/^[1-4]$/.test(event.key)) {
        event.preventDefault();
        if (!current.isRevealed) current.onReveal(current.item.id);
        else current.onGrade((["again", "hard", "good", "easy"] as const)[Number(event.key) - 1], current.item);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!shown.length) return createPortal(<aside className="exam-panel" data-exam-panel="empty" role="dialog" aria-label="Exam mode">
    <p>{markedOnly ? "Nothing is marked yet. Mark a bubble, card or label with ★." : "This note has no bubbles, cards or labels yet."}</p>
    <div className="exam-actions"><button type="button" data-exam-close onClick={onClose}>Close</button></div>
  </aside>, document.body);

  return createPortal(<aside className="exam-panel" data-exam-panel={item.kind} role="dialog" aria-label="Exam mode">
    <header className="exam-head">
      <strong>{position + 1} / {shown.length}</strong>
      <span className="exam-cue" data-exam-cue>{item.kind === "label" ? "Name the pinned structure" : item.kind === "bubble" ? item.cue || "Comment" : item.cue}</span>
      <button type="button" className="exam-close" data-exam-close aria-label="Leave exam mode" onClick={onClose}>×</button>
    </header>
    {isRevealed
      ? <p className="exam-answer" data-exam-answer>{item.answer || "No answer stored."}</p>
      : <p className="exam-wait" data-exam-wait>Press Space to reveal</p>}
    <div className="exam-actions">
      <button type="button" data-exam-reveal onClick={() => onReveal(item.id)} disabled={isRevealed}>Reveal</button>
      <button type="button" data-exam-previous disabled={position === 0} onClick={() => onIndex(position - 1)}>Previous</button>
      <button type="button" data-exam-next disabled={position >= shown.length - 1} onClick={() => onIndex(position + 1)}>Next</button>
      <label className="exam-filter"><input type="checkbox" data-exam-marked checked={filtered} onChange={event => { setFiltered(event.target.checked); onMarkedOnly(event.target.checked); }} />Quiz only what I marked</label>
    </div>
    <div className="exam-grades" role="group" aria-label="Preview grades; due dates do not move">
      {(["again", "hard", "good", "easy"] as const).map((grade, order) => <button type="button" key={grade} data-exam-grade={grade}
        disabled={!isRevealed} onClick={() => onGrade(grade, item)}>{order + 1} {grade}</button>)}
    </div>
  </aside>, document.body);
}
