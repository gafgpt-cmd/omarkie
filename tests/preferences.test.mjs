import test from "node:test";
import assert from "node:assert/strict";
import { defaultPreferences, loadPreferences } from "../src/preferences.ts";
import { language } from "../src/i18n.ts";

test("spellcheck defaults include the interface language and English; saved language selections round-trip", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage"); let saved = "{}";
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => saved } });
  try {
    const locale = { en: "en-US", es: "es-ES", ca: "ca", ro: "ro-RO", zh: "zh-CN" }[language];
    assert.deepEqual(loadPreferences().spellcheckLanguages, [...new Set([locale, "en-US"])]);
    saved = JSON.stringify({ spellcheckLanguages: ["es-ES", "ca", "es-419", "sr-Latn-RS", "ca", 42, "../../invalid"] });
    assert.deepEqual(loadPreferences().spellcheckLanguages, ["es-ES", "ca", "es-419", "sr-Latn-RS"]);
    saved = JSON.stringify({ spellcheckLanguages: "es-ES" });
    assert.deepEqual(loadPreferences().spellcheckLanguages, defaultPreferences.spellcheckLanguages);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
