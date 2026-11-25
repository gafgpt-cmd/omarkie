import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, FoldVertical, Paperclip, PenLine, Save, Trash2, Undo2 } from "lucide-react";
import type { GlassPlacement } from "../glass/anchor-map";
import { glassAsset } from "../glass/glass-assets";
import { sheetInkColors, type SheetStroke } from "../../shared/glass-clips.mjs";
import type { ClipPage, Cutout, ExtraPage } from "../glass/clip-model";

interface Place { x: number; y: number; width: number; height: number }

const clipPathOf = (lasso: Cutout["lasso"]) => lasso?.length
  ? `polygon(${lasso.map(([x, y]) => `${x}% ${y}%`).join(", ")})`
  : undefined;

// Ink lives in 0-1000 sheet units, so a resized page keeps the drawing.
function SheetInk({ strokes, color, size, active, onChange, label }: {
  strokes: SheetStroke[]; color: string; size: number; active: boolean;
  onChange(strokes: SheetStroke[]): void; label: string;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<[number, number][]>([]);
  const drawing = useRef<number | undefined>(undefined);
  const unit = (event: React.PointerEvent) => {
    const box = surface.current?.getBoundingClientRect();
    if (!box?.width || !box?.height) return [0, 0] as [number, number];
    return [Math.max(0, Math.min(1000, ((event.clientX - box.left) / box.width) * 1000)),
      Math.max(0, Math.min(1000, ((event.clientY - box.top) / box.height) * 1000))] as [number, number];
  };
  function start(event: React.PointerEvent) {
    if (!active || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drawing.current = event.pointerId;
    setDraft([unit(event)]);
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  }
  function move(event: React.PointerEvent) {
    if (drawing.current !== event.pointerId || !active) return;
    event.preventDefault();
    const point = unit(event);
    setDraft(current => {
      const last = current.at(-1);
      if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < 1.5) return current;
      return [...current, point];
    });
  }
  function end(event: React.PointerEvent) {
    if (drawing.current !== event.pointerId) return;
    drawing.current = undefined;
    const points = draft.length > 1 ? draft : [];
    setDraft([]);
    if (!points.length) return;
    onChange([...strokes, { color, size, points }].slice(-600));
  }
  return <div ref={surface} className="glass-sheet-ink" data-sheet-ink={active ? "on" : "off"} aria-label={label}
    onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
    <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
      {strokes.map((stroke, index) => <polyline key={index} data-sheet-stroke={index} fill="none" stroke={stroke.color}
        strokeWidth={stroke.size * 2} strokeLinecap="round" strokeLinejoin="round"
        points={stroke.points.map(point => point.join(",")).join(" ")} />)}
      {draft.length > 1 && <polyline data-sheet-draft fill="none" stroke={color} strokeWidth="10"
        strokeLinecap="round" strokeLinejoin="round" points={draft.map(point => point.join(",")).join(" ")} />}
    </svg>
  </div>;
}

function SheetBody({ text, strokes, color, size, ink, note, id, textLabel, onText, onStrokes, onInk, placeholder }: {
  text: string; strokes: SheetStroke[]; color: string; size: number; ink: boolean; note?: string; id: string;
  textLabel: string; onText(text: string): void; onStrokes(strokes: SheetStroke[]): void; onInk(on: boolean): void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState(text);
  const committed = useRef(text), latest = useRef(text);
  const write = useRef(onText);
  write.current = onText;
  latest.current = draft;
  const flush = useCallback(() => {
    if (latest.current === committed.current) return;
    committed.current = latest.current;
    write.current(latest.current);
  }, []);
  useEffect(() => flush, [flush]);
  useEffect(() => {
    if (draft === committed.current) return;
    const timer = setTimeout(flush, 400);
    return () => clearTimeout(timer);
  }, [draft, flush]);
  useEffect(() => {
    if (text === committed.current || latest.current !== committed.current) return;
    committed.current = text;
    setDraft(text);
  }, [text]);
  return <>
    <textarea className="glass-sheet-text" data-sheet-text={id} aria-label={textLabel} value={draft}
      placeholder={placeholder} spellCheck onChange={event => setDraft(event.target.value)} onBlur={flush}
      onPointerDown={event => ink && event.stopPropagation()} />
    <SheetInk strokes={strokes} color={color} size={size} active={ink} onChange={onStrokes} label={textLabel} />
    {note && <span className="glass-sheet-note-path" data-sheet-saved={note}>{note}</span>}
    <button type="button" className="glass-sheet-ink-toggle" data-sheet-ink-toggle={id} aria-pressed={ink}
      aria-label={ink ? "Stop drawing" : "Draw on this page"} title={ink ? "Stop drawing" : "Draw on this page"}
      onClick={() => onInk(!ink)}><PenLine size={13} /></button>
  </>;
}

export function ClipView({ clip, place, selected, savedNote, note, inkColor, inkSize, onSelect, onFold, onText, onStrokes,
  onSave, onDelete, onJump }: {
  clip: ClipPage; place: Extract<GlassPlacement, { status: "resolved" }>; selected: boolean; savedNote?: string | null;
  note?: string; inkColor: string; inkSize: number;
  onSelect(): void; onFold(folded: boolean): void; onText(text: string): void; onStrokes(strokes: SheetStroke[]): void;
  onSave(): Promise<unknown> | void; onDelete(): void; onJump?(): void;
}) {
  const [saving, setSaving] = useState(false);
  const [painting, setPainting] = useState(false);
  const title = clip.title.trim() || clip.text.split(/\r?\n/).find(line => line.trim())?.replace(/^#+\s*/, "").slice(0, 70) || "Clipped page";
  if (clip.folded) return <div className="glass-clip" data-magnet={clip.id} data-clip data-folded data-selected={selected || undefined}
    style={{ left: `${place.x}px`, top: `${place.y}px` }} tabIndex={0} onPointerDown={onSelect}
    onDoubleClick={() => onFold(false)} onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onFold(false); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); onDelete(); }
    }}>
    <button type="button" className="glass-clip-pill" data-clip-pill aria-expanded="false" title="Unfold this clipped page"
      onClick={() => onFold(false)}>
      <Paperclip size={14} aria-hidden="true" /><span>{title}</span><small>Clip</small>
    </button>
  </div>;
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try { await onSave(); } finally { setSaving(false); }
  };
  return <div className="glass-sheet glass-clip" data-magnet={clip.id} data-clip data-selected={selected || undefined}
    style={{ left: `${place.x}px`, top: `${place.y}px`, width: `${place.width}px`, height: `${place.height}px` }}
    tabIndex={0} aria-label={`Clipped page: ${title}`} onPointerDown={onSelect} onKeyDown={event => {
      const target = event.target as HTMLElement;
      if (target.closest("textarea, input, button")) return;
      if (event.key === "Escape" || event.key === "f" || event.key === "F") { event.preventDefault(); onFold(true); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); onDelete(); }
    }}>
    <header className="glass-sheet-head">
      <Paperclip size={14} aria-hidden="true" />
      <span className="glass-sheet-heading glass-clip-title" data-clip-title>{title}</span>
      <div className="glass-sheet-actions">
        {onJump && <button type="button" data-clip-jump title="Go to the paragraph this clip holds" aria-label="Jump to source" onClick={onJump}><Undo2 size={13} /></button>}
        <button type="button" data-clip-save title="Save this mini-page as one new note" aria-label="Save as note"
          disabled={saving} onClick={() => void save()}><Save size={13} /></button>
        <button type="button" data-clip-fold title="Fold the clip back into the margin" aria-label="Fold clip" onClick={() => onFold(true)}><FoldVertical size={13} /></button>
        <button type="button" data-clip-delete title="Move this clip to the glass trash" aria-label="Delete clip" onClick={onDelete}><Trash2 size={13} /></button>
      </div>
    </header>
    <div className="glass-sheet-body">
      <SheetBody id={clip.id} note={savedNote ?? undefined} text={clip.text} strokes={clip.strokes} color={inkColor} size={inkSize}
        ink={painting} textLabel="Clipped page Markdown" placeholder="Write the extra page here; the note stays untouched."
        onText={onText} onStrokes={onStrokes} onInk={setPainting} />
    </div>
    <span className="glass-sheet-grip" data-grip="right" aria-hidden="true" />
    <span className="glass-sheet-grip glass-sheet-grip-bottom" data-grip="bottom" aria-hidden="true" />
  </div>;
}

