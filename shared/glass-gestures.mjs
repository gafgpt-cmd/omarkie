// G17 smart ink: geometric gesture recognition over one pen stroke. No ML, no DOM.
// Thresholds are the G17 study's: 24 px minimum path, 16 px underline, 12 px closure slack,
// 0.12 * path length closure, 0.35 line-height flatness and 60% of points inside one text line.
// Nothing here decides what text a circle encloses; the renderer owns the DOM for that.
export const gestureDefaults = {
  minLength: 24,
  minPoints: 4,
  underline: { length: 16, flatness: 0.35, inside: 0.6 },
  circle: { slack: 12, factor: 0.12, tight: 0.06, area: 600, size: 12 },
  arrow: { length: 56, chord: 36, head: 34, turn: 18 },
  confident: 0.8,
};

const finite = value => typeof value === "number" && Number.isFinite(value);

export function pointsOf(points) {
  const out = [];
  for (const point of points ?? []) {
    const x = Array.isArray(point) ? point[0] : point?.x;
    const y = Array.isArray(point) ? point[1] : point?.y;
    if (finite(x) && finite(y)) out.push([x, y]);
  }
  return out;
}

export function pathLength(points) {
  let length = 0;
  for (let index = 1; index < points.length; index++)
    length += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
  return length;
}

export function bounds(points) {
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys),
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

export const centroid = points => {
  let x = 0, y = 0;
  for (const point of points) { x += point[0]; y += point[1]; }
  return { x: x / Math.max(1, points.length), y: y / Math.max(1, points.length) };
};

export const chordOf = points => points.length < 2 ? 0 : Math.hypot(points.at(-1)[0] - points[0][0], points.at(-1)[1] - points[0][1]);

