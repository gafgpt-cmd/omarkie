import { createTranslator, resolveLanguage } from "../shared/i18n.mjs";

let current = createTranslator(resolveLanguage(process.env.OMARKIE_LANGUAGE || "zh"));
export const t = (key, options) => current(key, options);
export function useLanguage(language) { current = createTranslator(language); }
