import { readingTheme, type Look } from "./toyporaTheme.ts";
import { t } from "./i18n.ts";
// Long-form academic writing: Literata text, Inter headings and chrome, a narrower measure, Zettlr-style green accent.
const inter = 'Inter,"Helvetica Neue",Arial,"Noto Color Emoji",sans-serif';
const shared = { text: 'Literata,Georgia,"Noto Color Emoji",serif', mono: '"JetBrains Mono","JetBrainsMono Nerd Font",ui-monospace,monospace', chrome: inter, headingFont: inter };
const extra = (accent: string, tint: string) => (scope: string) =>
  `${scope} .rich-document{max-width:760px;line-height:1.72}${scope} .cm-content{max-width:760px}`
  + `${scope} :is(.rich-document,.print-document) :is(h1,h2,h3,h4,h5,h6){font-weight:650;letter-spacing:-.018em;border-bottom-color:transparent!important}`
  + `${scope} :is(.rich-document,.print-document) h1{font-size:2.1em;margin-top:.6em}${scope} :is(.rich-document,.print-document) h2{padding-bottom:0}`
  + `${scope} .rich-document a{color:${accent};text-decoration:underline;text-decoration-color:color-mix(in srgb,${accent} 40%,transparent);text-underline-offset:3px}`
  + `${scope} .rich-document blockquote{border-left:3px solid ${accent};background:${tint};border-radius:0 6px 6px 0;padding:2px 16px;color:inherit}`
  + `${scope} .rich-document :not(pre)>code{color:${accent};background:${tint};border-color:transparent}`
  + `${scope} .rich-document mark{background:color-mix(in srgb,${accent} 22%,transparent);color:inherit;border-radius:2px}`
  + `${scope} .rich-document input[type=checkbox]{accent-color:${accent}}${scope} .rich-document hr{height:1px;background:var(--border);border:0}`
  + `${scope} .file-row.selected{box-shadow:inset 2px 0 ${accent}}`;
const light: Look = { ...shared, id: "toyzetlr", name: "Toyzetlr", description: t("学术写作：Literata · 绿色点缀"), dark: false, paper: "#fbfaf6", sidebar: "#f2f0e9", ink: "#26292b", muted: "#6b706d", border: "#e3e0d6", accent: "#18885f", code: "#f1efe8", quote: "#d8d4c8", selection: "#cdeedd", heading: "#1c3a31", extra: extra("#18885f", "#eef6f1") };
const night: Look = { ...shared, id: "toyzetlr-night", name: "Toyzetlr Night", description: t("学术写作 · 夜间"), dark: true, paper: "#1c2023", sidebar: "#16191c", ink: "#d7dcd8", muted: "#8e9792", border: "#2e3438", accent: "#45cf9a", code: "#252a2e", quote: "#34403b", selection: "#2c5244", heading: "#e9f0eb", extra: extra("#45cf9a", "#22302b") };
export const toyzetlrThemes = [readingTheme(light), readingTheme(night)];
