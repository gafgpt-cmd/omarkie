import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect } from "playwright/test";
import { languages } from "../shared/languages.mjs";
import { learningLabels, localeOrder } from "./fixtures/learning-labels.mjs";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";

const origin = "http://127.0.0.1:11434";
const pendingNotice = {
  en: "Resolve the pending reading move before editing reading history.",
  es: "Resuelve el traslado pendiente antes de editar el historial de lectura.",
  ca: "Resol el trasllat pendent abans d’editar l’historial de lectura.",
  ro: "Rezolvă mutarea în așteptare înainte de a edita istoricul de lectură.",
  zh: "请先处理尚未完成的移动，再编辑阅读记录。",
};
const payloadConsent = {
  en: [`Sends the selected text to ${origin}.`, `Sends this note’s text to ${origin}.`, "Do not send identifiable medical data. Even a local server can forward requests."],
  es: [`Envía el texto seleccionado a ${origin}.`, `Envía el texto de esta nota a ${origin}.`, "No envíes datos médicos identificables. Incluso un servidor local puede reenviar solicitudes."],
  ca: [`Envia el text seleccionat a ${origin}.`, `Envia el text d’aquesta nota a ${origin}.`, "No enviïs dades mèdiques identificables. Fins i tot un servidor local pot reenviar sol·licituds."],
  ro: [`Trimite textul selectat către ${origin}.`, `Trimite textul notei către ${origin}.`, "Nu trimite date medicale identificabile. Chiar și un server local poate redirecționa cereri."],
  zh: [`将选中的文字发送至 ${origin}。`, `将本笔记的文字发送至 ${origin}。`, "请勿发送可识别身份的医疗数据。本地服务器也可能转发请求。"],
};

