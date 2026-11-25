// Image labels: a pin plus a leader line plus text, anchored to an image magnet or a page image.
// Coordinates are normalised to the target box so resizing the picture never shears the label.
import { validAnchor } from "./glass-core.mjs";

export const labelDefaults = {
  textLimit: 240, offsetLimit: 4_000, minPin: 0, maxPin: 1, textMinWidth: 60, hitRadius: 14,
};
export const labelFieldNames = new Set(["kind", "target", "text", "nx", "ny", "dx", "dy", "hidden", "marked"]);

export function validLabelTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.some(key => !["kind", "element", "anchor", "magnet"].includes(key))) return false;
  if (value.kind === "magnet") return typeof value.magnet === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.magnet);
  if (value.kind === "element")
    return typeof value.element === "string" && value.element.length > 0 && value.element.length <= 96 && validAnchor(value.anchor);
  return false;
}

const finite = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

export function labelFields(fields, partial = false) {
  const values = {};
  for (const [field, value] of Object.entries(fields ?? {})) {
    if (!labelFieldNames.has(field)) throw new Error(`Unknown label field: ${field}.`);
    if (field === "kind") {
      if (value !== "label") throw new Error("A label keeps its kind.");
      values.kind = "label";
    } else if (field === "target") {
      if (!validLabelTarget(value)) throw new Error("A label needs an image magnet or a page image target.");
      values.target = value;
    } else if (field === "text") {
      if (typeof value !== "string" || value.length > labelDefaults.textLimit || value.includes("\u0000")) throw new Error("Label text must be up to 240 characters.");
      values.text = value;
    } else if (field === "nx" || field === "ny") {
      if (!finite(value, 0, 1)) throw new Error(`Label ${field} must be between 0 and 1.`);
      values[field] = value;
    } else if (field === "dx" || field === "dy") {
      if (!finite(value, -labelDefaults.offsetLimit, labelDefaults.offsetLimit)) throw new Error(`Label ${field} must be a number between -4,000 and 4,000.`);
      values[field] = Math.round(value);
    } else {
      if (typeof value !== "boolean") throw new Error(`Label ${field} must be true or false.`);
      values[field] = value;
    }
  }
  if (!partial) {
    if (!values.target) throw new Error("A label needs an image magnet or a page image target.");
    if (!values.text?.trim()) throw new Error("A label needs text.");
    values.nx ??= 0.5;
    values.ny ??= 0.5;
    values.dx ??= 18;
    values.dy ??= -14;
    values.hidden ??= false;
    values.marked ??= false;
  }
  return values;
}

// The pin position inside the target box; the leader line runs from the pin to the text.
export function labelPoint(box, nx, ny) {
  const x = finite(nx, 0, 1) ? nx : 0.5, y = finite(ny, 0, 1) ? ny : 0.5;
  return { x: box.x + x * box.width, y: box.y + y * box.height };
}

export function labelBox(pin, dx, dy) {
  const x = Math.round(dx || 0), y = Math.round(dy || 0);
  return { left: pin.x + x, top: pin.y + y, width: Math.max(labelDefaults.textMinWidth, 80) };
}
// G18 labels and reading order: shared by the export builder and the export dialog,
// so the cheatsheet order on screen is the order written to disk.
import { stickerName } from "./glass-art.mjs";

export const kindOf = magnet => magnet?.fields?.kind ?? magnet?.kind ?? "";

const label = (kind, fields) => {
  if (kind === "sticky") return String(fields.text ?? "").split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 60) || "Sticky note";
  if (kind === "comment") return "Comment";
  if (kind === "card") {
    const title = String(fields.title ?? "").trim();
    if (title) return title.slice(0, 60);
    return fields.card === "menu" ? "Menu card" : fields.card === "ai" ? "AI card" : "Card";
  }
  if (kind === "image") return String(fields.name ?? "").trim() || "Picture";
  if (kind === "ink") return "Ink";
  if (kind === "sticker") return stickerName(fields.sticker);
  if (kind === "arrow") return "Arrow";
  return kind ? `${kind} magnet` : "Magnet";
};
export const magnetLabel = (kind, fields = {}) => label(kind, fields);

export function sourceQuote(fields = {}) {
  const landmarks = Array.isArray(fields.anchor?.landmarks) ? fields.anchor.landmarks : [];
  const block = landmarks.find(landmark => landmark?.kind === "block" && typeof landmark.block === "string");
  if (block) return { quote: block.block.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 160) ?? "", line: block.line ?? null };
  const quote = landmarks.find(landmark => landmark?.kind === "quote" && typeof landmark.value?.exact === "string");
  if (quote) return { quote: quote.value.exact.split(/\r?\n/).find(line => line.trim())?.slice(0, 160) ?? "", line: null };
  if (fields.source && typeof fields.source.line === "number") return { quote: "", line: fields.source.line };
  return { quote: "", line: null };
}

export function anchorLine(fields = {}) {
  const source = sourceQuote(fields);
  if (source.line !== null) return source.line;
  const landmarks = Array.isArray(fields.anchor?.landmarks) ? fields.anchor.landmarks : [];
  const position = landmarks.find(landmark => landmark?.kind === "position");
  return position?.value?.line ?? Number.MAX_SAFE_INTEGER;
}

// Reading order: anchored paragraphs first, then the magnet offset inside its paragraph.
export function readingOrder(magnets) {
  return [...magnets].map((magnet, index) => ({ magnet, index })).sort((left, right) => {
    const line = anchorLine(left.magnet.fields) - anchorLine(right.magnet.fields);
    if (line) return line;
    const y = (Number(left.magnet.fields?.y) || 0) - (Number(right.magnet.fields?.y) || 0);
    if (y) return y;
    const x = (Number(left.magnet.fields?.x) || 0) - (Number(right.magnet.fields?.x) || 0);
    if (x) return x;
    return left.index - right.index;
  }).map(item => item.magnet);
}

function arrowEndLabel(end, magnets) {
  if (end?.kind === "magnet") {
    const magnet = magnets.find(item => item.id === end.magnet);
    if (!magnet) return `magnet ${end.magnet}`;
    return magnetLabel(kindOf(magnet), magnet.fields);
  }
  if (end?.kind === "element") return sourceQuote({ anchor: end.anchor }).quote || "page element";
  return "page element";
}

export function arrowConnections(magnets) {
  return magnets.filter(magnet => kindOf(magnet) === "arrow").map(magnet => ({
    magnet, from: arrowEndLabel(magnet.fields.from, magnets), to: arrowEndLabel(magnet.fields.to, magnets),
    label: String(magnet.fields.label ?? "").trim(),
  }));
}
