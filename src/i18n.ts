import { createTranslator, resolveLanguage } from "../shared/i18n.mjs";
export { languages } from "../shared/i18n.mjs";

export const languageKey = "omarkie-language";
// Node test runs pin the language through the environment.
const forced: string | undefined = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.OMARKIE_LANGUAGE;
// The desktop main process owns the choice so native menus and the window agree.
const desktop: { language: string; choice: string } | null = typeof window !== "undefined" && window.desktop?.language ? window.desktop.language() : null;
export const languageChoice: string = forced || desktop?.choice || (typeof localStorage !== "undefined" && localStorage.getItem(languageKey)) || "auto";
export const language: string = forced ? resolveLanguage(forced) : desktop?.language || resolveLanguage(languageChoice, typeof navigator === "undefined" ? [] : [...(navigator.languages || []), navigator.language]);
export const t = createTranslator(language);
if (typeof document !== "undefined") document.documentElement.lang = language;