for (const [language] of languages) {
  const [selectionNotice, noteNotice, medicalWarning] = payloadConsent[language];
  function label(key, args = {}) {
    const expected = learningLabels[key]?.[localeOrder.indexOf(language)];
    assert.ok(expected, `${language}: missing expected label ${key}`);
    return expected.replace(/{{(\w+)}}/g, (_, name) => {
      assert.ok(Object.hasOwn(args, name), `${language}: missing interpolation ${name}`);
      return args[name];
    });
  }
  const home = await mkdtemp(path.join(os.tmpdir(), `omarkie-learning-${language}-`));
  const vault = path.join(home, "vault"), file = path.join(vault, "locale.md");
  const excerpt = "A localized selection fixture.", content = `# Locale fixture\n\n${excerpt}\n\n==Highlight fixture==\n`;
  await mkdir(vault);
  await writeFile(file, content);
  const record = { id: "fixture", path: file, name: "locale.md", content, savedContent: content, diskHash: createHash("sha256").update(content).digest("hex"), lineEnding: "\n" };
  await writeFile(path.join(home, "session.json"), JSON.stringify({ version: 1, folder: vault, documents: [record], activeId: record.id }));
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: home, OMARKIE_LANGUAGE: language });
  delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL; delete env.OMARKIE_CLEAN_SCRIPT;
  delete env.OMARKIE_TTS;
  const application = await electron.launch({ args: [process.cwd(), ...headlessArguments], env });
  try {
    const page = await application.firstWindow();
    const rich = page.locator(".document-editor:not([hidden]) .rich-document");
    const button = (root, key, args) => root.getByRole("button", { name: label(key, args), exact: true });
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    await expect(rich.getByRole("heading", { name: "Locale fixture", exact: true })).toBeVisible();
    await button(page, "阅读图层").click();
    const rail = page.getByRole("complementary", { name: label("阅读图层"), exact: true });
    const margin = page.getByRole("complementary", { name: label("页边笔记"), exact: true });
    await expect(margin).toContainText(label("选择文本以添加页边笔记。"));
    await expect(button(margin, "导出笔记和卡片")).toBeVisible();
    const panel = page.getByRole("complementary", { name: label("Payload"), exact: true });
    await button(rail, "显示{{layer}}", { layer: label("问答摘要") }).click();
    await expect(panel).toContainText(label("Enable Payload"));
    await expect(button(panel, "Send question")).toBeDisabled();
    await button(panel, "Close Payload").click();
    await button(rail, "显示{{layer}}", { layer: label("清理") }).click();
    const clean = page.getByRole("region", { name: label("清理图层预览"), exact: true });
    await button(clean, "查看差异").click();
    await expect(clean.getByRole("heading", { name: label("清理前"), exact: true })).toBeVisible();
    await expect(button(clean, "应用到源文档")).toBeEnabled();
    await button(clean, "返回源文档").click();
    await button(rail, "显示{{layer}}", { layer: label("卡片") }).click();
    const cards = page.getByRole("complementary", { name: label("学习卡片"), exact: true });
    await expect(cards).toContainText(label("本笔记卡片：{{total}} / {{limit}}", { total: 0, limit: 10 }));
    await button(cards, "从高亮和笔记生成卡片").click();
    await expect(cards.getByRole("textbox", { name: label("答案"), exact: true })).toHaveValue("Highlight fixture");
    await expect(button(cards, "保存选中卡片")).toBeEnabled();
    const sidecar = path.join(vault, ".omarkie");
    await mkdir(sidecar, { recursive: true });
    const intent = { from: "locale.md", to: "moved.md", fingerprint: `0:${"0".repeat(64)}` };
    await writeFile(path.join(sidecar, "store.jsonl"), JSON.stringify({ v: 1, intent }) + "\n");
    await button(cards, "保存选中卡片").click();
    await expect(cards.getByRole("alert")).toHaveText(pendingNotice[language]);
    await cards.focus();
    await page.keyboard.press("Escape");
    await button(rail, "显示{{layer}}", { layer: label("卡片") }).click();
    await button(cards, "考考我").click();
    const review = page.getByRole("complementary", { name: label("考考我"), exact: true });
    await expect(review).toContainText(label("资料库没有到期的新卡或复习卡。"));
    await review.focus();
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+,");
    const preferences = page.getByRole("dialog");
    await preferences.getByLabel(label("Enable Payload")).check();
    await preferences.getByLabel(label("Payload model")).fill("locale-fixture");
    await expect(preferences.getByRole("option", { name: label("Off (natural size)"), exact: true })).toHaveCount(1);
    await expect(preferences.getByLabel(label("Standalone image scale limit"))).toHaveValue("2");
    await preferences.getByLabel(label("Enable on-demand grammar checks")).check();
    await expect(preferences.getByLabel(label("LanguageTool check URL"))).toHaveValue("http://127.0.0.1:8081/v2/check");
    await page.keyboard.press("Escape");
    const checkConsent = async notice => {
      await expect(panel.getByText(notice, { exact: true })).toBeVisible();
      await expect(panel.getByText(medicalWarning, { exact: true })).toBeVisible();
    };
    await button(page, "Payload").click();
    await checkConsent(noteNotice);
    await button(panel, "Close Payload").click();
    await rich.getByText(excerpt, { exact: true }).selectText();
    await page.keyboard.press("Alt+Enter");
    const selection = page.getByRole("dialog", { name: label("选区操作"), exact: true });
    await expect(button(selection, "给自己写笔记")).toBeEnabled();
    await expect(button(selection, "制作卡片")).toBeEnabled();
    await button(selection, "询问选中内容").click();
    await checkConsent(selectionNotice);
    await expect(panel.getByLabel(label("Ask one question about this text"))).toBeVisible();
    await expect(button(panel, "Send question")).toBeDisabled();
    await button(panel, "Close Payload").click();
    await button(rail, "关闭阅读图层").click();
    await button(page, "Check grammar…").click();
    const grammar = page.getByRole("dialog", { name: label("Send to LanguageTool?"), exact: true });
    await expect(button(grammar, "Send note")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator(".menu-container > button").click();
    await page.getByRole("menuitem", { name: label("朗读选区或段落"), exact: true }).click();
    await expect(page.locator(".toast")).toContainText(label("未配置朗读：请设置 OMARKIE_TTS。"));
    await page.locator(".menu-container > button").click();
    await page.getByRole("menuitem", { name: label("文档工具…"), exact: true }).click();
    const tools = page.getByRole("dialog", { name: label("文档工具"), exact: true });
    await button(tools, "写作与导出").click();
    await expect(button(tools, "关联 Zotero 自动导出")).toBeEnabled();
    await expect(button(tools, "导出项目为 {{format}}", { format: "DOCX" })).toBeEnabled();
    await expect(tools.getByRole("heading", { name: label("项目导出"), exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.locator(".menu-container > button").click();
    await page.getByRole("menuitem", { name: label("Collect highlights and callouts"), exact: true }).click();
    await expect(rich.getByRole("heading", { name: label("Reading summary"), exact: true })).toBeVisible();
    assert.equal(await readFile(file, "utf8"), content);
    console.log(`PASS: ${language} learning and reader controls match expected public labels`);
  } finally { await application.close(); }
}
