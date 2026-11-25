// Ink core: stroke geometry and SVG paths, shared by the renderer and omarkie-axi.
// No DOM here. Points are [x, y, pressure]; x/y are pixels for drawing and 0..1 of the
// element box once stored. perfect-freehand is MIT, offline, no telemetry.
import { getStroke } from "perfect-freehand";

export const inkTools = ["pen", "highlighter"];
// Pen: three widths. Highlighter: a chisel, two widths.
export const inkWidths = { pen: [2, 4, 8], highlighter: [16, 24] };
// Notebook ink and translucent highlighter paper colours.
export const inkColors = {
  pen: ["#24292f", "#1d4ed8", "#b42318"],
  highlighter: ["#f5d547", "#f39bb8", "#7cc7f5"],
};
export const inkLimits = { parts: 24, partPoints: 4000, points: 12000, size: 64, reach: 4 };

export function inkDefaults(tool = "pen") {
  const kind = inkTools.includes(tool) ? tool : "pen";
  return { tool: kind, color: inkColors[kind][0], size: inkWidths[kind][0] };
}

export function validInkTool(value) {
  return inkTools.includes(value);
}

export function validInkColor(tool, value) {
  return inkTools.includes(tool) && inkColors[tool].includes(value);
}

export function validInkSize(tool, value) {
  return inkTools.includes(tool) && inkWidths[tool].includes(value);
}

const finite = value => typeof value === "number" && Number.isFinite(value);

export function validInkPoint(point) {
  if (!Array.isArray(point) || point.length !== 3) return false;
  const [x, y, pressure] = point;
  return finite(x) && finite(y) && finite(pressure) && Math.abs(x) <= inkLimits.reach && Math.abs(y) <= inkLimits.reach
    && pressure >= 0 && pressure <= 1;
}

export function validInkPoints(points) {
  return Array.isArray(points) && points.length >= 1 && points.length <= inkLimits.partPoints && points.every(validInkPoint);
}

// A box says where inside a block the stroke sits: the block itself, a list item, or a table cell.
export function validInkBox(box) {
  if (!box || typeof box !== "object" || Array.isArray(box)) return false;
  const keys = Object.keys(box);
  const text = box.text === undefined ? [] : ["text"];
  if (box.text !== undefined && (typeof box.text !== "string" || box.text.length > 512)) return false;
  if (box.kind === "block") return keys.every(key => key === "kind");
  if (box.kind === "item") return Number.isInteger(box.index) && box.index >= 0 && box.index <= 999
    && keys.every(key => ["kind", "index", ...text].includes(key));
  if (box.kind === "cell") return Number.isInteger(box.row) && box.row >= 0 && box.row <= 999 && Number.isInteger(box.col) && box.col >= 0 && box.col <= 999
    && keys.every(key => ["kind", "row", "col", ...text].includes(key));
  return false;
}

// Anchors are validated by the storage core; this checks the rest of a part.
export function validInkPart(part) {
  if (!part || typeof part !== "object" || Array.isArray(part)) return false;
  if (!Object.keys(part).every(key => ["box", "anchor", "points"].includes(key))) return false;
  return validInkBox(part.box) && validInkPoints(part.points);
}

export function validInkParts(parts) {
  if (!Array.isArray(parts) || !parts.length || parts.length > inkLimits.parts) return false;
  let total = 0;
  for (const part of parts) {
    if (!validInkPart(part)) return false;
    total += part.points.length;
    if (total > inkLimits.points) return false;
  }
  return true;
}

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export function quantizePoint(point) {
  return [round(point[0], 4), round(point[1], 4), round(point[2], 2)];
}

export function quantizePoints(points) {
  return points.map(quantizePoint);
}

// Consecutive points that hit the same box become one part. The crossing sample is kept
// on both sides so the two halves join where the stroke left one element for the next.
export function splitRuns(points, keyOf) {
  const runs = [];
  let current;
  for (const point of points) {
    const key = keyOf(point);
    if (!current) { current = { key, points: [point] }; continue; }
    if (key === current.key) { current.points.push(point); continue; }
    const last = current.points.at(-1);
    runs.push(current);
    current = { key, points: [last, point] };
  }
  if (current) runs.push(current);
  return runs;
}

