import { useRef } from "react";
import { t } from "../../i18n";
import { STOPS, stopLabel as labelOf } from "./stops";

const stopLabel = (index: number) => labelOf(STOPS[index]);

// Floating level bar: five local stops on one slider, the model stop apart and off.
export function FoldBar({ index, percents, disabled, hint, pick, scrub, release }: {
  index: number;
  percents: number[];
  disabled: boolean;
  hint: boolean;
  pick(index: number): void;
  scrub(value: number): void;
  release(): void;
}) {
  const track = useRef<HTMLDivElement>(null), drag = useRef<{ id: number; moved: boolean; x: number } | null>(null);
  // Piecewise between stop label centres, so the thumb lands on a label at each whole stop.
  const valueAt = (x: number) => {
    const centres = [...track.current!.querySelectorAll<HTMLElement>("[data-stop]")].map(item => { const rect = item.getBoundingClientRect(); return rect.left + rect.width / 2; });
    if (x <= centres[0]) return 0;
    for (let i = 1; i < centres.length; i++) if (x <= centres[i]) return i - 1 + (x - centres[i - 1]) / (centres[i] - centres[i - 1]);
    return centres.length - 1;
  };
  const label = stopLabel(index);
  return <div className="fold-bar" data-disabled={disabled || undefined}>
    {disabled ? <p className="fold-bar-note" role="status">{t("Too short to fold")}</p> : hint && <p className="fold-bar-note">{t("Local fold · model lines when you choose")}</p>}
    <div className="fold-bar-row">
      <div ref={track} className="fold-track" role="slider" tabIndex={disabled ? -1 : 0} aria-label={t("Fold level")} aria-disabled={disabled || undefined}
        aria-valuemin={1} aria-valuemax={STOPS.length} aria-valuenow={index + 1}
        aria-valuetext={disabled ? t("Too short to fold") : t("{{level}}, {{percent}}% of words", { level: label, percent: percents[index] })}
        onKeyDown={event => {
          if (disabled) return;
          const next = event.key === "ArrowRight" || event.key === "ArrowUp" ? index + 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? index - 1
            : event.key === "Home" ? 0 : event.key === "End" ? STOPS.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); event.stopPropagation();
          pick(Math.max(0, Math.min(STOPS.length - 1, next)));
        }}
        onPointerDown={event => {
          if (disabled || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, moved: false, x: event.clientX };
        }}
        onPointerMove={event => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          if (!current.moved && Math.abs(event.clientX - current.x) < 3) return;
          current.moved = true;
          scrub(valueAt(event.clientX));
        }}
        onPointerUp={event => {
          const current = drag.current;
          if (!current || current.id !== event.pointerId) return;
          drag.current = null;
          if (current.moved) release(); else pick(Math.round(valueAt(event.clientX)));
        }}
        onLostPointerCapture={() => { if (drag.current?.moved) release(); drag.current = null; }}>
        {STOPS.map((stop, i) => <span key={stop} data-stop={stop} className="fold-stop" aria-hidden="true" data-current={i === index || undefined}>
          <span>{stopLabel(i)}</span><small>{percents[i]}%</small>
        </span>)}
      </div>
      <span className="fold-gap" aria-hidden="true" />
      <button type="button" className="fold-stop fold-estudio" disabled title={t("Estudio needs a model; local stops only for now")}>
        <span>{t("Estudio")}</span><small>{t("off")}</small>
      </button>
    </div>
  </div>;
}