export function ExtraPageView({ page, place, selected, inkColor, inkSize, onSelect, onText, onStrokes, onDelete, onJump }: {
  page: ExtraPage; place: Place; selected: boolean; inkColor: string; inkSize: number; onSelect(): void;
  onText(text: string): void; onStrokes(strokes: SheetStroke[]): void; onDelete(): void; onJump?(): void;
}) {
  const [painting, setPainting] = useState(false);
  const title = page.title.trim() || "Extra page";
  return <div className="glass-sheet glass-extra-page" data-magnet={page.id} data-extra-page data-paper={page.paper} data-selected={selected || undefined}
    style={{ left: `${place.x}px`, top: `${place.y}px`, width: `${place.width}px`, height: `${place.height}px` }}
    tabIndex={0} aria-label={title} onPointerDown={onSelect} onKeyDown={event => {
      const target = event.target as HTMLElement;
      if (target.closest("textarea, input, button")) return;
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); onDelete(); }
    }}>
    <header className="glass-sheet-head">
      <FileText size={14} aria-hidden="true" />
      <span className="glass-sheet-heading" data-extra-title>{title}</span>
      <div className="glass-sheet-actions">
        {onJump && <button type="button" data-extra-jump title="Go to the paragraph this sheet sits beside" aria-label="Jump to source" onClick={onJump}><Undo2 size={13} /></button>}
        <button type="button" data-extra-delete title="Move this sheet to the glass trash" aria-label="Delete extra page" onClick={onDelete}><Trash2 size={13} /></button>
      </div>
    </header>
    <div className="glass-sheet-body">
      <SheetBody id={page.id} text={page.text} strokes={page.strokes} color={inkColor} size={inkSize} ink={painting}
        textLabel={`${title} Markdown`} placeholder="A blank sheet between paragraphs: write or draw here."
        onText={onText} onStrokes={onStrokes} onInk={setPainting} />
    </div>
    <span className="glass-sheet-grip" data-grip="right" aria-hidden="true" />
    <span className="glass-sheet-grip glass-sheet-grip-bottom" data-grip="bottom" aria-hidden="true" />
  </div>;
}

