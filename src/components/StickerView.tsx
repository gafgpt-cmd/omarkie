import { useRef, useState } from "react";
import StickerArt from "./StickerArt";
import { stickerName, type StickerMark } from "../glass/sticker-model";
import type { GlassPlacement } from "../glass/anchor-map";

// G8: a sticker is paper on the Notes & stickers layer — pick up, turn, stretch, peel off.
export default function StickerView({ sticker, place, selected, onSelect, onRotate, onNudge, onDelete }: {
  sticker: StickerMark; place: GlassPlacement; selected: boolean; onSelect(): void;
  onRotate(rotate: number): void; onNudge(dx: number, dy: number): void; onDelete(): void;
}) {
  const paper = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<number | undefined>(undefined), [turning, setTurning] = useState(false);
  const turn = useRef<{ center: { x: number; y: number }; angle: number; rotate: number } | undefined>(undefined);
  const name = stickerName(sticker);
  if (place.status === "orphan") return null;
  const angleAt = (x: number, y: number) => {
    const center = turn.current?.center;
    return center ? Math.atan2(y - center.y, x - center.x) * 180 / Math.PI : 0;
  };
  return <div className="glass-sticker" data-magnet={sticker.id} data-sticker={sticker.image ? "custom" : sticker.sticker}
    data-selected={selected || undefined} data-turning={turning || undefined} role="group" aria-label={name} tabIndex={0}
    style={{ left: `${place.x}px`, top: `${place.y}px`, width: `${place.width}px`, height: `${place.height}px` }}
    onPointerDown={onSelect}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      const nudge = event.key.startsWith("Arrow") ? 8 : 0;
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); onDelete(); }
      else if (event.key === "Escape") event.currentTarget.blur();
      else if (nudge) {
        event.preventDefault();
        onNudge(event.key === "ArrowLeft" ? -8 : event.key === "ArrowRight" ? 8 : 0, event.key === "ArrowUp" ? -8 : event.key === "ArrowDown" ? 8 : 0);
      }
    }}>
    <div className="glass-sticker-paper" ref={paper} style={{ "--sticker-rotate": `${draft ?? sticker.rotate}deg` } as React.CSSProperties}>
      <StickerArt id={sticker.sticker} image={sticker.image} label={name} />
    </div>
    {selected && <>
      <button type="button" className="glass-sticker-rotate" data-sticker-rotate aria-label="Rotate sticker" title="Turn the sticker"
        onPointerDown={event => {
          event.preventDefault();
          event.stopPropagation();
          const rect = paper.current?.getBoundingClientRect();
          if (!rect) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          turn.current = { center, angle: Math.atan2(event.clientY - center.y, event.clientX - center.x) * 180 / Math.PI, rotate: sticker.rotate };
          setDraft(sticker.rotate);
          setTurning(true);
        }}
        onPointerMove={event => {
          const start = turn.current;
          if (!start) return;
          const rotate = Math.round(start.rotate + angleAt(event.clientX, event.clientY) - start.angle);
          setDraft(((rotate + 180) % 360 + 360) % 360 - 180);
        }}
        onPointerUp={event => {
          const start = turn.current;
          turn.current = undefined;
          setTurning(false);
          if (!start) return;
          const rotate = Math.round(start.rotate + angleAt(event.clientX, event.clientY) - start.angle);
          const settled = ((rotate + 180) % 360 + 360) % 360 - 180;
          setDraft(undefined);
          onRotate(settled);
        }}
        onPointerCancel={() => { turn.current = undefined; setTurning(false); setDraft(undefined); }}>↻</button>
      <span className="glass-sticker-grip" data-grip="sticker" aria-hidden="true" />
      <button type="button" className="glass-sticker-delete" data-sticker-delete aria-label="Delete sticker" title="Move sticker to trash"
        onClick={onDelete}>×</button>
    </>}
  </div>;
}
