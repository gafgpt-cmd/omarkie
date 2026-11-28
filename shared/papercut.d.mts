import type { CanvasFileNode, CanvasNode, CanvasTextNode } from "./json-canvas.mjs";

export interface ClipSource { file: string; quote: string; line: number; heading?: string }
export interface ClipInput { file: string; quote: string; line?: number; headings?: readonly string[] }
export const clipKey: "x-omarkie-clip";
export function clipSource(node: CanvasNode | undefined): ClipSource | null;
export function quoteLine(markdown: string, source: { quote: string; line: number }): number | null;
export function snapshotNode(clip: ClipInput, label?: string): CanvasTextNode;
export function headingNode(clip: { file: string; headings?: readonly string[] }): CanvasFileNode;
