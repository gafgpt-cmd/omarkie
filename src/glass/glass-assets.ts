import { displayFile, displayNeeded, displaySize, type ImageWrap } from "../../shared/glass-images.mjs";
import type { GlassImage } from "./image-model";

// One read per magnet copy per session: the display copy is small, and a note with many
// photos must not ask the back end again on every scroll.
const sources = new Map<string, Promise<string | null>>();
const generated = new Set<string>();

async function glassCall(request: Record<string, unknown>) {
  const api = window.desktop?.glass;
  if (!api) throw new Error("Glass storage is not available here.");
  const reply = await api(request);
  if (!reply?.ok) throw new Error(reply?.error ?? "Glass storage refused the change.");
  return reply.value ?? {};
}

export function glassAsset(note: string | undefined, magnet: string, which: "display" | "original"): Promise<string | null> {
  const key = `${note ?? ""}|${magnet}|${which === "display" ? "d" : "o"}`;
  const cached = sources.get(key);
  if (cached) return cached;
  const run = (async () => {
    if (!note) return null;
    try {
      const value = await glassCall({ note, magnet, action: "asset", which });
      const url = typeof value.base64 === "string" && value.base64 ? `data:${value.mime ?? "image/png"};base64,${value.base64}` : null;
      if (!url) sources.delete(key);
      return url;
    } catch { sources.delete(key); return null; }
  })();
  sources.set(key, run);
  return run;
}

export function forgetGlassAsset(note: string | undefined, magnet: string) {
  for (const key of [...sources.keys()]) if (key.startsWith(`${note ?? ""}|${magnet}|`)) sources.delete(key);
  generated.delete(magnet);
}

// The page CSP blocks fetch on data: URLs, so decode the base64 we already hold.
function dataBlob(url: string): Blob | null {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) return null;
  const header = url.slice(5, comma);
  if (!header.includes("base64")) return null;
  const binary = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: header.split(";")[0] || "application/octet-stream" });
}

async function toBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (let index = 0; index < bytes.length; index += 32_768) text += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  return btoa(text);
}

// Chromium already decodes EXIF orientation. One decode; a light WebP is encoded only when `needed` says so.
export async function imageCopy(blob: Blob, needed: (size: { width: number; height: number }) => boolean) {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const width = bitmap.width, height = bitmap.height;
    if (!needed({ width, height })) return { width, height };
    const size = displaySize({ width, height });
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext("2d");
    if (!context) return { width, height };
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    let encoded = await canvas.convertToBlob({ type: "image/webp", quality: 0.84 });
    if (encoded.type !== "image/webp") encoded = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.84 });
    return { width, height, base64: await toBase64(encoded) };
  } catch { return null; }
  finally { bitmap?.close(); }
}

// A magnet added by an agent (or outside the renderer) has no light copy yet; make one once.
export async function ensureDisplayCopy(note: string | undefined, image: GlassImage, patch: (fields: Record<string, unknown>) => void) {
  if (!note || image.display || generated.has(image.id)) return;
  generated.add(image.id);
  const original = await glassAsset(note, image.id, "original");
  if (!original) { generated.delete(image.id); return; }
  // A compressed 24 MP photo is small on disk but slow to paint; the pixel count decides.
  const blob = dataBlob(original);
  if (!blob) { generated.delete(image.id); return; }
  const copy = await imageCopy(blob, size => displayNeeded({ ...size, bytes: image.bytes }));
  if (!copy?.base64) return;
  try {
    await glassCall({ note, action: "asset-display", magnet: image.id, base64: copy.base64 });
    forgetGlassAsset(note, image.id);
    patch({ display: displayFile(image.asset) });
  } catch { generated.delete(image.id); }
}

export function wrapLabel(wrap: ImageWrap) {
  return wrap === "left" ? "Wrap left" : wrap === "right" ? "Wrap right" : wrap === "behind" ? "Behind text" : "In front of text";
}
