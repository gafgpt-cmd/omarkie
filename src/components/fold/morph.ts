import { morphPlan, scrubSegment, nearestStop, WORD_MORPH_LIMIT } from "../../../shared/fold-morph.mjs";
import type { DocumentUnit, FoldDocumentLadder } from "../../../shared/fold-units.mjs";
import { renderMarkdown } from "../../editor/markdown";
import { STOPS } from "./stops";

export const GLIDE_MS = 180;
const FADE_MS = 120;
// Elements that are one token: their text is not the author's running prose, or not text at all.
const ATOM = "img,video,iframe,code,.mathjax-node";
const BLOCK = "p,li,h1,h2,h3,h4,h5,h6,blockquote,tr,dt,dd,figure,pre,aside,details";
const ALL = (1 << STOPS.length) - 1;

export interface WordUnit { kind: "words"; unit: DocumentUnit; root: HTMLElement; present: number; stop: number; tokens: HTMLElement[]; bits: Uint8Array; blocks: HTMLElement[]; blockBits: Uint8Array }
interface RawUnit { kind: "raw"; unit: DocumentUnit; root: HTMLElement; present: number; stop: number; variants: HTMLElement[] }
export type FoldUnitView = WordUnit | RawUnit;
interface Move { element: HTMLElement; dx: number; dy: number }
type Point = readonly [number, number];
// Mark riders: chips and ink that sit on a unit's margins. `capture` reads where marks are before a commit,
// `paint` lays the riders out for the committed stops and says which new rider glides out of which point.
export interface Riders { capture(): void; paint(): Map<HTMLElement, Point> }
interface Segment { from: number; to: number; moves: Move[]; fades: HTMLElement[]; offset: number }
// Corte geometry for one near unit: dropped tokens by centre x, dropped raw blocks by left edge (scroller-relative).
interface CutGeometry { tokens: HTMLElement[]; centres: Float64Array; gone: Uint8Array; blocks: HTMLElement[]; lefts: Float64Array }

const atomKey = (element: Element) => element.matches(".mathjax-node") ? `math:${(element as HTMLElement).dataset.tex ?? ""}`
  : element instanceof HTMLImageElement ? `img:${element.getAttribute("src") ?? ""}` : `${element.localName}:${element.textContent ?? ""}`;

// Author words in document order. With wrap, each word becomes its own span so it can move and hide.
function scan(root: Node, wrap: boolean) {
  const keys: string[] = [], nodes: HTMLElement[] = [], atoms = new Map<number, Element>();
  const visit = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.nodeValue ?? "";
        if (!/\S/.test(text)) continue;
        const fragment = wrap ? document.createDocumentFragment() : null;
        for (const part of text.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { fragment?.append(part); continue; }
          keys.push(part);
          if (!fragment) continue;
          const span = document.createElement("span");
          span.className = "fold-w"; span.textContent = part;
          fragment.append(span); nodes.push(span);
        }
        if (fragment) child.replaceWith(fragment);
      } else if (child instanceof Element) {
        if (!child.matches(ATOM)) { visit(child); continue; }
        if (!wrap) atoms.set(keys.length, child);
        keys.push(atomKey(child));
        if (wrap) { child.classList.add("fold-w", "fold-atom"); nodes.push(child as HTMLElement); }
      }
    }
  };
  visit(root);
  return { keys, nodes, atoms };
}

