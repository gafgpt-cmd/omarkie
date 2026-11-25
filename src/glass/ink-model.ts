import {
  captureAnchor, normalizeText, resolveAnchor, type GlassAnchor, type GlassBlock,
} from "./anchor-map";
import { anchorFrom } from "./glass-state";
import type { GlassMagnet } from "./glass-model";
import {
  boxHit, inkLimits, splitRuns, toBoxPoints, validInkBox, validInkColor, validInkPoints, validInkSize, validInkTool,
  type InkBoxRef, type InkPoint, type InkTool,
} from "../../shared/ink-core.mjs";

// Ink is text-relative: every part of a stroke is anchored to one element box (paragraph,
// list item, table cell, formula, code block) and its points are fractions of that box.
export interface InkSample { x: number; y: number; pressure: number }
export interface InkPart { box: InkBoxRef; anchor: GlassAnchor; points: InkPoint[] }
export interface InkStroke { id: string; tool: InkTool; color: string; size: number; parts: InkPart[] }
export interface InkBox { key: string; ref: InkBoxRef; block: GlassBlock; element: HTMLElement }

export interface InkPlacement {
  stroke: InkStroke;
  part: number;
  points: InkPoint[];
  rect: { left: number; top: number; width: number; height: number };
  x: number;
  y: number;
  width: number;
  height: number;
}

const boxText = (element: HTMLElement) => normalizeText(element.textContent ?? "").slice(0, 512);

export function newInkId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pointOf(value: unknown): InkPoint | undefined {
  return validInkPoints([value]) ? value as InkPoint : undefined;
}

export function inkStrokeFromMagnet(magnet: GlassMagnet): InkStroke | undefined {
  const fields = magnet.fields ?? {};
  if ((fields.kind ?? magnet.kind) !== "ink") return;
  if (!validInkTool(fields.tool) || !validInkColor(fields.tool, fields.color) || !validInkSize(fields.tool, fields.size)) return;
  if (!Array.isArray(fields.parts) || !fields.parts.length || fields.parts.length > inkLimits.parts) return;
  const parts: InkPart[] = [];
  let total = 0;
  for (const raw of fields.parts) {
    if (!raw || typeof raw !== "object") return;
    const { box, anchor, points } = raw as Record<string, unknown>;
    const stored = anchorFrom(anchor);
    if (!validInkBox(box) || !stored || !Array.isArray(points)) return;
    const parsed = points.map(pointOf);
    if (parsed.some(point => !point) || !parsed.length) return;
    total += parsed.length;
    if (total > inkLimits.points) return;
    parts.push({ box, anchor: stored, points: parsed as InkPoint[] });
  }
  return { id: magnet.id, tool: fields.tool, color: fields.color, size: fields.size, parts };
}

export function inkFields(stroke: InkStroke): Record<string, unknown> {
  return { kind: "ink", layer: "ink", tool: stroke.tool, color: stroke.color, size: stroke.size, parts: stroke.parts };
}

// Every box ink may be anchored to: blocks, then the list items and table cells inside them.
export function liveBoxes(blocks: readonly GlassBlock[]): InkBox[] {
  const boxes: InkBox[] = [];
  for (const block of blocks) {
    const element = block.element;
    if (!element) continue;
    const kind = element.dataset.kind ?? block.kind ?? "";
    if (/list/.test(kind)) {
      const items = Array.from(element.querySelectorAll("li"));
      items.forEach((item, index) => boxes.push({ key: `${block.line}:item:${index}`, ref: { kind: "item", index, text: boxText(item) }, block, element: item }));
      if (!items.length) boxes.push({ key: `${block.line}:block`, ref: { kind: "block" }, block, element });
      continue;
    }
    if (/table/.test(kind)) {
      const cells = Array.from(element.querySelectorAll("td, th"));
      cells.forEach((cell, index) => {
        const row = (cell.closest("tr") as HTMLTableRowElement | null)?.rowIndex ?? Math.floor(index / 4);
        const column = (cell as HTMLTableCellElement).cellIndex ?? index % 4;
        boxes.push({ key: `${block.line}:cell:${row}:${column}`, ref: { kind: "cell", row, col: column, text: boxText(cell as HTMLElement) }, block, element: cell as HTMLElement });
      });
      if (!cells.length) boxes.push({ key: `${block.line}:block`, ref: { kind: "block" }, block, element });
      continue;
    }
    boxes.push({ key: `${block.line}:block`, ref: { kind: "block" }, block, element });
  }
  return boxes;
}

