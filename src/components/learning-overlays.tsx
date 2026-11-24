import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ReadingAnchor, StudyItem } from "../../shared/reading-store.ts";
import type { ReadingContext } from "../editor/MarkdownEditor";

export type StudyMark = Extract<StudyItem<ReadingAnchor>, { type: "mark" }>;
export interface StudyOverlay { line: number; tabs: ReactNode; tucks: ReactNode; marks: StudyMark[] }

function quoteRange(block: HTMLElement, { anchor, start }: StudyMark) {
  const quote = anchor.quote;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, { acceptNode: node =>
    node.parentElement?.closest('[aria-hidden="true"],.md-meta,.md-object-source') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const segments: { node: Text; start: number }[] = [];
  let rendered = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    segments.push({ node: node as Text, start: rendered.length });
    rendered += node.textContent;
  }
  let match = rendered.indexOf(quote);
  if (match < 0) return;
  if (rendered.indexOf(quote, match + quote.length) >= 0) {
    if (anchor.block.slice(start, start + quote.length) !== quote) return;
    for (let at = anchor.block.indexOf(quote); at < start; at = anchor.block.indexOf(quote, at + quote.length)) {
      match = rendered.indexOf(quote, match + quote.length);
      if (match < 0) return;
    }
  }
  const begin = segments.findLast(segment => segment.start <= match);
  const end = segments.findLast(segment => segment.start < match + quote.length);
  if (!begin || !end) return;
  const range = document.createRange();
  range.setStart(begin.node, match - begin.start);
  range.setEnd(end.node, match + quote.length - end.start);
  return range;
}

export function LearningOverlays({ root, nodes, groups }: { root: HTMLElement; nodes: ReadingContext["nodes"]; groups: StudyOverlay[] }) {
  const mount = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const layer = mount.current;
    if (!layer) return;
    const blocksByLine = new Map<number, string>();
    for (const node of nodes) if (!blocksByLine.has(node.line)) blocksByLine.set(node.line, node.id);
    const slots = Array.from(layer.children, (slot, index) => ({
      id: blocksByLine.get(groups[index].line),
      slot: slot as HTMLElement,
      tuck: slot.querySelector<HTMLElement>(".study-tucks")!,
      marks: groups[index].marks,
    }));
    const spaced = new Map<HTMLElement, string>();
    const highlightNames = ["amber", "blue", "rose", "green"] as const;
    let frame = 0;
    function update() {
      const origin = layer!.getBoundingClientRect();
      const children = new Map(Array.from(root.children, child => [(child as HTMLElement).dataset.cid, child as HTMLElement]));
      const placed = slots.map(group => ({ ...group, block: children.get(group.id) }));
      const added = new Set<HTMLElement>();
      for (const { block, tuck } of placed) if (block) {
        const space = tuck.childElementCount ? `${tuck.offsetHeight + 12}px` : "";
        if (!spaced.has(block)) spaced.set(block, block.style.paddingBottom);
        block.style.paddingBottom = space || spaced.get(block)!;
        added.add(block);
      }
      for (const [block, old] of spaced) if (!added.has(block)) { block.style.paddingBottom = old; spaced.delete(block); }
      const marks: Record<StudyMark["colour"], Range[]> = { amber: [], blue: [], rose: [], green: [] };
      for (const { block, slot, tuck, marks: groupMarks } of placed) {
        slot.hidden = !block;
        if (!block) continue;
        const box = block.getBoundingClientRect();
        slot.style.left = `${box.left - origin.left}px`;
        slot.style.top = `${box.top - origin.top}px`;
        slot.style.width = `${box.width}px`;
        tuck.style.top = `${box.height - (tuck.childElementCount ? tuck.offsetHeight : 0)}px`;
        for (const mark of groupMarks) {
          const range = quoteRange(block, mark);
          if (range) marks[mark.colour].push(range);
        }
      }
      if (globalThis.Highlight && CSS.highlights) for (const colour of highlightNames) {
        const key = `study-${colour}`;
        if (marks[colour].length) CSS.highlights.set(key, new Highlight(...marks[colour]));
        else CSS.highlights.delete(key);
      }
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    for (const { tuck } of slots) resize.observe(tuck);
    const mutation = new MutationObserver(schedule);
    mutation.observe(root, { subtree: true, childList: true, characterData: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect(); mutation.disconnect();
      for (const [block, old] of spaced) block.style.paddingBottom = old;
      if (CSS.highlights) for (const colour of highlightNames) CSS.highlights.delete(`study-${colour}`);
    };
  }, [root, nodes, groups]);
  return createPortal(<div className="study-overlay" ref={mount}>{groups.map(({ line, tabs, tucks }) =>
    <div className="study-placement" key={line}>
      <div className="study-tabs">{tabs}</div><div className="study-tucks">{tucks}</div>
    </div>)}</div>, root.parentElement!);
}
