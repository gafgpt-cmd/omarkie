import { memo, useCallback, useEffect, useRef, useState } from "react";
import { arrowColors, arrowHeads, arrowStyles, type ArrowColor, type ArrowEnd, type ArrowStyle } from "../../shared/glass-marks.mjs";
import { arrowPath, edgePoint, headPath, type ArrowMark, type ArrowRoute, type EndMark, type Jump, type Point, jumpFor } from "../glass/arrow-model";
import "./arrows.css";

export interface Hit { end: ArrowEnd; box: EndMark; name: string }

interface Props {
  routes: readonly ArrowRoute[];
  arrows: readonly ArrowMark[];
  selected?: string;
  view: { top: number; height: number; width: number; page: number };
  names: Record<string, { from: string; to: string }>;
  tool: boolean;
  style: ArrowStyle;
  color: ArrowColor;
  scroller: HTMLElement;
  hitTest(x: number, y: number): Hit | undefined;
  onCreate(from: ArrowEnd, to: ArrowEnd): void;
  onSelect(id?: string): void;
  onDelete(id: string): void;
  onUpdate(id: string, patch: Partial<ArrowMark>): void;
  onMissing(): void;
}

const colorOf = (color: ArrowColor) => color === "red" ? "#cf3b32" : color === "blue" ? "#2f6fb5" : color === "green" ? "#2f9e5f" : "var(--ink, #333)";

const ArrowPaths = memo(function ArrowPaths({ routes, arrows, selected, onSelect }: Pick<Props, "routes" | "arrows" | "selected" | "onSelect">) {
  const byId = new Map(arrows.map(arrow => [arrow.id, arrow]));
  return <svg className="glass-arrow-paths" aria-label="Glass arrows">
    {routes.map(route => {
      const arrow = byId.get(route.id);
      if (!arrow) return null;
      const on = selected === route.id;
      return <g key={route.id} data-arrow={route.id} data-selected={on || undefined} className="glass-arrow" style={{ color: colorOf(arrow.color) }}>
        {on && <path className="glass-arrow-halo" d={route.d} />}
        <path className="glass-arrow-line" data-arrow-path={route.id} d={route.d} role="button" tabIndex={0}
          aria-label={arrow.label ? `Arrow, ${arrow.label}` : "Arrow"}
          onPointerDown={event => { event.stopPropagation(); onSelect(route.id); }}
          onKeyDown={event => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(route.id); }
            else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); onSelect(route.id); }
          }} />
        {route.head && <path className="glass-arrow-head" data-arrow-head={route.id} d={route.head}
          fill={route.filled ? "currentColor" : "none"} stroke={route.filled ? "none" : "currentColor"}
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />}
        {arrow.label && <text className="glass-arrow-label" data-arrow-label-text={route.id} x={route.label.x} y={route.label.y}
          textAnchor="middle" dominantBaseline="middle" pointerEvents="none">{arrow.label}</text>}
      </g>;
    })}
  </svg>;
});

function ArrowJumps({ routes, view, names, scroller }: Pick<Props, "routes" | "view" | "names" | "scroller">) {
  const chips: { route: ArrowRoute; jump: Jump }[] = [];
  for (const route of routes) {
    const jump = jumpFor(view, route);
    if (jump) chips.push({ route, jump });
  }
  return <>{chips.map(({ route, jump }) => {
    const far = jump.far === "to" ? route.to : route.from;
    const ends = names[route.id];
    const name = (jump.far === "to" ? ends?.to : ends?.from) ?? "";
    return <button type="button" key={route.id} className="glass-arrow-jump" data-arrow-jump={route.id} data-direction={jump.direction}
      style={{ left: `${clamp(jump.point.x, 12, Math.max(12, view.width - 12))}px`,
        top: `${jump.direction === "up" ? view.top + 12 : view.top + view.height - 70}px` }}
      title={name ? `Jump to ${name}` : "Jump to the other end"} aria-label={name ? `Jump to ${name}` : "Jump to the other end"}
      onClick={() => scroller.scrollTo({ top: Math.max(0, far.y - 120), behavior: "smooth" })}>
      <span aria-hidden="true">{glyph(jump.direction)}</span>{name || "the other end"}</button>;
  })}</>;
}

