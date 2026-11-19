import { language } from "./i18n.ts";
import { backgroundDefaults } from "./background.ts";
import { defaultFonts, fontIds, type FontPreferences } from "./fonts.ts";
export interface Preferences extends FontPreferences {
  imageUploader: string; imageAutoUpload: boolean;
  remoteImages: boolean; imageFolder: string; imagePrefix: boolean; imageEscape: boolean;
  pdfPaper: "a4" | "letter"; pdfMargin: number; pdfHeader: string; pdfFooter: string;
  readingSpeed: number;
  lineHeight: number; editorColumns: number; sourceLineNumbers: boolean; codeLineNumbers: boolean;
  fontSize: number; tabSize: number; spellcheck: boolean; spellcheckLanguages: string[]; autoPair: boolean;
  backgroundOpacity: number; backgroundBlur: number;
  backgroundPosition: "center" | "top" | "bottom" | "left" | "right";
  backgroundSize: "cover" | "contain" | "repeat";
  highlight: boolean; subscript: boolean; superscript: boolean; emoji: boolean; inlineMath: boolean;
}
export const defaultPreferences: Preferences = { ...backgroundDefaults, ...defaultFonts, imageUploader: "http://127.0.0.1:36677/upload", imageAutoUpload: false, remoteImages: false, imageFolder: ".assets", imagePrefix: false, imageEscape: true, pdfPaper: "a4", pdfMargin: 36, pdfHeader: "", pdfFooter: "", readingSpeed: 200, fontSize: 16, lineHeight: 1.6, editorColumns: 80, sourceLineNumbers: false, codeLineNumbers: false, tabSize: 2, spellcheck: true, spellcheckLanguages: [...new Set([({ en: "en-US", es: "es-ES", ca: "ca", ro: "ro-RO", zh: "zh-CN" } as Record<string,string>)[language] || "en-US", "en-US"])], autoPair: true, highlight: true, subscript: true, superscript: true, emoji: true, inlineMath: true };
export function loadPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem("omarkie-preferences") || "{}");
    const next = { ...defaultPreferences };
    if (Number.isFinite(saved.backgroundOpacity)) next.backgroundOpacity = Math.max(0,Math.min(100,saved.backgroundOpacity));
    if (Number.isFinite(saved.backgroundBlur)) next.backgroundBlur = Math.max(0,Math.min(30,saved.backgroundBlur));
    if (["center","top","bottom","left","right"].includes(saved.backgroundPosition)) next.backgroundPosition = saved.backgroundPosition;
    if (["cover","contain","repeat"].includes(saved.backgroundSize)) next.backgroundSize = saved.backgroundSize;
    for (const key of ["imageAutoUpload", "remoteImages", "imagePrefix", "imageEscape", "sourceLineNumbers", "codeLineNumbers", "spellcheck", "autoPair", "highlight", "subscript", "superscript", "emoji", "inlineMath"] as const) if (typeof saved[key] === "boolean") next[key] = saved[key];
    for (const key of ["imageUploader", "imageFolder", "pdfHeader", "pdfFooter"] as const) if (typeof saved[key] === "string" && saved[key].length <= 500) next[key] = saved[key];
    if (Array.isArray(saved.spellcheckLanguages)) next.spellcheckLanguages = [...new Set<string>(saved.spellcheckLanguages.filter((code: unknown) => typeof code === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(code)))].slice(0, 100);
    if (saved.pdfPaper === "letter") next.pdfPaper = "letter";
    if (Number.isFinite(saved.pdfMargin)) next.pdfMargin = Math.max(18, Math.min(100, saved.pdfMargin));
    if (Number.isFinite(saved.readingSpeed)) next.readingSpeed = Math.max(50, Math.min(1000, saved.readingSpeed));
    if (Number.isFinite(saved.fontSize)) next.fontSize = Math.max(12, Math.min(28, saved.fontSize));
    if (Number.isFinite(saved.lineHeight)) next.lineHeight = Math.max(1, Math.min(2.5, saved.lineHeight));
    if (Number.isFinite(saved.editorColumns)) next.editorColumns = Math.max(40, Math.min(160, Math.round(saved.editorColumns)));
    if ([2, 4].includes(saved.tabSize)) next.tabSize = saved.tabSize;
    for (const key of ["documentFont", "headingFont", "codeFont", "interfaceFont"] as const) if (fontIds.includes(saved[key])) next[key] = saved[key];
    return next;
  } catch { return { ...defaultPreferences }; }
}
