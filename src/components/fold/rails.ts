// Glass in the fold: marks projected onto the fold's lines, never copied. Highlights tint the author's own
// tokens; everything else rides the margins of the line that holds it, or of the line that absorbed it.
import { inkPath, type InkPoint } from "../../../shared/ink-core.mjs";
import { projectAt, projectMarks, squash, unitAtLine, type Projection } from "../../../shared/fold-project.mjs";
import type { KeptClass } from "../../../shared/fold-strip.mjs";
import type { FoldDocumentLadder } from "../../../shared/fold-units.mjs";
import type { SheetColour } from "../../../shared/reading-store.ts";
import { resolveBox } from "../../glass/ink-model";
import { t } from "../../i18n";
import type { FoldMark } from "./fold-marks";
import type { FoldEngine, FoldUnitView, Riders, WordUnit } from "./morph";
import { STOPS, stopLabel, type Stop } from "./stops";

/** Post-fold hints, from the strip's choice; quiet, and never applied by themselves. */
export interface RailHints {
  // Units a reader's own mark pins (★); any other pinned unit was kept by a suggested red flag (⚑).
  starred: ReadonlySet<number>;
  // What a reader's pin keeps that the plain stop would drop, per unit and stop.
  kept: ReadonlyMap<number, Partial<Record<Stop, KeptClass>>>;
  // Out-of-fold marks a pin would keep: their group is let fold.
  keepable(mark: FoldMark): boolean;
}
const NO_HINTS: RailHints = { starred: new Set(), kept: new Map(), keepable: () => false };

function keptLabel(kept: KeptClass) {
  return kept === "negation" ? t("Negation kept") : kept === "condition" ? t("Condition kept") : kept === "restriction" ? t("Limit kept") : t("Number kept");
}

type Point = readonly [number, number];
type Side = "start" | "end";
const SVG = "http://www.w3.org/2000/svg";
const COLOURS: readonly SheetColour[] = ["amber", "blue", "rose", "green"];
const LINE_BLOCK = "p,li,h1,h2,h3,h4,h5,h6,td,th,dt,dd,figcaption";
const shows = (mask: number, stop: number) => (mask >> stop & 1) === 1;
const isAuthor = (token: HTMLElement) => !token.classList.contains("fold-added");

export function markKind(mark: FoldMark) {
  if (mark.kind === "highlight") return t("高亮");
  if (mark.kind === "ink") return t("Ink");
  if (mark.kind === "sticky") return t("Sticky note");
  switch (mark.type) {
    case "clip": return t("Clip");
    case "card": return t("Card");
    case "image": return t("Image");
    case "arrow": return t("Arrow");
    case "label": return t("Label");
    case "comment": return t("Comment bubble");
    case "voice": return t("Voice memo");
    default: return t("Magnet");
  }
}

// Author token indexes a quote covers, compared letters and digits only.
function tokenRun(unit: WordUnit, quote: string) {
  const needle = squash(quote);
  if (!needle) return;
  const ids: number[] = [], starts: number[] = [];
  let joined = "";
  unit.tokens.forEach((token, index) => { if (isAuthor(token)) { ids.push(index); starts.push(joined.length); joined += squash(token.textContent ?? ""); } });
  const at = joined.indexOf(needle);
  if (at < 0) return;
  const end = at + needle.length, run: number[] = [];
  for (let k = 0; k < ids.length; k++) {
    const from = starts[k], to = k + 1 < ids.length ? starts[k + 1] : joined.length;
    if (to > from && from < end && to > at) run.push(ids[k]);
  }
  return run.length ? run : undefined;
}

// Where a quote sits in rendered text: for blocks the fold shows whole (tables, code, math).
function textRange(root: Element, quote: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes: Text[] = [], offsets: number[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) { nodes.push(node as Text); offsets.push(text.length); text += node.nodeValue ?? ""; }
  const at = text.indexOf(quote);
  if (at < 0 || !quote) return;
  const locate = (offset: number) => { let k = nodes.length - 1; while (k > 0 && offsets[k] > offset) k--; return [nodes[k], offset - offsets[k]] as const; };
  const range = document.createRange();
  range.setStart(...locate(at)); range.setEnd(...locate(at + quote.length));
  return range;
}

