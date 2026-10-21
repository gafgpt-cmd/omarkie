import type { Theme } from "./themes.ts";
import { t } from "./i18n.ts";
export interface OmarchyPalette { mode: "dark" | "light"; colors: Record<string, string>; font: string | null }
// Omarchy's bundled Tokyo Night and Flexoki Light; the live theme falls back to Tokyo Night off Omarchy.
const omarchyLight: OmarchyPalette = { mode: "light", font: null, colors: { background: "#fffcf0", dark_background: "#f2efe4", lighter_background: "#e6e4d9", foreground: "#100f0f", dark_foreground: "#878580", bright_foreground: "#100f0f", accent: "#205ea6", selection: "#cecdc3", muted: "#b7b5ac", red: "#d14d41", yellow: "#d0a215", orange: "#d0772b", green: "#879a39", cyan: "#3aa99f", blue: "#205ea6", magenta: "#ce5d97" } };
const rosePine: OmarchyPalette = { mode: "dark", font: null, colors: { background: "#191724", dark_background: "#1f1d2e", lighter_background: "#26233a", foreground: "#e0def4", dark_foreground: "#6e6a86", bright_foreground: "#e0def4", accent: "#9ccfd8", selection: "#403d52", muted: "#524f67", red: "#eb6f92", yellow: "#f6c177", orange: "#ebbcba", green: "#31748f", cyan: "#ebbcba", blue: "#9ccfd8", magenta: "#c4a7e7" } };
const rosePineDawn: OmarchyPalette = { mode: "light", font: null, colors: { background: "#faf4ed", dark_background: "#ede7e1", lighter_background: "#f2e9e1", foreground: "#575279", dark_foreground: "#9893a5", bright_foreground: "#575279", accent: "#56949f", selection: "#dfdad9", muted: "#cecacd", red: "#b4637a", yellow: "#ea9d34", orange: "#cf8057", green: "#286983", cyan: "#d7827e", blue: "#56949f", magenta: "#907aa9" } };
const omarchyDefault: OmarchyPalette = { mode: "dark", font: null, colors: { background: "#1a1b26", dark_background: "#13141c", lighter_background: "#24283b", foreground: "#a9b1d6", dark_foreground: "#565f89", bright_foreground: "#c0caf5", accent: "#7aa2f7", selection: "#292e42", muted: "#414868", red: "#f7768e", yellow: "#e0af68", orange: "#eb927b", green: "#9ece6a", cyan: "#449dab", blue: "#7aa2f7", magenta: "#ad8ee6" } };
function colors(palette: OmarchyPalette) {
  const dark = palette.mode !== "light", base = (dark ? omarchyDefault : omarchyLight).colors;
  const c: Record<string, string> = { ...base, orange: palette.colors.yellow || base.orange, ...palette.colors };
  const mix = (color: string, amount: number) => `color-mix(in srgb,${color} ${amount}%,${c.background})`;
  const vars = `color-scheme:${dark ? "dark" : "light"};--paper:${c.background};--sidebar:${c.dark_background || c.background};--ink:${c.foreground};--muted:${mix(c.foreground, 62)};--border:${mix(c.foreground, 14)};--heading-border:${mix(c.foreground, 14)};--accent:${c.accent};--code:${dark ? c.lighter_background : mix(c.foreground, 5)};--selected:${mix(c.accent, 16)};--quote:${mix(c.foreground, 18)};--selection:${mix(c.accent, 32)}`;
  return { dark, c, mix, vars };
}
export function omarchyTheme(palette: OmarchyPalette = omarchyDefault, id = "omarchy", name = "Omarchy", description = t("跟随 Omarchy 当前主题")): Theme {
  const { dark, c, mix, vars } = colors(palette);
  const mono = `${palette.font ? JSON.stringify(palette.font) + "," : ""}"JetBrainsMono Nerd Font","JetBrains Mono",ui-monospace,monospace`;
  const scope = ':root[data-theme^="omarchy"]';
  const css = `:root[data-theme][data-appearance]{${vars};--chrome-font:${mono};--document-font:${mono}}`
    + `.rich-document,.print-document{font-family:var(--document-font)}`
    + `${scope} :is(.toolbar,.sidebar,.statusbar,.quick-actions,.more-menu,.sidebar-switcher-menu,.rich-search,.cm-search,.table-tools,.toast,.leave-focus,.empty-document,.dialog-backdrop>*){font-family:var(--chrome-font)}`
    + `${scope} :is(.rich-document,.cm-content) :is(h1,h2,h3,h4,h5,h6){font-family:${mono};font-weight:700;letter-spacing:-.01em}`
    + `${scope} :is(.rich-document,.print-document) :is(code,pre,.md-fence,.md-fence *,.md-fence-opening),${scope} .source-mode .cm-scroller{font-family:${mono}!important}`
    + `${scope} .rich-document h1{color:${c.red}}${scope} .rich-document h2{color:${c.green}}${scope} .rich-document h3{color:${c.yellow}}${scope} .rich-document h4{color:${c.blue}}${scope} .rich-document :is(h5,h6){color:${c.magenta}}`
    + `${scope} .rich-document a{color:${c.blue}}${scope} .rich-document strong{color:${c.bright_foreground || c.foreground}}${scope} .rich-document :is(h1,h2,h3,h4,h5,h6) strong{color:inherit}${scope} .rich-document mark{background:${mix(c.yellow, 30)};color:inherit}`
    + `${scope} .rich-document :not(pre)>code{color:${c.cyan};border-color:transparent}${scope} .rich-document .md-meta{color:${mix(c.foreground, 50)}}`
    + `${scope} .rich-document blockquote{border-left:3px solid ${c.accent};background:${mix(c.accent, 5)};padding:1px 15px}`
    + `${scope} .rich-document{caret-color:${c.accent}}${scope} .rich-document hr{height:1px}`
    + `${scope} .hljs-keyword,${scope} .hljs-selector-tag,${scope} .hljs-built_in{color:${c.magenta}}${scope} .hljs-string{color:${c.green}}${scope} .hljs-title{color:${c.blue}}${scope} .hljs-number,${scope} .hljs-literal{color:${c.orange}}${scope} .hljs-comment{color:${mix(c.foreground, 50)};font-style:italic}`
    + `${scope} *{border-radius:0!important}${scope} .dirty-dot{border-radius:50%!important;background:${c.accent}}`
    + `${scope} .file-row.selected{box-shadow:inset 2px 0 ${c.accent}}${scope} .document-title{color:${mix(c.foreground, 50)}}`
    + `${scope} :is(.toast,.more-menu,.sidebar-switcher-menu,.table-tools,.about-dialog,.leave-focus){border:2px solid ${c.accent};box-shadow:none}${scope} .toast{background:${c.background};color:${c.foreground}}`
    + `${scope} ::-webkit-scrollbar{width:8px;height:8px}${scope} ::-webkit-scrollbar-thumb{background:${mix(c.foreground, 18)}}${scope} ::-webkit-scrollbar-track{background:transparent}`;
  return { id, name, description, dark, paper: c.background, ink: c.foreground, accent: c.accent, css };
}
// Omarchy colours with the classic reading fonts: Open Sans, plain headings, default chrome and corners.
export function toyporaOmarchyTheme(palette: OmarchyPalette = omarchyDefault): Theme {
  const { dark, c, vars } = colors(palette), scope = ':root[data-theme="omarchy-toypora"]';
  const css = `:root[data-theme][data-appearance]{${vars};--document-font:"Open Sans","Clear Sans","Helvetica Neue",Helvetica,Arial,"Noto Color Emoji",sans-serif;--chrome-font:"Open Sans","Helvetica Neue",Arial,"Noto Color Emoji",sans-serif}`
    + `.rich-document,.print-document{font-family:var(--document-font)}${scope} :is(.rich-document,.print-document) :is(code,pre,.md-fence){font-family:"Lucida Console",Consolas,Courier,monospace}`
    + `${scope} .rich-document a{color:${c.accent};text-decoration:none}${scope} .rich-document{caret-color:${c.accent}}`;
  return { id: "omarchy-toypora", name: "Omarchy × Toypora", description: t("Omarchy 配色 · Toypora 字体"), dark, paper: c.background, ink: c.foreground, accent: c.accent, css };
}
export const omarchyThemes = [
  omarchyTheme(),
  toyporaOmarchyTheme(),
  omarchyTheme(omarchyDefault, "omarchy-dark", "Omarchy Dark", "Tokyo Night"),
  omarchyTheme(omarchyLight, "omarchy-light", "Omarchy Light", "Flexoki Light"),
  omarchyTheme(rosePine, "omarchy-rose-pine", "Rosé Pine", "Omarchy · Rosé Pine"),
  omarchyTheme(rosePineDawn, "omarchy-rose-pine-dawn", "Rosé Pine Dawn", "Omarchy · Rosé Pine Dawn"),
];
export function toggledTheme(id: string, liveDark = true) {
  if (id === "omarchy-toypora") return liveDark ? "omarchy-light" : "omarchy-dark";
  if (id === "toypora-omarchy") return "toypora-night";
  if (id.startsWith("toyzetlr")) return id === "toyzetlr" ? "toyzetlr-night" : "toyzetlr";
  if (id.startsWith("toypora")) return id === "toypora" ? "toypora-night" : "toypora";
  if (id === "omarchy") return liveDark ? "omarchy-light" : "omarchy-dark";
  if (id.startsWith("omarchy-rose-pine")) return id === "omarchy-rose-pine" ? "omarchy-rose-pine-dawn" : "omarchy-rose-pine";
  if (id.startsWith("omarchy")) return id === "omarchy-light" ? "omarchy-dark" : "omarchy-light";
  return id === "dark" ? "light" : "dark";
}
