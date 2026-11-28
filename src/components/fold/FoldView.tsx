import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent } from "react";
import { createPortal, flushSync } from "react-dom";
import { worthFolding } from "../../../shared/fold-text.mjs";
import { foldTopic } from "../../../shared/fold-topic.mjs";
import { foldDocumentLadder } from "../../../shared/fold-units.mjs";
import { renderMath } from "../../editor/math";
import { t } from "../../i18n";
import CompareSlider from "../CompareSlider";
import type { StudyMark } from "../learning-overlays";
import { FoldBar } from "./FoldBar";
import { FoldEvidence, FoldLens } from "./FoldEvidence";
import { FoldTopic, saveTopicView, savedTopicView, warmTopic, type TopicView } from "./FoldTopic";
import { FoldEngine, type FoldUnitView } from "./morph";
import { STOPS, stopLabel, type FoldStart, type Stop } from "./stops";
import "./fold.css";

const WHEEL_STEP = 60;
// Pen press-and-hold for Rayos X: still for this long, within this many px.
const HOLD_MS = 450;
const HOLD_SLOP = 8;

interface Peek { unit: FoldUnitView; host: HTMLElement; y: number }
interface Lens { unit: FoldUnitView; x: number; y: number }

// Fold view: the note's own words at a chosen local stop, read-only, in place of the rendered page.
export default function FoldView({ id, title, content, stop, setStop, close, start, leave, reveal, marks }: {
  id: string;
  /** Note name, the Topic title when the note has no single leading H1. */
  title: string;
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
}) {
  const ladder = useMemo(() => foldDocumentLadder(content), [content]);
  const topic = useMemo(() => foldTopic(ladder), [ladder]);
  const short = useMemo(() => !worthFolding(content, ladder.stops.topic.text), [content, ladder]);
  const index = short ? 0 : STOPS.indexOf(stop);
  const percents = useMemo(() => STOPS.map(level => ladder.total ? Math.round(ladder.stops[level].shown / ladder.total * 100) : 100), [ladder]);
  const section = useRef<HTMLElement>(null), scroller = useRef<HTMLDivElement>(null), article = useRef<HTMLElement>(null), engine = useRef<FoldEngine | null>(null);
  const [hint, setHint] = useState(true);
  const [peek, setPeekState] = useState<Peek | null>(null), peekRef = useRef<Peek | null>(null);
  const [lens, setLens] = useState<Lens | null>(null);
  const [cut, setCut] = useState(false), [cutValue, setCutValue] = useState(50), cutRef = useRef(cutValue);
  cutRef.current = cutValue;
  const [view, setView] = useState<TopicView>(savedTopicView);
  // Topic shows as cards or a map; while the reader scrubs, the morphing page shows through instead.
  const [scrubbing, setScrubbing] = useState(false);
  const topicShown = !short && STOPS[index] === "topic" && !scrubbing;
  // A Topic card or map node opened at Key: the unit to land on and the viewport y it was clicked at.
  const landing = useRef<{ unit: string; top: number } | null>(null);
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
      setPeek(null); setLens(null); setCut(false);
    };
  }, [ladder, id]);
  useEffect(() => {
    const view = engine.current, target = landing.current;
    landing.current = null;
    if (!view) return;
    // A stop that hides the peeked line takes its peek with it.
    const dropHiddenPeek = () => {
      const open = peekRef.current;
      if (open?.unit.root.classList.contains("fold-off")) { open.host.remove(); view.peek = null; setPeek(null); }
    };
    if (!target && topicShown) {
      // Topic covers the page: fold it underneath once Topic has painted, in a task of its own.
      let timer = 0;
      const frame = requestAnimationFrame(() => { timer = window.setTimeout(() => { view.switchTo(index, undefined, false); dropHiddenPeek(); }); });
      return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
    }
    if (!target) { view.switchTo(index); dropHiddenPeek(); return; }
    const landed = view.reveal(index, target.unit, target.top);
    dropHiddenPeek();
    if (!landed) return;
    landed.focus({ preventScroll: true });
    landed.classList.add("fold-landed");
    landed.addEventListener("animationend", () => landed.classList.remove("fold-landed"), { once: true });
  }, [index]);
  useEffect(() => short ? undefined : warmTopic(topic, id), [topic, id, short]);
  // Leaving the Topic overlay by key or bar removes the focused card; focus returns to the page.
  useLayoutEffect(() => {
    if (!topicShown && (!document.activeElement || document.activeElement === document.body)) article.current?.focus({ preventScroll: true });
  }, [topicShown]);
  useEffect(() => {
    const element = section.current!;
    let pending = 0, target: FoldUnitView | null = null, timer = 0;
    // Pinch (Ctrl+wheel): on a unit it folds that unit only; on the page margin or Topic cards it drives the slider.
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
      setScrubbing(true);
      view.scrub(Math.max(0, Math.min(STOPS.length - 1, view.value + event.deltaY / (WHEEL_STEP * 2))));
      clearTimeout(timer);
      timer = window.setTimeout(() => { const settled = view.release(); setScrubbing(false); setHint(false); setStop(STOPS[settled]); }, 160);
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
  function openAt(unit: string, top: number) {
    landing.current = { unit, top };
    setHint(false);
    setStop("key");
  }
  function chooseView(next: TopicView) {
    saveTopicView(next);
    setView(next);
  }
  // Topic covers the page; Tab that lands on it moves past it, as inert would, without restyling every word.
  function passPage(event: ReactFocusEvent<HTMLElement>) {
    const from = event.relatedTarget, page = scroller.current;
    const back = from instanceof Node && !!page && !!(page.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING);
    const stops = section.current?.querySelectorAll<HTMLElement>(back ? '.fold-topic [tabindex="0"]' : '.fold-bar [role="slider"]');
    stops?.[stops.length - 1]?.focus();
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
  const level = stopLabel(STOPS[index]);
  return <section ref={section} className="fold-view" aria-label={t("Fold view")} data-stop={STOPS[index]} data-cut={cut || undefined}
    style={cut ? { "--cut-at": `${cutValue}%` } as React.CSSProperties : undefined} onKeyDown={event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
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
    else if ((key === "ArrowDown" || key === "ArrowUp") && !target.closest('[role="slider"],.fold-topic')) moveFocus(key === "ArrowDown" ? 1 : -1);
    else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  }}>
    {topicShown && <FoldTopic topic={topic} title={title} documentId={id} view={view} setView={chooseView}
      reading={() => engine.current?.topLine() ?? latest.current.start.line} open={openAt} />}
    <div ref={scroller} className="fold-scroller" aria-hidden={topicShown || undefined} onFocus={topicShown ? passPage : undefined}>
      <article ref={article} className="rich-document fold-document" tabIndex={0} aria-label={t("Fold view")} />
    </div>
    {peek && engine.current && createPortal(<FoldEvidence html={engine.current.source(peek.unit)} line={peek.unit.unit.line}
      open={() => reveal(peek.unit.unit.line, peek.unit.root.getBoundingClientRect().top)} />, peek.host)}
    {lens && engine.current && section.current && <FoldLens frame={section.current} root={lens.unit.root} html={engine.current.source(lens.unit)} marks={lensMarks} x={lens.x} y={lens.y} />}
    {cut && <CompareSlider overlay value={cutValue} direction="horizontal" before={t("Full")} after={level}
      label={t("Divider between Full and {{level}}", { level })} valueText={value => t("{{percent}}% shows Full", { percent: value })}
      onChange={moveCut} onCommit={moveCut} />}
    <FoldBar index={index} percents={percents} disabled={short} hint={hint} pick={pick} cut={cut} toggleCut={toggleCut}
      scrub={value => { setScrubbing(true); engine.current?.scrub(value); }}
      release={() => {
        const settled = engine.current?.release();
        setHint(false);
        if (settled !== undefined) setStop(STOPS[settled]);
        // The page committed in this task; Topic, if the slider settled there, mounts in one of its own.
        window.setTimeout(() => setScrubbing(false));
      }} />
  </section>;
}
