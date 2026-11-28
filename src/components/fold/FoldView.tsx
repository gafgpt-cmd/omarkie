import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { createPortal, flushSync } from "react-dom";
import { GripVertical } from "lucide-react";
import { worthFolding } from "../../../shared/fold-text.mjs";
import { foldDocumentLadder } from "../../../shared/fold-units.mjs";
import { renderMath } from "../../editor/math";
import { t } from "../../i18n";
import CompareSlider from "../CompareSlider";
import type { StudyMark } from "../learning-overlays";
import { FoldBar } from "./FoldBar";
import { foldDragType, foldPayload, readFoldTransfer, writeFoldTransfer, type FoldOut, type FoldPayload, type FoldTarget } from "./drag";
import { FoldEvidence, FoldLens } from "./FoldEvidence";
import { FoldSendMenu, FoldSentNote, type FoldNotice } from "./FoldSend";
import { FoldEngine, type FoldUnitView } from "./morph";
import { STOPS, stopLabel, type FoldStart, type Stop } from "./stops";
import "./fold.css";

const WHEEL_STEP = 60;
// Pen press-and-hold for Rayos X: still for this long, within this many px.
const HOLD_MS = 450;
const HOLD_SLOP = 8;
const NOTICE_MS = 8000;

interface Peek { unit: FoldUnitView; host: HTMLElement; y: number }
interface Lens { unit: FoldUnitView; x: number; y: number }
interface Grip { unit: FoldUnitView; top: number; left: number }
interface Menu { unit: FoldUnitView; x: number; y: number; targets: FoldTarget[] }
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

