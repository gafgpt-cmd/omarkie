import {
  clipDefaults, cutoutDefaults, extraPageDefaults, extraPagePapers, sheetTitle, validLasso, validRegion, validSheetStrokes,
  type SheetStroke,
} from "../../shared/glass-clips.mjs";
import { validSource, type ImageSource } from "../../shared/glass-images.mjs";
import { anchorFrom } from "./glass-state";
import type { GlassAnchor } from "./anchor-map";
import type { GlassMagnet } from "./glass-model";

export interface ClipPage {
  id: string;
  text: string;
  title: string;
  anchor: GlassAnchor;
  x: number;
  y: number;
  w: number;
  h: number;
  folded: boolean;
  strokes: SheetStroke[];
  notePath: string | null;
  savedAt: string;
  source?: ImageSource;
}

export interface ExtraPage {
  id: string;
  text: string;
  title: string;
  paper: (typeof extraPagePapers)[number];
  anchor: GlassAnchor;
  x: number;
  y: number;
  w: number;
  h: number;
  strokes: SheetStroke[];
}

export interface Cutout {
  id: string;
  name: string;
  asset: string | null;
  display: string | null;
  sourceKind: "image" | "region";
  bytes: number;
  aspect: number;
  w: number;
  h: number;
  x: number;
  y: number;
  anchor: GlassAnchor;
  source: ImageSource;
  region: { x: number; y: number; w: number; h: number };
  lasso: [number, number][] | null;
  locked: boolean;
}

const number = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";

export function clipFromMagnet(magnet: GlassMagnet): ClipPage | undefined {
  const fields = magnet.fields ?? {};
  if ((fields.kind ?? magnet.kind) !== "clip") return;
  const anchor = anchorFrom(fields.anchor);
  if (!anchor) return;
  const source = validSource(fields.source) ?? undefined;
  return {
    id: magnet.id,
    text: text(fields.text, clipDefaults.textLimit),
    title: text(fields.title, clipDefaults.titleLimit),
    anchor,
    x: number(fields.x, 0, -clipDefaults.offsetLimit, clipDefaults.offsetLimit),
    y: number(fields.y, 0, -clipDefaults.offsetLimit, clipDefaults.offsetLimit),
    w: number(fields.w, clipDefaults.w, clipDefaults.minW, clipDefaults.maxW),
    h: number(fields.h, clipDefaults.h, clipDefaults.minH, clipDefaults.maxH),
    folded: fields.folded === true,
    strokes: validSheetStrokes(fields.strokes) ?? [],
    notePath: typeof fields.notePath === "string" && fields.notePath ? fields.notePath : null,
    savedAt: text(fields.savedAt, 40),
    ...(source ? { source } : {}),
  };
}

export function extraPageFromMagnet(magnet: GlassMagnet): ExtraPage | undefined {
  const fields = magnet.fields ?? {};
  if ((fields.kind ?? magnet.kind) !== "extra-page") return;
  const anchor = anchorFrom(fields.anchor);
  if (!anchor) return;
  return {
    id: magnet.id,
    text: text(fields.text, extraPageDefaults.textLimit),
    title: text(fields.title, extraPageDefaults.titleLimit),
    paper: extraPagePapers.includes(fields.paper as never) ? fields.paper as (typeof extraPagePapers)[number] : "lined",
    anchor,
    x: number(fields.x, 0, -extraPageDefaults.offsetLimit, extraPageDefaults.offsetLimit),
    y: number(fields.y, 0, -extraPageDefaults.offsetLimit, extraPageDefaults.offsetLimit),
    w: number(fields.w, extraPageDefaults.w, extraPageDefaults.minW, extraPageDefaults.maxW),
    h: number(fields.h, extraPageDefaults.h, extraPageDefaults.minH, extraPageDefaults.maxH),
    strokes: validSheetStrokes(fields.strokes) ?? [],
  };
}

export function cutoutFromMagnet(magnet: GlassMagnet): Cutout | undefined {
  const fields = magnet.fields ?? {};
  if ((fields.kind ?? magnet.kind) !== "cutout") return;
  const asset = typeof fields.asset === "string" && fields.asset && !/[/\\]/.test(fields.asset) ? fields.asset : null;
  const anchor = anchorFrom(fields.anchor);
  const source = validSource(fields.source);
  const region = validRegion(fields.region);
  const sourceKind = fields.sourceKind === "image" ? "image" : "region";
  if (!anchor || !source || !region || (sourceKind === "region" && !asset)) return;
  const w = number(fields.w, cutoutDefaults.w, cutoutDefaults.minW, cutoutDefaults.maxW);
  const aspect = typeof fields.aspect === "number" && Number.isFinite(fields.aspect) && fields.aspect > 0 ? fields.aspect : 1.5;
  return {
    id: magnet.id,
    name: typeof fields.name === "string" && fields.name.trim() ? fields.name.slice(0, cutoutDefaults.nameLimit) : "Cutout",
    asset,
    sourceKind,
    display: typeof fields.display === "string" && fields.display && !/[/\\]/.test(fields.display) ? fields.display : null,
    bytes: typeof fields.bytes === "number" && fields.bytes >= 0 ? fields.bytes : 0,
    aspect,
    w,
    h: number(fields.h, Math.round(w / aspect), cutoutDefaults.minH, cutoutDefaults.maxH),
    x: number(fields.x, 0, -cutoutDefaults.offsetLimit, cutoutDefaults.offsetLimit),
    y: number(fields.y, 0, -cutoutDefaults.offsetLimit, cutoutDefaults.offsetLimit),
    anchor,
    source,
    region,
    lasso: validLasso(fields.lasso),
    locked: fields.locked === true,
  };
}

export function clipFields(page: ClipPage): Record<string, unknown> {
  return { kind: "clip", text: page.text, title: page.title, anchor: page.anchor, x: page.x, y: page.y,
    w: page.w, h: page.h, folded: page.folded, strokes: page.strokes, notePath: page.notePath,
    savedAt: page.savedAt, ...(page.source ? { source: page.source } : {}) };
}

export function extraPageFields(page: ExtraPage): Record<string, unknown> {
  return { kind: "extra-page", text: page.text, title: page.title, paper: page.paper, anchor: page.anchor,
    x: page.x, y: page.y, w: page.w, h: page.h, strokes: page.strokes };
}

export function cutoutFields(cutout: Cutout): Record<string, unknown> {
  return { kind: "cutout", name: cutout.name, anchor: cutout.anchor, source: cutout.source,
    sourceKind: cutout.sourceKind, region: cutout.region, lasso: cutout.lasso,
    ...(cutout.asset ? { asset: cutout.asset } : {}), ...(cutout.display ? { display: cutout.display } : {}),
    ...(cutout.bytes ? { bytes: cutout.bytes } : {}), aspect: cutout.aspect, w: cutout.w, h: cutout.h, x: cutout.x, y: cutout.y,
    locked: cutout.locked };
}

export const newClipId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export { clipDefaults, cutoutDefaults, extraPageDefaults, extraPagePapers, sheetTitle, validLasso, validRegion, validSheetStrokes };
export type { SheetStroke };
