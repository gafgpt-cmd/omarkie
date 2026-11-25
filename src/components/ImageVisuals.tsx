import { useEffect, useRef, useState } from "react";
import { Lock, LockOpen, Plus, Trash2, ChevronLeft, ChevronRight, Eye, EyeOff, Pencil } from "lucide-react";
import { inkPath, pressureOf } from "../../shared/ink-core.mjs";
import {
  measureLabel, snapAnglePoint, snapLinePoint,
  type ImageScale, type MeasureKind, type Point2, type TraceTool,
} from "../../shared/glass-visual.mjs";
import type { ImageSheet } from "../../shared/glass-images.mjs";
import type { GlassImage } from "../glass/image-model";
import type { MeasureMark, SheetLabel, TraceMark } from "../glass/visual-model";

export type MeasureMode = "line" | "angle" | "scale";

export interface ImageVisualsProps {
  imageId: string;
  width: number;
  height: number;
  selected: boolean;
  sheets: ImageSheet[];
  activeSheet: string | null;
  traces: TraceMark[];
  labels: SheetLabel[];
  measures: MeasureMark[];
  scale: ImageScale | null;
  sheetsOpen: boolean;
  tracing: boolean;
  traceTool: TraceTool;
  traceColor: string;
  traceSize: number;
  labelMode: boolean;
  labelText: string;
  measuring: MeasureMode | null;
  onPatch(patch: Partial<GlassImage>, persist?: boolean): void;
  onActiveSheet(id: string): void;
  onTrace(fields: Record<string, unknown>): void;
  onLabel(fields: Record<string, unknown>): void;
  onMeasure(type: MeasureKind, points: Point2[]): void;
  onCalibration(line: [Point2, Point2]): void;
  onDraw(): void;
  onRemoveSheet?(sheetId: string): void;
  onToggleSheets?(): void;
  onSheetsOpen?(open: boolean): void;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const sheetId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export default function ImageVisuals({ imageId, width, height, selected, sheets, activeSheet, traces, labels,
  measures, scale, sheetsOpen, tracing, traceTool, traceColor, traceSize, labelMode, labelText, measuring,
  onPatch, onActiveSheet, onTrace, onLabel, onMeasure, onCalibration, onDraw, onRemoveSheet, onSheetsOpen }: ImageVisualsProps) {
  const surface = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<[number, number, number][]>([]);
  const draftRef = useRef<[number, number, number][]>([]);
  const [drag, setDrag] = useState<Point2 | null>(null);
  const [start, setStart] = useState<Point2 | null>(null);
  const startRef = useRef<Point2 | null>(null);
  const [clicks, setClicks] = useState<Point2[]>([]);
  const clicksRef = useRef<Point2[]>([]);
  const drawing = useRef<number>(0);
  const [opacities, setOpacities] = useState<Record<string, number>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const active = sheets.find(sheet => sheet.id === activeSheet) ?? sheets[0];
  const current = active?.id ?? null;
  const frame: [number, number] = [Math.max(1, width), Math.max(1, height)];

  useEffect(() => {
    // A new picture or a deleted sheet must not keep a stale local draft.
    setDraft([]); draftRef.current = [];
    setDrag(null); setStart(null); startRef.current = null;
    setClicks([]); clicksRef.current = [];
  }, [imageId, current]);

  useEffect(() => {
    if (!measuring) {
      setClicks([]); clicksRef.current = [];
      setDrag(null); setStart(null); startRef.current = null;
    }
  }, [measuring]);

  const point = (event: React.PointerEvent): Point2 => {
    const box = surface.current?.getBoundingClientRect();
    return box ? [clamp01((event.clientX - box.left) / box.width), clamp01((event.clientY - box.top) / box.height)] : [0, 0];
  };

  const sheetPatch = (id: string, patch: Partial<ImageSheet>, persist = true) => {
    onPatch({ sheets: sheets.map(sheet => sheet.id === id ? { ...sheet, ...patch } : sheet) }, persist);
  };

  const addSheet = () => {
    if (sheets.length >= 8) return;
    const id = sheetId();
    const names = ["Muscles", "Nerves", "Vessels"];
    const name = names[sheets.length] ?? `Sheet ${sheets.length + 1}`;
    const next = [...sheets, { id, name, opacity: 100, visible: true, locked: false }];
    onPatch({ sheets: next, activeSheet: id }, true);
  };

  const removeSheet = (id: string) => {
    const next = sheets.filter(sheet => sheet.id !== id);
    onRemoveSheet?.(id);
    onPatch({ sheets: next, activeSheet: next[0]?.id ?? null }, true);
  };

  const flip = (delta: number) => {
    if (sheets.length < 2 || !current) return;
    const at = sheets.findIndex(sheet => sheet.id === current);
    const next = sheets[(at + delta + sheets.length) % sheets.length];
    if (next) onActiveSheet(next.id);
  };

  const beginTrace = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !current) return;
    event.preventDefault();
    event.stopPropagation();
    if (active?.locked) return;
    if (labelMode) {
      if (!labelText.trim()) return;
      onLabel({ kind: "sheet-label", layer: "trace", image: imageId, sheet: current,
        x: point(event)[0], y: point(event)[1], text: labelText.trim(), size: 12 });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = event.pointerId;
    const at = point(event);
    draftRef.current = [[at[0], at[1], pressureOf(event.pointerType || "mouse", event.pressure)]];
    setDraft(draftRef.current);
  };

