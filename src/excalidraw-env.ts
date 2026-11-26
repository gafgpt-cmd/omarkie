// Excalidraw's canvas fonts load from this local path. The app packages the MIT font files beside the
// renderer, so opening a board makes no CDN request. Packaged pages use the omarkie protocol because a
// file:// fetch cannot read local fonts and the library then falls back to its esm.sh CDN.
window.EXCALIDRAW_ASSET_PATH = window.location.protocol === "file:" ? "omarkie://app/excalidraw-assets/" : new URL("./excalidraw-assets/", window.location.href).href;

// Excalidraw appends its esm.sh CDN to every font source even when EXCALIDRAW_ASSET_PATH points at
// packaged fonts. Keep the local source and drop that fallback so opening a board never calls the CDN.
const NativeFontFace = window.FontFace;
window.FontFace = class extends NativeFontFace {
  constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
    super(family, typeof source === "string" ? source.split(/,\s*(?=url\()/).filter(part => !/esm\.sh/i.test(part)).join(", ") : source, descriptors);
  }
} as typeof FontFace;
declare global {
  interface Window { EXCALIDRAW_ASSET_PATH?: string }
}
export {};
