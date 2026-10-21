import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findKeys, getTranslations } from "i18next-cli";
import { createTranslator } from "../shared/i18n.mjs";

register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier.endsWith("?typora-plugin")) return { url: "data:text/javascript,export default () => ({})", shortCircuit: true };
  try { return await next(specifier, context); } catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error; return next(specifier + ".ts", context); }
}`)}`);
const { bundledPlugins } = await import("../src/plugins/catalog.ts");

// Forward slashes: the extractor takes glob patterns, and a URL pathname is "/D:/..." on Windows.
const root = fileURLToPath(new URL("..", import.meta.url)).replaceAll("\\", "/").replace(/\/$/, "");
const cjk = /[　-〿一-鿿＀-￯]/;
const languages = ["en", "es", "ca", "ro"];
const config = {
  locales: languages,
  extract: {
    input: ["src/**/*.{ts,tsx}", "electron/*.mjs", "shared/*.mjs"].map(pattern => `${root}/${pattern}`), ignore: [`${root}/src/demo/**`],
    output: `${root}/shared/locales/{{language}}.json`, functions: ["t"], defaultNS: false,
    keySeparator: false, nsSeparator: false, contextSeparator: "_", pluralSeparator: "_", extractFromComments: false,
  },
};
const quiet = { info() {}, warn() {}, error() {} };

// Strings reach t() as data too: command labels and titles, and the bundled plugins' display names.
async function dynamicKeys() {
  const keys = new Set(bundledPlugins.map(plugin => plugin.name));
  const walk = value => { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === "object") { for (const field of ["label", "title"]) if (typeof value[field] === "string" && cjk.test(value[field])) keys.add(value[field]); Object.values(value).forEach(walk); } };
  walk(JSON.parse(await readFile(path.join(root, "shared/commands.json"), "utf8")));
  return keys;
}
const placeholders = text => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort().join(",");

test("every UI string the i18next extractor finds has a complete translation in each language", async () => {
  const errors = [], { allKeys, objectKeys } = await findKeys(config, quiet, errors);
  assert.deepEqual(errors, []);
  assert.ok(allKeys.size > 500);
  assert.ok([...allKeys.values()].some(({ key }) => key === "文件_sidebar"), "context keys are extracted with the _ separator");
  const results = await getTranslations(allKeys, objectKeys, config, { logger: quiet }), extra = await dynamicKeys();
  assert.deepEqual(results.map(result => result.locale).sort(), [...languages].sort());
  assert.ok(extra.size > bundledPlugins.length);
  for (const { locale, newTranslations, existingTranslations: catalogue } of results) {
    for (const form of new Set([...Object.keys(newTranslations), ...extra])) {
      const value = catalogue[form];
      assert.equal(typeof value, "string", `${locale}: missing ${form}`);
      assert.equal(placeholders(value), placeholders(form), `${locale}: placeholders differ for ${form}`);
      assert.doesNotMatch(value.replace("中文", ""), cjk, `${locale}: Chinese left in ${form}`);
    }
    if (locale === "ro") assert.doesNotMatch(JSON.stringify(catalogue), /[şţŞŢ]/, "Romanian must use comma-below ș ț");
  }
  const forms = locale => Object.keys(results.find(result => result.locale === locale).newTranslations).filter(key => key.startsWith("{{count}} 词_")).sort();
  assert.deepEqual(forms("ro"), ["{{count}} 词_few", "{{count}} 词_one", "{{count}} 词_other"]);
  assert.deepEqual(forms("es"), ["{{count}} 词_many", "{{count}} 词_one", "{{count}} 词_other"]);
});

test("translator falls back to English, then to the source text", () => {
  assert.equal(createTranslator("zh")("保存"), "保存");
  assert.notEqual(createTranslator("ro")("保存"), "保存");
  assert.equal(createTranslator("es")("not a known key"), "not a known key");
  assert.match(createTranslator("ro")("{{count}} 词", { count: 20 }), /^20 de /);
});

test("messages carrying user text are shown verbatim", () => {
  assert.equal(createTranslator("en")("file $t(保存).md failed"), "file $t(保存).md failed");
});
