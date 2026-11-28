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

interface WordUnit { kind: "words"; unit: DocumentUnit; root: HTMLElement; present: number; stop: number; tokens: HTMLElement[]; bits: Uint8Array; blocks: HTMLElement[]; blockBits: Uint8Array }
interface RawUnit { kind: "raw"; unit: DocumentUnit; root: HTMLElement; present: number; stop: number; variants: HTMLElement[] }
export type FoldUnitView = WordUnit | RawUnit;
interface Move { element: HTMLElement; dx: number; dy: number }
interface Segment { from: number; to: number; moves: Move[]; fades: HTMLElement[]; offset: number }

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

export function buildUnits(container: HTMLElement, ladder: FoldDocumentLadder, documentId: string): FoldUnitView[] {
  const rendered = new Map<string, string>();
  const html = (markdown: string) => {
    let value = rendered.get(markdown);
    if (value === undefined) rendered.set(markdown, value = markdown ? renderMarkdown(markdown, documentId) : "");
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
  readonly wordMorph: boolean;
  stop = 0;
  value = 0;
  private overrides = new Map<FoldUnitView, number>();
  private segment: Segment | null = null;
  private observer: IntersectionObserver;

  constructor(private scroller: HTMLElement, private container: HTMLElement, ladder: FoldDocumentLadder, documentId: string) {
    this.units = buildUnits(container, ladder, documentId);
    this.wordMorph = this.units.length <= WORD_MORPH_LIMIT;
    // Two screens either side are near: they lay out fully, so motion there is never clipped.
    this.observer = new IntersectionObserver(entries => { for (const entry of entries) entry.target.classList.toggle("fold-near", entry.isIntersecting); }, { root: scroller, rootMargin: "200% 0px" });
    for (const unit of this.units) this.observer.observe(unit.root);
  }

  stopOf(unit: FoldUnitView) { return this.overrides.get(unit) ?? this.stop; }

  // The visible change; its measure is what the 50 ms commit budget holds.
  private commit(stop: number, units = this.units) {
    const start = performance.now();
    for (const unit of units) applyStop(unit, units === this.units ? stop : this.stopOf(unit));
    void this.scroller.scrollHeight;
    performance.measure("omarkie:fold-commit", { start, end: performance.now() });
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
      if (unit.kind === "words" && this.wordMorph) for (const token of unit.tokens) { if (!token.classList.contains("fold-off")) elements.push(token); }
      else if (!unit.root.classList.contains("fold-off")) elements.push(unit.root);
    }
    return elements;
  }

  private measure(elements: HTMLElement[]) {
    return new Map(elements.map(element => { const rect = element.getBoundingClientRect(); return [element, [rect.left, rect.top] as const]; }));
  }

  private glide(before: Map<HTMLElement, readonly [number, number]>, after: HTMLElement[]) {
    if (reducedMotion()) { this.container.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: FADE_MS }); return; }
    for (const element of after) {
      const was = before.get(element);
      if (!was) { element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: GLIDE_MS, easing: "ease-out" }); continue; }
      const rect = element.getBoundingClientRect(), dx = was[0] - rect.left, dy = was[1] - rect.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: GLIDE_MS, easing: "ease-out" });
    }
  }

  // Open straight at a stop, no motion.
  jump(stop: number) {
    this.endSegment();
    this.overrides.clear(); this.stop = stop; this.value = stop;
    this.commit(stop);
  }

  // Change the whole page (or one unit with an override) and glide what survives from where it was.
  switchTo(stop: number, only?: FoldUnitView) {
    this.endSegment();
    if (only) { if (this.stopOf(only) === stop) return; }
    else if (stop === this.stop && !this.overrides.size) return;
    const near = only ? [only] : this.near(), before = this.measure(this.pieces(near));
    const next = (unit: FoldUnitView) => only ? (unit === only ? stop : this.stopOf(unit)) : stop;
    const anchor = this.anchor(only ? this.near() : near, unit => this.stopOf(unit), next), anchorTop = anchor?.root.getBoundingClientRect().top;
    if (only) { this.overrides.set(only, stop); this.commit(stop, [only]); }
    else { this.overrides.clear(); this.stop = stop; this.value = stop; this.commit(stop); }
    if (anchor && anchorTop !== undefined && anchor !== only) this.scroller.scrollTop += anchor.root.getBoundingClientRect().top - anchorTop;
    this.glide(before, this.pieces(near));
  }

  // A continuous slider value: survivors sit part way between the two stops, dropped words fade.
  scrub(value: number) {
    const start = performance.now(), { from, to, fraction } = scrubSegment(value, STOPS.length);
    this.value = value;
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
    if (!this.segment) { this.switchTo(target); return target; }
    const near = this.near(), before = this.measure(this.pieces(near));
    const anchor = this.anchor(near, () => this.stop, () => target), anchorTop = anchor?.root.getBoundingClientRect().top;
    this.endSegment();
    this.stop = target; this.value = target;
    this.commit(target);
    if (anchor && anchorTop !== undefined) this.scroller.scrollTop += anchor.root.getBoundingClientRect().top - anchorTop;
    this.glide(before, this.pieces(near));
    return target;
  }

  private keepAnchor(stop: number) {
    const anchor = this.anchor(this.near(), unit => this.stopOf(unit), () => stop), top = anchor?.root.getBoundingClientRect().top;
    this.overrides.clear(); this.stop = stop;
    this.commit(stop);
    if (anchor && top !== undefined) this.scroller.scrollTop += anchor.root.getBoundingClientRect().top - top;
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

  scrollToLine(line: number) {
    let target: FoldUnitView | undefined;
    for (const unit of this.units) { if (unit.unit.line > line) break; if (!unit.root.classList.contains("fold-off")) target = unit; }
    if (target) this.scroller.scrollTop += target.root.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top;
  }

  dispose() { this.endSegment(); this.observer.disconnect(); }
}