  const moveTrace = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drawing.current !== event.pointerId) return;
    const at = point(event), last = draftRef.current.at(-1);
    if (last && Math.hypot(at[0] - last[0], at[1] - last[1]) < 0.002) return;
    draftRef.current = [...draftRef.current, [at[0], at[1], pressureOf(event.pointerType || "mouse", event.pressure)]];
    setDraft(draftRef.current);
  };

  const endTrace = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drawing.current !== event.pointerId) return;
    drawing.current = 0;
    if (draftRef.current.length >= 2 && current) {
      onTrace({ kind: "trace", layer: "trace", image: imageId, sheet: current, tool: traceTool,
        color: traceColor, size: traceSize, refWidth: frame[0], points: draftRef.current });
    }
    draftRef.current = [];
    setDraft([]);
  };

  const beginLine = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const at = point(event);
    startRef.current = at;
    setStart(at); setDrag(at);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveLine = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    const at = point(event);
    setDrag(event.shiftKey ? snapLinePoint(startRef.current, at, frame, 45) : at);
  };

  const endLine = (event: React.PointerEvent<HTMLDivElement>) => {
    const first = startRef.current;
    if (!first) return;
    const at = event.shiftKey ? snapLinePoint(first, point(event), frame, 45) : point(event);
    if (Math.hypot(at[0] - first[0], at[1] - first[1]) >= 0.01) {
      if (measuring === "scale") onCalibration([first, at]);
      else if (measuring === "line") onMeasure("line", [first, at]);
    }
    startRef.current = null;
    setStart(null); setDrag(null);
  };

  const clickAngle = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    let at = point(event);
    if (clicksRef.current.length === 2) at = event.shiftKey ? snapAnglePoint(clicksRef.current[0], clicksRef.current[1], at, frame, 15) : at;
    if (clicksRef.current.length < 2) {
      clicksRef.current = [...clicksRef.current, at];
      setClicks(clicksRef.current);
      return;
    }
    onMeasure("angle", [clicksRef.current[0], clicksRef.current[1], at]);
    clicksRef.current = [];
    setClicks([]);
  };

  const surfaceFor = measuring === "angle"
    ? { onPointerDown: clickAngle }
    : { onPointerDown: beginLine, onPointerMove: moveLine, onPointerUp: endLine, onPointerCancel: endLine };
  const tracingSurface = tracing && current && !active?.locked;

  return <>
    {(traces.length > 0 || labels.length > 0) && <svg className="glass-trace" data-glass-trace={traces.length}
      viewBox={`0 0 ${frame[0]} ${frame[1]}`} preserveAspectRatio="none" aria-hidden="true">
      {sheets.map(sheet => <g key={sheet.id} data-trace-sheet={sheet.id} opacity={sheet.visible ? sheet.opacity / 100 : 0}>
        {traces.filter(trace => trace.sheet === sheet.id).map(trace => {
          const points = trace.points.map(([x, y, pressure]) => [x * frame[0], y * frame[1], pressure] as [number, number, number]);
          const size = Math.max(1, trace.size * (frame[0] / trace.refWidth));
          return <path key={trace.id} d={inkPath(points, { tool: trace.tool, size })} data-trace={trace.id}
            fill={trace.color} fillOpacity={trace.tool === "highlighter" ? 0.42 : 1}
            style={{ mixBlendMode: trace.tool === "highlighter" ? "multiply" : "normal" }} />;
        })}
      </g>)}
    </svg>}
    {sheets.map(sheet => sheet.visible && labels.filter(label => label.sheet === sheet.id).map(label =>
      <span key={label.id} className="glass-sheet-label" data-sheet-label={label.id}
        style={{ left: `${label.x * 100}%`, top: `${label.y * 100}%`, opacity: sheet.opacity / 100 }}>{label.text}</span>))}
    {measures.length > 0 && <svg className="glass-measure" data-glass-measure={measures.length}
      viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {measures.map(measure => measure.type === "line"
        ? <g key={measure.id} data-measure={measure.id}>
          <line x1={measure.points[0][0] * 100} y1={measure.points[0][1] * 100}
            x2={measure.points[1][0] * 100} y2={measure.points[1][1] * 100} vectorEffect="non-scaling-stroke" />
          {measure.points.map((at, index) => <circle key={index} cx={at[0] * 100} cy={at[1] * 100} r={1.2} vectorEffect="non-scaling-stroke" />)}
        </g>
        : <g key={measure.id} data-measure={measure.id}>
          <line x1={measure.points[0][0] * 100} y1={measure.points[0][1] * 100}
            x2={measure.points[1][0] * 100} y2={measure.points[1][1] * 100} vectorEffect="non-scaling-stroke" />
          <line x1={measure.points[0][0] * 100} y1={measure.points[0][1] * 100}
            x2={measure.points[2][0] * 100} y2={measure.points[2][1] * 100} vectorEffect="non-scaling-stroke" />
          <circle cx={measure.points[0][0] * 100} cy={measure.points[0][1] * 100} r={1.2} vectorEffect="non-scaling-stroke" />
        </g>)}
      {scale && <line className="glass-measure-calibration" data-measure-calibration
        x1={scale.line[0][0] * 100} y1={scale.line[0][1] * 100} x2={scale.line[1][0] * 100} y2={scale.line[1][1] * 100}
        vectorEffect="non-scaling-stroke" />}
    </svg>}
    {measures.map(measure => {
      const label = measureLabel(measure, scale, frame);
      if (!label) return null;
      const at = measure.type === "angle" ? measure.points[0] : [(measure.points[0][0] + measure.points[1][0]) / 2,
        (measure.points[0][1] + measure.points[1][1]) / 2] as Point2;
      return <span key={measure.id} className="glass-measure-label" data-measure-label={measure.id}
        data-measure-kind={measure.type}
        style={{ left: `${at[0] * 100}%`, top: `${at[1] * 100}%` }}>{label}</span>;
    })}
    {scale && <span className="glass-scale-label" data-scale-label
      style={{ left: `${scale.line[0][0] * 100}%`, top: `${Math.max(0, scale.line[0][1] * 100 - 6)}%` }}>
      Scale: {scale.length} {scale.unit}
    </span>}
    {selected && sheetsOpen && <div className="glass-sheets" data-glass-sheets role="group" aria-label="Tracing sheets"
      onPointerDown={event => event.stopPropagation()}>
      <div className="glass-sheets-head">
        <strong>Sheets</strong>
        <span>{sheets.length}/8</span>
        <button type="button" data-sheet-flip="-1" aria-label="Previous sheet" title="Previous sheet"
          disabled={sheets.length < 2} onClick={() => flip(-1)}><ChevronLeft size={13} /></button>
        <button type="button" data-sheet-flip="1" aria-label="Next sheet" title="Next sheet"
          disabled={sheets.length < 2} onClick={() => flip(1)}><ChevronRight size={13} /></button>
        <button type="button" data-sheet-add aria-label="Add tracing sheet" title="Add sheet"
          disabled={sheets.length >= 8} onClick={addSheet}><Plus size={13} /></button>
      </div>
      {sheets.length === 0 ? <p className="glass-sheets-hint">Add a sheet, then draw on the picture. Three sheets cover muscles, nerves and vessels.</p>
        : <ul>{sheets.map(sheet => <li key={sheet.id} data-sheet={sheet.id} data-active={sheet.id === current || undefined}>
          <button type="button" data-sheet-eye aria-label={sheet.visible ? `Hide ${sheet.name}` : `Show ${sheet.name}`}
            aria-pressed={sheet.visible} title={sheet.visible ? "Hide sheet" : "Show sheet"}
            onClick={() => sheetPatch(sheet.id, { visible: !sheet.visible })}>
            {sheet.visible ? <Eye size={12} /> : <EyeOff size={12} />}</button>
          <input className="glass-sheet-name" data-sheet-name aria-label="Sheet name" value={names[sheet.id] ?? sheet.name}
            maxLength={40} onChange={event => setNames({ ...names, [sheet.id]: event.target.value })}
            onBlur={() => { const name = (names[sheet.id] ?? sheet.name).trim(); if (name && name !== sheet.name) sheetPatch(sheet.id, { name }); }}
            onKeyDown={event => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} />
          <input className="glass-sheet-opacity" data-sheet-opacity type="range" min={0} max={100} step={5}
            aria-label={`${sheet.name} opacity`} value={opacities[sheet.id] ?? sheet.opacity}
            onChange={event => setOpacities({ ...opacities, [sheet.id]: Number(event.target.value) })}
            onPointerUp={() => { sheetPatch(sheet.id, { opacity: opacities[sheet.id] ?? sheet.opacity }); }}
            onKeyUp={() => { sheetPatch(sheet.id, { opacity: opacities[sheet.id] ?? sheet.opacity }); }} />
          <button type="button" data-sheet-lock aria-label={sheet.locked ? `Unlock ${sheet.name}` : `Lock ${sheet.name}`}
            aria-pressed={sheet.locked} title={sheet.locked ? "Unlock sheet" : "Lock sheet"}
            onClick={() => sheetPatch(sheet.id, { locked: !sheet.locked })}>
            {sheet.locked ? <Lock size={12} /> : <LockOpen size={12} />}</button>
          <button type="button" data-sheet-delete aria-label={`Delete ${sheet.name}`} title="Delete sheet"
            onClick={() => removeSheet(sheet.id)}><Trash2 size={12} /></button>
          <button type="button" data-sheet-draw aria-label={`Draw on ${sheet.name}`} title="Draw on this sheet"
            aria-pressed={tracing && sheet.id === current}
            onClick={() => { onActiveSheet(sheet.id); onDraw(); onSheetsOpen?.(false); }}><Pencil size={12} /></button>
        </li>)}</ul>}
      <p className="glass-sheets-hint">Alt+↑/↓ flips sheets while the picture is focused. Sheets move and resize with the picture.</p>
    </div>}
    {tracingSurface && <div ref={surface} className="glass-trace-surface" data-trace-surface data-trace-tool={labelMode ? "label" : traceTool}
      onPointerDown={beginTrace} onPointerMove={moveTrace} onPointerUp={endTrace} onPointerCancel={endTrace}
      onPointerLeave={() => { if (!drawing.current) { draftRef.current = []; setDraft([]); } }} />}
    {measuring && <div ref={surface} className="glass-measure-surface" data-measure-surface={measuring}
      onPointerDown={surfaceFor.onPointerDown} onPointerMove={surfaceFor.onPointerMove}
      onPointerUp={surfaceFor.onPointerUp} onPointerCancel={surfaceFor.onPointerCancel} />}
    {measuring && drag && start && <svg className="glass-measure-live" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line x1={start[0] * 100} y1={start[1] * 100} x2={drag[0] * 100} y2={drag[1] * 100} vectorEffect="non-scaling-stroke" />
    </svg>}
    {measuring === "angle" && clicks.length > 0 && <svg className="glass-measure-live" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {clicks.map((at, index) => <circle key={index} cx={at[0] * 100} cy={at[1] * 100} r={1.4} vectorEffect="non-scaling-stroke" />)}
      {clicks.length === 2 && <line x1={clicks[0][0] * 100} y1={clicks[0][1] * 100} x2={clicks[1][0] * 100} y2={clicks[1][1] * 100} vectorEffect="non-scaling-stroke" />}
    </svg>}
    {tracing && draft.length > 0 && <svg className="glass-trace-live" viewBox={`0 0 ${frame[0]} ${frame[1]}`}
      preserveAspectRatio="none" aria-hidden="true">
      <path d={inkPath(draft.map(([x, y, pressure]) => [x * frame[0], y * frame[1], pressure]), { tool: traceTool, size: traceSize })} />
    </svg>}
  </>;
}
