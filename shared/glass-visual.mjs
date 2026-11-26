// Visual tools on a picture: tracing sheets, compare sliders, calibrated rulers and angles.
// Pure geometry and validation, shared by the renderer, storage and omarkie-axi.
// Coordinates are fractions of the image frame (0..1); distances use the frame's pixel
// aspect so a measured length never changes when the picture is resized.
import { inkColors, inkTools, inkWidths } from "./ink-core.mjs";

export const visualDefaults = {
  maxSheets: 8,
  sheetNameLimit: 40,
  labelLimit: 200,
  labelSize: [10, 12, 14, 18, 24],
  maxTracePoints: 4000,
  maxMeasures: 64,
  compareGap: 8,
  units: ["mm", "cm", "m", "in", "ft", "px"],
  precisions: [0, 1, 2, 3],
  minCompare: 120,
  maxCompare: 4000,
  minCompareHeight: 90,
  maxCompareHeight: 4000,
  offsetLimit: 200_000,
  traceLimit: 1_000,
};
export const measureUnits = visualDefaults.units;
export const measurePrecisions = visualDefaults.precisions;
export const compareDirections = ["horizontal", "vertical"];
export const measureKinds = ["line", "angle"];
export const traceLayers = { trace: "trace", measure: "measure", compare: "compare" };

const finite = value => typeof value === "number" && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const sheetIdPattern = /^[A-Za-z0-9_-]{1,40}$/;

export const validMeasureUnit = value => measureUnits.includes(value);
export const validPrecision = value => Number.isInteger(value) && measurePrecisions.includes(value);
export const validSheetId = value => typeof value === "string" && sheetIdPattern.test(value);
export const validImageId = value => typeof value === "string" && idPattern.test(value);

function point2(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [x, y] = value;
  return finite(x) && finite(y) && x >= -0.05 && x <= 1.05 && y >= -0.05 && y <= 1.05 ? [x, y] : null;
}

function tracePoint(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, pressure] = value;
  return finite(x) && finite(y) && finite(pressure) && x >= -0.05 && x <= 1.05 && y >= -0.05 && y <= 1.05
    && pressure >= 0 && pressure <= 1 ? [x, y, pressure] : null;
}

export function validFrame(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [width, height] = value;
  return finite(width) && finite(height) && width > 0 && height > 0 && width <= 200_000 && height <= 200_000
    ? [width, height] : null;
}

export function validLine2(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const first = point2(value[0]), second = point2(value[1]);
  return first && second ? [first, second] : null;
}

export function validPoints2(value, count) {
  if (!Array.isArray(value) || value.length !== count) return null;
  const points = value.map(point2);
  return points.every(Boolean) ? points : null;
}

export function normalizeSheet(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some(key => !["id", "name", "opacity", "visible", "locked"].includes(key))) return null;
  const { id, name, opacity, visible, locked } = value;
  if (!validSheetId(id)) return null;
  if (typeof name !== "string" || !name.trim() || name.length > visualDefaults.sheetNameLimit || /[\u0000-\u001f]/.test(name)) return null;
  if (!finite(opacity) || opacity < 0 || opacity > 100) return null;
  if (typeof visible !== "boolean" || typeof locked !== "boolean") return null;
  return { id, name: name.trim(), opacity: Math.round(opacity), visible, locked };
}

export function validSheets(value) {
  if (!Array.isArray(value) || value.length > visualDefaults.maxSheets) return null;
  const sheets = value.map(normalizeSheet);
  if (sheets.some(Boolean) === false && value.length) return null;
  if (sheets.some(sheet => !sheet)) return null;
  const ids = new Set(sheets.map(sheet => sheet?.id));
  return ids.size === sheets.length ? sheets : null;
}

export function validScale(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some(key => !["unit", "precision", "length", "line", "frame"].includes(key))) return null;
  const { unit, precision, length, line, frame } = value;
  const line2 = validLine2(line), frames = validFrame(frame);
  if (!validMeasureUnit(unit) || !validPrecision(precision)) return null;
  if (!finite(length) || length <= 0 || length > 1_000_000_000) return null;
  if (!line2 || !frames) return null;
  const first = line2[0], second = line2[1];
  if (planeDistance(first, second, frames) < 1) return null;
  return { unit, precision, length, line: line2, frame: frames };
}

export function scaleFromLine(line, length, unit, precision, frame) {
  const line2 = validLine2(line), frames = validFrame(frame);
  if (!line2 || !frames) throw new Error("Calibration needs two points and a frame.");
  const scale = { unit, precision, length, line: line2, frame: frames };
  const valid = validScale(scale);
  if (!valid) throw new Error("Calibration needs a positive length, a known unit, and two different points.");
  return valid;
}

