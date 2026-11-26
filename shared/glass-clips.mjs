// G13: paper clips, scissors cutouts and extra pages.
// Pure field normalizers shared by the store, the renderer and omarkie-axi.
import { validSource } from "./glass-images.mjs";

export const clipDefaults = {
  w: 348, h: 284, minW: 232, minH: 176, maxW: 960, maxH: 1600,
  foldedW: 196, foldedH: 44, textLimit: 40_000, titleLimit: 200, offsetLimit: 200_000,
};
export const extraPageDefaults = {
  w: 420, h: 340, minW: 200, minH: 160, maxW: 1400, maxH: 2400,
  textLimit: 20_000, titleLimit: 120, offsetLimit: 200_000,
};
export const extraPagePapers = ["lined", "grid", "dotted", "kraft", "plain"];
export const cutoutDefaults = {
  w: 280, minW: 48, maxW: 1600, minH: 40, maxH: 1600,
  offsetLimit: 200_000, nameLimit: 200, lassoLimit: 160, minCropPx: 10,
};
export const sheetStrokeLimit = 600;
export const sheetPointLimit = 12_000;
export const sheetInkColors = ["#2f6fb5", "#cf3b32", "#2f9e5f", "#23262b", "#b07b1e"];

const finite = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const colour = /^#[0-9a-f]{6}$/i;

// Strokes live in sheet units (0-1000 on both axes) so a resized sheet keeps the same drawing.
export function validSheetStrokes(value) {
  if (!Array.isArray(value) || value.length > sheetStrokeLimit) return null;
  let points = 0;
  const strokes = [];
  for (const stroke of value) {
    if (!stroke || typeof stroke !== "object" || Array.isArray(stroke)) return null;
    const { color, size, points: line } = stroke;
    if (typeof color !== "string" || !colour.test(color)) return null;
    if (!finite(size, 0.5, 24)) return null;
    if (!Array.isArray(line) || line.length < 2 || line.length > 2000) return null;
    points += line.length;
    if (points > sheetPointLimit) return null;
    const clean = [];
    for (const point of line) {
      if (!Array.isArray(point) || point.length !== 2) return null;
      const [x, y] = point;
      if (!finite(x, 0, 1000) || !finite(y, 0, 1000)) return null;
      clean.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    }
    strokes.push({ color, size: Math.round(size * 10) / 10, points: clean });
  }
  return strokes;
}

// Where a cutout sits inside its source element: percentages of that element's box.
export function validRegion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { x, y, w, h } = value;
  if (![x, y, w, h].every(number => finite(number, 0, 100))) return null;
  if (w <= 0 || h <= 0 || x + w > 100.5 || y + h > 100.5) return null;
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100 };
}

// A freehand lasso, also in percentages of the cutout's own picture box.
export function validLasso(value) {
  if (!Array.isArray(value) || value.length < 3 || value.length > cutoutDefaults.lassoLimit) return null;
  const points = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2) return null;
    const [x, y] = point;
    if (!finite(x, 0, 100) || !finite(y, 0, 100)) return null;
    points.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
  }
  return points;
}

const number = (value, limits, label) => {
  if (!finite(value, limits[0], limits[1])) throw new Error(`${label} must be between ${limits[0]} and ${limits[1]}.`);
  return Math.round(value);
};

function baseFields(values, field, value, labels) {
  switch (field) {
    case "kind":
      if (value !== labels.kind) throw new Error(`A ${labels.kind} keeps its kind.`);
      values.kind = labels.kind;
      return true;
    case "anchor":
      values.anchor = value;
      return true;
    case "x":
    case "y":
      values[field] = number(value, [-labels.offsetLimit, labels.offsetLimit], labels[field]);
      return true;
    case "w":
    case "h":
      values[field] = number(value, [labels[`min${field.toUpperCase()}`], labels[`max${field.toUpperCase()}`]], labels[field]);
      return true;
    case "source": {
      const source = validSource(value);
      if (!source) throw new Error("A glass clipping needs its source element and line.");
      values.source = source;
      return true;
    }
    default:
      return false;
  }
}

