// Glass image magnets: human asset names, EXIF-aware sizes, display copies and scrap migration.
// Pure functions only; electron/glass-service.mjs owns the disk.

import { sanitizeTitle, truncateBytes } from "./glass-core.mjs";

export const imageWraps = ["left", "right", "behind", "front"];
export const imageDefaults = {
  w: 320, minW: 48, maxW: 4000, minH: 40, maxH: 4000,
  maxBytes: 64 * 1024 * 1024, nameLimit: 200, fileLimit: 96,
  // A photo needs a light copy once it is big enough to stall a scroll.
  displayBytes: 2 * 1024 * 1024, displayPixels: 12_000_000, displayEdge: 2400, displayMax: 1600,
  rotateLimit: 360, offsetLimit: 200_000,
};
export const imageFieldNames = new Set(["kind", "name", "asset", "display", "bytes", "w", "h", "aspect",
  "rot", "wrap", "tape", "locked", "anchor", "x", "y"]);

const types = [
  ["png", "89504e470d0a1a0a"], ["jpeg", "ffd8ff"], ["gif", "47494638"], ["webp", "52494646"],
  ["avif", "00000018667479706176"], ["heic", "00000018667479706865"], ["tiff", "49492a00"], ["tiff", "4d4d002a"],
];
const extensions = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp", avif: "avif", heic: "heic", tiff: "tif" };
const mimes = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", heic: "image/heic", tiff: "image/tiff" };
// Chromium decodes these; anything else needs a converted display copy before it can be shown.
const previewable = new Set(["png", "jpeg", "gif", "webp", "avif"]);

// Runs in the browser as well as in Electron, so no Buffer here.
function hex(bytes) {
  if (typeof bytes === "string") return bytes.toLowerCase();
  if (!bytes) return "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const byte of view) text += byte.toString(16).padStart(2, "0");
  return text;
}

export function imageTypeOf(bytes) {
  const head = hex(bytes).slice(0, 32);
  if (!head) return null;
  const found = types.find(([, prefix]) => head.startsWith(prefix));
  if (found) return found[0];
  // ISO-BMFF brands sit at offset 8 ("ftyp"), so match the brand, not the size bytes.
  if (head.slice(8, 12) === "66747970") {
    const brand = head.slice(12, 16);
    if (["61766966", "61766973"].includes(brand)) return "avif";
    if (["68656963", "68656978", "68657663", "6d696631", "6d736631"].includes(brand)) return "heic";
  }
  // WebP: "RIFF....WEBP" carries the type at offset 8.
  if (head.slice(0, 8) === "52494646" && head.slice(16, 24) === "57454250") return "webp";
  return null;
}

export const extensionFor = type => extensions[type] ?? null;
export const mimeFor = type => mimes[type] ?? "application/octet-stream";
export const needsPreview = type => !previewable.has(type);
export const convertible = type => type === "heic" || type === "tiff";

// EXIF orientations 5-8 (and their mirrors) present the picture a quarter turn round.
export function orientationSize({ width, height, orientation } = {}) {
  const w = Number(width), h = Number(height);
  const safe = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { width: Math.round(w), height: Math.round(h) } : null;
  if (!safe) return null;
  return orientation >= 5 && orientation <= 8 ? { width: safe.height, height: safe.width } : safe;
}

export function displayNeeded({ width = 0, height = 0, bytes = 0, type } = {}) {
  if (type && needsPreview(type)) return true;
  if (bytes > imageDefaults.displayBytes) return true;
  if (width * height > imageDefaults.displayPixels) return true;
  return Math.max(width, height) > imageDefaults.displayEdge;
}

// Longest edge of the light copy; never enlarge.
export function displaySize({ width, height } = {}) {
  const longest = Math.max(Number(width) || 0, Number(height) || 0) || 1;
  const scale = Math.min(1, imageDefaults.displayMax / longest);
  return { width: Math.max(1, Math.round(longest * scale)), height: Math.max(1, Math.round((Number(height) || 1) * scale)) };
}

function stem(name) {
  return String(name ?? "").replace(/\.[A-Za-z0-9]{1,8}$/, "");
}

// A human name a person can read in the folder; duplicates get -2, -3 instead of a hash.
export function assetFile(wanted, extension, taken = new Set()) {
  const ext = extensionFor(extension) ?? extension;
  if (!ext || !/^[a-z0-9]{2,5}$/.test(ext)) throw new Error("Unknown image type.");
  const suffix = `-999.${ext}`;
  const base = truncateBytes(sanitizeTitle(stem(wanted) || "image"), imageDefaults.fileLimit - Buffer.byteLength(suffix)) || "image";
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}${index === 1 ? "" : `-${index}`}.${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("Too many images with that name.");
}

export function displayFile(asset) {
  const name = String(asset ?? "");
  const cut = name.lastIndexOf(".");
  const base = cut > 0 ? name.slice(0, cut) : name;
  return `${truncateBytes(base, imageDefaults.fileLimit)} ~display.webp`;
}

