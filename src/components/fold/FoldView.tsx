import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal, flushSync } from "react-dom";
import { unitAtLine } from "../../../shared/fold-project.mjs";
import { keeps, keptPayload, markGroup, markPins, readChoice, redFlags, setKeep, stripGroups, type StripChoice } from "../../../shared/fold-strip.mjs";
import { worthFolding } from "../../../shared/fold-text.mjs";
import { extractUnits, foldDocumentLadder, type FoldDocumentLadder, type FoldPin } from "../../../shared/fold-units.mjs";
import type { SheetColour } from "../../../shared/reading-store.ts";
import { renderMath } from "../../editor/math";
import { t } from "../../i18n";
import CompareSlider from "../CompareSlider";
import type { StudyMark } from "../learning-overlays";
import { FoldBar } from "./FoldBar";
import { FoldEvidence, FoldLens } from "./FoldEvidence";
import type { FoldMark, FoldMarks } from "./fold-marks";
import { FoldEngine, type FoldUnitView, type WordUnit } from "./morph";
import { PreFoldStrip } from "./PreFoldStrip";
import { FoldRails, markKind, quoteOf, visibleRun, type RailHints } from "./rails";
import { STOPS, stopLabel, type FoldStart, type Stop } from "./stops";
import "./fold.css";

const WHEEL_STEP = 60;
// Pen press-and-hold for Rayos X: still for this long, within this many px.
const HOLD_MS = 450;
const HOLD_SLOP = 8;
const COLOURS: readonly SheetColour[] = ["amber", "blue", "rose", "green"];
const TOAST_MS = 6000;
// What the strip keeps, per note: `{ seen, keep }` with only the reader's overrides.
const STRIP_STORE = "omarkie-fold-strip:";

interface Peek { unit: FoldUnitView; host: HTMLElement; y: number }
interface Lens { unit: FoldUnitView; x: number; y: number }
// Author words picked for a highlight, and where the colour choice opens.
interface Pick { unit: WordUnit; quote: string; x: number; y: number }
interface Deck { marks: readonly FoldMark[]; chip: HTMLElement; x: number; y: number }

