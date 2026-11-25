// Snap, guides and glue: the one set of rules every magnet follows while it is picked up,
// shared by the renderer and omarkie-axi. No DOM here; callers pass boxes in one coordinate
// space (the glass frame for the app, offsets from the anchored paragraph for the agent).
export const snapDefaults = Object.freeze({
  grid: 8,
  sizes: [8, 16, 24],
  threshold: 6,
  lineThreshold: 12,
  spacing: 8,
  liftScale: 1.02,
  settleMs: 150,
});

const finite = value => typeof value === "number" && Number.isFinite(value);
const round = value => Math.round(value);

export function snapSetting(value) {
  if (!value || typeof value !== "object") return { on: true, size: snapDefaults.grid };
  return { on: value.on !== false, size: snapDefaults.sizes.includes(value.size) ? value.size : snapDefaults.grid };
}

export function gridValue(value, fallback = snapDefaults.grid) {
  return snapDefaults.sizes.includes(value) ? value : fallback;
}

function nearest(candidate, best) {
  if (!candidate) return best;
  if (!best || candidate.distance < best.distance - 0.001) return candidate;
  if (candidate.distance > best.distance + 0.001) return best;
  // Same distance: a real neighbour beats the page column, an edge beats a centre.
  const rank = item => item.kind === "column" ? 2 : item.kind === "center" ? 1 : 0;
  return rank(candidate) < rank(best) ? candidate : best;
}

// Other magnets and the page column, in frame coordinates.
function alignment({ box, others, column, threshold }) {
  const left = box.x, centre = box.x + box.w / 2, right = box.x + box.w;
  let best;
  for (const other of others) {
    const from = Math.min(box.y, other.y), to = Math.max(box.y + box.h, other.y + other.h);
    for (const [kind, edge] of [["edge", other.x], ["center", other.x + other.w / 2], ["edge", other.x + other.w]]) {
      for (const own of [left, centre, right]) {
        const delta = edge - own;
        if (Math.abs(delta) > threshold) continue;
        best = nearest({ distance: Math.abs(delta), delta, kind, at: edge, from, to }, best);
      }
    }
  }
  if (column) {
    for (const [edge, own] of [[column.left, left], [column.right, right]]) {
      if (!finite(edge)) continue;
      const delta = edge - own;
      if (Math.abs(delta) > threshold) continue;
      best = nearest({ distance: Math.abs(delta), delta, kind: "column", at: edge }, best);
    }
  }
  return best;
}

function gluing({ box, lines, threshold, lineThreshold, column }) {
  const top = box.y;
  let best;
  for (const line of lines) {
    if (!finite(line.y)) continue;
    const delta = line.y - top;
    if (Math.abs(delta) > lineThreshold) continue;
    const from = finite(line.x) ? line.x : column?.left ?? 0;
    const to = finite(line.x) && finite(line.width) ? line.x + line.width : column?.right ?? from;
    best = nearest({ distance: Math.abs(delta), delta, kind: "line", at: line.y, from, to }, best);
  }
  return best;
}

function edgesY({ box, others, threshold }) {
  const top = box.y, centre = box.y + box.h / 2, bottom = box.y + box.h;
  let best;
  for (const other of others) {
    const from = Math.min(box.x, other.x), to = Math.max(box.x + box.w, other.x + other.w);
    for (const [kind, edge] of [["edge", other.y], ["center", other.y + other.h / 2], ["edge", other.y + other.h]]) {
      for (const own of [top, centre, bottom]) {
        const delta = edge - own;
        if (Math.abs(delta) > threshold) continue;
        best = nearest({ distance: Math.abs(delta), delta, kind, at: edge, from, to }, best);
      }
    }
  }
  return best;
}

// A spacing hint: an even gap beside a neighbour on the same row, so the desk reads tidy.
function spacingHint({ box, others, spacing = snapDefaults.spacing }) {
  let best;
  for (const other of others) {
    const overlap = Math.min(box.y + box.h, other.y + other.h) - Math.max(box.y, other.y);
    if (overlap < 8) continue;
    for (const [gap, start] of [[box.x - (other.x + other.w), other.x + other.w], [other.x - (box.x + box.w), box.x + box.w]]) {
      if (gap < 0 || Math.abs(gap - spacing) > 2) continue;
      const distance = Math.abs(gap - spacing);
      if (best && best.distance <= distance) continue;
      best = { distance, gap, at: start, from: Math.max(box.y, other.y), to: Math.min(box.y + box.h, other.y + other.h) };
    }
  }
  return best;
}

// box and others: {x, y, w, h}. column: {left, right}. lines: [{y, x?, width?}] line tops.
export function snapBox({ box, others = [], column, lines = [], grid = snapDefaults.grid, threshold = snapDefaults.threshold,
  lineThreshold = snapDefaults.lineThreshold, spacing = snapDefaults.spacing, disabled = false }) {
  const step = snapDefaults.sizes.includes(grid) ? grid : grid === 0 ? 0 : snapDefaults.grid;
  if (disabled || !box || !finite(box.x) || !finite(box.y))
    return { x: finite(box?.x) ? box.x : 0, y: finite(box?.y) ? box.y : 0, guides: [], snapped: { x: false, y: false } };
  const x = alignment({ box, others, column, threshold });
  const y = nearest(gluing({ box, lines, threshold, lineThreshold, column }), edgesY({ box, others, threshold }));
  const gap = x ? undefined : spacingHint({ box, others, spacing });
  const next = {
    x: round(box.x + (x ? x.delta : 0)),
    y: round(box.y + (y ? y.delta : 0)),
  };
  if (!x && step) next.x = round(box.x / step) * step;
  if (!y && step) next.y = round(box.y / step) * step;
  const guides = [];
  if (x) guides.push({ axis: "x", kind: x.kind, at: round(x.at), from: x.from, to: x.to });
  else if (gap) guides.push({ axis: "x", kind: "spacing", at: round(gap.at), from: round(gap.from), to: round(gap.to), gap: Math.round(gap.gap) });
  if (y) guides.push({ axis: "y", kind: y.kind, at: round(y.at), from: y.from, to: y.to });
  return { x: next.x, y: next.y, guides, snapped: { x: Boolean(x), y: Boolean(y) } };
}

// Drop totals: how far the hand stopped from the snapped spot, for the settle ease.
export function settleDelta(from, to) {
  if (!from || !to) return { x: 0, y: 0 };
  return { x: round(to.x - from.x), y: round(to.y - from.y) };
}
