import { useEffect, useState } from "react";
import { host } from "../host";
import { defaultFonts, fontChoices, type FontPreferences } from "../fonts";
import type { Preferences } from "../preferences";
import { t } from "../i18n";
export function FontSettings({ value, change, changeTheme }: { value: Preferences; change(next: Preferences): void; changeTheme(theme: string): void }) {
  const [omarchyFont, setOmarchyFont] = useState<string | null>(null);
  const [localFonts, setLocalFonts] = useState<string[] | null>(null);
  useEffect(() => { void host.omarchyTheme().then(palette => setOmarchyFont(palette?.font ?? null)).catch(() => {}); }, []);
  useEffect(() => {
    let active = true;
    void Promise.all([["helvetica", "Helvetica Neue"], ["toypora-mono", "Lucida Console"], ...(omarchyFont ? [["omarchy", omarchyFont]] : [])].map(async ([id, family]) => {
      try { await new FontFace("omarkie-local-check", `local(${JSON.stringify(family)})`).load(); return id; }
      catch { return ""; }
    })).then(fonts => { if (active) setLocalFonts(fonts); });
    return () => { active = false; };
  }, [omarchyFont]);
  // Fonts the system lacks are hidden as new choices, but a saved choice stays selectable and saved; its stack falls back when rendered.
  const choices = fontChoices(omarchyFont), available = (font: { id: string }) => !["helvetica", "toypora-mono", "omarchy"].includes(font.id) || localFonts?.includes(font.id), groups = [["toypora", "Toypora"], ["toyzetlr", "Toyzetlr"], ["omarchy", "Omarchy"], ["system", t("系统")]] as const;
  const fields = [["documentFont", t("正文字体")], ["headingFont", t("标题字体")], ["codeFont", t("代码字体")], ["interfaceFont", t("界面字体")]] as const;
  const select = (key: keyof FontPreferences, label: string) => <label key={key}>{label}<select aria-label={label} value={value[key]} onChange={e => change({ ...value, [key]: e.target.value })}>
    <option value="theme">{t("跟随主题")}</option>
    {groups.map(([group, name]) => <optgroup key={group} label={name}>{choices.filter(font => font.group === group && (available(font) || font.id === value[key])).map(font => <option key={font.id} value={font.id}>{font.name}</option>)}</optgroup>)}
  </select></label>;
  return <fieldset><legend>{t("字体")}</legend>
    <div className="form-grid">{fields.map(([key, label]) => select(key, label))}</div>
    {omarchyFont && <p className="dialog-note">{t("Omarchy 当前字体会随 omarchy-font-set 自动更新。")}</p>}
    <button type="button" className="background-reset" onClick={() => { changeTheme("toypora"); change({ ...value, ...defaultFonts, fontSize: 16 }); }}>{t("恢复 Toypora 经典阅读")}</button>
  </fieldset>;
}
