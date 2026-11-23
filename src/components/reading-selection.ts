import type { ReadingBlock, ReadingTarget } from "../../shared/reading-store.ts";
import type { EditorHandle, ReadingContext } from "../editor/MarkdownEditor";

function paths(context: ReadingContext) {
  const stack: typeof context.headings[number][] = [];
  let cursor = 0;
  return (line: number) => {
    while (context.headings[cursor]?.line <= line) {
      const next = context.headings[cursor++];
      while (stack.length && stack.at(-1)!.level >= next.level) stack.pop();
      stack.push(next);
    }
    return stack.map(heading => heading.text);
  };
}

export function readingBlocks(context: ReadingContext): ReadingBlock[] {
  const headingPath = paths(context);
  if (!context.nodes.length) return context.text.split("\n").flatMap((block, index) => block.trim() ? [{ block, line: index + 1, headings: [] }] : []);
  const blocks: ReadingBlock[] = [];
  for (const node of context.nodes) if (node.source.trim()) blocks.push({ block: node.source, line: node.line, headings: headingPath(node.line) });
  return blocks;
}

export function readingSelection(editor: EditorHandle, surface: HTMLElement, image?: HTMLImageElement): { target: ReadingTarget; x: number; y: number } | undefined {
  const rich = surface.matches(".rich-document"), native = window.getSelection(), context = editor.readingContext();
  if (!context) return;
  let quote: string, rect: { bottom: number; left: number } | null;
  const { from, to, index, nodes, text } = context;
  if (image && rich && (native?.isCollapsed ?? true)) {
    const id = image.closest<HTMLElement>("[data-cid]")?.dataset.cid;
    const node = id && nodes.find(node => node.id === id);
    if (!node) return;
    const rect = image.getBoundingClientRect();
    return { target: { block: node.source, line: node.line, headings: paths(context)(node.line), quote: image.alt.trim() || node.source }, x: rect.left, y: rect.bottom };
  }
  if (rich) {
    if (!native || native.isCollapsed || !surface.contains(native.anchorNode) || !surface.contains(native.focusNode)) return;
    rect = native.getRangeAt(0).getBoundingClientRect();
    quote = native.toString().trim() || text.slice(from, to).trim();
  } else {
    if (from === to) return;
    rect = native && !native.isCollapsed && surface.contains(native.anchorNode) && surface.contains(native.focusNode)
      ? native.getRangeAt(0).getBoundingClientRect() : editor.view()?.coordsAtPos(to, -1) ?? null;
    quote = text.slice(from, to).trim();
  }
  if (!rect || !quote) return;
  const node = nodes[index + Number(!!nodes[index] && nodes[index].to < from)];
  const start = node ? 0 : text.lastIndexOf("\n", from - 1) + 1, end = node ? 0 : text.indexOf("\n", from);
  const line = node?.line ?? 1 + (text.slice(0, start).match(/\n/g)?.length ?? 0);
  const block = node?.source || text.slice(start, end < 0 ? undefined : end);
  if (!block.trim()) return;
  return { target: { block, line, headings: paths(context)(line), quote }, x: rect.left, y: rect.bottom };
}
