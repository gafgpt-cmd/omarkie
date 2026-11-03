import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The app ships its Hunspell dictionaries. Chromium looks in <profile>/Dictionaries before it
// downloads one, so they are placed there; a language the app lacks is requested from the app's
// own folder instead of Google's servers, and simply has no spellcheck.
export const dictionarySource = root => path.join(root, "dictionaries");
export function seedDictionaries(source, profile) {
  let names;
  try { names = readdirSync(source).filter(name => name.endsWith(".bdic")); } catch { return []; }
  const target = path.join(profile, "Dictionaries");
  mkdirSync(target, { recursive: true });
  for (const name of names) {
    const from = path.join(source, name), to = path.join(target, name);
    if (!existsSync(to) || statSync(to).size !== statSync(from).size) writeFileSync(to, readFileSync(from));
  }
  return names;
}
export const dictionaryDownloadURL = source => pathToFileURL(source).href.replace(/\/?$/, "/");