// Frame pixels for a normalized point; the frame's own width and height carry the aspect.
export function pointInFrame(point, frame) {
  return [point[0] * frame[0], point[1] * frame[1]];
}

export function planeDistance(first, second, frame) {
  if (!finite(first?.[0]) || !finite(first?.[1]) || !finite(second?.[0]) || !finite(second?.[1])) return 0;
  return Math.hypot((second[0] - first[0]) * frame[0], (second[1] - first[1]) * frame[1]);
}

export function unitsPerPixel(scale) {
  if (!scale) return 0;
  const length = planeDistance(scale.line[0], scale.line[1], scale.frame);
  return length > 0 ? scale.length / length : 0;
}

// A line is measured with the picture's current frame, so resizing never changes the result.
export function lineLength(points, scale, frame) {
  const points2 = validPoints2(points, 2), frames = validFrame(frame);
  if (!points2 || !frames || !scale) return null;
  return planeDistance(points2[0], points2[1], frames) * unitsPerPixel(scale);
}

export function formatMeasure(value, unit, precision) {
  if (!finite(value) || !validMeasureUnit(unit)) return "";
  const digits = validPrecision(precision) ? precision : 1;
  return `${value.toFixed(digits)} ${unit}`;
}

export function formatAngle(degrees) {
  return finite(degrees) ? `${degrees.toFixed(1)}°` : "";
}

// Vertex first: [vertex, arm A, arm B]. Degrees to one decimal.
export function angleDegrees(points, frame) {
  const points2 = validPoints2(points, 3), frames = validFrame(frame);
  if (!points2 || !frames) return null;
  const [vertex, first, second] = points2;
  const ax = (first[0] - vertex[0]) * frames[0], ay = (first[1] - vertex[1]) * frames[1];
  const bx = (second[0] - vertex[0]) * frames[0], by = (second[1] - vertex[1]) * frames[1];
  const firstLength = Math.hypot(ax, ay), secondLength = Math.hypot(bx, by);
  if (firstLength < 1e-9 || secondLength < 1e-9) return null;
  const cosine = clamp((ax * bx + ay * by) / (firstLength * secondLength), -1, 1);
  return Math.round((Math.acos(cosine) * 180 / Math.PI) * 10) / 10;
}

// Shift while drawing a line snaps it to 45° steps, like a drafting square.
export function snapLinePoint(start, end, frame, step = 45) {
  const frames = validFrame(frame), first = point2(start), second = point2(end);
  if (!frames || !first || !second || !finite(step) || step <= 0) return second ?? end;
  const dx = (second[0] - first[0]) * frames[0], dy = (second[1] - first[1]) * frames[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return second;
  const snapped = Math.round(Math.atan2(dy, dx) / (step * Math.PI / 180)) * (step * Math.PI / 180);
  return [first[0] + Math.cos(snapped) * length / frames[0], first[1] + Math.sin(snapped) * length / frames[1]];
}

// Shift while placing the second arm snaps the angle from the first arm to 15° steps.
export function snapAnglePoint(vertex, arm, point, frame, step = 15) {
  const frames = validFrame(frame), center = point2(vertex), first = point2(arm), second = point2(point);
  if (!frames || !center || !first || !second || !finite(step) || step <= 0) return second ?? point;
  const armAngle = Math.atan2((first[1] - center[1]) * frames[1], (first[0] - center[0]) * frames[0]);
  const dx = (second[0] - center[0]) * frames[0], dy = (second[1] - center[1]) * frames[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return second;
  const direction = Math.atan2(dy, dx);
  let delta = direction - armAngle;
  const turn = step * Math.PI / 180;
  delta = Math.round(delta / turn) * turn;
  const snapped = armAngle + delta;
  return [center[0] + Math.cos(snapped) * length / frames[0], center[1] + Math.sin(snapped) * length / frames[1]];
}

// Tracing strokes: image-scoped, normalized points, one sheet and one tool per stroke.
export function validTraceFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const keys = Object.keys(fields);
  if (keys.some(key => !["kind", "layer", "image", "sheet", "tool", "color", "size", "refWidth", "points"].includes(key))) return null;
  const { kind, layer, image, sheet, tool, color, size, refWidth, points } = fields;
  if (kind !== "trace" || layer !== "trace") return null;
  if (!validImageId(image) || !validSheetId(sheet)) return null;
  if (!inkTools.includes(tool) || !inkColors[tool]?.includes(color)) return null;
  if (!inkWidths[tool].includes(size)) return null;
  if (!finite(refWidth) || refWidth < 1 || refWidth > 200_000) return null;
  if (!Array.isArray(points) || points.length < 2 || points.length > visualDefaults.maxTracePoints) return null;
  const parsed = points.map(tracePoint);
  if (parsed.some(point => !point)) return null;
  return { kind, layer, image, sheet, tool, color, size, refWidth, points: parsed };
}

export function validSheetLabelFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const keys = Object.keys(fields);
  if (keys.some(key => !["kind", "layer", "image", "sheet", "x", "y", "text", "size"].includes(key))) return null;
  const { kind, layer, image, sheet, x, y, text, size } = fields;
  if (kind !== "sheet-label" || layer !== "trace") return null;
  if (!validImageId(image) || !validSheetId(sheet)) return null;
  const point = point2([x, y]);
  if (!point) return null;
  if (typeof text !== "string" || !text.trim() || text.length > visualDefaults.labelLimit || /[\u0000-\u001f]/.test(text)) return null;
  if (!visualDefaults.labelSize.includes(size)) return null;
  return { kind, layer, image, sheet, x: point[0], y: point[1], text: text.trim(), size };
}

