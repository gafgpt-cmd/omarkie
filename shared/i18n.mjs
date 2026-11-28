import i18next from "i18next";
import { readFileSync } from "node:fs";
import { languages } from "./languages.mjs";

// Chinese source keys fall through; the small catalog covers English-keyed controls.
// Catalogs load on demand: a translator needs its own language and the English fallback only.
const known = new Set(languages.map(([code]) => code)), catalogs = new Map();
function catalog(code) {
  if (!catalogs.has(code)) catalogs.set(code, JSON.parse(readFileSync(new URL(`./locales/${code}.json`, import.meta.url), "utf8")));
  return catalogs.get(code);
}
export { languages, resolveLanguage } from "./languages.mjs";

export function createTranslator(language) {
  const instance = i18next.createInstance(), fallbackLng = language === "zh" ? false : "en";
  const resources = Object.fromEntries([...new Set([language, ...(fallbackLng ? [fallbackLng] : [])])].filter(code => known.has(code)).map(code => [code, { translation: catalog(code) }]));
  instance.init({
    lng: language, fallbackLng, resources, initAsync: false,
    keySeparator: false, nsSeparator: false, returnEmptyString: false,
    // No nesting: messages may carry user text such as file names containing "$t(".
    interpolation: { escapeValue: false, nestingPrefix: `\u0000$t(`, nestingSuffix: `)\u0000` },
  });
  return instance.t.bind(instance);
}