/** The author's words from token `from` to token `to` (author order), exactly as the page renders them. */
export function quoteOf(unit: WordUnit, run: readonly number[]) {
  const range = document.createRange();
  range.setStartBefore(unit.tokens[run[0]]); range.setEndAfter(unit.tokens[run[run.length - 1]]);
  const copy = document.createElement("div");
  copy.append(range.cloneContents());
  // A marker the fold added came in with one space of its own; both go.
  for (const added of copy.querySelectorAll(".fold-added")) {
    const before = added.previousSibling, after = added.nextSibling;
    if (before?.nodeType === Node.TEXT_NODE && before.nodeValue === " ") before.remove();
    else if (after?.nodeType === Node.TEXT_NODE && after.nodeValue === " ") after.remove();
    added.remove();
  }
  return (copy.textContent ?? "").trim();
}

/** Visible author tokens next to each other, inside one line, starting at `first`. */
export function visibleRun(unit: WordUnit, first: number, keep: (token: HTMLElement) => boolean = () => true) {
  const order = [...unit.root.querySelectorAll<HTMLElement>(".fold-w")].filter(token => !token.classList.contains("fold-off"));
  const index = new Map(unit.tokens.map((token, at) => [token, at]));
  const start = order.indexOf(unit.tokens[first]), line = unit.tokens[first].closest(LINE_BLOCK), run: number[] = [];
  for (let k = start; k >= 0 && k < order.length; k++) {
    const token = order[k], at = index.get(token)!;
    if (!isAuthor(token) || !keep(token) || token.closest(LINE_BLOCK) !== line || (run.length && at !== run[run.length - 1] + 1)) break;
    run.push(at);
  }
  return run;
}

export class FoldRails implements Riders {
  marks: readonly FoldMark[] = [];
  projection: Projection<FoldMark> | null = null;
  // Stickies whose "tus palabras" card is open.
  readonly open = new Set<string>();
  private readonly engine: FoldEngine;
  private readonly container: HTMLElement;
  private readonly ladder: FoldDocumentLadder;
  private readonly changed: () => void;
  private readonly lines: { line: number; endLine: number; sectionId: string | null }[];
  private readonly pins: number[];
  private runs = new Map<string, number[]>();
  private tinted: HTMLElement[] = [];
  private seen = new Map<string, Point>();
  private riders = new Map<number, Map<string, HTMLElement>>();
  private sizes = new Map<string, readonly [number, number]>();
  private hints = NO_HINTS;

  constructor(engine: FoldEngine, container: HTMLElement, ladder: FoldDocumentLadder, changed: () => void) {
    this.engine = engine; this.container = container; this.ladder = ladder; this.changed = changed;
    this.lines = engine.units.map(({ unit }) => ({ line: unit.line, endLine: unit.endLine, sectionId: unit.sectionId ?? null }));
    this.pins = ladder.byUnit.flatMap((entry, index) => entry.pinned.length ? [index] : []);
  }

  // A highlight whose words left the source has no line any more: it waits in the re-anchor tray.
  setMarks(marks: readonly FoldMark[]) {
    this.runs.clear();
    this.marks = marks.map(mark => {
      if (mark.kind !== "highlight" || !mark.quote) return mark;
      const unit = this.engine.units[unitAtLine(this.lines, mark.line)];
      if (!unit) return mark;
      if (unit.kind === "words") {
        const run = tokenRun(unit, mark.quote);
        if (run) { this.runs.set(mark.id, run); return mark; }
      } else if (squash((unit.root.querySelector(".fold-variant") ?? unit.root).textContent).includes(squash(mark.quote))) return mark;
      return { ...mark, line: null };
    });
  }

  // True when the hints changed, so the caller repaints.
  setHints(hints: RailHints) { if (this.hints === hints) return false; this.hints = hints; return true; }
  unitOf(mark: FoldMark) { return unitAtLine(this.lines, mark.line); }

  private stopAt(index: number) { return this.engine.cutting ? 0 : this.engine.stopOf(this.engine.units[index]); }

  // A highlight shows when every word it covers shows; any other mark rides its line.
  visible(mark: FoldMark, index: number, stop: number) {
    const unit = this.engine.units[index];
    if (!shows(unit.present, stop)) return false;
    const run = this.runs.get(mark.id);
    return !run || unit.kind !== "words" || run.every(token => shows(unit.bits[token], stop));
  }

  // Marks that show at each stop, for the slider ticks.
  ticks() {
    const units = this.engine.units;
    return projectMarks(this.lines.map((line, index) => ({ ...line, present: STOPS.map((_, stop) => shows(units[index].present, stop)) })),
      this.marks, (mark, index, stop) => this.visible(mark, index, stop)).map(at => at.ticks);
  }