export function validMeasureFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const keys = Object.keys(fields);
  if (keys.some(key => !["kind", "layer", "image", "type", "points"].includes(key))) return null;
  const { kind, layer, image, type, points } = fields;
  if (kind !== "measure" || layer !== "measure") return null;
  if (!validImageId(image) || !measureKinds.includes(type)) return null;
  const points2 = validPoints2(points, type === "angle" ? 3 : 2);
  return points2 ? { kind, layer, image, type, points: points2 } : null;
}

export function validCompareFields(fields, { partial = false } = {}) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const allowed = ["kind", "layer", "left", "right", "value", "direction", "before", "after", "anchor", "x", "y", "w", "h"];
  if (Object.keys(fields).some(key => !allowed.includes(key))) return null;
  if (partial) {
    for (const [key, value] of Object.entries(fields)) {
      switch (key) {
        case "kind":
          if (value !== "compare") return null;
          break;
        case "layer":
          if (value !== "compare") return null;
          break;
        case "left":
        case "right":
          if (!validImageId(value)) return null;
          break;
        case "value":
          if (!finite(value) || value < 0 || value > 100) return null;
          break;
        case "direction":
          if (!compareDirections.includes(value)) return null;
          break;
        case "before":
        case "after":
          if (typeof value !== "string" || value.length > 40) return null;
          break;
        case "anchor":
          if (!value || typeof value !== "object" || Array.isArray(value)) return null;
          break;
        case "x":
        case "y":
          if (!finite(value) || Math.abs(value) > visualDefaults.offsetLimit) return null;
          break;
        case "w":
          if (!finite(value) || value < visualDefaults.minCompare || value > visualDefaults.maxCompare) return null;
          break;
        case "h":
          if (!finite(value) || value < visualDefaults.minCompareHeight || value > visualDefaults.maxCompareHeight) return null;
          break;
      }
    }
    return fields;
  }
  const { kind, layer, left, right, value, direction, before, after, anchor, x, y, w, h } = fields;
  if (kind !== "compare" || layer !== "compare") return null;
  if (!validImageId(left) || !validImageId(right) || left === right) return null;
  if (!finite(value) || value < 0 || value > 100) return null;
  if (!compareDirections.includes(direction)) return null;
  if (typeof before !== "string" || before.length > 40 || typeof after !== "string" || after.length > 40) return null;
  if (!anchor || typeof anchor !== "object") return null;
  if (!finite(x) || !finite(y) || Math.abs(x) > visualDefaults.offsetLimit || Math.abs(y) > visualDefaults.offsetLimit) return null;
  if (!finite(w) || w < visualDefaults.minCompare || w > visualDefaults.maxCompare) return null;
  if (!finite(h) || h < visualDefaults.minCompareHeight || h > visualDefaults.maxCompareHeight) return null;
  return { kind, layer, left, right, value, direction, before, after, anchor, x, y, w, h };
}

export function compareValue(value) {
  return finite(value) ? clamp(Math.round(value), 0, 100) : 50;
}

export function compareDirection(leftAspect, rightAspect) {
  const aspect = finite(leftAspect) && leftAspect > 0 ? leftAspect : finite(rightAspect) && rightAspect > 0 ? rightAspect : 1;
  return aspect < 0.9 ? "vertical" : "horizontal";
}

export function measureLabel(measure, scale, frame) {
  if (!measure) return "";
  const frames = scale?.frame ?? frame;
  if (measure.type === "angle") {
    const degrees = angleDegrees(measure.points, frames);
    return degrees === null ? "" : formatAngle(degrees);
  }
  if (!scale) return "Set scale";
  const value = lineLength(measure.points, scale, frames);
  return value === null ? "Set scale" : formatMeasure(value, scale.unit, scale.precision);
}
