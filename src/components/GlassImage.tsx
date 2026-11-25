import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlignLeft, AlignRight, Bandage, BringToFront, Lock, LockOpen, RotateCw, SendToBack, Trash2 } from "lucide-react";
import type { GlassPlacement } from "../glass/anchor-map";
import { glassAsset, ensureDisplayCopy, wrapLabel } from "../glass/glass-assets";
import { imageWrapModes, type GlassImage, type ImageWrap } from "../glass/image-model";

interface Props {
  image: GlassImage;
  place: Extract<GlassPlacement, { status: "resolved" }>;
  selected: boolean;
  note?: string;
  scroller: HTMLElement;
  paintHost?: HTMLElement | null;
  onSelect(): void;
  onPatch(patch: Partial<GlassImage>, persist?: boolean): void;
  onDrop(drop: { dx: number; dy: number; clientX: number; clientY: number }): void;
  onLiveSize(width: number, height: number): void;
  maxWidth?: number;
  onDelete(): void;
  onSnap?(dx: number, dy: number, alt: boolean): { dx: number; dy: number };
  onSnapEnd?(): void;
  onSettle?(element: HTMLElement): void;
  onMerge?(): void;
  onJump?(): void;
}

// A photo on the glass: drag to place, corner to stretch (Shift keeps the ratio), handle to tilt.
// "Behind text" paints the picture in the layer under the page and keeps this frame as its handle.
export default function GlassImageFrame({ image, place, selected, note, scroller, paintHost, onSelect, onPatch, onDrop, onLiveSize, onDelete, onMerge, onJump, maxWidth, onSnap, onSnapEnd, onSettle }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const paint = useRef<HTMLImageElement>(null);
  const [source, setSource] = useState<string>();
  const [missing, setMissing] = useState(false);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const patchRef = useRef(onPatch);
  patchRef.current = onPatch;
  const gesture = useRef<{ pointer: number; mode: "move" | "resize" | "rotate"; x: number; y: number; w: number; h: number; dx: number; dy: number } | undefined>(undefined);
  const shift = useRef(false);
  const behind = image.wrap === "behind";

  // Lazy decode: a note with fifty photos only asks for the bytes that are near the viewport.
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setVisible(true); },
      { root: scroller, rootMargin: "320px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroller]);

  useEffect(() => {
    if (!visible || !note || !image.asset) return;
    let alive = true;
    void glassAsset(note, image.id, image.display ? "display" : "original").then(url => {
      if (!alive) return;
      setSource(url ?? undefined);
      setMissing(!url);
      if (url && !image.display && image.bytes > 0) void ensureDisplayCopy(note, image, fields => patchRef.current(fields as Partial<GlassImage>, true));
    });
    return () => { alive = false; };
  }, [visible, note, image.id, image.display, image.asset, image.bytes]);

  useEffect(() => {
    const track = (event: KeyboardEvent) => { shift.current = event.shiftKey; };
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    return () => { window.removeEventListener("keydown", track); window.removeEventListener("keyup", track); };
  }, []);

  const wrap = (mode: ImageWrap) => {
    if (mode !== "left" && mode !== "right") { onPatch({ wrap: mode }, true); return; }
    // A floated picture must leave a readable measure beside it.
    const width = Math.min(image.w, maxWidth ?? image.w);
    onPatch({ wrap: mode, x: 0, y: 0, w: width, h: Math.round(width / image.aspect) }, true);
  };

  function begin(event: React.PointerEvent, mode: "move" | "resize" | "rotate") {
    if (event.button !== 0 || image.locked) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    gesture.current = { pointer: event.pointerId, mode, x: event.clientX, y: event.clientY, w: image.w, h: image.h, dx: 0, dy: 0 };
    setBusy(true);
    frame.current?.classList.add("is-lifting");
  }

  function move(event: React.PointerEvent) {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId || !frame.current) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (current.mode === "move") {
      const placed = onSnap?.(dx, dy, event.altKey) ?? { dx, dy };
      current.dx = placed.dx; current.dy = placed.dy;
      frame.current.style.transform = `translate3d(${placed.dx}px, ${placed.dy}px, 0)`;
      if (paint.current) paint.current.style.transform = `translate3d(${placed.dx}px, ${placed.dy}px, 0) rotate(var(--glass-image-rot, 0deg))`;
    } else if (current.mode === "resize") {
      const width = Math.min(maxWidth ?? Number.POSITIVE_INFINITY, Math.max(48, Math.round(current.w + dx)));
      const height = shift.current ? Math.max(40, Math.round(width / image.aspect)) : Math.max(40, Math.round(current.h + dy));
      frame.current.style.width = `${width}px`;
      frame.current.style.height = `${height}px`;
      if (paint.current) { paint.current.style.width = `${width}px`; paint.current.style.height = `${height}px`; }
      onLiveSize(width, height);
    } else {
      const angle = (Math.atan2(event.clientY - current.y, event.clientX - current.x) * 180) / Math.PI + 90;
      const snappedAngle = shift.current ? Math.round(angle / 15) * 15 : Math.round(angle);
      const value = `${Math.max(-360, Math.min(360, snappedAngle))}deg`;
      frame.current.style.setProperty("--glass-image-rot", value);
      if (paint.current) paint.current.style.setProperty("--glass-image-rot", value);
    }
  }

  function end(event: React.PointerEvent) {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    gesture.current = undefined;
    setBusy(false);
    const element = frame.current;
    element?.classList.remove("is-lifting");
    if (!element) return;
    element.style.removeProperty("transform");
    if (paint.current) paint.current.style.removeProperty("transform");
    onSnapEnd?.();
    if (current.mode === "move") {
      onDrop({ dx: current.dx, dy: current.dy, clientX: event.clientX, clientY: event.clientY });
      onSettle?.(element);
    } else if (current.mode === "resize") {
      const width = Math.round(element.getBoundingClientRect().width), height = Math.round(element.getBoundingClientRect().height);
      element.style.removeProperty("width");
      element.style.removeProperty("height");
      if (paint.current) { paint.current.style.removeProperty("width"); paint.current.style.removeProperty("height"); }
      onPatch({ w: width, h: height }, true);
    } else {
      const raw = element.style.getPropertyValue("--glass-image-rot");
      element.style.removeProperty("--glass-image-rot");
      if (paint.current) paint.current.style.removeProperty("--glass-image-rot");
      onPatch({ rot: Number.parseFloat(raw) || 0 }, true);
    }
  }

  function key(event: React.KeyboardEvent) {
    if (event.target !== event.currentTarget && !(event.target as HTMLElement).dataset.glassHandle) return;
    const step = event.shiftKey ? 16 : 8;
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); onDelete(); }
    else if (event.key === "l" || event.key === "L") { event.preventDefault(); onPatch({ locked: !image.locked }, true); }
    else if (event.key === "t" || event.key === "T") { event.preventDefault(); onPatch({ tape: !image.tape }, true); }
    else if (event.key === "[" || event.key === "]") { event.preventDefault(); onPatch({ rot: image.rot + (event.key === "]" ? 15 : -15) }, true); }
    else if (event.key.startsWith("Arrow")) {
      if ((image.wrap === "left" || image.wrap === "right") && !event.shiftKey) return;
      event.preventDefault();
      if (event.shiftKey) onPatch({ w: image.w + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
        h: image.h + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) }, true);
      else onPatch({ x: image.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
        y: image.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) }, true);
    }
  }

  const rotation = `rotate(${image.rot}deg)`;
  return <div ref={frame} className="glass-image" data-magnet={image.id} data-wrap={image.wrap} data-glass-image data-glass-layer="media"
    data-locked={image.locked || undefined} data-tape={image.tape || undefined} data-selected={selected || undefined}
    data-busy={busy || undefined} tabIndex={0} role="group" aria-label={`Image, ${image.name}`}
    style={{ left: `${place.x}px`, top: `${place.y}px`, width: `${place.width}px`, height: `${place.height}px`, "--glass-image-rot": rotation } as React.CSSProperties}
    onKeyDown={key} onFocus={onSelect}>
    <span className="glass-image-body" data-glass-image-body onPointerDown={event => begin(event, "move")}
      onPointerMove={move} onPointerUp={end} onLostPointerCapture={end}>
      {behind ? null : source
        ? <img src={source} alt={image.name} draggable={false} loading="lazy" decoding="async" data-glass-image-source />
        : <span className="glass-image-fallback" data-glass-image-fallback>{missing ? `${image.name} — not available` : image.name}</span>}
    </span>
    {image.tape && <span className="glass-image-tape" aria-hidden="true" data-glass-image-tape />}
    {selected && <div className="glass-image-tools" role="group" aria-label="Image">
      {imageWrapModes.map(mode => <button type="button" key={mode} className="glass-image-tool" data-glass-wrap={mode}
        aria-label={wrapLabel(mode)} title={wrapLabel(mode)} aria-pressed={image.wrap === mode} onClick={() => wrap(mode)}>
        {mode === "left" ? <AlignLeft size={13} /> : mode === "right" ? <AlignRight size={13} /> : mode === "behind" ? <SendToBack size={13} /> : <BringToFront size={13} />}</button>)}
      <button type="button" className="glass-image-tool" data-glass-tape aria-label="Washi tape" title="Washi tape"
        aria-pressed={image.tape} onClick={() => onPatch({ tape: !image.tape }, true)}><Bandage size={13} /></button>
      <button type="button" className="glass-image-tool" data-glass-lock aria-label={image.locked ? "Unlock image" : "Lock image"}
        title={image.locked ? "Unlock image" : "Lock image"} aria-pressed={image.locked} onClick={() => onPatch({ locked: !image.locked }, true)}>
        {image.locked ? <Lock size={13} /> : <LockOpen size={13} />}</button>
      {onJump && image.source && <button type="button" className="glass-image-tool" data-glass-jump aria-label="Jump to source" title="Jump to source"
        onClick={onJump}>↩</button>}
      {onMerge && <button type="button" className="glass-image-tool" data-glass-merge={image.id} aria-label="Merge down" title="Merge down into the page"
        onClick={onMerge}>⇩</button>}
      <button type="button" className="glass-image-tool" data-glass-trash-image aria-label="Move image to trash" title="Move image to trash"
        onClick={onDelete}><Trash2 size={13} /></button>
    </div>}
    {selected && !image.locked && <>
      <span className="glass-image-handle" data-glass-handle="se" role="button" tabIndex={-1} aria-label="Resize image"
        onPointerDown={event => begin(event, "resize")} onPointerMove={move} onPointerUp={end} onLostPointerCapture={end} />
      <span className="glass-image-handle" data-glass-handle="rotate" role="button" tabIndex={-1} aria-label="Rotate image"
        onPointerDown={event => begin(event, "rotate")} onPointerMove={move} onPointerUp={end} onLostPointerCapture={end}><RotateCw size={12} /></span>
    </>}
    {behind && paintHost && createPortal(<img ref={paint} className="glass-image-paint" data-glass-image-paint src={source} alt={image.name}
      draggable={false} loading="lazy" decoding="async" data-missing={missing || undefined}
      style={{ left: `${place.x}px`, top: `${place.y}px`, width: `${place.width}px`, height: `${place.height}px`, "--glass-image-rot": rotation } as React.CSSProperties} />, paintHost)}
  </div>;
}