// Fold view: the note's own words at a chosen local stop, read-only, in place of the rendered page.
export default function FoldView({ id, content, stop, setStop, close, start, leave, reveal, marks, note, title, out }: {
  id: string;
  content: string;
  stop: Stop;
  setStop(stop: Stop): void;
  close(): void;
  start: FoldStart;
  leave(line: number, focused: boolean): void;
  // Open the source in the editor with this line at viewport y.
  reveal(line: number, y: number): void;
  // Visible study marks by source line.
  marks(): ReadonlyMap<number, readonly StudyMark[]>;
  // Vault-relative path ("" while unsaved) and display name: the way back a dragged line carries.
  note: string;
  title: string;
  // Where a line can go: study sheets, the loose tray, a card on the page. Null while Learning mode is not ready.
  out(): FoldOut | null;
}) {
  const ladder = useMemo(() => foldDocumentLadder(content), [content]);
  const short = useMemo(() => !worthFolding(content, ladder.stops.topic.text), [content, ladder]);
  const index = short ? 0 : STOPS.indexOf(stop);
  const percents = useMemo(() => STOPS.map(level => ladder.total ? Math.round(ladder.stops[level].shown / ladder.total * 100) : 100), [ladder]);
  const section = useRef<HTMLElement>(null), scroller = useRef<HTMLDivElement>(null), article = useRef<HTMLElement>(null), engine = useRef<FoldEngine | null>(null);
  const [hint, setHint] = useState(true);
  const [peek, setPeekState] = useState<Peek | null>(null), peekRef = useRef<Peek | null>(null);
  const [lens, setLens] = useState<Lens | null>(null);
  const [cut, setCut] = useState(false), [cutValue, setCutValue] = useState(50), cutRef = useRef(cutValue);
  cutRef.current = cutValue;
  const [grip, setGrip] = useState<Grip | null>(null), [menu, setMenu] = useState<Menu | null>(null), [notice, setNotice] = useState<FoldNotice | null>(null);
  const dragged = useRef<FoldUnitView | null>(null), copying = useRef<FoldPayload | null>(null);
  const latest = useRef({ index, start, leave, togglePeek });
  latest.current = { index, start, leave, togglePeek };
  const setPeek = (next: Peek | null) => { peekRef.current = next; setPeekState(next); };
  useLayoutEffect(() => () => {
    const view = engine.current;
    if (view) latest.current.leave(view.topLine(), !!section.current?.contains(document.activeElement));
  }, []);
  useLayoutEffect(() => {
    const root = article.current!, view = new FoldEngine(scroller.current!, root, ladder, id);
    engine.current = view;
    view.jump(latest.current.index);
    const { line, y, focus } = latest.current.start;
    const unit = view.scrollToLine(line, y === undefined ? 0 : y - scroller.current!.getBoundingClientRect().top);
    (focus && unit ? unit.root : root).focus({ preventScroll: true });
    void renderMath(root).catch(() => {});
    return () => {
      latest.current.start = { line: view.topLine() };
      view.dispose();
      engine.current = null;
      root.replaceChildren();
      setPeek(null); setLens(null); setCut(false); setGrip(null); setMenu(null);
    };
  }, [ladder, id]);
  useEffect(() => {
    engine.current?.switchTo(index);
    setGrip(null);
    // A stop that hides the peeked line takes its peek with it.
    const open = peekRef.current;
    if (open?.unit.root.classList.contains("fold-off")) { open.host.remove(); if (engine.current) engine.current.peek = null; setPeek(null); }
  }, [index]);
  useEffect(() => {
    const element = scroller.current!;
    let pending = 0, target: FoldUnitView | null = null, timer = 0;
    // Pinch (Ctrl+wheel): on a unit it folds that unit only; on the page margin it drives the slider.
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || short) return;
      event.preventDefault();
      const view = engine.current;
      if (!view || view.cutting) return;
      const unit = view.units.find(item => item.root.contains(event.target as Node)) ?? null;
      if (unit) {
        if (unit !== target) { target = unit; pending = 0; }
        pending += event.deltaY;
        if (Math.abs(pending) < WHEEL_STEP) return;
        const next = Math.max(0, Math.min(STOPS.length - 1, view.stopOf(unit) + Math.sign(pending)));
        pending = 0;
        view.switchTo(next, unit);
        return;
      }
      target = null;
      view.scrub(Math.max(0, Math.min(STOPS.length - 1, view.value + event.deltaY / (WHEEL_STEP * 2))));
      clearTimeout(timer);
      timer = window.setTimeout(() => { const settled = view.release(); setHint(false); setStop(STOPS[settled]); }, 160);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => { element.removeEventListener("wheel", wheel); clearTimeout(timer); };
  }, [short, setStop]);
  // Rayos X: hold Alt (pointer line, else the focused line) or press-and-hold the pen.
  useEffect(() => {
    const element = scroller.current!;
    let pointer: { x: number; y: number } | null = null, alt = false, suppressed = false;
    let pen: { id: number; x: number; y: number; timer: number; on: boolean } | null = null;
    const at = (x: number, y: number): Lens | null => {
      const unit = engine.current?.unitOf(document.elementFromPoint(x, y));
      return unit ? { unit, x, y } : null;
    };
    const target = (): Lens | null => {
      if (pen?.on) return at(pen.x, pen.y);
      const hit = pointer && at(pointer.x, pointer.y);
      if (hit) return hit;
      const unit = engine.current?.unitOf(document.activeElement);
      if (!unit) return null;
      const rect = unit.root.getBoundingClientRect();
      return { unit, x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + 72 };
    };
    const update = () => setLens((alt && !suppressed) || pen?.on ? target() : null);
    const outside = (event: Event) => event.target instanceof Element && !!event.target.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]');
    const down = (event: KeyboardEvent) => {
      if (event.key !== "Alt" || event.repeat || outside(event)) return;
      event.preventDefault();
      alt = true; suppressed = false;
      update();
    };
    const up = (event: KeyboardEvent) => { if (event.key === "Alt") { alt = false; update(); } };
    const cancelPen = () => { if (!pen) return; clearTimeout(pen.timer); const was = pen.on; pen = null; if (was) update(); };
    const blur = () => { alt = false; cancelPen(); update(); };
    const move = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      pointer = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom ? { x: event.clientX, y: event.clientY } : null;
      if (pen && event.pointerId === pen.id) {
        if (!pen.on) { if (Math.hypot(event.clientX - pen.x, event.clientY - pen.y) > HOLD_SLOP) cancelPen(); return; }
        event.preventDefault();
        pen.x = event.clientX; pen.y = event.clientY;
      }
      if (alt || pen?.on) update();
    };
    const press = (event: PointerEvent) => {
      if (event.pointerType !== "pen" || event.button !== 0 || !engine.current?.unitOf(event.target as Element)) return;
      cancelPen();
      const hold = { id: event.pointerId, x: event.clientX, y: event.clientY, on: false, timer: 0 };
      hold.timer = window.setTimeout(() => { hold.on = true; getSelection()?.removeAllRanges(); update(); }, HOLD_MS);
      pen = hold;
    };
    const release = (event: PointerEvent) => { if (pen?.id === event.pointerId) cancelPen(); };
    const click = (event: MouseEvent) => {
      if (!event.altKey) return;
      const unit = engine.current?.unitOf(event.target as Element);
      if (!unit || (event.target as Element).closest(".fold-peek")) return;
      event.preventDefault();
      suppressed = true; update();
      latest.current.togglePeek(unit);
    };
    const scroll = () => { if (alt || pen?.on) update(); };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    element.addEventListener("pointerdown", press);
    element.addEventListener("click", click);
    element.addEventListener("scroll", scroll, { passive: true });
    return () => {
      cancelPen();
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      element.removeEventListener("pointerdown", press);
      element.removeEventListener("click", click);
      element.removeEventListener("scroll", scroll);
    };
  }, []);
  // One drag grip for the whole page, beside the hovered or focused line.
  useEffect(() => {
    const element = scroller.current!;
    const at = (unit: FoldUnitView): Grip => {
      const box = element.getBoundingClientRect(), rect = unit.root.getBoundingClientRect();
      return { unit, top: Math.round(rect.top - box.top + element.scrollTop), left: Math.max(0, Math.round(rect.left - box.left + element.scrollLeft - 28)) };
    };
    const place = (target: EventTarget | null) => {
      const unit = target instanceof Element ? engine.current?.unitOf(target) : undefined;
      if (!unit || unit.root.classList.contains("fold-off")) return;
      const next = at(unit);
      setGrip(current => current?.unit === unit && current.top === next.top && current.left === next.left ? current : next);
    };
    // The column moves when a side panel opens (the tray shows on dragstart): the grip follows its line.
    const resized = new ResizeObserver(() => setGrip(current => current?.unit.root.isConnected ? at(current.unit) : current));
    resized.observe(element);
    const over = (event: PointerEvent) => place(event.target);
    const focus = (event: FocusEvent) => place(event.target);
    element.addEventListener("pointerover", over);
    element.addEventListener("focusin", focus);
    return () => { element.removeEventListener("pointerover", over); element.removeEventListener("focusin", focus); resized.disconnect(); };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const away = (event: PointerEvent) => { if (!(event.target instanceof Element && event.target.closest(".fold-send"))) setMenu(null); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [menu]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  // Corte geometry follows the page width.
  useEffect(() => {
    if (!cut) return;
    const observer = new ResizeObserver(() => { const view = engine.current; if (view?.cutting) { view.cutAt(cutRef.current / 100); view.remeasureCut(); } });
    observer.observe(scroller.current!);
    return () => observer.disconnect();
  }, [cut]);
  const lensMarks = useMemo(() => {
    if (!lens) return [];
    const byLine = marks(), found: StudyMark[] = [];
    for (let line = lens.unit.unit.line; line <= lens.unit.unit.endLine; line++) found.push(...byLine.get(line) ?? []);
    return found;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lens?.unit, marks]);
  function pick(next: number) {
    if (short) return;
    setHint(false);
    if (next === index) engine.current?.switchTo(next);
    setStop(STOPS[next]);
  }
  function moveFocus(delta: number) {
    const view = engine.current;
    if (!view) return;
    const lines = view.units.filter(unit => !unit.root.classList.contains("fold-off")).map(unit => unit.root);
    const current = lines.findIndex(line => line.contains(document.activeElement));
    const next = lines[current < 0 ? (delta > 0 ? 0 : lines.length - 1) : Math.max(0, Math.min(lines.length - 1, current + delta))];
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: "nearest" });
  }
  // One peek at a time, under its line. Never touches the stop.
  function togglePeek(unit: FoldUnitView) {
    const view = engine.current, open = peekRef.current;
    if (!view) return;
    if (open) closePeek(open.unit === unit);
    if (open?.unit === unit) return;
    const host = document.createElement("div");
    host.className = "fold-peek";
    const y = unit.root.getBoundingClientRect().top;
    view.reflow(() => { unit.root.append(host); view.peek = host; flushSync(() => setPeek({ unit, host, y })); });
  }
  // Closing puts the line back at the y it had when the peek opened.
  function closePeek(restore: boolean) {
    const view = engine.current, open = peekRef.current, frame = scroller.current;
    if (!view || !open || !frame) return;
    view.reflow(() => {
      flushSync(() => setPeek(null));
      open.host.remove(); view.peek = null;
      if (restore) frame.scrollTop += open.unit.root.getBoundingClientRect().top - open.y;
    });
    if (restore) open.unit.root.focus({ preventScroll: true });
  }
  function toggleCut() {
    const view = engine.current;
    if (!view || short) return;
    const next = !view.cutting, inside = !!section.current?.querySelector(".glass-compare")?.contains(document.activeElement);
    if (next) view.cutAt(cutValue / 100);
    view.setCut(next);
    setCut(next);
    if (next) requestAnimationFrame(() => section.current?.querySelector<HTMLElement>("[data-compare-handle]")?.focus({ preventScroll: true }));
    else if (inside) article.current?.focus({ preventScroll: true });
  }
  const moveCut = (value: number) => { setCutValue(value); engine.current?.cutAt(value / 100); };
  // The line as it reads at its stop, and the unit's Full author words behind it.
  function payloadOf(unit: FoldUnitView) {
    const view = engine.current!, entry = ladder.byUnit[view.units.indexOf(unit)], at = STOPS[view.stopOf(unit)];
    return foldPayload({ note, title, stop: at, by: "author", line: unit.unit.line, endLine: unit.unit.endLine, headings: unit.unit.headings,
      text: entry.stops[at] || entry.stops.full, quote: entry.stops.full });
  }
  async function send(unit: FoldUnitView, target: FoldTarget) {
    const api = out();
    if (!api) return;
    try {
      const sent = await api.send(payloadOf(unit), target);
      const undo = sent.undo && (async () => { try { await sent.undo!(); } catch (error) { setNotice({ message: failure(error), error: true }); } });
      const show = sent.line === undefined ? undefined : () => reveal(sent.line!, unit.root.isConnected ? unit.root.getBoundingClientRect().top : 0);
      setNotice({ message: sent.message, undo, show });
    } catch (error) { setNotice({ message: failure(error), error: true }); }
  }
  function openMenu(unit: FoldUnitView) {
    const rect = unit.root.getBoundingClientRect(), box = section.current!.getBoundingClientRect();
    setMenu({ unit, x: Math.round(Math.max(8, Math.min(rect.left - box.left, box.width - 268))), y: Math.round(rect.bottom - box.top + 4), targets: out()?.targets() ?? [] });
  }
  function closeMenu() {
    const open = menu;
    setMenu(null);
    if (open?.unit.root.isConnected) open.unit.root.focus({ preventScroll: true });
  }
  function copyLine(unit: FoldUnitView) {
    copying.current = payloadOf(unit);
    const copied = document.execCommand("copy");
    copying.current = null;
    closeMenu();
    setNotice(copied ? { message: t("Linked excerpt copied") } : { message: t("Could not copy the line."), error: true });
  }
  function dragStart(event: ReactDragEvent, unit: FoldUnitView) {
    const payload = payloadOf(unit);
    writeFoldTransfer(event.dataTransfer, payload);
    event.dataTransfer.effectAllowed = "copy";
    const ghost = document.createElement("div");
    ghost.className = "fold-drag-ghost";
    ghost.textContent = payload.text.length > 90 ? `${payload.text.slice(0, 89)}…` : payload.text;
    document.body.append(ghost);
    event.dataTransfer.setDragImage(ghost, 14, 14);
    setTimeout(() => ghost.remove());
    dragged.current = unit;
    section.current!.dataset.dragging = "true";
    setMenu(null);
  }
  function dragEnd() {
    dragged.current = null;
    delete section.current?.dataset.dragging;
  }
  // Dropped back on the page (not on its own line): a card pinned at the evidence.
  const pageTarget = (event: ReactDragEvent) => {
    const source = dragged.current;
    return source && event.dataTransfer.types.includes(foldDragType) && engine.current?.unitOf(event.target as Element) !== source
      && !(event.target as Element).closest(".fold-bar") ? source : null;
  };
  // Dropped on a study sheet row or the loose tray (Learning mode marks them data-fold-drop).
  const zoneTarget = (event: DragEvent) => {
    const zone = dragged.current && event.target instanceof Element ? event.target.closest<HTMLElement>("[data-fold-drop]") : null;
    const kind = zone?.dataset.foldDrop, sheet = zone?.dataset.sheet;
    return zone ? out()?.targets().find(target => target.kind === kind && (kind !== "sheet" || target.id === sheet)) ?? null : null;
  };
  const zoneOver = useEffectEvent((event: DragEvent) => {
    if (!zoneTarget(event)) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = "copy";
  });
  const zoneDrop = useEffectEvent((event: DragEvent) => {
    const target = zoneTarget(event), source = dragged.current;
    if (!target || !source) return;
    event.preventDefault(); event.stopPropagation();
    dragEnd();
    void send(source, target);
  });
  useEffect(() => {
    const over = (event: DragEvent) => zoneOver(event), drop = (event: DragEvent) => zoneDrop(event);
    document.addEventListener("dragover", over, true);
    document.addEventListener("drop", drop, true);
    return () => { document.removeEventListener("dragover", over, true); document.removeEventListener("drop", drop, true); };
  }, []);
  const level = stopLabel(STOPS[index]);
  return <section ref={section} className="fold-view" aria-label={t("Fold view")} data-stop={STOPS[index]} data-cut={cut || undefined}
    style={cut ? { "--cut-at": `${cutValue}%` } as React.CSSProperties : undefined}
    onDragOver={event => { if (!pageTarget(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
    onDrop={event => {
      const source = pageTarget(event), page = source && readFoldTransfer(event.dataTransfer) && out()?.targets().find(target => target.kind === "page");
      if (!source) return;
      event.preventDefault(); event.stopPropagation();
      dragEnd();
      if (page) void send(source, page);
      else setNotice({ message: t("Open a saved note in Learning mode to keep this line."), error: true });
    }}
    onCopy={event => {
      const unit = engine.current?.unitOf(document.activeElement), selection = getSelection();
      const payload = copying.current ?? (unit && document.activeElement === unit.root && (!selection || selection.isCollapsed) ? payloadOf(unit) : null);
      if (!payload) return;
      writeFoldTransfer(event.clipboardData, payload);
      event.preventDefault();
    }}
    onKeyDown={event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing || (event.target as Element).closest(".fold-send")) return;
    const key = event.key, target = event.target as HTMLElement, unit = engine.current?.unitOf(target);
    let handled = true;
    if (key === "Escape") { if (peekRef.current) closePeek(true); else if (cut) toggleCut(); else close(); }
    else if (key === "Enter" && event.shiftKey && unit) reveal(unit.unit.line, unit.root.getBoundingClientRect().top);
    else if (key === "Enter" && !event.shiftKey && unit && target === unit.root) togglePeek(unit);
    else if ((key === "c" || key === "C") && !target.closest("button:not([data-compare-handle])")) toggleCut();
    else if (key === "[") pick(Math.max(0, index - 1));
    else if (key === "]") pick(Math.min(STOPS.length - 1, index + 1));
    else if (/^[1-5]$/.test(key)) pick(Number(key) - 1);
    else if (key === "6") setHint(true);
    else if ((key === "d" || key === "D" || key === "ContextMenu" || (key === "F10" && event.shiftKey)) && unit && target === unit.root) openMenu(unit);
    else if ((key === "ArrowDown" || key === "ArrowUp") && !target.closest('[role="slider"]')) moveFocus(key === "ArrowDown" ? 1 : -1);
    else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  }}>
    <div ref={scroller} className="fold-scroller">
      <article ref={article} className="rich-document fold-document" tabIndex={0} aria-label={t("Fold view")} />
      {grip && grip.unit.root.isConnected && <button type="button" className="fold-grip" draggable tabIndex={-1} style={{ top: grip.top, left: grip.left }}
        aria-label={t("Drag this line out · D")} title={t("Drag this line out · D")}
        onDragStart={event => dragStart(event, grip.unit)} onDragEnd={dragEnd} onClick={() => openMenu(grip.unit)}><GripVertical size={14} aria-hidden="true" /></button>}
    </div>
    {peek && engine.current && createPortal(<FoldEvidence html={engine.current.source(peek.unit)} line={peek.unit.unit.line}
      open={() => reveal(peek.unit.unit.line, peek.unit.root.getBoundingClientRect().top)} />, peek.host)}
    {lens && engine.current && section.current && <FoldLens frame={section.current} root={lens.unit.root} html={engine.current.source(lens.unit)} marks={lensMarks} x={lens.x} y={lens.y} />}
    {cut && <CompareSlider overlay value={cutValue} direction="horizontal" before={t("Full")} after={level}
      label={t("Divider between Full and {{level}}", { level })} valueText={value => t("{{percent}}% shows Full", { percent: value })}
      onChange={moveCut} onCommit={moveCut} />}
    {menu && <FoldSendMenu x={menu.x} y={menu.y} targets={menu.targets} close={closeMenu} copy={() => copyLine(menu.unit)}
      pick={target => { const unit = menu.unit; closeMenu(); void send(unit, target); }} />}
    {notice && <FoldSentNote notice={notice} dismiss={() => setNotice(null)} />}
    <FoldBar index={index} percents={percents} disabled={short} hint={hint} pick={pick} cut={cut} toggleCut={toggleCut}
      scrub={value => engine.current?.scrub(value)}
      release={() => { const settled = engine.current?.release(); setHint(false); if (settled !== undefined) setStop(STOPS[settled]); }} />
  </section>;
}
