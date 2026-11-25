export interface FlowChoice { label: string; next: FlowNode }
export type FlowNode = { question: string; choices: FlowChoice[] } | { result: string };

export const flowLimits: {
  nodes: number; depth: number; question: number; label: number; choices: number; result: number;
  indent: number; outline: number;
};
export function normalizeFlow(value: unknown): FlowNode;
export function flowAt(flow: FlowNode, path?: number[]): FlowNode | undefined;
export function flowNodeId(path?: number[]): string;
export function flowPathFromId(id: unknown): number[] | null;
export function flowMermaid(flow: FlowNode, options?: { title?: string }): string;
export function flowOutline(flow: FlowNode, indent?: number): string[];
export function parseFlowOutline(source: unknown): FlowNode;