// Style, colour, head, label and delete for the selected arrow, floating at its label point.
function ArrowTools({ arrow, route, view, onUpdate, onDelete, onSelect }: {
  arrow: ArrowMark; route: ArrowRoute; view: Props["view"];
  onUpdate: Props["onUpdate"]; onDelete: Props["onDelete"]; onSelect: Props["onSelect"];
}) {
  const [label, setLabel] = useState(arrow.label);
  useEffect(() => setLabel(arrow.label), [arrow.label]);
  const commit = () => { if (label !== arrow.label) onUpdate(arrow.id, { label }); };
  return <div className="glass-arrow-tools" role="group" aria-label="Arrow" data-arrow-tools={arrow.id}
    style={{ left: `${clamp(route.label.x, 132, Math.max(132, view.width - 132))}px`, top: `${clamp(route.label.y, view.top + 10, view.top + view.height - 96)}px` }}>
    <div className="glass-arrow-row">
      {arrowStyles.map(style => <button type="button" key={style} data-arrow-style={style} aria-pressed={arrow.style === style}
        aria-label={style === "curved" ? "Curved arrow" : "Straight arrow"} title={style === "curved" ? "Curved" : "Straight"}
        onClick={() => onUpdate(arrow.id, { style })}>{style === "curved" ? "⌒" : "╱"}</button>)}
      {arrowColors.map(color => <button type="button" key={color} data-arrow-colour={color} aria-pressed={arrow.color === color}
        aria-label={`${color} arrow`} title={color} className="glass-arrow-swatch" style={{ color: colorOf(color) }}
        onClick={() => onUpdate(arrow.id, { color })}>●</button>)}
      {arrowHeads.map(head => <button type="button" key={head} data-arrow-head-shape={head} aria-pressed={arrow.head === head}
        aria-label={`${head} head`} title={head} onClick={() => onUpdate(arrow.id, { head })}>{head === "solid" ? "▸" : head === "open" ? "›" : "—"}</button>)}
    </div>
    <div className="glass-arrow-row">
      <input className="glass-arrow-label-input" aria-label="Arrow label" placeholder="Label" value={label} maxLength={240} data-arrow-label
        onChange={event => setLabel(event.target.value)} onBlur={commit}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); }
          else if (event.key === "Escape") { event.preventDefault(); setLabel(arrow.label); event.currentTarget.blur(); }
        }} />
      <button type="button" data-arrow-delete aria-label="Delete arrow" title="Delete arrow" onClick={() => onDelete(arrow.id)}>×</button>
      <button type="button" aria-label="Close arrow tools" title="Close" onClick={() => onSelect(undefined)}>✕</button>
    </div>
  </div>;
}

type Drag =
  | { from: ArrowEnd; box: EndMark }
  | { end: "from" | "to"; route: ArrowRoute; arrow: ArrowMark; line: SVGPathElement | null; head: SVGPathElement | null };

