import i18next from "i18next";
import { resolveLanguage } from "../shared/languages.mjs";
export { languages } from "../shared/languages.mjs";

export const languageKey = "omarkie-language";
// Node test runs pin the language through the environment.
const forced: string | undefined = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.OMARKIE_LANGUAGE;
// The desktop main process owns the choice so native menus and the window agree.
const desktop: { language: string; choice: string } | null = typeof window !== "undefined" && window.desktop?.language ? window.desktop.language() : null;
export const languageChoice: string = forced || desktop?.choice || (typeof localStorage !== "undefined" && localStorage.getItem(languageKey)) || "auto";
export const language: string = forced ? resolveLanguage(forced) : desktop?.language || resolveLanguage(languageChoice, typeof navigator === "undefined" ? [] : [...(navigator.languages || []), navigator.language]);
const catalogs: Record<string, () => Promise<{ default: Record<string, string> }>> = {
  en: () => import("../shared/locales/en.json", { with: { type: "json" } }), es: () => import("../shared/locales/es.json", { with: { type: "json" } }),
  ca: () => import("../shared/locales/ca.json", { with: { type: "json" } }), ro: () => import("../shared/locales/ro.json", { with: { type: "json" } }),
};
const translation = catalogs[language] ? (await catalogs[language]()).default : {};
const instance = i18next.createInstance();
instance.init({ lng: language, fallbackLng: false, resources: { [language]: { translation } }, initAsync: false,
  keySeparator: false, nsSeparator: false, returnEmptyString: false,
  interpolation: { escapeValue: false, nestingPrefix: `\u0000$t(`, nestingSuffix: `)\u0000` },
});
export const t = instance.t.bind(instance);
if (typeof document !== "undefined") document.documentElement.lang = language;
