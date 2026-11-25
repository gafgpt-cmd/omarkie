// Marks on the glass: the built-in sticker sheet and arrow ends.
// Shared by the renderer, the storage service and omarkie-axi so one vocabulary decides what exists.
import { validAnchor } from "./glass-core.mjs";

// Drawn in-repo as SVG paths (no third-party sticker pack, no network); emoji use the system font.
export const stickerIds = [
  "star", "check", "cross", "warning", "question", "heart",
  "number-1", "number-2", "number-3", "number-4", "number-5", "number-6", "number-7", "number-8", "number-9",
  "smile", "cool", "think", "fire", "bulb", "thumbs-up",
];
export const stickerLayer = "notes";
// A custom sticker travels in the journal as a data URL; small enough to stay one journal line.
export const customStickerBytes = 300_000;
const imageType = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;

export const arrowStyles = ["straight", "curved"];
export const arrowColors = ["ink", "red", "blue", "green"];
export const arrowHeads = ["solid", "open", "none"];

export function validStickerImage(value) {
  return typeof value === "string" && value.length <= customStickerBytes && imageType.test(value);
}

// An arrow end is a page element (by id, with its landmarks) or another magnet.
export function validArrowEnd(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.some(key => !["kind", "element", "anchor", "magnet"].includes(key))) return false;
  if (value.kind === "element")
    return typeof value.element === "string" && value.element.length > 0 && value.element.length <= 96 && validAnchor(value.anchor);
  if (value.kind === "magnet")
    return typeof value.magnet === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.magnet);
  return false;
}

export function arrowEndKey(end) {
  return end.kind === "element" ? `element:${end.element}` : `magnet:${end.magnet}`;
}
