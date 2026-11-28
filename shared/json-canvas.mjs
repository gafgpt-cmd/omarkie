// JSON Canvas 1.0 (jsoncanvas.org): one plain JSON document is the board's only source of truth.
// Nodes and edges stay the objects read from disk, so key order and unknown keys survive every edit.

export const canvasLimits = { nodes: 4000, edges: 8000, bytes: 20 * 1024 * 1024, grid: 20, minSize: 40, maxSize: 20_000, coordinate: 10_000_000, label: 2000 };
export const canvasNodeTypes = ["text", "file", "link", "group"];
export const canvasSides = ["top", "right", "bottom", "left"];
export const canvasEnds = ["none", "arrow"];
export const canvasBackgroundStyles = ["cover", "ratio", "repeat"];
export const canvasPresets = ["1", "2", "3", "4", "5", "6"];
export const canvasExtension = /\.canvas$/i;

const record = value => !!value && typeof value === "object" && !Array.isArray(value);
const finite = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= canvasLimits.coordinate;
const optionalString = value => value === undefined || typeof value === "string";
const optionalOf = (value, allowed) => value === undefined || allowed.includes(value);
export const validCanvasColor = value => typeof value === "string" && (canvasPresets.includes(value) || /^#[0-9a-f]{6}$/i.test(value));

export class CanvasError extends Error {
  constructor(message, code = "CANVAS_INVALID") { super(message); this.code = code; }
}

// Returns why a node cannot be edited here, or null. Unknown types are kept but never rewritten.
function nodeProblem(node) {
  if (!record(node)) return "invalid-node";
  if (typeof node.id !== "string" || !node.id) return "invalid-node";
  if (typeof node.type !== "string") return "invalid-node";
  if (!["x", "y", "width", "height"].every(key => finite(node[key]))) return "invalid-node";
  if (node.width < 0 || node.height < 0) return "invalid-node";
  if (node.color !== undefined && !validCanvasColor(node.color)) return "invalid-node";
  if (!canvasNodeTypes.includes(node.type)) return "unknown-type";
  if (node.type === "text" && typeof node.text !== "string") return "invalid-node";
  if (node.type === "file" && (typeof node.file !== "string" || !optionalString(node.subpath) || node.subpath !== undefined && !node.subpath.startsWith("#"))) return "invalid-node";
  if (node.type === "link" && typeof node.url !== "string") return "invalid-node";
  if (node.type === "group" && (!optionalString(node.label) || !optionalString(node.background) || !optionalOf(node.backgroundStyle, canvasBackgroundStyles))) return "invalid-node";
  return null;
}

function edgeProblem(edge, ids) {
  if (!record(edge) || typeof edge.id !== "string" || !edge.id || typeof edge.fromNode !== "string" || typeof edge.toNode !== "string") return "invalid-edge";
  if (!optionalOf(edge.fromSide, canvasSides) || !optionalOf(edge.toSide, canvasSides) || !optionalOf(edge.fromEnd, canvasEnds) || !optionalOf(edge.toEnd, canvasEnds)) return "invalid-edge";
  if (edge.color !== undefined && !validCanvasColor(edge.color) || !optionalString(edge.label)) return "invalid-edge";
  if (!ids.has(edge.fromNode) || !ids.has(edge.toNode)) return "dangling-edge";
  return null;
}

// A board opens read-only when any part of it would be lost or reshaped by an edit.
// Dangling edges stay editable: they are kept verbatim and simply not drawn.
export function inspectCanvas(canvas) {
  const issues = [], ids = new Set();
  for (const node of canvas.nodes ?? []) {
    const problem = nodeProblem(node);
    const id = record(node) && typeof node.id === "string" ? node.id : undefined;
    if (problem) issues.push({ kind: problem, id, type: record(node) ? node.type : undefined });
    if (id !== undefined) {
      if (ids.has(id)) issues.push({ kind: "duplicate-id", id });
      ids.add(id);
    }
  }
  for (const edge of canvas.edges ?? []) {
    const problem = edgeProblem(edge, ids);
    const id = record(edge) && typeof edge.id === "string" ? edge.id : undefined;
    if (problem) issues.push({ kind: problem, id });
    if (id !== undefined) {
      if (ids.has(id)) issues.push({ kind: "duplicate-id", id });
      ids.add(id);
    }
  }
  return { issues, editable: issues.every(issue => issue.kind === "dangling-edge") };
}

export function parseCanvas(text) {
  if (typeof text !== "string") throw new CanvasError("The board is not text.");
  if (text.length > canvasLimits.bytes) throw new CanvasError("The board is larger than 20 MB.", "CANVAS_TOO_LARGE");
  let canvas;
  try { canvas = text.trim() ? JSON.parse(text) : {}; }
  catch { throw new CanvasError("The board is not valid JSON."); }
  if (!record(canvas)) throw new CanvasError("A JSON Canvas board must be a JSON object.");
  if (canvas.nodes !== undefined && !Array.isArray(canvas.nodes) || canvas.edges !== undefined && !Array.isArray(canvas.edges))
    throw new CanvasError("Board nodes and edges must be lists.");
  if ((canvas.nodes?.length ?? 0) > canvasLimits.nodes || (canvas.edges?.length ?? 0) > canvasLimits.edges)
    throw new CanvasError("The board has too many cards or connections.", "CANVAS_TOO_LARGE");
  return { canvas, ...inspectCanvas(canvas) };
}

// Obsidian writes tab-indented JSON; matching it keeps diffs small for people who use both apps.
export function serializeCanvas(canvas) {
  return JSON.stringify(canvas, null, "\t");
}

export const emptyCanvas = () => ({ nodes: [], edges: [] });
export const canvasNodes = canvas => canvas.nodes ?? [];
export const canvasEdges = canvas => canvas.edges ?? [];

export function newCanvasId(taken = new Set()) {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const id = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    if (!taken.has(id)) return id;
  }
}
export const canvasIds = canvas => new Set([...canvasNodes(canvas).map(node => node.id), ...canvasEdges(canvas).map(edge => edge.id)]);