  // The most folded stop under `below` where every one of these marks shows again.
  reach(marks: readonly FoldMark[], below: number) {
    for (let stop = below - 1; stop > 0; stop--)
      if (marks.every(mark => { const index = this.unitOf(mark); return index >= 0 && (mark.kind === "sticky" || this.visible(mark, index, stop)); })) return stop;
    return 0;
  }

  capture() {
    this.seen.clear();
    const at = (element: Element) => { const rect = element.getBoundingClientRect(); return rect.width || rect.height ? [rect.left, rect.top] as const : undefined; };
    for (const token of this.tinted) {
      const id = token.dataset.markStart, point = id && at(token);
      if (id && point) this.seen.set(id, point);
    }
    for (const rider of this.container.querySelectorAll<HTMLElement>(".fold-rider[data-marks]")) {
      const point = at(rider);
      if (point) for (const id of rider.dataset.marks!.split(" ")) if (!this.seen.has(id)) this.seen.set(id, point);
    }
  }

  paint() {
    const units = this.engine.units, stops = units.map((_, index) => this.stopAt(index));
    const projection = projectAt(this.lines, this.marks, units.map((unit, index) => shows(unit.present, stops[index])),
      (mark, index) => this.visible(mark, index, stops[index]));
    this.projection = projection;
    this.tint(projection);
    const origins = new Map<HTMLElement, Point>();
    const touched = new Set([...this.riders.keys(), ...this.pins, ...projection.own.keys(), ...projection.out.keys(), ...projection.decks.keys(), ...projection.words.keys()]);
    for (const index of touched) if (index >= 0) this.sync(index, stops[index], projection, origins);
    this.changed();
    return origins;
  }

  dispose() {
    for (const colour of COLOURS) CSS.highlights?.delete(`fold-mark-${colour}`);
    for (const token of this.tinted) { delete token.dataset.mark; delete token.dataset.markStart; delete token.dataset.markEnd; }
    this.tinted = [];
    for (const map of this.riders.values()) for (const element of map.values()) element.remove();
    this.riders.clear();
  }

  private tint(projection: Projection<FoldMark>) {
    for (const token of this.tinted) { delete token.dataset.mark; delete token.dataset.markStart; delete token.dataset.markEnd; }
    this.tinted = [];
    const ranges = new Map<SheetColour, Range[]>();
    for (const [index, list] of projection.own) for (const mark of list) {
      if (mark.kind !== "highlight") continue;
      const unit = this.engine.units[index], run = this.runs.get(mark.id), colour = mark.colour ?? "amber";
      if (run && unit.kind === "words") {
        run.forEach((at, k) => {
          const token = unit.tokens[at];
          token.dataset.mark = colour;
          if (k === 0) token.dataset.markStart = mark.id;
          if (k === run.length - 1) token.dataset.markEnd = "";
          this.tinted.push(token);
        });
        continue;
      }
      const host = unit.kind === "raw" ? unit.variants[this.stopAt(index)] : unit.root, range = mark.quote ? textRange(host, mark.quote) : undefined;
      if (range) ranges.set(colour, [...ranges.get(colour) ?? [], range]);
    }
    if (!CSS.highlights) return;
    for (const colour of COLOURS) {
      const list = ranges.get(colour);
      if (list) CSS.highlights.set(`fold-mark-${colour}`, new Highlight(...list)); else CSS.highlights.delete(`fold-mark-${colour}`);
    }
  }

