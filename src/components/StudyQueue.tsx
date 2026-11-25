import { useCallback, useEffect, useState } from "react";
import SrsPanel from "./SrsPanel";
import { t } from "../i18n";

// The rail entry: due count for this vault, and the review sheet behind it.
export default function StudyQueue({ note }: { note?: string }) {
  const [count, setCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState(false);
  const refresh = useCallback(async () => {
    const api = window.desktop?.glass;
    if (!api) return;
    try {
      const reply = await api({ action: "srs-due" });
      if (!reply?.ok) return;
      const value = reply.value as { count?: number; total?: number };
      setCount(value.count ?? 0);
      setTotal(value.total ?? 0);
    } catch { /* the rail keeps its last count */ }
  }, []);

  useEffect(() => {
    if (!note) return;
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 60_000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    window.addEventListener("omarkie:study-changed", focus);
    const stop = window.desktop?.onGlassChanged?.((event: { note?: string; action?: string } | undefined) => {
      if (event?.action === "srs-answer" || event?.action === "srs-card" || event?.action === "srs-review" || event?.action === "study-set") void refresh();
    });
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      window.removeEventListener("omarkie:study-changed", focus);
      stop?.();
    };
  }, [note, refresh]);

  if (!note) return null;
  return <>
    <button type="button" className="study-due" data-srs-open data-srs-count={count} data-srs-total={total}
      title={t("Spaced repetition: due cards in this vault")} onClick={() => setOpen(true)}>
      {t("Review")} <strong>{count}</strong> {t("due")}{total ? <small> / {total}</small> : null}
    </button>
    {open && <SrsPanel close={() => { setOpen(false); void refresh(); }} />}
  </>;
}