export function CutoutView({ cutout, place, selected, note, sourceImage, onSelect, onDelete, onJump }: {
  cutout: Cutout; place: Place; selected: boolean; note?: string; sourceImage?: string;
  onSelect(): void; onDelete(): void; onJump(): void;
}) {
  const [source, setSource] = useState<string>();
  const [missing, setMissing] = useState(false);
  const down = useRef<{ x: number; y: number } | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    if (cutout.sourceKind === "image" && sourceImage) { setSource(sourceImage); setMissing(false); return; }
    if (!note || !cutout.asset) { setSource(undefined); setMissing(true); return; }
    void glassAsset(note, cutout.id, cutout.display ? "display" : "original").then(url => {
      if (!alive) return;
      setSource(url ?? undefined);
      setMissing(!url);
    });
    return () => { alive = false; };
  }, [note, cutout.id, cutout.display, cutout.asset, cutout.sourceKind, sourceImage]);
  const crop = cutout.sourceKind === "image" && source
    ? { position: "absolute" as const, width: `${10_000 / Math.max(0.1, cutout.region.w)}%`,
        height: `${10_000 / Math.max(0.1, cutout.region.h)}%`,
        left: `-${(cutout.region.x / Math.max(0.1, cutout.region.w)) * 100}%`,
        top: `-${(cutout.region.y / Math.max(0.1, cutout.region.h)) * 100}%`, maxWidth: "none" }
    : undefined;
  return <div className="glass-cutout" data-magnet={cutout.id} data-cutout data-selected={selected || undefined}
    style={{ left: `${place.x}px`, top: `${place.y}px`, width: `${place.width}px`, height: `${place.height}px` }}
    tabIndex={0} aria-label={`Cutout: ${cutout.name}`} title={`Jump to ${cutout.source.kind ?? "source"} on line ${cutout.source.line}`}
    onPointerDown={event => { onSelect(); down.current = { x: event.clientX, y: event.clientY }; }}
    onClick={event => {
      const start = down.current;
      down.current = undefined;
      if (!start || event.button !== 0) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 4) onJump();
    }}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onJump(); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); onDelete(); }
    }}>
    {source
      ? <span className="glass-cutout-frame" style={cutout.lasso ? { clipPath: clipPathOf(cutout.lasso) } : undefined}>
          <img className="glass-cutout-image" src={source} alt="" draggable={false} style={crop} />
        </span>
      : <span className="glass-cutout-missing" role="status">{missing ? "Picture missing" : "Loading cutout…"}</span>}
    <span className="glass-cutout-badge" aria-hidden="true"><Paperclip size={11} />{cutout.name}</span>
    <div className="glass-cutout-actions">
      <button type="button" data-cutout-jump title="Jump to source" aria-label="Jump to source"
        onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onJump(); }}><FileText size={12} /></button>
      <button type="button" data-cutout-delete title="Move cutout to the glass trash" aria-label="Delete cutout"
        onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onDelete(); }}><Trash2 size={12} /></button>
    </div>
    <span className="glass-cutout-grip" data-grip="bottom-right" aria-hidden="true" />
  </div>;
}
