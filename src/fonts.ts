import { t } from "./i18n.ts";
export interface FontPreferences { documentFont: string; headingFont: string; codeFont: string; interfaceFont: string }
export interface FontChoice { id: string; name: string; group: "toypora" | "toyzetlr" | "omarchy" | "system"; stack: string }
const emoji = '"Noto Color Emoji"';
const jetbrains = '"JetBrainsMono Nerd Font","JetBrains Mono",ui-monospace';
const catalog: Omit<FontChoice, "name">[] = [
  { id: "open-sans", group: "toypora", stack: `"Open Sans","Clear Sans","Helvetica Neue",Helvetica,Arial,${emoji},sans-serif` },
  { id: "pt-serif", group: "toypora", stack: `"PT Serif","Times New Roman",Times,${emoji},serif` },
  { id: "merriweather", group: "toypora", stack: `Merriweather,"PT Serif",Georgia,"Times New Roman",${emoji},serif` },
  { id: "lato", group: "toypora", stack: `Lato,"Helvetica Neue",Helvetica,${emoji},sans-serif` },
  { id: "vollkorn", group: "toypora", stack: `Vollkorn,Palatino,Times,${emoji},serif` },
  { id: "helvetica", group: "toypora", stack: `"Helvetica Neue",Helvetica,Arial,${emoji},sans-serif` },
  { id: "toypora-mono", group: "toypora", stack: `"Lucida Console",Consolas,Courier,${emoji},monospace` },
  { id: "literata", group: "toyzetlr", stack: `Literata,Georgia,${emoji},serif` },
  { id: "inter", group: "toyzetlr", stack: `Inter,"Helvetica Neue",Arial,${emoji},sans-serif` },
  { id: "omarchy", group: "omarchy", stack: `${jetbrains},${emoji},monospace` },
  { id: "jetbrains-mono", group: "omarchy", stack: `${jetbrains},${emoji},monospace` },
  { id: "liberation-sans", group: "omarchy", stack: `"Liberation Sans",Arimo,Arial,${emoji},sans-serif` },
  { id: "liberation-serif", group: "omarchy", stack: `"Liberation Serif",Tinos,"Times New Roman",${emoji},serif` },
  { id: "sans-serif", group: "system", stack: `sans-serif,${emoji}` },
  { id: "serif", group: "system", stack: `serif,${emoji}` },
  { id: "monospace", group: "system", stack: `monospace,${emoji}` },
];
export const fontIds = ["theme", ...catalog.map(font => font.id)];
export const fontKeys = ["documentFont", "headingFont", "codeFont", "interfaceFont"] as const;
export const defaultFonts: FontPreferences = { documentFont: "theme", headingFont: "theme", codeFont: "theme", interfaceFont: "theme" };
// Everything outside the document; themes set --chrome-font, the default replaces the platform UI font.
export const chromeSelector = ".toolbar,.menu-bar,.sidebar,.statusbar,.quick-actions,.more-menu,.sidebar-switcher-menu,.file-context-menu,.rich-search,.cm-search,.table-tools,.toast,.leave-focus,.empty-document,.dialog-backdrop>*";
export const defaultChromeFont = `"Open Sans","Helvetica Neue",Arial,${emoji},sans-serif`;
export function fontChoices(omarchyFont: string | null): FontChoice[] {
  const names: Record<string, string> = {
    "open-sans": "Open Sans", literata: "Literata", inter: "Inter", "pt-serif": "PT Serif", merriweather: "Merriweather", lato: "Lato", vollkorn: "Vollkorn", helvetica: "Helvetica Neue",
    "toypora-mono": "Lucida Console", omarchy: t("Omarchy 当前字体（{{font}}）", { font: omarchyFont || "JetBrainsMono Nerd Font" }),
    "jetbrains-mono": "JetBrainsMono Nerd Font", "liberation-sans": "Liberation Sans", "liberation-serif": "Liberation Serif",
    "sans-serif": t("系统无衬线字体"), serif: t("系统衬线字体"), monospace: t("系统等宽字体"),
  };
  return catalog.map(font => ({ ...font, name: names[font.id], stack: font.id === "omarchy" && omarchyFont ? `${JSON.stringify(omarchyFont)},${font.stack}` : font.stack }));
}
// `:root:not(#_)` outranks every theme selector. The text rule targets the document roots only, so code blocks and source mode keep their own faces.
export function fontCss(fonts: FontPreferences, omarchyFont: string | null) {
  const choices = fontChoices(omarchyFont), stack = (id: string) => choices.find(font => font.id === id)?.stack;
  const scope = ":root:not(#_)", text = stack(fonts.documentFont), heading = stack(fonts.headingFont), code = stack(fonts.codeFont), chrome = stack(fonts.interfaceFont);
  return `${scope} :is(${chromeSelector}){font-family:var(--chrome-font,${defaultChromeFont})!important}` + (chrome ? `${scope}{--chrome-font:${chrome}}` : "")
    + (text ? `${scope}{--document-font:${text}}${scope} :is(.rich-document,.print-document){font-family:${text}!important}` : "")
    + (heading ? `${scope} :is(.rich-document,.print-document,.cm-content) :is(h1,h2,h3,h4,h5,h6){font-family:${heading}!important}` : "")
    + (code ? `${scope} :is(.rich-document,.print-document) :is(code,pre,.md-fence,.md-fence *,.md-fence-opening),${scope} .source-mode .cm-scroller{font-family:${code}!important}` : "");
}
export function applyFonts(fonts: FontPreferences, omarchyFont: string | null) {
  const style = document.createElement("style"); style.dataset.fontPreferences = "true"; style.dataset.customTheme = "true";
  style.textContent = fontCss(fonts, omarchyFont);
  document.head.append(style);
  return () => style.remove();
}