export const isAssetName = value => typeof value === "string" && value.length > 0 && value.length <= imageDefaults.fileLimit
  && !value.includes("\u0000") && !/[/\\]/.test(value) && value !== "." && value !== "..";

const finite = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

// The single normalizer both the service and the renderer round-trip through.
export function imageFields(input = {}, { partial = false } = {}) {
  const values = {};
  for (const [field, value] of Object.entries(input)) {
    if (!imageFieldNames.has(field)) throw new Error(`Unknown image magnet field: ${field}.`);
    switch (field) {
      case "kind":
        if (value !== "image") throw new Error("An image magnet keeps its kind.");
        values.kind = "image";
        break;
      case "name":
        if (typeof value !== "string" || !value.trim() || value.length > imageDefaults.nameLimit || value.includes("\u0000")) throw new Error("Image name must be text up to 200 characters.");
        values.name = value.trim();
        break;
      case "asset":
        if (!isAssetName(value)) throw new Error("Image asset must be a plain file name.");
        values.asset = value;
        break;
      case "display":
        if (value === null) { values.display = null; break; }
        if (!isAssetName(value)) throw new Error("Image display copy must be a plain file name.");
        values.display = value;
        break;
      case "bytes":
        if (!finite(value, 0, imageDefaults.maxBytes)) throw new Error("Image size must be a number of bytes.");
        values.bytes = Math.round(value);
        break;
      case "w":
      case "h": {
        const limits = field === "w" ? [imageDefaults.minW, imageDefaults.maxW] : [imageDefaults.minH, imageDefaults.maxH];
        if (!finite(value, limits[0], limits[1])) throw new Error(`Image ${field} must be between ${limits[0]} and ${limits[1]}.`);
        values[field] = Math.round(value);
        break;
      }
      case "aspect":
        if (!finite(value, 0.05, 20)) throw new Error("Image aspect must be a ratio between 0.05 and 20.");
        values.aspect = Math.round(value * 10_000) / 10_000;
        break;
      case "rot":
        if (!finite(value, -imageDefaults.rotateLimit, imageDefaults.rotateLimit)) throw new Error("Image rotation must be between -360 and 360 degrees.");
        values.rot = Math.round(value * 10) / 10;
        break;
      case "wrap":
        if (!imageWraps.includes(value)) throw new Error(`Image wrap must be one of: ${imageWraps.join(", ")}.`);
        values.wrap = value;
        break;
      case "tape":
      case "locked":
        if (typeof value !== "boolean") throw new Error(`Image ${field} must be true or false.`);
        values[field] = value;
        break;
      case "x":
      case "y":
        if (!finite(value, -imageDefaults.offsetLimit, imageDefaults.offsetLimit)) throw new Error(`Image ${field} must be a number between -200000 and 200000.`);
        values[field] = Math.round(value);
        break;
      case "anchor":
        if (!value || typeof value !== "object" || !Array.isArray(value.landmarks) || !value.landmarks.length) throw new Error("An image magnet needs an anchor.");
        values.anchor = value;
        break;
    }
  }
  if (partial) return values;
  if (values.kind === undefined) values.kind = "image";
  values.wrap ??= "left";
  values.rot ??= 0;
  values.tape ??= false;
  values.locked ??= false;
  values.x ??= 0;
  values.y ??= 0;
  values.w ??= imageDefaults.w;
  values.h ??= Math.max(imageDefaults.minH, Math.round(values.w / (values.aspect ?? 1)));
  values.bytes ??= 0;
  return values;
}

// Legacy Learning-mode image scraps become glass images unchanged; the scrap itself is never deleted.
export function scrapImageMagnet({ scrap, asset, width, height, blockText, headings = [], display = null } = {}) {
  if (!scrap?.id || !isAssetName(asset)) throw new Error("A scrap image needs an id and an asset.");
  const id = `m-scrap-${String(scrap.id).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 56)}`;
  const size = orientationSize({ width, height }) ?? { width: 240, height: 180 };
  const aspect = size.width / size.height;
  const w = Math.round(Math.min(imageDefaults.maxW, Math.max(imageDefaults.minW, Number(scrap.image?.width) || 240)));
  return {
    id,
    fields: {
      kind: "image",
      name: String(scrap.body || scrap.image?.name || "Image").slice(0, imageDefaults.nameLimit),
      asset, display, bytes: 0, w, h: Math.max(imageDefaults.minH, Math.round(w / aspect)), aspect: Math.round(aspect * 10_000) / 10_000,
      rot: 0, wrap: scrap.image?.side === "right" ? "right" : "left", tape: false, locked: false, x: 0, y: 0,
      anchor: { landmarks: [{ kind: "block", block: blockText, headings: [...headings].slice(0, 6), ...(Number.isInteger(scrap.anchor?.line) ? { line: scrap.anchor.line } : {}) }] },
    },
  };
}