export default function ArrowOverlay(props: Props) {
  const { routes, arrows, selected, view, names, tool, style, color, scroller, hitTest, onCreate, onSelect, onDelete, onUpdate, onMissing } = props;
  const root = useRef<HTMLDivElement>(null);
  const preview = useRef<SVGPathElement>(null), previewHead = useRef<SVGPathElement>(null), snap = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | undefined>(undefined), last = useRef<Point | undefined>(undefined), frame = useRef<number | undefined>(undefined);
  const live = useRef({ hitTest, onCreate, onUpdate, onSelect, onDelete, onMissing, scroller, arrows, style, color });
  live.current = { hitTest, onCreate, onUpdate, onSelect, onDelete, onMissing, scroller, arrows, style, color };
  const arrow = arrows.find(item => item.id === selected), route = routes.find(item => item.id === selected);

  const showSnap = useCallback((hit: Hit | undefined) => {
    const element = snap.current;
    if (!element) return;
    if (!hit) { element.hidden = true; return; }
    element.hidden = false;
    element.style.left = `${hit.box.x}px`;
    element.style.top = `${hit.box.y}px`;
    element.style.width = `${hit.box.width}px`;
    element.style.height = `${hit.box.height}px`;
    element.dataset.arrowSnapName = hit.name;
  }, []);

  const drawPreview = useCallback((at: Point) => {
    const state = drag.current;
    if (!state || !("box" in state)) return;
    const start = state.box, current = live.current;
    const path = arrowPath(edgePoint(start, at), at, current.style);
    preview.current?.setAttribute("d", path.d);
    previewHead.current?.setAttribute("d", headPath(path.end, path.angle, "solid"));
    preview.current?.style.setProperty("stroke", colorOf(current.color));
    previewHead.current?.style.setProperty("fill", colorOf(current.color));
  }, []);

  const local = useCallback((clientX: number, clientY: number): Point => {
    const rect = root.current?.getBoundingClientRect();
    return rect ? { x: clientX - rect.left, y: clientY - rect.top } : { x: clientX, y: clientY };
  }, []);

  const redrawEnd = useCallback((state: Extract<Drag, { end: string }>, at: Point) => {
    const other = state.end === "from" ? state.route.to : state.route.from;
    const start = state.end === "from" ? at : other, finish = state.end === "from" ? other : at;
    const path = arrowPath(start, finish, state.arrow.style);
    state.line?.setAttribute("d", path.d);
    state.head?.setAttribute("d", headPath(path.end, path.angle, state.arrow.head));
  }, []);

  useEffect(() => {
    let scrollTime: number | undefined;
    const step = (time: number) => {
      frame.current = undefined;
      const point = last.current, state = drag.current;
      last.current = undefined;
      if (!point || !state) return;
      const current = live.current;
      const rect = current.scroller.getBoundingClientRect(), zone = 52;
      const direction = point.y < rect.top + zone ? -1 : point.y > rect.bottom - zone ? 1 : 0;
      if (direction) {
        const delta = Math.min(64, Math.max(0, time - (scrollTime ?? time - 16.7)));
        current.scroller.scrollBy(0, direction * delta * 1.1);
        scrollTime = time;
        last.current = point;
        frame.current = requestAnimationFrame(step);
      } else scrollTime = undefined;
      const at = local(point.x, point.y);
      const hit = current.hitTest(point.x, point.y);
      if ("end" in state) redrawEnd(state, at);
      else drawPreview(at);
      showSnap(hit);
    };
    const move = (event: PointerEvent) => {
      if (!drag.current) return;
      last.current = { x: event.clientX, y: event.clientY };
      if (frame.current === undefined) frame.current = requestAnimationFrame(step);
    };
    const cancel = () => {
      const state = drag.current;
      drag.current = undefined;
      last.current = undefined;
      scrollTime = undefined;
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      showSnap(undefined);
      preview.current?.setAttribute("d", "");
      previewHead.current?.setAttribute("d", "");
      if (state && "end" in state) {
        state.line?.setAttribute("d", state.route.d);
        state.head?.setAttribute("d", state.route.head ?? "");
      }
    };
    const finish = (event: PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      const current = live.current;
      const hit = current.hitTest(event.clientX, event.clientY);
      cancel();
      if (!hit) return;
      if ("end" in state) {
        const mark = current.arrows.find(item => item.id === state.arrow.id);
        const other = state.end === "from" ? mark?.to : mark?.from;
        if (mark && !sameEnd(hit.end, other)) current.onUpdate(mark.id, state.end === "from" ? { from: hit.end } : { to: hit.end });
      } else current.onCreate(state.from, hit.end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [drawPreview, local, redrawEnd, showSnap]);

  const begin = (state: Drag) => {
    drag.current = state;
    last.current = undefined;
    if ("box" in state) showSnap({ end: state.from, box: state.box, name: "" });
  };

  const startCreate = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const hit = hitTest(event.clientX, event.clientY);
    if (!hit) { onMissing(); return; }
    event.preventDefault();
    begin({ from: hit.end, box: hit.box });
  };

  const startEnd = (end: "from" | "to") => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (!route || !arrow || !root.current) return;
    begin({ route, arrow, end,
      line: root.current.querySelector(`[data-arrow-path="${route.id}"]`),
      head: root.current.querySelector(`[data-arrow-head="${route.id}"]`) });
  };

  return <div className="glass-arrow-overlay" ref={root} data-glass-arrows style={{ height: `${view.page}px` }}>
    <ArrowPaths routes={routes} arrows={arrows} selected={selected} onSelect={onSelect} />
    <ArrowJumps routes={routes} view={view} names={names} scroller={scroller} />
    <div className="glass-arrow-snap" ref={snap} hidden />
    {arrow && route && <ArrowTools arrow={arrow} route={route} view={view} onUpdate={onUpdate} onDelete={onDelete} onSelect={onSelect} />}
    {selected && route && ["from", "to"].map(end => {
      const point = end === "from" ? route.from : route.to;
      return <button type="button" key={end} className="glass-arrow-handle" data-arrow-handle={end}
        aria-label={`Move the ${end === "from" ? "start" : "end"} of the arrow`} title="Drag to re-attach"
        style={{ left: `${point.x}px`, top: `${point.y}px` }} onPointerDown={startEnd(end as "from" | "to")} />;
    })}
    <svg className="glass-arrow-preview" aria-hidden="true" style={{ height: `${view.page}px` }}><path ref={preview} /><path ref={previewHead} fill="currentColor" stroke="none" /></svg>
    {tool && <div className="glass-arrow-surface" data-glass-arrow-surface aria-label="Drag from one paragraph or sticker to another"
      style={{ top: `${view.top}px`, height: `${view.height}px` }} onPointerDown={startCreate} />}
  </div>;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function glyph(direction: "up" | "down") {
  return direction === "up" ? "↑" : "↓";
}

function sameEnd(left: ArrowEnd, right: ArrowEnd | undefined) {
  if (!right) return false;
  return "element" in left
    ? "element" in right && left.element === right.element
    : "magnet" in right && left.magnet === right.magnet;
}
