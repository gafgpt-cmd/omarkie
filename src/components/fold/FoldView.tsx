import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent } from "react";
import { worthFolding } from "../../../shared/fold-text.mjs";
import { foldTopic } from "../../../shared/fold-topic.mjs";
import { foldDocumentLadder } from "../../../shared/fold-units.mjs";
import { renderMath } from "../../editor/math";
import { t } from "../../i18n";
import { FoldBar } from "./FoldBar";
import { FoldTopic, saveTopicView, savedTopicView, type TopicView } from "./FoldTopic";
import { FoldEngine, type FoldUnitView } from "./morph";
import { STOPS, type Stop } from "./stops";
import "./fold.css";

const WHEEL_STEP = 60;

// Fold view: the note's own words at a chosen local stop, read-only, in place of the rendered page.
export default function FoldView({ id, title, content, stop, setStop, close, startLine, leave }: {
  id: string;
  /** Note name, the Topic title when the note has no single leading H1. */
  title: string;
  content: string;
  stop: Stop;
  setStop(stop: Stop): void;
  close(): void;
  startLine: number;
  leave(line: number, focused: boolean): void;
}) {
  const ladder = useMemo(() => foldDocumentLadder(content), [content]);
  const topic = useMemo(() => foldTopic(ladder), [ladder]);
  const short = useMemo(() => !worthFolding(content, ladder.stops.topic.text), [content, ladder]);
  const index = short ? 0 : STOPS.indexOf(stop);
  const percents = useMemo(() => STOPS.map(level => ladder.total ? Math.round(ladder.stops[level].shown / ladder.total * 100) : 100), [ladder]);
  const shell = useRef<HTMLElement>(null), scroller = useRef<HTMLDivElement>(null), article = useRef<HTMLElement>(null), engine = useRef<FoldEngine | null>(null);
  const [hint, setHint] = useState(true);
  const [view, setView] = useState<TopicView>(savedTopicView);
  // Topic shows as cards or a map; while the reader scrubs, the morphing page shows through instead.
  const [scrubbing, setScrubbing] = useState(false);
  const topicShown = !short && STOPS[index] === "topic" && !scrubbing;
  // A Topic card or map node opened at Key: the unit to land on and the viewport y it was clicked at.
  const landing = useRef<{ unit: string; top: number } | null>(null);
  const latest = useRef({ index, startLine, leave });
  latest.current = { index, startLine, leave };
  useLayoutEffect(() => () => {
    const view = engine.current;
    if (view) latest.current.leave(view.topLine(), !!scroller.current?.closest(".fold-view")?.contains(document.activeElement));
  }, []);
  useLayoutEffect(() => {
    const root = article.current!, view = new FoldEngine(scroller.current!, root, ladder, id);
    engine.current = view;
    view.jump(latest.current.index);
    view.scrollToLine(latest.current.startLine);
    root.focus({ preventScroll: true });
    void renderMath(root).catch(() => {});
    return () => {
      latest.current.startLine = view.topLine();
      view.dispose();
      engine.current = null;
      root.replaceChildren();
    };
  }, [ladder, id]);
  useEffect(() => {
    const view = engine.current, target = landing.current;
    landing.current = null;
    if (!view) return;
    if (!target) { view.switchTo(index, undefined, !topicShown); return; }
    const landed = view.reveal(index, target.unit, target.top);
    if (!landed) return;
    landed.focus({ preventScroll: true });
    landed.classList.add("fold-landed");
    landed.addEventListener("animationend", () => landed.classList.remove("fold-landed"), { once: true });
  }, [index]);
  // Leaving the Topic overlay by key or bar removes the focused card; focus returns to the page.
  useLayoutEffect(() => {
    if (!topicShown && (!document.activeElement || document.activeElement === document.body)) article.current?.focus({ preventScroll: true });
  }, [topicShown]);
  useEffect(() => {
    const element = shell.current!;
    let pending = 0, target: FoldUnitView | null = null, timer = 0;
    // Pinch (Ctrl+wheel): on a unit it folds that unit only; on the page margin or Topic cards it drives the slider.
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || short) return;
      event.preventDefault();
      const view = engine.current;
      if (!view) return;
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
    const stops = shell.current?.querySelectorAll<HTMLElement>(back ? '.fold-topic [tabindex="0"]' : '.fold-bar [role="slider"]');
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
  return <section ref={shell} className="fold-view" aria-label={t("Fold view")} data-stop={STOPS[index]} onKeyDown={event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const key = event.key;
    let handled = true;
    if (key === "Escape") close();
    else if (key === "[") pick(Math.max(0, index - 1));
    else if (key === "]") pick(Math.min(STOPS.length - 1, index + 1));
    else if (/^[1-5]$/.test(key)) pick(Number(key) - 1);
    else if (key === "6") setHint(true);
    else if ((key === "ArrowDown" || key === "ArrowUp") && !(event.target as Element).closest('[role="slider"],.fold-topic')) moveFocus(key === "ArrowDown" ? 1 : -1);
    else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  }}>
    {topicShown && <FoldTopic topic={topic} title={title} documentId={id} view={view} setView={chooseView}
      reading={() => engine.current?.topLine() ?? latest.current.startLine} open={openAt} />}
    <div ref={scroller} className="fold-scroller" aria-hidden={topicShown || undefined} onFocus={topicShown ? passPage : undefined}>
      <article ref={article} className="rich-document fold-document" tabIndex={0} aria-label={t("Fold view")} />
    </div>
    <FoldBar index={index} percents={percents} disabled={short} hint={hint} pick={pick}
      scrub={value => { setScrubbing(true); engine.current?.scrub(value); }}
      release={() => { const settled = engine.current?.release(); setScrubbing(false); setHint(false); if (settled !== undefined) setStop(STOPS[settled]); }} />
  </section>;
}
