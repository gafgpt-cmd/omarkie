import { useEffect, useState } from "react";
import { host } from "../host";
import { defaultFonts, fontChoices, type FontPreferences } from "../fonts";
import type { Preferences } from "../preferences";
import { t } from "../i18n";
export function FontSettings({ value, change, changeTheme }: { value: Preferences; change(next: Preferences): void; changeTheme(theme: string): void }) {
  const [omarchyFont, setOmarchyFont] = useState<string | null>(null);
  useEffect(() => { void host.omarchyTheme().then(palette => setOmarchyFont(palette?.font ?? null)).catch(() => {}); }, []);
  const choices = fontChoices(omarchyFont), groups = [["toypora", "Toypora"], ["toyzetlr", "Toyzetlr"], ["omarchy", "Omarchy"], ["system", t("系统")]] as const;
  const fields = [["documentFont", t("正文字体")], ["headingFont", t("标题字体")], ["codeFont", t("代码字体")], ["interfaceFont", t("界面字体")]] as const;
  const select = (key: keyof FontPreferences, label: string) => <label key={key}>{label}<select aria-label={label} value={value[key]} onChange={e => change({ ...value, [key]: e.target.value })}>
    <option value="theme">{t("跟随主题")}</option>
    {groups.map(([group, name]) => <optgroup key={group} label={name}>{choices.filter(font => font.group === group).map(font => <option key={font.id} value={font.id}>{font.name}</option>)}</optgroup>)}
  </select></label>;
  return <fieldset><legend>{t("字体")}</legend>
    <div className="form-grid">{fields.map(([key, label]) => select(key, label))}</div>
    {omarchyFont && <p className="dialog-note">{t("Omarchy 当前字体会随 omarchy-font-set 自动更新。")}</p>}
    <button type="button" className="background-reset" onClick={() => { changeTheme("toypora"); change({ ...value, ...defaultFonts, fontSize: 16 }); }}>{t("恢复 Toypora 经典阅读")}</button>
  </fieldset>;
}
