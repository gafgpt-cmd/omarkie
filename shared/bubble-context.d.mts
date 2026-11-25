import type { PageElement } from "./element-model.mjs";

export interface BubbleBundle {
  note: string;
  element: { id: string; kind: string; line: number; headings: string[] };
  headings: string[];
  text: string;
  quote: string;
  neighbours: { before?: string; after?: string };
  images: string[];
  metadata: { note: string; kind: string; line: number };
}

export interface BubblePayload {
  document: string;
  element: string;
  kind: string;
  line: number;
  headings: string[];
  text: string;
  quote: string;
  neighbours: { before?: string; after?: string };
  images?: string[];
  question: string;
}

export type IdentifierKind = "dob" | "name" | "record" | "contact" | "date";

export interface IdentifierFlag {
  kind: IdentifierKind;
  label: string;
  value: string;
  index: number;
  signature: string;
}

export function bubbleBundle(elements: PageElement[], element: PageElement | undefined, options?: { note?: string; quote?: string }): BubbleBundle | undefined;
export function bubblePayload(bundle: BubbleBundle | undefined, question: string, text?: string): BubblePayload | undefined;
export function payloadText(payload: BubblePayload | undefined): string;
export function findIdentifiers(text: string, options?: { limit?: number }): IdentifierFlag[];
export function identifierSignature(flag: IdentifierFlag): string;