// Fold view: the note's own words at a chosen local stop, read-only, in place of the rendered page.
export default function FoldView({ id, memory, content, stop, setStop, close, start, leave, reveal, marks }: {
  id: string;
  // The note's name for what the reader chose to keep (its vault path, else its id).
  memory: string;
  content: string;
  stop: Stop;
  setStop(stop: Stop): void;
  close(): void;
  start: FoldStart;
  leave(line: number, focused: boolean): void;
  // Open the source in the editor with this line at viewport y.
  reveal(line: number, y: number): void;
  // Study marks and Glass magnets, projected here, never copied; writes go through the publisher.
  marks: FoldMarks;
}) {
  const feed = useSyncExternalStore(marks.subscribe, marks.get);
  const units = useMemo(() => extractUnits(content), [content]), flags = useMemo(() => redFlags(units), [units]);
  const [choice, setChoiceState] = useState(() => readChoice(localStorage.getItem(STRIP_STORE + memory)));
  const setChoice = (next: StripChoice) => { setChoiceState(next); localStorage.setItem(STRIP_STORE + memory, JSON.stringify(next)); };
  const groups = useMemo(() => stripGroups(feed.marks, flags), [feed.marks, flags]);
  // Kept groups pin their marks' sentences, red flags their own: they reach Takeaway in the author's words.
  const ownPins = useMemo(() => markPins(feed.marks, choice), [feed.marks, choice]);
  const pinKey = JSON.stringify([ownPins, keeps(choice, "redflag")]);
  const previous = useRef<FoldDocumentLadder | null>(null);
  const ladder = useMemo(() => {
    const [own, flagged] = JSON.parse(pinKey) as [FoldPin[], boolean];
    const next = foldDocumentLadder(content, { pins: flagged ? [...own, ...flags] : own, units }), last = previous.current;
    // Same lines at every stop: keep the built page (and the reader's place) as it is.
    const same = last && last.byUnit.length === next.byUnit.length && last.byUnit.every((entry, at) =>
      entry.pinned.join() === next.byUnit[at].pinned.join() && STOPS.every(level => entry.stops[level] === next.byUnit[at].stops[level]));
    return previous.current = same ? last : next;
  }, [content, units, flags, pinKey]);
  // Post-fold hints: ★ for the reader's own pins (and what they keep), ⚑ for suggested red flags, Keep for marks let fold.
  const hints = useMemo<RailHints>(() => ({
    starred: new Set(ownPins.map(pin => unitAtLine(ladder.units, pin.line))),
    kept: keptPayload(ladder, ownPins),
    keepable: mark => { const group = mark.line === null ? null : markGroup(mark); return !!group && !keeps(choice, group); },
  }), [ladder, ownPins, choice]);
  const short = useMemo(() => !worthFolding(content, ladder.stops.topic.text), [content, ladder]);
  const index = short ? 0 : STOPS.indexOf(stop);
  const percents = useMemo(() => STOPS.map(level => ladder.total ? Math.round(ladder.stops[level].shown / ladder.total * 100) : 100), [ladder]);
  const section = useRef<HTMLElement>(null), scroller = useRef<HTMLDivElement>(null), article = useRef<HTMLElement>(null), engine = useRef<FoldEngine | null>(null);
  const rails = useRef<FoldRails | null>(null), [, setPainted] = useState(0), [ticks, setTicks] = useState<{ shown: number; total: number }[]>();
  const [hint, setHint] = useState(true), [stripOpen, setStripOpen] = useState(false);
  // The strip rides inside the page, above the first fold line; it outlives rebuilds so its focus does too.
  const [strip] = useState(() => Object.assign(document.createElement("div"), { className: "fold-strip" }));
  const showStrip = !short && (groups.length > 0 || feed.uncarded > 0);
  const [peek, setPeekState] = useState<Peek | null>(null), peekRef = useRef<Peek | null>(null);
  const [lens, setLens] = useState<Lens | null>(null);
  const [cut, setCut] = useState(false), [cutValue, setCutValue] = useState(50), cutRef = useRef(cutValue);
  const [picking, setPicking] = useState<Pick | null>(null), [deck, setDeck] = useState<Deck | null>(null), [tray, setTray] = useState(false), [toast, setToast] = useState(false);
  const focusAfter = useRef<FoldMark | null>(null);
  cutRef.current = cutValue;
  const latest = useRef({ index, start, leave, togglePeek, feed, hints });
  latest.current = { index, start, leave, togglePeek, feed, hints };
  const setPeek = (next: Peek | null) => { peekRef.current = next; setPeekState(next); };
  // The last build's rendered HTML: a rebuild for new pins re-renders only the units they changed.
  const rendered = useRef<ReadonlyMap<string, string>>(undefined);
  useLayoutEffect(() => () => {
    const view = engine.current;
    if (view) latest.current.leave(view.topLine(), !!section.current?.contains(document.activeElement));
  }, []);
  useLayoutEffect(() => {
    const root = article.current!, first = strip.parentNode !== root;
    if (first) root.prepend(strip);
    const view = new FoldEngine(scroller.current!, root, ladder, id, rendered.current);
    rendered.current = view.rendered;
    const glass = new FoldRails(view, root, ladder, () => setPainted(count => count + 1));
    glass.setHints(latest.current.hints);
    glass.setMarks(latest.current.feed.marks);
    engine.current = view; rails.current = glass; view.riders = glass;
    setTicks(glass.ticks());
    view.jump(latest.current.index);
    const { line, y, focus } = latest.current.start;
    const unit = view.scrollToLine(line, y === undefined ? 0 : y - scroller.current!.getBoundingClientRect().top);
    // Opening on the first line opens at the top, the strip above it in view.
    if (first && unit === view.units.find(item => !item.root.classList.contains("fold-off"))) scroller.current!.scrollTop = 0;
    if (!strip.contains(document.activeElement)) (focus && unit ? unit.root : root).focus({ preventScroll: true });
    void renderMath(root).catch(() => {});
    return () => {
      // A rebuild (new pins) reopens at the same line, same height, same focus.
      const focused = section.current?.contains(document.activeElement) ? view.unitOf(document.activeElement) : undefined;
      const kept = focused && !focused.root.classList.contains("fold-off") ? focused : view.unitAtLine(view.topLine());
      latest.current.start = kept ? { line: kept.unit.line, y: kept.root.getBoundingClientRect().top, focus: kept === focused } : { line: view.topLine() };
      glass.dispose();
      view.dispose();
      engine.current = null; rails.current = null;
      while (root.lastChild && root.lastChild !== strip) root.lastChild.remove();
      setPeek(null); setLens(null); setCut(false); setPicking(null); setDeck(null);
    };
  }, [ladder, id, strip]);
  useEffect(() => {
    const view = engine.current, glass = rails.current;
    if (view && glass && glass.setHints(hints)) view.reflow(() => glass.paint());
  }, [hints]);
  // The strip opens by itself once per note, the first time there is something to say; after that it stays a line.
  useEffect(() => {
    if (!showStrip || choice.seen) return;
    setStripOpen(true);
    setChoice({ ...choice, seen: true });
  });
  useEffect(() => {
    const view = engine.current, glass = rails.current;
    if (!view || !glass || glass.marks === feed.marks) return;
    glass.setMarks(feed.marks);
    setTicks(glass.ticks());
    view.reflow(() => glass.paint());
  }, [feed.marks]);
  useEffect(() => {
    engine.current?.switchTo(index);
    // A stop that hides the peeked line takes its peek with it.
    const open = peekRef.current;
    if (open?.unit.root.classList.contains("fold-off")) { open.host.remove(); if (engine.current) engine.current.peek = null; setPeek(null); }
    setDeck(null); setPicking(null);
    // Out of fold: the jump lands on the first mark it brought back.
    const mark = focusAfter.current, glass = rails.current, view = engine.current;
    focusAfter.current = null;
    const target = mark && glass && view ? view.units[glass.unitOf(mark)] : undefined;
    if (target && !target.root.classList.contains("fold-off")) { target.root.focus({ preventScroll: true }); target.root.scrollIntoView({ block: "nearest" }); }
  }, [index]);
  const couldUndo = useRef(false);
  useEffect(() => {
    // Undo (menu, Ctrl+Z, or the toast) took the mark back: the toast goes with it.
    const undone = couldUndo.current && !feed.canUndo;
    couldUndo.current = feed.canUndo;
    if (!toast) return;
    if (undone) { setToast(false); return; }
    const timer = window.setTimeout(() => setToast(false), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast, feed]);
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
  // Corte geometry follows the page width.
  useEffect(() => {
    if (!cut) return;
    const observer = new ResizeObserver(() => { const view = engine.current; if (view?.cutting) { view.cutAt(cutRef.current / 100); view.remeasureCut(); } });
    observer.observe(scroller.current!);
    return () => observer.disconnect();
  }, [cut]);
  const lensMarks = useMemo(() => {
    if (!lens) return [];
    const found: StudyMark[] = [];
    for (let line = lens.unit.unit.line; line <= lens.unit.unit.endLine; line++) found.push(...feed.study.get(line) ?? []);
    return found;
  }, [lens, feed.study]);
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
  // Mouse: a selection inside one line's shown author words opens the colour choice under it.
  function selectFromPage() {
    const view = engine.current, selection = getSelection();
    if (!view || view.cutting || !selection || selection.isCollapsed || !selection.rangeCount) { setPicking(null); return; }
    const range = selection.getRangeAt(0), element = (node: Node) => node instanceof Element ? node : node.parentElement;
    const unit = view.unitOf(element(range.startContainer));
    if (!unit || unit !== view.unitOf(element(range.endContainer)) || unit.kind !== "words") { setPicking(null); return; }
    const shown = (token: HTMLElement) => !token.classList.contains("fold-added") && !token.classList.contains("fold-off");
    const first = unit.tokens.findIndex(token => shown(token) && range.intersectsNode(token));
    if (first >= 0) choose(unit, visibleRun(unit, first, token => range.intersectsNode(token)), range.getBoundingClientRect(), false);
  }
  // Keyboard: `h` on a line picks its first shown words.
  function selectLine(unit: WordUnit) {
    const first = unit.tokens.findIndex(token => !token.classList.contains("fold-added") && !token.classList.contains("fold-off"));
    if (first < 0) return;
    const run = visibleRun(unit, first), range = document.createRange(), selection = getSelection();
    range.setStartBefore(unit.tokens[run[0]]); range.setEndAfter(unit.tokens[run[run.length - 1]]);
    selection?.removeAllRanges(); selection?.addRange(range);
    choose(unit, run, range.getBoundingClientRect(), true);
  }
  function choose(unit: WordUnit, run: readonly number[], rect: DOMRect, focus: boolean) {
    const quote = run.length ? quoteOf(unit, run) : "", frame = section.current?.getBoundingClientRect();
    if (!quote || !frame) { setPicking(null); return; }
    setDeck(null);
    flushSync(() => setPicking({ unit, quote, x: Math.max(8, rect.left - frame.left), y: rect.bottom - frame.top + 6 }));
    if (focus) section.current?.querySelector<HTMLElement>(".fold-pick button")?.focus();
  }
  async function highlight(colour: SheetColour) {
    const current = picking;
    if (!current) return;
    setPicking(null);
    getSelection()?.removeAllRanges();
    current.unit.root.focus({ preventScroll: true });
    if (await marks.get().highlight(current.unit.unit.line, current.unit.unit.endLine, current.quote, colour)) setToast(true);
  }
  function undo() { setToast(false); void marks.get().undo(); }
  // A rider chip: out of fold jumps to the stop that shows those marks, the deck lists, the glyph re-expands, your words open.
  function railAction(chip: HTMLElement) {
    const view = engine.current, glass = rails.current, projection = glass?.projection, at = Number(chip.dataset.unit);
    if (!view || !glass || !projection) return;
    const unit = view.units[at], action = chip.dataset.action;
    if (action === "out") {
      const list = projection.out.get(at) ?? [];
      focusAfter.current = list[0] ?? null;
      pick(glass.reach(list, index));
    } else if (action === "deck") {
      const rect = chip.getBoundingClientRect(), frame = section.current!.getBoundingClientRect();
      setPicking(null);
      setDeck(deck?.chip === chip ? null : { marks: projection.decks.get(at) ?? [], chip, x: rect.right - frame.left, y: rect.bottom - frame.top + 4 });
    } else if (action === "ink") {
      view.switchTo(0, unit);
      unit.root.focus({ preventScroll: true });
    } else if (action === "words") {
      const list = projection.words.get(at) ?? [], opened = list.some(mark => glass.open.has(mark.id));
      for (const mark of list) if (opened) glass.open.delete(mark.id); else glass.open.add(mark.id);
      view.reflow(() => glass.paint());
    } else if (action === "keep") {
      // Keep these marks' groups from now on; the rebuilt page brings them back at this stop.
      const kept = new Set((projection.out.get(at) ?? []).filter(hints.keepable).flatMap(mark => markGroup(mark) ?? []));
      unit.root.focus({ preventScroll: true });
      setChoice(setKeep(choice, [...kept], true));
    }
  }
  function jumpTo(mark: FoldMark) {
    const view = engine.current, glass = rails.current, unit = view && glass ? view.units[glass.unitOf(mark)] : undefined;
    setDeck(null); setTray(false);
    if (!unit || unit.root.classList.contains("fold-off")) return;
    unit.root.focus({ preventScroll: true });
    unit.root.scrollIntoView({ block: "center" });
  }
  useEffect(() => { if (deck) section.current?.querySelector<HTMLElement>(".fold-deck-pop button")?.focus(); }, [deck]);
  const level = stopLabel(STOPS[index]);
  const orphans = rails.current?.projection?.orphans ?? [], checks = feed.marks.filter(mark => mark.check), trayCount = orphans.length + checks.length;
  const markLine = (mark: FoldMark) => <><span className="fold-pop-kind">{markKind(mark)}</span>{(mark.quote || mark.text) && <span className="fold-pop-text">{mark.quote || mark.text}</span>}</>;
  return <section ref={section} className="fold-view" aria-label={t("Fold view")} data-stop={STOPS[index]} data-cut={cut || undefined}
    style={cut ? { "--cut-at": `${cutValue}%` } as React.CSSProperties : undefined} onKeyDown={event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const key = event.key, target = event.target as HTMLElement, unit = engine.current?.unitOf(target), inPopup = !!target.closest(".fold-pop, .fold-pick, .fold-strip");
    let handled = true;
    if (key === "Escape") {
      if (picking) { setPicking(null); getSelection()?.removeAllRanges(); picking.unit.root.focus({ preventScroll: true }); }
      else if (deck) { setDeck(null); deck.chip.focus({ preventScroll: true }); }
      else if (tray) setTray(false);
      else if (stripOpen && strip.contains(target)) { setStripOpen(false); strip.querySelector<HTMLElement>(".fold-strip-adjust")?.focus(); }
      else if (peekRef.current) closePeek(true); else if (cut) toggleCut(); else close();
    }
    else if (inPopup) handled = false;
    else if (key === "Enter" && event.shiftKey && unit) reveal(unit.unit.line, unit.root.getBoundingClientRect().top);
    else if (key === "Enter" && !event.shiftKey && unit && target === unit.root) togglePeek(unit);
    else if ((key === "h" || key === "H") && unit?.kind === "words" && target === unit.root && !cut) selectLine(unit);
    else if ((key === "c" || key === "C") && !target.closest("button:not([data-compare-handle])")) toggleCut();
    else if (key === "[") pick(Math.max(0, index - 1));
    else if (key === "]") pick(Math.min(STOPS.length - 1, index + 1));
    else if (/^[1-5]$/.test(key)) pick(Number(key) - 1);
    else if (key === "6") setHint(true);
    else if ((key === "ArrowDown" || key === "ArrowUp") && !target.closest('[role="slider"]')) moveFocus(key === "ArrowDown" ? 1 : -1);
    else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  }}>
    <div ref={scroller} className="fold-scroller" onPointerUp={() => requestAnimationFrame(selectFromPage)} onClick={event => {
      const chip = (event.target as Element).closest<HTMLElement>("button[data-action]");
      if (chip && article.current?.contains(chip)) railAction(chip); else setDeck(null);
    }}>
      <article ref={article} className="rich-document fold-document" tabIndex={0} aria-label={t("Fold view")} data-marks={feed.marks.length ? "" : undefined} />
    </div>
    {showStrip && createPortal(<PreFoldStrip groups={groups} choice={choice} setChoice={setChoice} open={stripOpen} setOpen={setStripOpen}
      uncarded={feed.uncarded} makeCards={feed.makeCards} />, strip)}
    {peek && engine.current && createPortal(<FoldEvidence html={engine.current.source(peek.unit)} line={peek.unit.unit.line}
      open={() => reveal(peek.unit.unit.line, peek.unit.root.getBoundingClientRect().top)} />, peek.host)}
    {lens && engine.current && section.current && <FoldLens frame={section.current} root={lens.unit.root} html={engine.current.source(lens.unit)} marks={lensMarks} x={lens.x} y={lens.y} />}
    {cut && <CompareSlider overlay value={cutValue} direction="horizontal" before={t("Full")} after={level}
      label={t("Divider between Full and {{level}}", { level })} valueText={value => t("{{percent}}% shows Full", { percent: value })}
      onChange={moveCut} onCommit={moveCut} />}
    {picking && <div className="fold-pick" role="group" aria-label={t("选区操作")} style={{ left: picking.x, top: picking.y }}>
      <div role="group" aria-label={t("高亮")}>{COLOURS.map(colour => {
        const label = t("Highlight: {{colour}}", { colour: t(colour) });
        return <button key={colour} type="button" className="fold-swatch" data-colour={colour} aria-label={label} title={label} onClick={() => void highlight(colour)} />;
      })}</div>
    </div>}
    {deck && <div className="fold-pop fold-deck-pop" role="dialog" aria-label={t("Magnets in this section · {{n}}", { n: deck.marks.length })}
      style={{ right: `calc(100% - ${deck.x}px)`, top: deck.y }}>
      <ul>{deck.marks.map(mark => <li key={mark.id}><button type="button" onClick={() => jumpTo(mark)}>{markLine(mark)}</button></li>)}</ul>
    </div>}
    {trayCount > 0 && !cut && <div className="fold-tray">
      <button type="button" className="fold-tray-chip" aria-expanded={tray} onClick={() => { setDeck(null); setTray(!tray); }}>{t("Re-anchor tray · {{n}}", { n: trayCount })}</button>
      {tray && <div className="fold-pop fold-tray-pop" role="dialog" aria-label={t("Re-anchor tray")}>
        {orphans.length > 0 && <><p className="fold-pop-head">{t("Without a line")}</p><ul>{orphans.map(mark => <li key={mark.id}>{markLine(mark)}</li>)}</ul></>}
        {checks.length > 0 && <><p className="fold-pop-head">{t("Placement to check")}</p>
          <ul>{checks.map(mark => <li key={mark.id}><button type="button" onClick={() => jumpTo(mark)}>{markLine(mark)}</button></li>)}</ul></>}
        <button type="button" className="fold-pop-open" onClick={close}>{t("Open on the page")}</button>
      </div>}
    </div>}
    {toast && <div className="fold-toast" role="status">{t("Highlight added")}
      {feed.canUndo && <button type="button" onClick={undo}>{t("Undo")}</button>}</div>}
    <FoldBar index={index} percents={percents} ticks={ticks} disabled={short} hint={hint} pick={pick} cut={cut} toggleCut={toggleCut}
      scrub={value => engine.current?.scrub(value)}
      release={() => { const settled = engine.current?.release(); setHint(false); if (settled !== undefined) setStop(STOPS[settled]); }} />
  </section>;
}
