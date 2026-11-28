import { cardDefaults, cardKinds, cardTitle, parseCardLink, type CardChoice, type CardKind } from "../../shared/glass-cards.mjs";
import { isLevelId, type LevelId } from "../../shared/fold-format.mjs";
import { calcLimits, normalizeCalcInputs, normalizePrecision, type CalcInput } from "../../shared/calc-model.mjs";
import { normalizeFlow, type FlowNode } from "../../shared/flow-model.mjs";
import { anchorFrom } from "./glass-state";
import type { GlassAnchor } from "./anchor-map";
import type { GlassMagnet } from "./glass-model";

export const cardMinWidth = cardDefaults.minW, cardMaxWidth = cardDefaults.maxW, cardGap = 10;

export interface GlassCard {
  id: string;
  card: CardKind;
  title: string;
  link: string;
  question: string;
  answer: string;
  answerAt: string;
  choices: CardChoice[];
  formula: string;
  inputs: CalcInput[];
  unit: string;
  citation: string;
  precision: number;
  flow?: FlowNode;
  // Fold card: the stop the line was read at (question = the line, answer = its evidence).
  stop?: LevelId;
  proposed: boolean;
  anchor: GlassAnchor;
  x: number;
  y: number;
  w: number;
  folded: boolean;
  marked: boolean;
}

const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";

function choicesOf(value: unknown): CardChoice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const choice = item as Record<string, unknown>;
    if (typeof choice.label !== "string" || !choice.label.trim() || choice.label.length > cardDefaults.labelLimit) return [];
    return [{ label: choice.label.trim(), body: typeof choice.body === "string" ? choice.body.slice(0, cardDefaults.bodyLimit) : "" }];
  });
}

export function cardFromMagnet(magnet: GlassMagnet): GlassCard | undefined {
  const fields = magnet.fields ?? {};
  if ((fields.kind ?? magnet.kind) !== "card") return;
  if (!cardKinds.includes(fields.card as CardKind)) return;
  const anchor = anchorFrom(fields.anchor);
  if (!anchor) return;
  const kind = fields.card as CardKind;
  let inputs: CalcInput[] = [], flow: FlowNode | undefined;
  try {
    if (kind === "calc") inputs = normalizeCalcInputs(fields.inputs);
    if (kind === "flow") flow = normalizeFlow(fields.flow);
  } catch { return; }
  const card = {
    card: kind,
    title: text(fields.title, cardDefaults.titleLimit),
    link: text(fields.link, cardDefaults.linkLimit),
    question: text(fields.question, cardDefaults.questionLimit),
    answer: text(fields.answer, cardDefaults.answerLimit),
    choices: choicesOf(fields.choices),
    formula: text(fields.formula, calcLimits.formula),
    inputs,
    unit: text(fields.unit, calcLimits.unit),
    citation: text(fields.citation, cardDefaults.citationLimit),
    flow,
    proposed: fields.proposed === true,
    stop: isLevelId(fields.stop) ? fields.stop : undefined,
  };
  if (kind === "calc" && (!card.formula || !card.unit || !card.citation || !card.inputs.length)) return;
  if (kind === "flow" && (!card.flow || !card.citation)) return;
  if (kind === "fold" && (!card.question || !card.answer || !card.stop)) return;
  return {
    id: magnet.id,
    ...card,
    title: cardTitle(card),
    answerAt: text(fields.answerAt, cardDefaults.atLimit),
    precision: number(fields.precision, calcLimits.defaultPrecision, 0, calcLimits.precision),
    anchor,
    x: number(fields.x, 0, -cardDefaults.offsetLimit, cardDefaults.offsetLimit),
    y: number(fields.y, 0, -cardDefaults.offsetLimit, cardDefaults.offsetLimit),
    w: number(fields.w, cardDefaults.w, cardDefaults.minW, cardDefaults.maxW),
    folded: fields.folded !== false,
    marked: fields.marked === true,
  };
}

export function cardFieldsOf(card: GlassCard): Record<string, unknown> {
  return {
    kind: "card", card: card.card, layer: "ai-cards", title: card.title,
    ...(card.card === "static" ? { link: card.link } : {}),
    ...(card.card === "ai" ? { question: card.question } : {}),
    ...(card.card === "menu" ? { choices: card.choices } : {}),
    ...(card.card === "calc" ? { formula: card.formula, inputs: card.inputs, unit: card.unit, citation: card.citation, precision: card.precision } : {}),
    ...(card.card === "flow" ? { flow: card.flow, citation: card.citation } : {}),
    ...(card.card === "fold" ? { question: card.question, answer: card.answer, link: card.link, stop: card.stop } : {}),
    proposed: card.proposed,
    anchor: card.anchor, x: card.x, y: card.y, w: card.w, folded: card.folded,
  };
}

export function newCardId() {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function cardAnchor(target: { block: string; headings?: readonly string[]; line?: number }): GlassAnchor {
  return { version: 2, landmarks: [{ kind: "block", block: target.block, headings: [...(target.headings ?? [])], ...(Number.isInteger(target.line) ? { line: target.line } : {}) }] };
}

export function cardBlock(card: GlassCard) {
  const landmark = card.anchor.landmarks.find(item => item.kind === "block");
  return landmark && landmark.kind === "block" ? landmark : undefined;
}

// Pills sit in the right margin of the paragraph; a narrow window clamps them to the visible desk.
export function pillPlacement(rect: { right: number; top: number }, frame: { width: number; left: number; top: number }) {
  const right = rect.right - frame.left;
  const spare = frame.width - right - cardGap - 8;
  const width = Math.max(cardMinWidth, Math.min(cardMaxWidth, Math.round(Math.max(spare, cardMinWidth))));
  return { x: Math.max(cardGap, Math.min(right + cardGap, frame.width - width - 8)), y: rect.top - frame.top, width };
}

export function cardLinkTitle(link: string) {
  const parsed = parseCardLink(link);
  if (!parsed) return "";
  if (parsed.section) return parsed.section;
  return parsed.target.split("/").at(-1)?.replace(/\.(?:md|markdown|mdown)$/i, "") ?? "";
}
