import { useEffect, useState } from "react";
import { host } from "../host";
import { Dialog } from "./Dialog";
import type { Preferences } from "../preferences";
import { ThemePicker } from "./ThemePicker";
import { BackgroundSettings } from "./BackgroundSettings";
import { FontSettings } from "./FontSettings";
import type { BackgroundAsset } from "../background";
import { t, languages, languageChoice, languageKey } from "../i18n";
export function PreferencesDialog({ value, change, theme, changeTheme, themes, installTheme, background, chooseBackground, clearBackground, plugins, close }: { value: Preferences; change(next: Preferences): void; theme: string; changeTheme(theme: string): void; themes: { id: string; name: string }[]; installTheme(): Promise<void>; background: BackgroundAsset | null; chooseBackground(): Promise<void>; clearBackground(): Promise<void>; plugins(): void; close(): void }) {
  const [conversion, setConversion] = useState<{ pandoc: string; word: boolean; libreOffice?: string }>({ pandoc: "", word: false }), [error, setError] = useState("");
  useEffect(() => { void host.conversionSettings().then(setConversion).catch(e => setError(e.message)); }, []);
  const options = [["imageAutoUpload", t("插入后通过 PicGo 自动上传")], ["remoteImages", t("显示远程图片")], ["imagePrefix", t("相对图片路径使用 ./ 前缀")], ["imageEscape", t("自动转义图片路径")], ["spellcheck", t("拼写检查")], ["autoPair", t("自动配对括号与引号")], ["highlight", t("高亮：==文字==")], ["subscript", t("下标：H~2~O")], ["superscript", t("上标：X^2^")], ["emoji", t("Emoji：:smile:")], ["inlineMath", t("行内公式：$x^2$")]] as const;
  async function changeLanguage(choice: string) {
    if (window.desktop?.setLanguage) { const result = await window.desktop.setLanguage(choice); if (!result?.ok) setError(result?.error || t("语言无效。")); return; }
    localStorage.setItem(languageKey, choice);
    location.reload();
  }
  return <Dialog title={t("偏好设置")} close={close}>
    <label className="workspace-field">{t("界面语言")}<select aria-label={t("界面语言")} value={languageChoice} onChange={e => void changeLanguage(e.target.value)}><option value="auto">{t("自动（跟随系统）")}</option>{languages.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
    <ThemePicker value={theme} change={changeTheme} custom={themes} install={async () => { try { await installTheme(); } catch (error) { setError((error as Error).message); } }} />
    <FontSettings value={value} change={change} changeTheme={changeTheme} />
    <BackgroundSettings asset={background} value={value} change={change} choose={chooseBackground} clear={clearBackground} />
    <fieldset><legend>{t("插件")}</legend><p className="dialog-note">{t("无图阅读、只读模式、段落聚焦与常显语法标记等社区插件。")}</p><button onClick={plugins}>{t("管理插件…")}</button></fieldset>
    <fieldset><legend>{t("编辑器")}</legend><div className="form-grid">
      <label>{t("正文字号")}<input type="number" min={12} max={28} value={value.fontSize} onChange={e => { const n = Number(e.target.value); if (n >= 12 && n <= 28) change({ ...value, fontSize: n }); }} /></label>
      <label>{t("阅读速度（词/分钟）")}<input type="number" min={50} max={1000} value={value.readingSpeed} onChange={e => { const n = Number(e.target.value); if (n >= 50 && n <= 1000) change({ ...value, readingSpeed: n }); }} /></label>
      <label>{t("缩进宽度")}<select aria-label={t("缩进宽度")} value={value.tabSize} onChange={e => change({ ...value, tabSize: Number(e.target.value) })}><option value={2}>{t("2 个空格")}</option><option value={4}>{t("4 个空格")}</option></select></label>
    </div></fieldset>
    <fieldset><legend>{t("输入与 Markdown 扩展")}</legend>{options.map(([key, label]) => <label className="checkbox-option" key={key}><input type="checkbox" checked={value[key]} onChange={e => change({ ...value, [key]: e.target.checked })} />{label}</label>)}</fieldset>
    <fieldset><legend>{t("图片")}</legend><label className="workspace-field">{t("复制图片到")}<input aria-label={t("复制图片到")} value={value.imageFolder} onChange={e => change({ ...value, imageFolder: e.target.value })} /></label><p className="dialog-note">{t("相对于文档的路径，支持 {{variable}}。文档 YAML 中的 typora-copy-images-to 优先。", { variable: "${filename}" })}</p><label className="workspace-field">{t("PicGo Server 地址")}<input aria-label={t("PicGo Server 地址")} value={value.imageUploader} onChange={e => change({ ...value, imageUploader: e.target.value })} /></label></fieldset>
    <fieldset><legend>{t("PDF 导出")}</legend><div className="form-grid"><label>{t("纸张")}<select aria-label={t("PDF 纸张")} value={value.pdfPaper} onChange={e => change({ ...value, pdfPaper: e.target.value as "a4" | "letter" })}><option value="a4">A4</option><option value="letter">US Letter</option></select></label><label>{t("页边距（点）")}<input aria-label={t("PDF 页边距")} type="number" min={18} max={100} value={value.pdfMargin} onChange={e => { const n = Number(e.target.value); if (n >= 18 && n <= 100) change({ ...value, pdfMargin: n }); }} /></label></div><label className="workspace-field">{t("页眉")}<input aria-label={t("PDF 页眉")} value={value.pdfHeader} onChange={e => change({ ...value, pdfHeader: e.target.value })} /></label><label className="workspace-field">{t("页脚")}<input aria-label={t("PDF 页脚")} value={value.pdfFooter} onChange={e => change({ ...value, pdfFooter: e.target.value })} /></label><p className="dialog-note">{t("可使用 {{title}}、{{pageNo}}、{{totalPages}} 和 {{date}}。", { title: "${title}", pageNo: "${pageNo}", totalPages: "${totalPages}", date: "${date}" })}</p></fieldset>
    <fieldset><legend>{t("导入导出")}</legend><p className="dialog-note">{conversion.word ? t("macOS 提供基础 Word / RTF 转换；安装 Pandoc 可保留更多结构及媒体。") : t("DOCX、ODT、EPUB 等格式使用 Pandoc。旧 DOC / RTF 导入还需要 LibreOffice。")}</p><p className="dialog-note workspace-path">{conversion.pandoc || t("尚未配置 Pandoc")}</p>{!conversion.word && <p className="dialog-note workspace-path">{conversion.libreOffice || t("未检测到 LibreOffice（仅旧 DOC / RTF 导入需要）")}</p>}<button onClick={() => void host.conversionSettings(true).then(setConversion).catch(e => setError(e.message))}>{t("选择 Pandoc…")}</button></fieldset>
    {error && <p role="alert" className="form-error">{error}</p>}
    <p className="dialog-note">{t("设置即时生效并保存在本机。关闭扩展不会修改文档源码。")}</p>
    <div className="dialog-actions"><button className="primary-button" onClick={close}>{t("完成")}</button></div>
  </Dialog>;
}