// Inside a box wins; over the margins the nearest box does, so a doodle in the desk still
// travels with the page.
export function boxAt(boxes: readonly InkBox[], point: { x: number; y: number }): InkBox | undefined {
  const plain = boxes.map(box => ({ box, ...box.element.getBoundingClientRect().toJSON() }));
  return boxHit(plain, point)?.box;
}

// One gesture becomes as many parts as boxes it crossed; the crossing sample is shared so
// the halves meet on screen and both follow their own element.
export function splitStroke(samples: readonly InkSample[], boxes: readonly InkBox[], blocks: readonly GlassBlock[]): InkPart[] {
  if (!samples.length || !boxes.length) return [];
  const byKey = new Map(boxes.map(box => [box.key, box]));
  const runs = splitRuns(samples, sample => boxAt(boxes, sample)?.key ?? "").slice(0, inkLimits.parts);
  const parts: InkPart[] = [];
  for (const run of runs) {
    const box = byKey.get(run.key) ?? boxAt(boxes, run.points[0]);
    if (!box) continue;
    const rect = box.element.getBoundingClientRect();
    parts.push({ box: box.ref, anchor: captureAnchor(box.block, blocks),
      points: toBoxPoints(run.points.map(sample => [sample.x, sample.y, sample.pressure]), rect) });
  }
  return parts;
}

export function resolveBox(block: HTMLElement, ref: InkBoxRef): HTMLElement | undefined {
  if (ref.kind === "block") return block;
  if (ref.kind === "item") {
    const items = Array.from(block.querySelectorAll<HTMLElement>("li"));
    const byText = ref.text ? items.find(item => boxText(item) === ref.text) : undefined;
    return byText ?? items[ref.index] ?? block;
  }
  const cells = Array.from(block.querySelectorAll<HTMLElement>("td, th"));
  const byText = ref.text ? cells.find(cell => boxText(cell) === ref.text) : undefined;
  const byGrid = (block as HTMLTableElement).rows?.[ref.row]?.cells?.[ref.col] as HTMLElement | undefined;
  return byText ?? byGrid ?? block;
}

// Resolve every part against the live page; `origin` is the ink SVG's own rect and each
// placement's points are local to its element box, drawn under a translate.
export function placeInk(strokes: readonly InkStroke[], blocks: readonly GlassBlock[], origin: { left: number; top: number }): {
  placed: InkPlacement[]; orphans: number;
} {
  const byLine = new Map(blocks.map(block => [block.line, block]));
  const placed: InkPlacement[] = [];
  let orphans = 0;
  for (const stroke of strokes) {
    stroke.parts.forEach((part, index) => {
      const resolved = resolveAnchor(part.anchor, blocks);
      const block = resolved.line === null || resolved.confidence < 0.5 ? undefined : byLine.get(resolved.line);
      const element = block?.element ? resolveBox(block.element, part.box) : undefined;
      if (!element) { orphans += 1; return; }
      const box = element.getBoundingClientRect();
      const points = part.points.map(([x, y, pressure]) => [x * box.width, y * box.height, pressure] as InkPoint);
      placed.push({ stroke, part: index, points, rect: { left: box.left, top: box.top, width: box.width, height: box.height },
        x: box.left - origin.left, y: box.top - origin.top, width: box.width, height: box.height });
    });
  }
  return { placed, orphans };
}