// Shoelace area of the sampled path; a scribble that doubles back still has a real area,
// which is why closure alone never makes a circle.
export function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const [x1, y1] = points[index], [x2, y2] = points[(index + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSegment = (a, b, c) => Math.abs(cross(a, b, c)) < 0.001 && c[0] >= Math.min(a[0], b[0]) - 0.001 &&
  c[0] <= Math.max(a[0], b[0]) + 0.001 && c[1] >= Math.min(a[1], b[1]) - 0.001 && c[1] <= Math.max(a[1], b[1]) + 0.001;

function crossing(a, b, c, d) {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (d1 === 0 && onSegment(c, d, a)) || (d2 === 0 && onSegment(c, d, b)) ||
    (d3 === 0 && onSegment(a, b, c)) || (d4 === 0 && onSegment(a, b, d));
}

// Sampled so a dense stroke does not cost O(n^2): 96 segments is plenty to spot a lasso.
export function selfCrossings(points, limit = 96) {
  const step = Math.max(1, Math.ceil(points.length / limit));
  const sample = [];
  for (let index = 0; index < points.length; index += step) sample.push(points[index]);
  if (sample.at(-1) !== points.at(-1)) sample.push(points.at(-1));
  let crossings = 0;
  for (let i = 0; i < sample.length - 1; i++) {
    for (let j = i + 2; j < sample.length - 1; j++) {
      if (i === 0 && j === sample.length - 2) continue;
      if (crossing(sample[i], sample[i + 1], sample[j], sample[j + 1])) crossings += 1;
    }
  }
  return crossings;
}

// A recognisable head is two short back-segments: points on both sides of the approach
// axis, close to the tip and behind it. A plain line, curve or corner has none.
export function arrowHeadOf(points, options = gestureDefaults.arrow) {
  const n = points.length;
  if (n < 5) return { head: false, left: 0, right: 0, tip: undefined, base: 0 };
  const tip = points[n - 1];
  // The approach axis: walk back until at least `head` px behind the tip.
  let base = tip, index = n - 2;
  const reach = Math.max(12, options.head);
  for (; index >= 0; index--) {
    base = points[index];
    if (Math.hypot(tip[0] - base[0], tip[1] - base[1]) >= reach) break;
  }
  if (index < 0) return { head: false, left: 0, right: 0, tip, base: 0 };
  const ax = tip[0] - base[0], ay = tip[1] - base[1], axis = Math.hypot(ax, ay) || 1;
  let left = 0, right = 0;
  for (let i = Math.max(0, index); i < n; i++) {
    const [x, y] = points[i];
    const along = ((x - base[0]) * ax + (y - base[1]) * ay) / axis;
    if (along < 0 || along > axis + 2) continue;
    const side = ((x - base[0]) * ay - (y - base[1]) * ax) / axis;
    if (side >= 2.5) left += 1;
    else if (side <= -2.5) right += 1;
  }
  return { head: left >= 2 && right >= 2, left, right, tip, base: index };
}

function underline(lines, points, length, box, options) {
  if (length < options.length || !lines.length) return undefined;
  let best;
  for (const line of lines) {
    const top = line.top, bottom = line.bottom;
    if (!finite(top) || !finite(bottom) || bottom <= top) continue;
    const inside = points.filter(([, y]) => y >= top - 2 && y <= bottom + 2).length / points.length;
    const flat = box.height <= Math.max(6, options.flatness * (bottom - top));
    if (inside < options.inside || !flat) continue;
    const score = inside - Math.max(0, (box.height / Math.max(1, bottom - top)) * 0.5);
    if (!best || score > best.score) best = { score, inside, line, flat };
  }
  return best;
}

export function classifyGesture(raw, { lines = [] } = {}) {
  const points = pointsOf(raw);
  const none = reason => ({ kind: "none", confidence: 0, reason, points });
  if (points.length < gestureDefaults.minPoints) return none("too-few-points");
  const length = pathLength(points);
  if (length < gestureDefaults.minLength) return none("too-short");
  const box = bounds(points), chord = chordOf(points);

  // 1. Arrow: a tip with two back-segments, a real chord, and no lasso in the shaft.
  // The head's own back-and-forth may cross the shaft; only crossings behind it are a scribble.
  if (chord >= gestureDefaults.arrow.chord && length >= gestureDefaults.arrow.length) {
    const head = arrowHeadOf(points);
    if (head.head && selfCrossings(points.slice(0, head.base + 1)) === 0) {
      const straight = box.height < 8 || box.width < 8 || box.width / Math.max(1, box.height) >= 0.2;
      return { kind: "arrow", confidence: straight ? 0.88 : 0.82, reason: "head", points, length, chord, box, head };
    }
  }

  // 2. Underline: flat, long enough, mostly inside one text line.
  const band = underline(lines, points, length, box, gestureDefaults.underline);
  if (band) {
    const confidence = band.inside >= 0.8 && band.line.bottom - band.line.top >= box.height * 2 ? 0.9 : 0.68;
    return { kind: "underline", confidence, reason: "line", points, length, chord, box, band };
  }

  // 3. Circle: closed, non-trivial area, no self-crossing. Anything else stays ink.
  const slack = Math.max(gestureDefaults.circle.slack, gestureDefaults.circle.factor * length);
  const tight = Math.max(4, gestureDefaults.circle.tight * length);
  const area = polygonArea(points), crossings = selfCrossings(points);
  const size = Math.min(box.width, box.height);
  if (area >= gestureDefaults.circle.area && size >= gestureDefaults.circle.size && crossings <= 1) {
    if (chord <= tight) return { kind: "circle", confidence: 0.92, reason: "closed", points, length, chord, box, area, crossings };
    if (chord <= slack) return { kind: "circle", confidence: 0.7, reason: "loose", points, length, chord, box, area, crossings };
  }
  if (crossings > 1) return none("lasso");
  if (chord > slack) return none("open");
  return none("small");
}

// Renderer-side choice: an underline needs a text line to become a highlight, and a circle
// needs enclosed words to become a bubble. Recognition alone never converts ink.
export function gestureAction(result, { hasText = false, hasEnds = false } = {}) {
  if (!result || result.kind === "none") return "none";
  if (result.kind === "underline") return "highlight";
  if (result.kind === "arrow") return hasEnds ? "connector" : "none";
  return hasText ? "bubble" : "none";
}

export const gestureLabel = {
  bubble: "Circle → bubble",
  highlight: "Underline → highlight",
  connector: "Arrow → connector",
};
