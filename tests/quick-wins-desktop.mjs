import { _electron as electron, expect } from "playwright/test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const directory = await mkdtemp(path.join(os.tmpdir(), "omarkie-quick-wins-"));
const env = { ...process.env, OMARKIE_DATA_DIR: directory, OMARKIE_LANGUAGE: "zh" }; delete env.OMARKIE_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({ args: [process.cwd()], env });
try {
  const page = await application.firstWindow();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".document-editor:not([hidden]) .rich-document")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  const preferences = page.getByRole("dialog", { name: "偏好设置", exact: true });
  await expect(preferences).toBeVisible();
  for (const [id, name] of [["omarchy", "Omarchy（自动）"], ["toypora-omarchy", "Toypora 纸张 · Omarchy 标题"], ["omarchy-toypora", "Omarchy 配色 · Toypora 字体"]]) {
    await expect(preferences.getByLabel("主题", { exact: true }).locator(`option[value="${id}"]`)).toHaveText(name);
  }
  const available = await application.evaluate(({ session }) => session.defaultSession.availableSpellCheckerLanguages);
  const chosen = ["en-US", "es-ES", "ca"].filter(code => available.includes(code)).sort();
  await preferences.getByLabel("拼写检查语言").selectOption(chosen);
  await expect(preferences.getByLabel("拼写检查语言")).toHaveValues(chosen);
  await expect.poll(() => application.evaluate(({ session }) => session.defaultSession.getSpellCheckerLanguages())).toEqual(chosen);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("omarkie-preferences")).spellcheckLanguages)).toEqual(chosen);
  await preferences.getByRole("button", { name: "完成", exact: true }).click();
  await expect(preferences).toBeHidden();
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".document-editor:not([hidden]) .rich-document")).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("omarkie-preferences")).spellcheckLanguages)).toEqual(chosen);
  await expect.poll(() => application.evaluate(({ session }) => session.defaultSession.getSpellCheckerLanguages())).toEqual(chosen);
  const response = await page.evaluate(() => window.desktop.spellcheckLanguages(["invalid-language", "en-US"])); assert.equal(response.ok, true);
  assert.deepEqual(await application.evaluate(({ session }) => session.defaultSession.getSpellCheckerLanguages()), ["en-US"]);
  // Window content and remote dictionary hosts stay blocked.
  await assert.rejects(page.evaluate(() => fetch("https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic")));
  await page.getByRole("button", { name: "Omarkie", exact: true }).click();
  await page.getByRole("menuitem", { name: "关于 Omarkie", exact: true }).click();
  const build = await page.locator('meta[name="omarkie-build"]').getAttribute("content");
  await expect(page.locator(".about-details")).toContainText(`(${build})`);
} finally { await application.close(); }