export const snapToGrid = (value, grid = canvasLimits.grid) => Math.round(value / grid) * grid;
const size = value => Math.round(Math.min(canvasLimits.maxSize, Math.max(canvasLimits.minSize, value)));
const coordinate = value => Math.round(Math.min(canvasLimits.coordinate, Math.max(-canvasLimits.coordinate, value)));

function withNodes(canvas, nodes) { return nodes === canvas.nodes ? canvas : { ...canvas, nodes }; }

// One transaction for a whole gesture: every moved or resized node lands in a single new document.
export function setGeometry(canvas, changes) {
  let changed = false;
  const nodes = canvasNodes(canvas).map(node => {
    const change = changes[node.id];
    if (!change) return node;
    const next = { ...node };
    if (change.x !== undefined) next.x = coordinate(change.x);
    if (change.y !== undefined) next.y = coordinate(change.y);
    if (change.width !== undefined) next.width = size(change.width);
    if (change.height !== undefined) next.height = size(change.height);
    if (next.x === node.x && next.y === node.y && next.width === node.width && next.height === node.height) return node;
    changed = true;
    return next;
  });
  return changed ? withNodes(canvas, nodes) : canvas;
}

const inside = (inner, outer) => inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

// Nodes drawn above a group and fully inside it travel with it, as in Obsidian.
export function groupMembers(canvas, groupId) {
  const nodes = canvasNodes(canvas), index = nodes.findIndex(node => node.id === groupId);
  const group = nodes[index];
  if (!group || group.type !== "group") return [];
  return nodes.slice(index + 1).filter(node => inside(node, group)).map(node => node.id);
}

export function moveNodes(canvas, ids, dx, dy) {
  if (!dx && !dy) return canvas;
  const moving = new Set(ids);
  for (const id of ids) for (const member of groupMembers(canvas, id)) moving.add(member);
  const changes = {};
  for (const node of canvasNodes(canvas)) if (moving.has(node.id)) changes[node.id] = { x: node.x + dx, y: node.y + dy };
  return setGeometry(canvas, changes);
}

