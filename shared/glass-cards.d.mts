import type { CalcInput } from "./calc-model.mjs";
import type { FlowNode } from "./flow-model.mjs";

export type CardKind = "static" | "ai" | "menu" | "calc" | "flow";
export interface CardChoice { label: string; body: string }
export interface CardLink { target: string; section: string }
export interface CardSection {
  status: "ok" | "empty" | "section-missing";
  heading: string | null;
  level: number;
  markdown: string;
}
export interface CardShape {
  card: CardKind;
  title?: string;
  link?: string;
  question?: string;
  answer?: string;
  choices?: CardChoice[];
  formula?: string;
  inputs?: CalcInput[];
  unit?: string;
  citation?: string;
  precision?: number;
  flow?: FlowNode;
  proposed?: boolean;
}

export const cardKinds: readonly CardKind[];
export const cardLayer: string;
export const cardDefaults: {
  w: number; minW: number; maxW: number; titleLimit: number; linkLimit: number; questionLimit: number;
  answerLimit: number; atLimit: number; choiceCount: number; labelLimit: number; bodyLimit: number;
  offsetLimit: number; headingLimit: number; pageBytes: number; citationLimit: number;
};
export const cardFieldNames: Set<string>;

export function parseCardLink(value: unknown): CardLink | null;
export function cardLink(target: string, section?: string): string;
export function extractSection(markdown: unknown, section?: string): CardSection;
export function sectionRange(markdown: unknown, path: string[]): { start: number; end: number; level: number; heading: string; matches: number; lines: string[] } | null;
export function normalizeChoices(value: unknown): CardChoice[];
export function cardFields(fields: Record<string, unknown>): Record<string, unknown>;
export function cardTitle(card: CardShape | undefined): string;
export function cardIcon(card: CardShape | undefined): "sparkles" | "list" | "book" | "calculator" | "flow";
export function cardPageMarkdown(card: CardShape, options?: { markdown?: string }): string;
export function cardPageStem(card: CardShape): string;