function smoothPath(outline) {
  const points = outline.filter(point => Array.isArray(point) && finite(point[0]) && finite(point[1]));
  if (!points.length) return "";
  const format = point => `${round(point[0], 2)} ${round(point[1], 2)}`;
  if (points.length < 3) return `M ${format(points[0])} L ${format(points.at(-1))}`;
  const middle = (left, right) => [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
  let path = `M ${format(points[0])} Q ${format(points[1])} ${format(middle(points[1], points[2]))}`;
  for (let index = 2; index < points.length - 1; index++) {
    path += ` Q ${format(points[index])} ${format(middle(points[index], points[index + 1]))}`;
  }
  return `${path} L ${format(points.at(-1))} Z`;
}

const nibAngle = -0.62;

// Chisel nib: a flat edge at a fixed angle, so a vertical stroke is thin and a diagonal one broad.
export function chiselOutline(points, size) {
  if (!points.length) return [];
  const half = Math.max(1, size) / 2, left = [], right = [];
  for (let index = 0; index < points.length; index++) {
    const previous = points[Math.max(0, index - 1)], next = points[Math.min(points.length - 1, index + 1)];
    const dx = next[0] - previous[0], dy = next[1] - previous[1];
    const length = Math.hypot(dx, dy);
    const normal = length ? [-dy / length, dx / length] : [Math.sin(nibAngle), -Math.cos(nibAngle)];
    const pressure = Math.min(1, Math.max(0.2, points[index][2] ?? 0.5));
    const flat = length ? Math.abs(Math.sin(nibAngle - Math.atan2(dy, dx))) : 1;
    const width = half * (0.45 + 1.15 * flat) * (0.7 + 0.3 * pressure);
    left.push([points[index][0] + normal[0] * width, points[index][1] + normal[1] * width]);
    right.push([points[index][0] - normal[0] * width, points[index][1] - normal[1] * width]);
  }
  return [...left, ...right.reverse()];
}

function freehandOutline(points, size) {
  return getStroke(points, {
    size,
    thinning: 0.62,
    smoothing: 0.55,
    streamline: 0.32,
    simulatePressure: false,
    last: true,
    easing: t => t,
  });
}

// Pixel-space path for one part. Pen follows pressure; highlighter is the chisel ribbon.
export function inkPath(points, { tool, size }) {
  if (!Array.isArray(points) || !points.length) return "";
  const scaled = points.map(([x, y, pressure]) => [x, y, Math.min(1, Math.max(0, pressure ?? 0.5))]);
  if (tool === "highlighter") return smoothPath(chiselOutline(scaled, size));
  return smoothPath(freehandOutline(scaled, size));
}

// Geometry without the DOM: boxes are plain rects, so tests can move them.
export function boxHit(boxes, point) {
  let inside, insideArea = Infinity, near, nearDistance = Infinity, nearArea = Infinity;
  for (const box of boxes) {
    const dx = Math.max(box.left - point.x, 0, point.x - (box.left + box.width));
    const dy = Math.max(box.top - point.y, 0, point.y - (box.top + box.height));
    const area = box.width * box.height;
    if (!dx && !dy) { if (area < insideArea) { inside = box; insideArea = area; } continue; }
    const gap = Math.hypot(dx, dy);
    if (gap < nearDistance || (gap === nearDistance && area < nearArea)) { near = box; nearDistance = gap; nearArea = area; }
  }
  return inside ?? near;
}

// Pixels → fractions of the element box, and back after the box moved or reflowed.
export function toBoxPoints(points, rect) {
  const width = rect.width || 1, height = rect.height || 1;
  return points.map(point => quantizePoint([(point[0] - rect.left) / width, (point[1] - rect.top) / height, point[2] ?? 0.5]));
}

export function fromBoxPoints(points, rect) {
  return points.map(point => [rect.left + point[0] * rect.width, rect.top + point[1] * rect.height, point[2] ?? 0.5]);
}

// Pen-only drawing once a stylus is present: palms and fingers never leave marks, and a
// second contact during a stroke is a palm, not a stroke.
export function drawsPointer(type, { penSeen = false, drawing = false } = {}) {
  if (type === "pen") return true;
  if (type === "mouse") return true;
  if (type === "touch") return !penSeen && !drawing;
  return false;
}

export function pressureOf(type, pressure) {
  if (type === "mouse") return 0.5;
  return finite(pressure) && pressure > 0 ? Math.min(1, Math.max(0.05, pressure)) : 0.5;
}

// Eraser bite: drop the points inside the circle; the survivors become separate runs.
export function biteRuns(points, center, radius) {
  const runs = [];
  let current = null;
  for (const point of points) {
    if (Math.hypot(point[0] - center.x, point[1] - center.y) <= radius) { current = null; continue; }
    if (current) current.push(point);
    else { current = [point]; runs.push(current); }
  }
  return runs.filter(run => run.length >= 2);
}