function sheetValues(kind, defaults, fields, partial) {
  const labels = { kind, offsetLimit: defaults.offsetLimit, minW: defaults.minW, maxW: defaults.maxW, minH: defaults.minH, maxH: defaults.maxH,
    x: `${kind} x`, y: `${kind} y`, w: `${kind} width`, h: `${kind} height` };
  const allowed = new Set(["kind", "text", "title", ...(kind === "extra-page" ? ["paper"] : []), "anchor", "source", "x", "y", "w", "h", "folded", "strokes", "notePath", "savedAt", "updatedAt"]);
  const values = {};
  for (const [field, value] of Object.entries(fields)) {
    if (!allowed.has(field)) throw new Error(`Unknown ${kind} field: ${field}.`);
    if (baseFields(values, field, value, labels)) continue;
    if (field === "text") {
      if (typeof value !== "string" || value.length > defaults.textLimit) throw new Error(`${kind} text must be up to ${defaults.textLimit} characters.`);
      values.text = value;
    } else if (field === "title") {
      if (typeof value !== "string" || value.length > defaults.titleLimit || value.includes("\u0000")) throw new Error(`${kind} title must be text up to ${defaults.titleLimit} characters.`);
      values.title = value.trim();
    } else if (field === "paper") {
      if (!extraPagePapers.includes(value)) throw new Error(`Extra page paper must be one of: ${extraPagePapers.join(", ")}.`);
      values.paper = value;
    } else if (field === "folded") {
      if (typeof value !== "boolean") throw new Error(`${kind} folded must be true or false.`);
      values.folded = value;
    } else if (field === "strokes") {
      const strokes = validSheetStrokes(value);
      if (!strokes) throw new Error(`${kind} ink is invalid.`);
      values.strokes = strokes;
    } else if (field === "notePath") {
      if (value !== null && (typeof value !== "string" || !value.trim() || value.length > 4096)) throw new Error("Saved note path is invalid.");
      values.notePath = value;
    } else if (field === "savedAt" || field === "updatedAt") {
      if (typeof value !== "string" || value.length > 40) throw new Error(`${kind} ${field} is invalid.`);
      values[field] = value;
    }
  }
  if (!partial) {
    if (!values.anchor) throw new Error(`A ${kind} needs an anchor.`);
    values.text ??= "";
    values.title ??= "";
    values.folded ??= false;
    values.x ??= 0;
    values.y ??= 0;
    values.w ??= defaults.w;
    values.h ??= defaults.h;
    values.strokes ??= [];
    if (kind === "extra-page") values.paper ??= "lined";
  }
  return values;
}

export function clipFieldValues(fields, partial = false) {
  return sheetValues("clip", clipDefaults, fields, partial);
}

export function extraPageFieldValues(fields, partial = false) {
  return sheetValues("extra-page", extraPageDefaults, fields, partial);
}