function fragment(html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

// `rendered` collects this build's Markdown → HTML; `reuse` is the last build's, so a pin change re-renders only what it changed.
export function buildUnits(container: HTMLElement, ladder: FoldDocumentLadder, documentId: string, rendered: Map<string, string>, reuse?: ReadonlyMap<string, string>): FoldUnitView[] {
  const html = (markdown: string) => {
    let value = rendered.get(markdown);
    if (value === undefined) rendered.set(markdown, value = reuse?.get(markdown) ?? (markdown ? renderMarkdown(markdown, documentId) : ""));
    return value;
  };
  const units: FoldUnitView[] = [];
  for (const { unit, stops } of ladder.byUnit) {
    const texts = STOPS.map(stop => stops[stop] ?? "");
    const root = document.createElement("div");
    root.className = "fold-unit"; root.tabIndex = -1;
    Object.assign(root.dataset, { unit: unit.elementId, line: String(unit.line), kind: unit.kind });
    const present = texts.reduce((mask, text, index) => text ? mask | 1 << index : mask, 0);
    if (unit.raw) {
      const byText = new Map<string, HTMLElement>();
      const variants = texts.map(text => {
        let variant = byText.get(text);
        if (!variant) {
          variant = document.createElement("div");
          variant.className = "fold-variant"; variant.innerHTML = html(text); variant.hidden = byText.size > 0;
          byText.set(text, variant); root.append(variant);
        }
        return variant;
      });
      units.push({ kind: "raw", unit, root, present, stop: 0, variants });
    } else {
      root.innerHTML = html(texts[0]);
      const { keys, nodes } = scan(root, true);
      const tokens = [...nodes], bits = nodes.map(() => 1), index = new Map<HTMLElement, number>(nodes.map((node, i) => [node, i]));
      const added = new Map<string, HTMLElement>();
      for (let stop = 1; stop < STOPS.length; stop++) {
        if (texts[stop] === texts[0]) { for (let i = 0; i < nodes.length; i++) bits[i] |= 1 << stop; continue; }
        const target = texts[stop] ? scan(fragment(html(texts[stop])), false) : { keys: [] as string[], atoms: new Map<number, Element>() };
        const plan = morphPlan(keys, target.keys);
        plan.kept.forEach((kept, i) => { if (kept) bits[i] |= 1 << stop; });
        let position = 0;
        const tails = new Map<number, Element>();
        for (const { after, token } of plan.added) {
          const id = `${after}\u0000${token}`;
          let span = added.get(id);
          if (!span) {
            const atom = target.atoms.get(target.keys.indexOf(token, position));
            span = (atom ? atom.cloneNode(true) : document.createElement("span")) as HTMLElement;
            if (!atom) span.textContent = token;
            span.classList.add("fold-w", "fold-added", "fold-off");
            if (after >= 0) (tails.get(after) ?? nodes[after]).after(" ", span);
            else if (nodes[0]) nodes[0].before(span, " ");
            else (root.querySelector(BLOCK) ?? root).append(span);
            added.set(id, span); index.set(span, tokens.length); tokens.push(span); bits.push(0);
          }
          bits[index.get(span)!] |= 1 << stop;
          if (after >= 0) tails.set(after, span);
          position = Math.max(position, target.keys.indexOf(token, position) + 1);
        }
      }
      const blocks = [...root.querySelectorAll<HTMLElement>(BLOCK)];
      const blockBits = blocks.map(block => {
        let mask = 0;
        for (const token of block.querySelectorAll<HTMLElement>(".fold-w")) mask |= bits[index.get(token) ?? -1] ?? 0;
        return mask || ALL;
      });
      units.push({ kind: "words", unit, root, present: tokens.length ? present : present || ALL, stop: 0, tokens, bits: Uint8Array.from(bits), blocks, blockBits: Uint8Array.from(blockBits) });
    }
    container.append(root);
  }
  return units;
}

const shows = (mask: number, stop: number) => (mask >> stop & 1) === 1;

export function applyStop(unit: FoldUnitView, stop: number) {
  const from = unit.stop;
  if (from === stop) return;
  unit.stop = stop;
  unit.root.classList.toggle("fold-off", !shows(unit.present, stop));
  if (unit.kind === "raw") {
    if (unit.variants[from] !== unit.variants[stop]) { unit.variants[from].hidden = true; unit.variants[stop].hidden = false; }
    return;
  }
  const { tokens, bits, blocks, blockBits } = unit;
  for (let i = 0; i < tokens.length; i++) if (shows(bits[i], from) !== shows(bits[i], stop)) tokens[i].classList.toggle("fold-off", !shows(bits[i], stop));
  for (let i = 0; i < blocks.length; i++) if (shows(blockBits[i], from) !== shows(blockBits[i], stop)) blocks[i].classList.toggle("fold-off", !shows(blockBits[i], stop));
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Fold motion: discrete stop switches glide survivors (FLIP), a scrub interpolates between two stops.
export class FoldEngine {
  readonly units: FoldUnitView[];
  // Markdown → HTML of this build; the next build of the same note reuses it.
  readonly rendered = new Map<string, string>();
  readonly wordMorph: boolean;
  stop = 0;
  value = 0;
  cutting = false;
  // The open evidence peek; it glides with its unit.
  peek: HTMLElement | null = null;
  riders: Riders | null = null;
  private overrides = new Map<FoldUnitView, number>();
  private segment: Segment | null = null;
  private observer: IntersectionObserver;
  private byRoot = new Map<Element, FoldUnitView>();
  private nearUnits = new Set<FoldUnitView>();
  private sources = new Map<FoldUnitView, string>();
  private cutX = 0;
  private cuts = new Map<FoldUnitView, CutGeometry>();

  constructor(private scroller: HTMLElement, private container: HTMLElement, private ladder: FoldDocumentLadder, private documentId: string, reuse?: ReadonlyMap<string, string>) {
    this.units = buildUnits(container, ladder, documentId, this.rendered, reuse);
    this.wordMorph = this.units.length <= WORD_MORPH_LIMIT;
    for (const unit of this.units) this.byRoot.set(unit.root, unit);
    // Two screens either side are near: they lay out fully, so motion there is never clipped.
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        entry.target.classList.toggle("fold-near", entry.isIntersecting);
        const unit = this.byRoot.get(entry.target);
        if (!unit) continue;
        if (!entry.isIntersecting) { this.nearUnits.delete(unit); continue; }
        this.nearUnits.add(unit);
        if (this.cutting) this.cutUnit(unit);
      }
    }, { root: scroller, rootMargin: "200% 0px" });
    for (const unit of this.units) this.observer.observe(unit.root);
  }

  stopOf(unit: FoldUnitView) { return this.overrides.get(unit) ?? this.stop; }

  unitOf(element: Element | null) {
    const root = element?.closest(".fold-unit");
    return root ? this.byRoot.get(root) : undefined;
  }

  // The unit's Full author text as rendered HTML: the evidence behind every stop.
  source(unit: FoldUnitView) {
    let html = this.sources.get(unit);
    if (html === undefined) {
      const markdown = this.ladder.byUnit[this.units.indexOf(unit)]?.stops.full ?? "";
      this.sources.set(unit, html = markdown ? renderMarkdown(markdown, this.documentId) : "");
    }
    return html;
  }

  // The visible change; its measure is what the 50 ms commit budget holds. Riders follow the words they ride.
  private commit(stop: number, units = this.units) {
    this.riders?.capture();
    const start = performance.now();
    for (const unit of units) applyStop(unit, units === this.units ? stop : this.stopOf(unit));
    void this.scroller.scrollHeight;
    performance.measure("omarkie:fold-commit", { start, end: performance.now() });
    return this.riders?.paint();
  }

  private near() {
    const box = this.scroller.getBoundingClientRect(), height = box.height;
    return this.units.filter(unit => {
      const rect = unit.root.getBoundingClientRect();
      return rect.height > 0 && rect.bottom >= box.top - height / 4 && rect.top <= box.bottom + height / 4;
    });
  }

  // The first unit at the viewport top that both layouts show; its top stays put across a commit.
  private anchor(units: FoldUnitView[], from: (unit: FoldUnitView) => number, to: (unit: FoldUnitView) => number) {
    const top = this.scroller.getBoundingClientRect().top;
    return units.find(unit => shows(unit.present, from(unit)) && shows(unit.present, to(unit)) && unit.root.getBoundingClientRect().bottom > top);
  }

  private pieces(units: FoldUnitView[]) {
    const elements: HTMLElement[] = [];
    for (const unit of units) {
      if (unit.root.classList.contains("fold-off")) continue;
      if (unit.kind === "words" && this.wordMorph) {
        for (const token of unit.tokens) { if (!token.classList.contains("fold-off")) elements.push(token); }
        if (this.peek && unit.root.contains(this.peek)) elements.push(this.peek);
        elements.push(...unit.root.querySelectorAll<HTMLElement>(".fold-rider"));
      } else elements.push(unit.root);
    }
    return elements;
  }

  private measure(elements: HTMLElement[]) {
    return new Map(elements.map(element => { const rect = element.getBoundingClientRect(); return [element, [rect.left, rect.top] as const]; }));
  }

  // A new element fades in, or glides out of its origin (a chip leaving the words it stands for).
  private glide(before: Map<HTMLElement, Point>, after: HTMLElement[], origins?: Map<HTMLElement, Point>) {
    if (reducedMotion()) { this.container.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: FADE_MS }); return; }
    for (const element of after) {
      const was = before.get(element) ?? origins?.get(element);
      if (!was) { element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: GLIDE_MS, easing: "ease-out" }); continue; }
      const rect = element.getBoundingClientRect(), dx = was[0] - rect.left, dy = was[1] - rect.top;
      const fade = !before.has(element);
      if (fade || Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) element.animate([{ transform: `translate(${dx}px, ${dy}px)`, ...(fade ? { opacity: 0 } : {}) },
        { transform: "none", ...(fade ? { opacity: 1 } : {}) }], { duration: GLIDE_MS, easing: "ease-out" });
    }
  }

  // Open straight at a stop, no motion.
  jump(stop: number) {
    this.endSegment();
    this.overrides.clear(); this.stop = stop; this.value = stop;
    this.commit(stop);
  }

  // Change the whole page (or one unit with an override) and glide what survives from where it was; `glide` false
  // still keeps the reading anchor, for a page nobody sees (Topic covers it).
  switchTo(stop: number, only?: FoldUnitView, glide = true) {
    this.endSegment();
    if (this.cutting) { if (!only) this.recut(stop); return; }
    if (only) { if (this.stopOf(only) === stop) return; }
    else if (stop === this.stop && !this.overrides.size) return;
    const near = only ? [only] : this.near(), before = glide ? this.measure(this.pieces(near)) : null;
    const next = (unit: FoldUnitView) => only ? (unit === only ? stop : this.stopOf(unit)) : stop;
    const anchor = this.anchor(only ? this.near() : near, unit => this.stopOf(unit), next), anchorTop = anchor?.root.getBoundingClientRect().top;
    let origins;
    if (only) { this.overrides.set(only, stop); origins = this.commit(stop, [only]); }
    else { this.overrides.clear(); this.stop = stop; this.value = stop; origins = this.commit(stop); }
    if (anchor && anchorTop !== undefined && anchor !== only) this.scroller.scrollTop += anchor.root.getBoundingClientRect().top - anchorTop;
    if (before) this.glide(before, this.pieces(near), origins);
  }

  // A continuous slider value: survivors sit part way between the two stops, dropped words fade.
  scrub(value: number) {
    const start = performance.now(), { from, to, fraction } = scrubSegment(value, STOPS.length);
    this.value = value;
    if (this.cutting) return;
    if (reducedMotion()) { const stop = nearestStop(value, STOPS.length); if (stop !== this.stop) this.switchTo(stop); return; }
    if (this.segment?.from !== from) {
      this.endSegment();
      if (this.stop !== from || this.overrides.size) this.keepAnchor(from);
      this.segment = this.prepare(from, to);
    }
    const { moves, fades } = this.segment!;
    for (const { element, dx, dy } of moves) element.style.transform = `translate(${dx * fraction}px, ${dy * fraction}px)`;
    for (const element of fades) element.style.opacity = String(1 - fraction);
    // Each scrub frame's own cost, read by the frame-budget test.
    this.container.dataset.scrubMs = (performance.now() - start).toFixed(2);
  }

  // Let go of a scrub: settle on the nearest stop, gliding from where the words are now.
  release() {
    const target = nearestStop(this.value, STOPS.length);
    if (!this.segment || this.cutting) { this.switchTo(target); return target; }
    const near = this.near(), before = this.measure(this.pieces(near));
    const anchor = this.anchor(near, () => this.stop, () => target), anchorTop = anchor?.root.getBoundingClientRect().top;
    this.endSegment();
    this.stop = target; this.value = target;
    const origins = this.commit(target);
    if (anchor && anchorTop !== undefined) this.scroller.scrollTop += anchor.root.getBoundingClientRect().top - anchorTop;
    this.glide(before, this.pieces(near), origins);
    return target;
  }

  private keepAnchor(stop: number) {
    const anchor = this.anchor(this.near(), unit => this.stopOf(unit), () => stop), top = anchor?.root.getBoundingClientRect().top;
    this.overrides.clear(); this.stop = stop;
    this.commit(stop);
    if (anchor && top !== undefined) this.scroller.scrollTop += anchor.root.getBoundingClientRect().top - top;
  }

  // Land on a stop with one unit's top at a viewport y: a Topic card opens its section where the card was.
  reveal(stop: number, elementId: string, top: number) {
    this.jump(stop);
    const from = this.units.findIndex(unit => unit.unit.elementId === elementId);
    const target = from < 0 ? undefined : this.units.slice(from).find(unit => !unit.root.classList.contains("fold-off"));
    if (!target) return null;
    this.scroller.scrollTop += target.root.getBoundingClientRect().top - top;
    this.container.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "ease-out" });
    return target.root;
  }

  private prepare(from: number, to: number): Segment {
    const near = this.near(), anchor = this.anchor(near, () => from, () => to);
    const pieces = this.pieces(near), before = this.measure(pieces), anchorTop = anchor?.root.getBoundingClientRect().top ?? 0;
    for (const unit of near) applyStop(unit, to);
    const offset = anchor ? anchor.root.getBoundingClientRect().top - anchorTop : 0;
    const moves: Move[] = [], fades: HTMLElement[] = [];
    for (const element of pieces) {
      const was = before.get(element)!;
      if (element.classList.contains("fold-off") || !element.getClientRects().length) { fades.push(element); continue; }
      const rect = element.getBoundingClientRect(), dx = rect.left - was[0], dy = rect.top - offset - was[1];
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) moves.push({ element, dx, dy });
    }
    for (const unit of near) applyStop(unit, from);
    return { from, to, moves, fades, offset };
  }

  private endSegment() {
    if (!this.segment) return;
    for (const { element } of this.segment.moves) element.style.transform = "";
    for (const element of this.segment.fades) element.style.opacity = "";
    this.segment = null;
  }

  topLine() {
    const top = this.scroller.getBoundingClientRect().top;
    return (this.units.find(unit => unit.root.getBoundingClientRect().bottom > top && !unit.root.classList.contains("fold-off")) ?? this.units[0])?.unit.line ?? 1;
  }

  // The last shown unit that starts at or before a source line.
  unitAtLine(line: number) {
    let target: FoldUnitView | undefined;
    for (const unit of this.units) { if (unit.unit.line > line) break; if (!unit.root.classList.contains("fold-off")) target = unit; }
    return target;
  }

  // Put that line's unit `offset` px below the viewport top. Units never painted sit at their placeholder
  // height (content-visibility), so everything above the target lays out once first; the observer trims it after.
  scrollToLine(line: number, offset = 0) {
    const target = this.unitAtLine(line);
    if (!target) return target;
    for (const unit of this.units) { unit.root.classList.add("fold-near"); if (unit === target) break; }
    this.scroller.scrollTop += target.root.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - offset;
    return target;
  }

  // A layout change outside the stops (a peek opening): what moves glides, the change itself fades in.
  reflow(change: () => void) {
    this.endSegment();
    const near = this.near(), before = this.measure(this.pieces(near));
    change();
    this.glide(before, this.pieces(this.near()));
  }

  // Corte: the page lays out at Full; words the current stop drops are marked and either side of the divider shows or hides them.
  setCut(on: boolean) {
    if (on === this.cutting) return;
    this.endSegment();
    const near = this.near(), before = this.measure(this.pieces(near));
    const anchor = this.anchor(near, unit => on ? this.stopOf(unit) : 0, unit => on ? 0 : this.stopOf(unit)), anchorTop = anchor?.root.getBoundingClientRect().top;
    this.cutting = on;
    this.container.classList.toggle("fold-cutting", on);
    this.cuts.clear();
    if (on) for (const unit of this.units) { applyStop(unit, 0); markCut(unit, this.stopOf(unit)); }
    else for (const unit of this.units) { clearCut(unit); applyStop(unit, this.stopOf(unit)); }
    this.riders?.paint();
    void this.scroller.scrollHeight;
    if (anchor && anchorTop !== undefined) this.scroller.scrollTop += anchor.root.getBoundingClientRect().top - anchorTop;
    if (on) for (const unit of this.nearUnits) this.cutUnit(unit);
    this.glide(before, this.pieces(near));
  }

  // Divider position as a fraction of the scroller width.
  cutAt(fraction: number) {
    this.cutX = fraction * this.scroller.getBoundingClientRect().width;
    if (this.cutting) for (const unit of this.nearUnits) this.cutUnit(unit);
  }

  // Width changed: words rewrapped, so cached geometry is stale.
  remeasureCut() {
    this.cuts.clear();
    if (this.cutting) for (const unit of this.nearUnits) this.cutUnit(unit);
  }

  private recut(stop: number) {
    this.overrides.clear(); this.stop = stop; this.value = stop;
    const start = performance.now();
    for (const unit of this.units) { clearCut(unit); markCut(unit, stop); }
    this.cuts.clear();
    for (const unit of this.nearUnits) this.cutUnit(unit);
    performance.measure("omarkie:fold-commit", { start, end: performance.now() });
  }

  private cutUnit(unit: FoldUnitView) {
    let geometry = this.cuts.get(unit);
    if (!geometry) {
      const left = this.scroller.getBoundingClientRect().left;
      const tokens = unit.kind === "words" ? unit.tokens.filter(token => token.classList.contains("fold-cut")) : [];
      const blocks = [...unit.root.querySelectorAll<HTMLElement>(".fold-cut-block")];
      geometry = {
        tokens, blocks, gone: new Uint8Array(tokens.length).fill(2),
        centres: Float64Array.from(tokens, token => { const rect = token.getBoundingClientRect(); return rect.left + rect.width / 2 - left; }),
        lefts: Float64Array.from(blocks, block => block.getBoundingClientRect().left - left),
      };
      this.cuts.set(unit, geometry);
    }
    const { tokens, centres, gone, blocks, lefts } = geometry, x = this.cutX;
    for (let i = 0; i < tokens.length; i++) {
      const hidden = centres[i] > x ? 1 : 0;
      if (gone[i] !== hidden) { gone[i] = hidden; tokens[i].classList.toggle("fold-cut-gone", hidden === 1); }
    }
    for (let i = 0; i < blocks.length; i++) blocks[i].style.setProperty("--cut-local", `${x - lefts[i]}px`);
  }

  dispose() { this.endSegment(); this.observer.disconnect(); }
}

// Mark what `stop` drops from a unit laid out at Full. Table rows go one by one; any other changed raw block goes whole.
function markCut(unit: FoldUnitView, stop: number) {
  if (unit.kind === "words") {
    for (let i = 0; i < unit.tokens.length; i++) if (shows(unit.bits[i], 0) && !shows(unit.bits[i], stop)) unit.tokens[i].classList.add("fold-cut");
    return;
  }
  const full = unit.variants[0], kept = unit.variants[stop];
  if (kept === full) return;
  const rows = [...full.querySelectorAll("tr")];
  if (rows.length && shows(unit.present, stop)) {
    const keep = new Set([...kept.querySelectorAll("tr")].map(row => row.textContent));
    for (const row of rows) if (!keep.has(row.textContent)) for (const cell of row.cells) cell.classList.add("fold-cut-block");
  } else full.classList.add("fold-cut-block");
}

function clearCut(unit: FoldUnitView) {
  if (unit.kind === "words") { for (const token of unit.tokens) token.classList.remove("fold-cut", "fold-cut-gone"); return; }
  for (const block of unit.root.querySelectorAll<HTMLElement>(".fold-cut-block")) { block.classList.remove("fold-cut-block"); block.style.removeProperty("--cut-local"); }
}
