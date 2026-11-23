import test from "node:test";
import assert from "node:assert/strict";
import { defaultPreferences, loadPreferences } from "../src/preferences.ts";
import { language } from "../src/i18n.ts";

test("reading preferences round-trip and reject invalid types and unsafe ranges", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage"); let saved = "{}";
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => saved } });
  try {
    saved = JSON.stringify({ lineHeight: 1.9, editorColumns: 96, fontSize: 21, sourceLineNumbers: true, codeLineNumbers: true });
    let preferences = loadPreferences(); assert.equal(preferences.lineHeight, 1.9); assert.equal(preferences.editorColumns, 96); assert.equal(preferences.fontSize, 21); assert.equal(preferences.sourceLineNumbers, true); assert.equal(preferences.codeLineNumbers, true);
    saved = JSON.stringify({ lineHeight: -3, editorColumns: 1e6, sourceLineNumbers: "true", codeLineNumbers: 1 }); preferences = loadPreferences();
    assert.equal(preferences.lineHeight, 1); assert.equal(preferences.editorColumns, 160); assert.equal(preferences.sourceLineNumbers, false); assert.equal(preferences.codeLineNumbers, false);
    for (const [scale, expected] of [[1, 1], [1.5, 1.5], [2, 2], [3, 2], [4, 2]]) {
      saved = JSON.stringify({ standaloneImageScale: scale });
      assert.equal(loadPreferences().standaloneImageScale, expected);
    }
  } finally { if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else Reflect.deleteProperty(globalThis, "localStorage"); }
});

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
