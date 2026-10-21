const families = [
  ["Open Sans", () => import("./fontStyles/open-sans.ts")] as const,
  ["PT Serif", () => import("./fontStyles/pt-serif.ts")] as const,
  ["Lato", () => import("./fontStyles/lato.ts")] as const,
  ["Merriweather", () => import("./fontStyles/merriweather.ts")] as const,
  ["Vollkorn", () => import("./fontStyles/vollkorn.ts")] as const,
  ["Arimo", () => import("./fontStyles/arimo.ts")] as const,
  ["Tinos", () => import("./fontStyles/tinos.ts")] as const,
  ["JetBrains Mono", () => import("./fontStyles/jetbrains-mono.ts")] as const,
  ["Inter", () => import("./fontStyles/inter.ts")] as const,
  ["Literata", () => import("./fontStyles/literata.ts")] as const
];
const loaded = new Set<string>();
const pending = new Set<Promise<unknown>>();
export async function fontFacesReady() { await Promise.all([...pending]); }
export function loadFontFaces(css: string) {
  for (const [family, load] of families) if (css.includes(family) && !loaded.has(family)) { loaded.add(family); const loading = load().catch(() => loaded.delete(family)).finally(() => pending.delete(loading)); pending.add(loading); }
}
