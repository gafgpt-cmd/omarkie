export type CanvasSide = "top" | "right" | "bottom" | "left";
export type CanvasEnd = "none" | "arrow";
export interface CanvasNodeBase {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  [key: string]: unknown;
}
export interface CanvasTextNode extends CanvasNodeBase { type: "text"; text: string }
export interface CanvasFileNode extends CanvasNodeBase { type: "file"; file: string; subpath?: string }
export interface CanvasLinkNode extends CanvasNodeBase { type: "link"; url: string }
export interface CanvasGroupNode extends CanvasNodeBase { type: "group"; label?: string; background?: string; backgroundStyle?: "cover" | "ratio" | "repeat" }
export type CanvasNode = CanvasTextNode | CanvasFileNode | CanvasLinkNode | CanvasGroupNode | CanvasNodeBase;
export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasSide;
  toSide?: CanvasSide;
  fromEnd?: CanvasEnd;
  toEnd?: CanvasEnd;
  color?: string;
  label?: string;
  [key: string]: unknown;
}
export interface JsonCanvas {
  nodes?: CanvasNode[];
  edges?: CanvasEdge[];
  [key: string]: unknown;
}
export type CanvasIssueKind = "invalid-node" | "unknown-type" | "invalid-edge" | "dangling-edge" | "duplicate-id";
export interface CanvasIssue { kind: CanvasIssueKind; id?: string; type?: unknown }
export interface CanvasInspection { issues: CanvasIssue[]; editable: boolean }
export interface CanvasHistory { canvas: JsonCanvas; past: JsonCanvas[]; future: JsonCanvas[] }
export interface CanvasRect { x: number; y: number; width: number; height: number }

export const canvasLimits: { nodes: number; edges: number; bytes: number; grid: number; minSize: number; maxSize: number; coordinate: number; label: number };
export const canvasNodeTypes: readonly string[];
export const canvasSides: readonly CanvasSide[];
export const canvasEnds: readonly CanvasEnd[];
export const canvasBackgroundStyles: readonly string[];
export const canvasPresets: readonly string[];
export const canvasExtension: RegExp;
export function validCanvasColor(value: unknown): value is string;
export class CanvasError extends Error { code: string; constructor(message: string, code?: string) }
export function inspectCanvas(canvas: JsonCanvas): CanvasInspection;
export function parseCanvas(text: string): CanvasInspection & { canvas: JsonCanvas };
export function serializeCanvas(canvas: JsonCanvas): string;
export function emptyCanvas(): JsonCanvas;
export function canvasNodes(canvas: JsonCanvas): CanvasNode[];
export function canvasEdges(canvas: JsonCanvas): CanvasEdge[];
export function newCanvasId(taken?: Set<string>): string;
export function canvasIds(canvas: JsonCanvas): Set<string>;
export function snapToGrid(value: number, grid?: number): number;
export function setGeometry(canvas: JsonCanvas, changes: Record<string, Partial<CanvasRect>>): JsonCanvas;
export function groupMembers(canvas: JsonCanvas, groupId: string): string[];
export function moveNodes(canvas: JsonCanvas, ids: string[], dx: number, dy: number): JsonCanvas;
export function addNode(canvas: JsonCanvas, node: CanvasNode): JsonCanvas;
export function updateNode(canvas: JsonCanvas, id: string, patch: Record<string, unknown>): JsonCanvas;
export function addEdge(canvas: JsonCanvas, edge: CanvasEdge): JsonCanvas;
export function updateEdge(canvas: JsonCanvas, id: string, patch: Record<string, unknown>): JsonCanvas;
export function removeItems(canvas: JsonCanvas, nodeIds?: string[], edgeIds?: string[]): JsonCanvas;
export function nodeBounds(nodes: CanvasRect[]): CanvasRect | null;
export function groupNodes(canvas: JsonCanvas, ids: string[], options?: { id?: string; label?: string; padding?: number }): { canvas: JsonCanvas; group: CanvasGroupNode };
export function bringToFront(canvas: JsonCanvas, ids: string[]): JsonCanvas;
export function canvasHistory(canvas: JsonCanvas): CanvasHistory;
export function commitCanvas(history: CanvasHistory, next: JsonCanvas, limit?: number): CanvasHistory;
export function undoCanvas(history: CanvasHistory): CanvasHistory;
export function redoCanvas(history: CanvasHistory): CanvasHistory;
export function markdownHeadings(markdown: string): { lines: string[]; headings: { level: number; text: string; line: number }[] };
export function locateSubpath(markdown: string, subpath?: string): { lines: string[]; start: number; end: number; marker?: RegExp } | null;
export function canvasSubpath(markdown: string, subpath?: string): string | null;