export function addNode(canvas, node) {
  if (nodeProblem(node)) throw new CanvasError("That card is not valid JSON Canvas.");
  if (canvasIds(canvas).has(node.id)) throw new CanvasError("That card id is already used.");
  if (canvasNodes(canvas).length >= canvasLimits.nodes) throw new CanvasError("The board has too many cards or connections.", "CANVAS_TOO_LARGE");
  return withNodes(canvas, [...canvasNodes(canvas), node]);
}

export function updateNode(canvas, id, patch) {
  let changed = false;
  const nodes = canvasNodes(canvas).map(node => {
    if (node.id !== id) return node;
    const next = { ...node };
    for (const [key, value] of Object.entries(patch)) {
      if (["id", "type"].includes(key)) continue;
      if (value === undefined) delete next[key]; else next[key] = value;
    }
    if (nodeProblem(next)) throw new CanvasError("That card is not valid JSON Canvas.");
    changed = JSON.stringify(next) !== JSON.stringify(node);
    return changed ? next : node;
  });
  return changed ? withNodes(canvas, nodes) : canvas;
}

export function addEdge(canvas, edge) {
  const ids = new Set(canvasNodes(canvas).map(node => node.id));
  if (edgeProblem(edge, ids)) throw new CanvasError("That connection is not valid JSON Canvas.");
  if (edge.fromNode === edge.toNode) throw new CanvasError("A card cannot connect to itself.");
  if (canvasIds(canvas).has(edge.id)) throw new CanvasError("That connection id is already used.");
  if (canvasEdges(canvas).some(other => other.fromNode === edge.fromNode && other.toNode === edge.toNode &&
    (other.fromSide ?? null) === (edge.fromSide ?? null) && (other.toSide ?? null) === (edge.toSide ?? null))) return canvas;
  if (canvasEdges(canvas).length >= canvasLimits.edges) throw new CanvasError("The board has too many cards or connections.", "CANVAS_TOO_LARGE");
  return { ...canvas, edges: [...canvasEdges(canvas), edge] };
}

export function updateEdge(canvas, id, patch) {
  const ids = new Set(canvasNodes(canvas).map(node => node.id));
  let changed = false;
  const edges = canvasEdges(canvas).map(edge => {
    if (edge.id !== id) return edge;
    const next = { ...edge };
    for (const [key, value] of Object.entries(patch)) {
      if (["id", "fromNode", "toNode"].includes(key)) continue;
      if (value === undefined) delete next[key]; else next[key] = value;
    }
    if (edgeProblem(next, ids)) throw new CanvasError("That connection is not valid JSON Canvas.");
    changed = JSON.stringify(next) !== JSON.stringify(edge);
    return changed ? next : edge;
  });
  return changed ? { ...canvas, edges } : canvas;
}

// Removing a card removes the connections drawn to it; connections already dangling on disk stay.
export function removeItems(canvas, nodeIds = [], edgeIds = []) {
  const nodes = new Set(nodeIds), edges = new Set(edgeIds);
  const keptNodes = canvasNodes(canvas).filter(node => !nodes.has(node.id));
  const keptEdges = canvasEdges(canvas).filter(edge => !edges.has(edge.id) && !nodes.has(edge.fromNode) && !nodes.has(edge.toNode));
  if (keptNodes.length === canvasNodes(canvas).length && keptEdges.length === canvasEdges(canvas).length) return canvas;
  return { ...canvas, ...(canvas.nodes ? { nodes: keptNodes } : {}), ...(canvas.edges ? { edges: keptEdges } : {}) };
}

