import type { Theme } from "./themes.ts";
import { t } from "./i18n.ts";
export interface Look { id: string; name: string; description: string; dark: boolean; paper: string; sidebar: string; ink: string; muted: string; border: string; accent: string; code: string; quote: string; selection: string; heading: string; text: string; mono: string; chrome: string; headingFont?: string; extra?: (scope: string) => string }
const sans = '"Open Sans","Clear Sans","Helvetica Neue",Helvetica,Arial,"Noto Color Emoji",sans-serif';
export function readingTheme(look: Look): Theme {
  const scope = `:root[data-theme="${look.id}"]`;
  const css = `:root[data-theme][data-appearance]{color-scheme:${look.dark ? "dark" : "light"};--paper:${look.paper};--sidebar:${look.sidebar};--ink:${look.ink};--muted:${look.muted};--border:${look.border};--heading-border:${look.border};--accent:${look.accent};--code:${look.code};--selected:${look.selection};--quote:${look.quote};--selection:${look.selection};--document-font:${look.text};--chrome-font:${look.chrome}}`
    + `.rich-document,.print-document{font-family:var(--document-font)}`
    + `${scope} :is(.rich-document,.print-document) :is(code,pre,.md-fence){font-family:${look.mono}}${scope} .source-mode .cm-scroller{font-family:${look.mono}!important}`
    + `${scope} :is(.rich-document,.print-document) :is(h1,h2,h3,h4,h5,h6){color:${look.heading}}${scope} .rich-document a{text-decoration:none}`
    + (look.headingFont ? `${scope} :is(.rich-document,.print-document,.cm-content) :is(h1,h2,h3,h4,h5,h6){font-family:${look.headingFont};font-weight:700;letter-spacing:-.01em}` : "")
    + (look.extra?.(scope) ?? "");
  return { id: look.id, name: look.name, description: look.description, dark: look.dark, paper: look.paper, ink: look.ink, accent: look.accent, css };
}
const classic = { id: "toypora", name: "Toypora", description: "", dark: false, paper: "#ffffff", sidebar: "#fafafa", ink: "#333333", muted: "#777777", border: "#eeeeee", accent: "#4183c4", code: "#f8f8f8", quote: "#dfe2e5", selection: "#b5d6fc", heading: "#333333", text: sans, mono: '"Lucida Console",Consolas,Courier,monospace', chrome: '"Open Sans","Helvetica Neue",Arial,"Noto Color Emoji",sans-serif' };
// Classic colours with Omarchy's fonts: the live Omarchy monospace for chrome, headings and code, Liberation Sans for text.
export function omarchyFontsTheme(font: string | null): Theme {
  const mono = `${font ? JSON.stringify(font) + "," : ""}"JetBrainsMono Nerd Font","JetBrains Mono",ui-monospace,monospace`;
  return readingTheme({ ...classic, id: "toypora-omarchy", name: "Toypora × Omarchy", description: t("Toypora 配色 · Omarchy 字体"), text: '"Liberation Sans",Arimo,Arial,"Noto Color Emoji",sans-serif', mono, chrome: mono, headingFont: mono });
}
// The classic reading set: Open Sans 16px, line height 1.6, 860px column (base styles), these colours and code faces.
export const toyporaThemes = [
  readingTheme({ ...classic, description: t("经典阅读：Open Sans · 白纸") }),
  readingTheme({ id: "toypora-night", name: "Toypora Night", description: t("经典阅读 · 夜间"), dark: true, paper: "#363b40", sidebar: "#2e3033", ink: "#b8bfc6", muted: "#9da2a6", border: "#474d54", accent: "#6dc1e7", code: "#333333", quote: "#474d54", selection: "#4a89dc", heading: "#dedede", text: '"Helvetica Neue",Helvetica,Arial,"Noto Color Emoji",sans-serif', mono: 'Monaco,Consolas,"Andale Mono","DejaVu Sans Mono",monospace', chrome: '"Helvetica Neue",Helvetica,Arial,"Noto Color Emoji",sans-serif' }),
  omarchyFontsTheme(null),
];