export function cutoutFieldValues(fields, partial = false) {
  const allowed = new Set(["kind", "name", "asset", "display", "bytes", "aspect", "w", "h", "x", "y",
    "anchor", "source", "region", "lasso", "locked", "wrap", "sourceKind"]);
  const labels = { kind: "cutout", offsetLimit: cutoutDefaults.offsetLimit, minW: cutoutDefaults.minW, maxW: cutoutDefaults.maxW,
    minH: cutoutDefaults.minH, maxH: cutoutDefaults.maxH, x: "cutout x", y: "cutout y", w: "cutout width", h: "cutout height" };
  const values = {};
  for (const [field, value] of Object.entries(fields)) {
    if (!allowed.has(field)) throw new Error(`Unknown cutout field: ${field}.`);
    if (baseFields(values, field, value, labels)) continue;
    if (field === "name") {
      if (typeof value !== "string" || !value.trim() || value.length > cutoutDefaults.nameLimit || value.includes("\u0000")) throw new Error("Cutout name must be text up to 200 characters.");
      values.name = value.trim();
    } else if (field === "asset") {
      if (typeof value !== "string" || !value || /[/\\]/.test(value)) throw new Error("Cutout asset must be a plain file name.");
      values.asset = value;
    } else if (field === "display") {
      if (value !== null && (typeof value !== "string" || !value || /[/\\]/.test(value))) throw new Error("Cutout display copy must be a plain file name.");
      values.display = value;
    } else if (field === "bytes") {
      if (!finite(value, 0, 64 * 1024 * 1024)) throw new Error("Cutout size must be a number of bytes.");
      values.bytes = Math.round(value);
    } else if (field === "aspect") {
      if (!finite(value, 0.05, 20)) throw new Error("Cutout aspect must be a ratio between 0.05 and 20.");
      values.aspect = value;
    } else if (field === "sourceKind") {
      if (!["image", "region"].includes(value)) throw new Error("A cutout source is an image or a page region.");
      values.sourceKind = value;
    } else if (field === "region") {
      const region = validRegion(value);
      if (!region) throw new Error("Cutout region must be percentages inside the source element.");
      values.region = region;
    } else if (field === "lasso") {
      if (value === null) { values.lasso = null; continue; }
      const lasso = validLasso(value);
      if (!lasso) throw new Error("Cutout lasso must be 3-160 points in percentages.");
      values.lasso = lasso;
    } else if (field === "locked") {
      if (typeof value !== "boolean") throw new Error("Cutout lock must be true or false.");
      values.locked = value;
    } else if (field === "wrap") {
      if (value !== "front") throw new Error("A cutout lives in front of the page.");
      values.wrap = value;
    }
  }
  if (!partial) {
    if (!values.anchor) throw new Error("A cutout needs an anchor.");
    if (!values.source) throw new Error("A cutout needs its source element.");
    if (!values.region) throw new Error("A cutout needs its region.");
    values.sourceKind ??= "region";
    if (values.sourceKind === "region" && !values.asset) throw new Error("A region cutout needs its picture.");
    values.name ??= "Cutout";
    values.lasso ??= null;
    values.locked ??= false;
    values.x ??= 0;
    values.y ??= 0;
    values.w ??= cutoutDefaults.w;
    values.h ??= Math.max(cutoutDefaults.minH, Math.round(values.w / (values.aspect ?? 1.5)));
    values.bytes ??= 0;
    values.display ??= null;
  }
  return values;
}

// A place inside an element, as percentages; clamped so rounding at an edge never leaves the box.
export function regionOf(box, rect) {
  if (!box || !rect || !box.width || !box.height) return { x: 0, y: 0, w: 100, h: 100 };
  const x = Math.max(0, Math.min(100, ((rect.x - box.x) / box.width) * 100));
  const y = Math.max(0, Math.min(100, ((rect.y - box.y) / box.height) * 100));
  const w = Math.max(0.1, Math.min(100 - x, (rect.width / box.width) * 100));
  const h = Math.max(0.1, Math.min(100 - y, (rect.height / box.height) * 100));
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100 };
}

export function lassoOf(points, rect) {
  if (!rect.width || !rect.height) return null;
  const lasso = points.map(([x, y]) => [
    Math.round(Math.max(0, Math.min(100, ((x - rect.x) / rect.width) * 100)) * 100) / 100,
    Math.round(Math.max(0, Math.min(100, ((y - rect.y) / rect.height) * 100)) * 100) / 100,
  ]);
  return validLasso(lasso);
}

export function sheetTitle(clip) {
  if (clip.title?.trim()) return clip.title.trim();
  const first = String(clip.text ?? "").split(/\r?\n/).find(line => line.trim());
  return first ? first.replace(/^#+\s*/, "").slice(0, 80) : "Clipped page";
}
