import i18next from "i18next";
import en from "./locales/en.json" with { type: "json" };
import es from "./locales/es.json" with { type: "json" };
import ca from "./locales/ca.json" with { type: "json" };
import ro from "./locales/ro.json" with { type: "json" };

// The Chinese UI text is the key; zh needs no catalogue.
const resources = { en: { translation: en }, es: { translation: es }, ca: { translation: ca }, ro: { translation: ro } };
export const languages = [["en", "English"], ["es", "Español"], ["ca", "Català"], ["ro", "Română"], ["zh", "中文"]];
const supported = new Set(languages.map(([code]) => code));

export function resolveLanguage(choice, locales = []) {
  if (supported.has(choice)) return choice;
  for (const locale of locales) {
    const base = String(locale).toLowerCase().split(/[-_.]/)[0];
    if (supported.has(base)) return base;
  }
  return "en";
}

export function createTranslator(language) {
  const instance = i18next.createInstance();
  instance.init({
    lng: language, fallbackLng: language === "zh" ? false : "en", resources, initAsync: false,
    keySeparator: false, nsSeparator: false, returnEmptyString: false,
    // No nesting: messages may carry user text such as file names containing "$t(".
    interpolation: { escapeValue: false, nestingPrefix: `\u0000$t(`, nestingSuffix: `)\u0000` },
  });
  return instance.t.bind(instance);
}
