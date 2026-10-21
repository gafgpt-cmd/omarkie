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