export function nodeBounds(nodes) {
  if (!nodes.length) return null;
  const left = Math.min(...nodes.map(node => node.x)), top = Math.min(...nodes.map(node => node.y));
  const right = Math.max(...nodes.map(node => node.x + node.width)), bottom = Math.max(...nodes.map(node => node.y + node.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// The group goes directly below its lowest member so every member stays drawn above it.
export function groupNodes(canvas, ids, { id, label, padding = canvasLimits.grid * 2 } = {}) {
  const chosen = new Set(ids);
  const nodes = canvasNodes(canvas), members = nodes.filter(node => chosen.has(node.id));
  const bounds = nodeBounds(members);
  if (!bounds) throw new CanvasError("Select cards to group.");
  const group = {
    id: id ?? newCanvasId(canvasIds(canvas)), type: "group",
    x: coordinate(bounds.x - padding), y: coordinate(bounds.y - padding * 1.5),
    width: size(bounds.width + padding * 2), height: size(bounds.height + padding * 2.5),
    ...(label ? { label: label.slice(0, canvasLimits.label) } : {}),
  };
  const at = nodes.findIndex(node => chosen.has(node.id));
  return { canvas: withNodes(canvas, [...nodes.slice(0, at), group, ...nodes.slice(at)]), group };
}

export function bringToFront(canvas, ids) {
  const chosen = new Set(ids), nodes = canvasNodes(canvas);
  const next = [...nodes.filter(node => !chosen.has(node.id)), ...nodes.filter(node => chosen.has(node.id))];
  return next.every((node, index) => node === nodes[index]) ? canvas : withNodes(canvas, next);
}

// Undo history holds whole documents: each gesture commits one entry and undo restores it exactly.
export function canvasHistory(canvas) { return { canvas, past: [], future: [] }; }
export function commitCanvas(history, next, limit = 200) {
  if (next === history.canvas) return history;
  return { canvas: next, past: [...history.past, history.canvas].slice(-limit), future: [] };
}
export function undoCanvas(history) {
  if (!history.past.length) return history;
  return { canvas: history.past.at(-1), past: history.past.slice(0, -1), future: [history.canvas, ...history.future] };
}
export function redoCanvas(history) {
  if (!history.future.length) return history;
  return { canvas: history.future[0], past: [...history.past, history.canvas], future: history.future.slice(1) };
}

const fence = /^ {0,3}(`{3,}|~{3,})/;
const atx = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const headingKey = text => text.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();

// Headings outside fenced code, with the line each one starts on.
export function markdownHeadings(markdown) {
  const lines = markdown.split(/\r\n|\r|\n/), headings = [];
  let open = "";
  lines.forEach((line, index) => {
    const marker = line.match(fence)?.[1];
    if (open) { if (marker && marker[0] === open[0] && marker.length >= open.length && !line.slice(line.indexOf(marker) + marker.length).trim()) open = ""; return; }
    if (marker) { open = marker; return; }
    const heading = line.match(atx);
    if (heading) headings.push({ level: heading[1].length, text: heading[2].trim(), line: index });
  });
  return { lines, headings };
}

// A file node's subpath: "#Heading", "#Parent#Child" or "#^block". Locates the section's lines
// (0-based, end exclusive), or null when the target no longer exists.
export function locateSubpath(markdown, subpath) {
  const { lines, headings } = markdownHeadings(markdown);
  if (!subpath) return { lines, start: 0, end: lines.length };
  if (!subpath.startsWith("#")) return null;
  if (subpath.startsWith("#^")) {
    const id = subpath.slice(2);
    if (!/^[\w-]+$/.test(id)) return null;
    const marker = new RegExp(`(?:^|\\s)\\^${id}\\s*$`);
    const last = lines.findIndex(line => marker.test(line));
    if (last < 0) return null;
    let first = last;
    while (first > 0 && lines[first - 1].trim() && !atx.test(lines[first - 1])) first -= 1;
    return { lines, start: first, end: last + 1, marker };
  }
  const path = subpath.split("#").slice(1).map(headingKey).filter(Boolean);
  if (!path.length) return { lines, start: 0, end: lines.length };
  let from = 0, found;
  for (const segment of path) {
    found = headings.find(heading => heading.line >= from && headingKey(heading.text) === segment);
    if (!found) return null;
    from = found.line + 1;
  }
  const following = headings.find(heading => heading.line > found.line && heading.level <= found.level);
  return { lines, start: found.line, end: following ? following.line : lines.length };
}

// The section's Markdown for a file card, or null when the subpath no longer resolves.
export function canvasSubpath(markdown, subpath) {
  if (!subpath) return markdown;
  const found = locateSubpath(markdown, subpath);
  if (!found) return null;
  const { lines, start, end, marker } = found;
  if (marker) return [...lines.slice(start, end - 1), lines[end - 1].replace(marker, "")].join("\n").trim();
  return lines.slice(start, end).join("\n").trimEnd();
}
