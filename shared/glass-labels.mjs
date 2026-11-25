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
