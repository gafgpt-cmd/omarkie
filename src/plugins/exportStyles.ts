import { adaptThemeCss } from "../themes.ts";
export const exportHelpers = new Map<string, { before?: (options: { type: string }) => unknown; failed(error: unknown): void }>();
export function pluginExportStyles(options: { type: string }) {
  let css = "";
  for (const helper of exportHelpers.values()) { try { const value = helper.before?.(options); if (typeof value === "string") css += value + "\n"; } catch (error) { helper.failed(error); } }
  return css ? adaptThemeCss(css).replace(/<\/style/gi, "<\\/style") : "";
}
