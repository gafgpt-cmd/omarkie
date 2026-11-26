import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SrsCard, SrsDue, SrsGrade } from "../glass/srs-model";

const grades: SrsGrade[] = ["again", "hard", "good", "easy"];

function interval(due: string, now = Date.now()) {
  const minutes = Math.max(0, Math.round((Date.parse(due) - now) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
}

async function glassCall(request: Record<string, unknown>) {
  const api = window.desktop?.glass;
  if (!api) throw new Error("Study storage is not available here.");
  const reply = await api(request);
  if (!reply?.ok) throw new Error(reply?.error ?? "Study storage refused the change.");
  return reply.value ?? {};
}

// Review flow: Space reveals, 1-4 grades. Each answer is written before the next card shows.
export default function SrsPanel({ close }: { close(): void }) {
  const [due, setDue] = useState<SrsDue>({ due: [], count: 0, total: 0, learning: 0 });
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const card: SrsCard | undefined = due.due[index];
  const latest = useRef({ card, revealed, index, due, busy, close });
  latest.current = { card, revealed, index, due, busy, close };

  const refresh = useCallback(async () => {
    try {
      const value = await glassCall({ action: "srs-due" }) as SrsDue;
      setDue(value);
      setIndex(current => Math.min(current, Math.max(0, value.due.length - 1)));
      window.dispatchEvent(new CustomEvent("omarkie:study-changed"));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const grade = useCallback(async (value: SrsGrade) => {
    const current = latest.current.card;
    if (!current || latest.current.busy) return;
    setBusy(true); setError("");
    try {
      await glassCall({ action: "srs-review", id: current.id, grade: value });
      setRevealed(false);
      setIndex(0);
      await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }, [refresh]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const current = latest.current;
      if (event.key === "Escape") { event.preventDefault(); current.close(); return; }
      if (!current.card) return;
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        if (!current.revealed) setRevealed(true);
        else void grade("good");
        return;
      }
      if (/^[1-4]$/.test(event.key)) {
        event.preventDefault();
        if (!current.revealed) setRevealed(true);
        else void grade(grades[Number(event.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [grade]);

  const remaining = useMemo(() => due.due.length - index - 1, [due.due.length, index]);
  return createPortal(<aside className="srs-panel" data-srs-panel role="dialog" aria-label="Review due cards">
    <header className="srs-head">
      <strong data-srs-count>{due.due.length ? `${index + 1} / ${due.due.length}` : "No cards due"}</strong>
      <span className="srs-source">{card ? card.note : "Study queue"}</span>
      <button type="button" className="srs-close" data-srs-close aria-label="Close review" onClick={close}>×</button>
    </header>
    {card ? <>
      <p className="srs-front" data-srs-front>{card.front}</p>
      {revealed
        ? <p className="srs-back" data-srs-back>{card.back || "No answer stored."}</p>
        : <p className="srs-wait" data-srs-wait>Space to reveal</p>}
      <div className="srs-grades" role="group" aria-label="Grade this card">
        {grades.map((value, order) => <button type="button" key={value} data-srs-grade={value} disabled={busy}
          title={`${value} — next in ${card.next?.[value] ? interval(card.next[value].due) : "?"}`}
          onClick={() => { if (!revealed) setRevealed(true); else void grade(value); }}>
          <span>{order + 1} {value}</span>
          <small>{card.next?.[value] ? interval(card.next[value].due) : ""}</small>
        </button>)}
      </div>
      <div className="srs-actions">
        <button type="button" data-srs-next disabled={remaining <= 0} onClick={() => { setIndex(index + 1); setRevealed(false); }}>Skip</button>
        <span className="srs-hint">Space reveals · 1-4 grades · Esc closes</span>
      </div>
    </> : <div className="srs-empty">
      <p>{due.total ? "Nothing is due. The next review comes back on its own." : "No study cards yet. Miss a hidden label to make one."}</p>
      <div className="srs-actions"><button type="button" data-srs-close onClick={close}>Close</button></div>
    </div>}
    {error && <p className="srs-error" role="alert">{error}</p>}
  </aside>, document.body);
}