  // Lay out one line's riders: reuse what is there, glide in what is new, take away what is gone.
  private sync(index: number, stop: number, projection: Projection<FoldMark>, origins: Map<HTMLElement, Point>) {
    const unit = this.engine.units[index], root = unit.root, before = this.riders.get(index) ?? new Map<string, HTMLElement>();
    const after = new Map<string, HTMLElement>();
    const rail = (side: Side) => {
      let element = root.querySelector<HTMLElement>(`:scope > .fold-rail-${side}`);
      if (!element) { element = document.createElement("div"); element.className = `fold-rail fold-rail-${side}`; root.append(element); }
      return element;
    };
    const place = <K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, key: string, tag: K, className: string, marks: readonly FoldMark[]) => {
      let element = before.get(key) as HTMLElementTagNameMap[K] | undefined;
      if (!element) {
        element = document.createElement(tag);
        const from = marks.map(mark => this.seen.get(mark.id)).find(point => point);
        if (from) origins.set(element, from);
      }
      element.className = `fold-rider ${className}`;
      element.dataset.rider = key;
      if (marks.length) element.dataset.marks = marks.map(mark => mark.id).join(" "); else delete element.dataset.marks;
      if (element.parentElement !== parent) parent.append(element);
      after.set(key, element);
      return element;
    };
    const button = (parent: HTMLElement, key: string, className: string, marks: readonly FoldMark[], action: string, label: string) => {
      const element = place(parent, key, "button", className, marks);
      element.type = "button";
      Object.assign(element.dataset, { action, unit: String(index) });
      element.setAttribute("aria-label", label);
      element.title = label;
      return element;
    };
    const present = shows(unit.present, stop) && !this.engine.cutting, level = STOPS[stop];
    if (present && this.ladder.byUnit[index].pinned.includes(level)) {
      const own = this.hints.starred.has(index), kept = own ? this.hints.kept.get(index)?.[level] : undefined;
      const pin = place(rail("start"), "pin", "span", own ? "fold-pin" : "fold-pin fold-flag", []);
      const label = own ? t("Pinned: kept in the author's words") : t("Red flag: kept by suggestion");
      const why = kept && t("{{kept}}: {{level}} alone would drop it from your highlight", { kept: keptLabel(kept), level: stopLabel(level) });
      pin.setAttribute("role", "img"); pin.setAttribute("aria-label", why ? `${label} · ${why}` : label); pin.title = why ? `${label}\n${why}` : label;
      pin.textContent = own ? "★" : "⚑";
      if (kept) place(rail("start"), "kept", "span", "fold-kept", []).replaceChildren(span("fold-kept-label", keptLabel(kept)));
    }
    const out = present ? projection.out.get(index) : undefined;
    if (out) {
      const chip = button(rail("start"), "out", "fold-out", out, "out", t("{{n}} marks out of fold at this line: show them", { n: out.length }));
      chip.replaceChildren(span("fold-out-label", t("Out of fold · {{n}}", { n: out.length })), span("fold-out-count", String(out.length)));
      // Brief to Takeaway keep pinned marks; offer it for marks whose group the reader lets fold.
      const keep = stop >= 1 && stop <= 3 ? out.filter(mark => this.hints.keepable(mark) && this.engine.units[this.unitOf(mark)]?.kind === "words") : [];
      if (keep.length) button(rail("start"), "keep", "fold-keep", keep, "keep", t("Keep {{count}} marks in the fold", { count: keep.length }))
        .replaceChildren(span("fold-keep-label", t("Keep")), span("fold-keep-icon", "+"));
    }
    const deck = present ? projection.decks.get(index) : undefined;
    if (deck) {
      const chip = button(rail("end"), "deck", "fold-deck", deck, "deck", t("Magnets in this section · {{n}}", { n: deck.length }));
      chip.setAttribute("aria-haspopup", "dialog");
      chip.replaceChildren(deckIcon(), span("fold-deck-count", String(deck.length)));
    }
    const ink = present ? (projection.own.get(index) ?? []).filter(mark => mark.kind === "ink" && mark.ink) : [];
    if (ink.length) {
      const entry = this.ladder.byUnit[index], whole = entry.stops[STOPS[stop]] === entry.stops.full;
      if (whole) for (const mark of ink) this.drawInPlace(place(root as HTMLElement, `ink:${mark.id}`, "div", "fold-ink", [mark]), unit, mark);
      else {
        const glyph = button(rail("end"), "glyph", "fold-glyph", ink, "ink", t("Ink: show at full size"));
        glyph.replaceChildren(...ink.map(mark => this.glyph(unit, index, mark)));
      }
    }
    const words = present ? projection.words.get(index) : undefined;
    if (words) {
      const opened = words.some(mark => this.open.has(mark.id));
      const toggle = button(rail("end"), "words", "fold-words", words, "words", t("Your words · {{n}}", { n: words.length }));
      toggle.setAttribute("aria-expanded", String(opened));
      toggle.replaceChildren(span("fold-words-label", t("Your words · {{n}}", { n: words.length })), span("fold-words-count", String(words.length)));
      if (opened) {
        const card = place(root, "card", "div", "fold-words-card", words);
        card.setAttribute("role", "region"); card.setAttribute("aria-label", t("Your words"));
        const list = document.createElement("ul");
        for (const mark of words) { const item = document.createElement("li"); item.textContent = mark.text ?? ""; list.append(item); }
        card.replaceChildren(list);
      }
    }
    for (const [key, element] of before) if (!after.has(key)) element.remove();
    for (const side of ["start", "end"] as const) {
      const element = root.querySelector(`:scope > .fold-rail-${side}`);
      if (element && !element.childElementCount) element.remove();
    }
    if (after.size) this.riders.set(index, after); else this.riders.delete(index);
  }

  // The rendered block an ink part was drawn on; raw lines show one variant.
  private block(unit: FoldUnitView, root: HTMLElement) {
    const host = unit.kind === "raw" ? root.querySelector<HTMLElement>(":scope > .fold-variant:not([hidden])") ?? root : root;
    return host.querySelector<HTMLElement>(":scope > :not(.fold-rail, .fold-rider, .fold-peek)") ?? host;
  }

  // An ink part's box size at Full: measured once per page width, so the glyph and the full-size ink draw one path.
  private size(unit: FoldUnitView, index: number, mark: FoldMark): readonly [number, number] {
    const style = getComputedStyle(this.container), width = this.container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const key = `${mark.id}@${width}`, cached = this.sizes.get(key);
    if (cached) return cached;
    const entry = this.ladder.byUnit[index], live = !unit.root.classList.contains("fold-off") && entry.stops[STOPS[this.stopAt(index)]] === entry.stops.full;
    let root = unit.root;
    if (!live) {
      root = unit.root.cloneNode(true) as HTMLElement;
      for (const extra of root.querySelectorAll(".fold-rail, .fold-rider, .fold-peek")) extra.remove();
      root.classList.remove("fold-off");
      root.classList.add("fold-near", "fold-measure");
      if (unit.kind === "raw") root.querySelectorAll<HTMLElement>(":scope > .fold-variant").forEach((variant, at) => { variant.hidden = at > 0; });
      else {
        for (const hidden of root.querySelectorAll(".fold-off")) hidden.classList.remove("fold-off");
        for (const added of root.querySelectorAll(".fold-added")) added.classList.add("fold-off");
      }
      root.style.width = `${width}px`;
      this.container.append(root);
    }
    const box = resolveBox(this.block(unit, root), mark.ink!.part.box)?.getBoundingClientRect();
    if (!live) root.remove();
    const size = [box?.width ?? 0, box?.height ?? 0] as const;
    this.sizes.set(key, size);
    return size;
  }

  private path(unit: FoldUnitView, index: number, mark: FoldMark) {
    const ink = mark.ink!, [width, height] = this.size(unit, index, mark);
    const points = ink.part.points.map(([x, y, pressure]): InkPoint => [x * width, y * height, pressure]);
    const element = document.createElementNS(SVG, "path");
    element.setAttribute("d", inkPath(points, { tool: ink.tool, size: ink.size }));
    element.setAttribute("fill", ink.color);
    element.setAttribute("fill-opacity", ink.tool === "highlighter" ? "0.42" : "1");
    element.dataset.inkColour = ink.color; element.dataset.inkTool = ink.tool;
    return { element, points, width, height };
  }

  private drawInPlace(host: HTMLElement, unit: FoldUnitView, mark: FoldMark) {
    const index = this.engine.units.indexOf(unit), { element, width, height } = this.path(unit, index, mark);
    const box = resolveBox(this.block(unit, unit.root), mark.ink!.part.box)?.getBoundingClientRect(), frame = unit.root.getBoundingClientRect();
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width)); svg.setAttribute("height", String(height));
    svg.setAttribute("aria-hidden", "true");
    svg.append(element);
    Object.assign(host.style, { left: `${(box?.left ?? frame.left) - frame.left}px`, top: `${(box?.top ?? frame.top) - frame.top}px`, width: `${width}px`, height: `${height}px` });
    host.replaceChildren(svg);
  }

  // The ink compressed to a glyph: the same path, framed by its own bounds.
  private glyph(unit: FoldUnitView, index: number, mark: FoldMark) {
    const { element, points } = this.path(unit, index, mark), pad = mark.ink!.size;
    const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
    const left = Math.min(...xs) - pad, top = Math.min(...ys) - pad;
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", `${left} ${top} ${Math.max(...xs) + pad - left} ${Math.max(...ys) + pad - top}`);
    svg.setAttribute("aria-hidden", "true"); svg.setAttribute("preserveAspectRatio", "none");
    svg.dataset.marks = mark.id;
    svg.append(element);
    return svg;
  }
}

function span(className: string, text: string) {
  const element = document.createElement("span");
  element.className = className; element.textContent = text;
  element.setAttribute("aria-hidden", "true");
  return element;
}

// Three cards stacked: the section's magnets as one deck.
function deckIcon() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("aria-hidden", "true");
  for (const [x, y] of [[5, 1], [3, 3], [1, 5]]) {
    const card = document.createElementNS(SVG, "rect");
    Object.entries({ x, y, width: 10, height: 10, rx: 2 }).forEach(([name, value]) => card.setAttribute(name, String(value)));
    svg.append(card);
  }
  return svg;
}
