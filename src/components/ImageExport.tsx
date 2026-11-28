import { useState } from "react";
import { Dialog } from "./Dialog";
import { t } from "../i18n";

export type ImageChoice = { selection: boolean; scale: 1 | 2; light: boolean };

export function ImageExport({ selection, close, run }: { selection: boolean; close(): void; run(choice: ImageChoice): Promise<void> }) {
  const [choice, setChoice] = useState<ImageChoice>({ selection, scale: 2, light: false });
  return <Dialog title={t("Export image")} close={close}>
    <div className="form-grid">
      <label>{t("Content")}<select aria-label={t("Content")} value={choice.selection ? "selection" : "note"} onChange={e => setChoice({ ...choice, selection: e.target.value === "selection" })}><option value="note">{t("Whole note")}</option><option value="selection" disabled={!selection}>{t("Selected lines")}</option></select></label>
      <label>{t("Scale")}<select aria-label={t("Scale")} value={choice.scale} onChange={e => setChoice({ ...choice, scale: e.target.value === "2" ? 2 : 1 })}><option value={1}>1× · 800 px</option><option value={2}>2× · 1600 px</option></select></label>
      <label>{t("主题")}<select aria-label={t("主题")} value={choice.light ? "light" : "active"} onChange={e => setChoice({ ...choice, light: e.target.value === "light" })}><option value="active">{t("Current theme")}</option><option value="light">{t("简白")}</option></select></label>
    </div>
    <p className="dialog-note">{t("PNG at a fixed width, with images at their original resolution. Long notes: export PDF instead.")}</p>
    <div className="dialog-actions"><button onClick={close}>{t("取消")}</button><button className="primary-button" onClick={() => void run(choice)}>{t("导出")}</button></div>
  </Dialog>;
}
