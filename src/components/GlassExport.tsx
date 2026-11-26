import { useEffect, useMemo, useState } from "react";
import { Dialog } from "./Dialog";
import { t } from "../i18n";
import { host } from "../host";
import { magnetLabel, kindOf, readingOrder } from "../../shared/glass-labels.mjs";
import "./glass-export.css";

type Mode = "page" | "flat" | "handout" | "cheatsheet" | "bundle";
type Magnet = { id: string; fields: Record<string, unknown>; kind?: string | null };
const modes: Mode[] = ["page", "flat", "handout", "cheatsheet", "bundle"];
const modeLabel: Record<Mode, string> = { page: "仅页面", flat: "页面与玻璃", handout: "玻璃讲义", cheatsheet: "速查表", bundle: "玻璃导出包" };

// G18: one dialog for every scope. Markdown goes through the export module; PDF uses the
// same print path as Export PDF, with the glass scope painted into the print document.
export function GlassExport({ note, close, pdf }: {
  note: string; close(): void;
  pdf(scope: "page" | "flat" | "handout"): Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>("flat"), [format, setFormat] = useState<"markdown" | "pdf">("markdown");
  const [target, setTarget] = useState<"github" | "obsidian">("github");
  const [magnets, setMagnets] = useState<Magnet[]>([]), [order, setOrder] = useState<string[]>([]);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => {
    if (!note || !host.glass) { setMessage(t("先保存文档，玻璃才能导出。")); return; }
    let live = true;
    void host.glass({ action: "list", note }).then(value => {
      if (!live) return;
      const list = (Array.isArray(value?.magnets) ? value.magnets : []).filter((magnet: Magnet & { deleted?: boolean }) => !magnet.deleted) as Magnet[];
      const ordered = readingOrder(list);
      setMagnets(ordered);
      setOrder(ordered.map(magnet => magnet.id));
      setIncluded(new Set(ordered.map(magnet => magnet.id)));
    }, error => { if (live) setMessage(t((error as Error).message)); });
    return () => { live = false; };
  }, [note]);
  const byId = useMemo(() => new Map(magnets.map(magnet => [magnet.id, magnet])), [magnets]);
  const canPdf = mode !== "cheatsheet" && mode !== "bundle";
  const ordered = order.flatMap(id => byId.get(id) ?? []);
  function reorder(from: number, to: number) {
    if (from === to) return;
    setOrder(current => { const next = [...current], [item] = next.splice(from, 1); next.splice(to, 0, item); return next; });
  }
  async function run(task: () => Promise<unknown>) {
    setBusy(true); setMessage("");
    try { await task(); } catch (error) { setMessage(t((error as Error).message)); }
    finally { setBusy(false); }
  }
  async function exportNow() {
    if (!note) return;
    if (format === "pdf" && canPdf) { await pdf(mode as "page" | "flat" | "handout"); close(); return; }
    if (!host.exportGlass) throw new Error(t("导出玻璃需要桌面应用"));
    const selection = mode === "cheatsheet" ? ordered.filter(magnet => included.has(magnet.id)).map(magnet => magnet.id) : [];
    if (mode === "cheatsheet" && !selection.length) throw new Error(t("没有磁贴可导出。"));
    const result = await host.exportGlass({ note, mode, target, ...(selection.length ? { order: selection } : {}) });
    if (result) setMessage(t("玻璃已导出：{{path}}", { path: result.out }));
  }
  return <Dialog title={t("导出选项")} close={close}>
    <fieldset className="glass-export-modes" aria-label={t("导出选项")}>
      {modes.map(value => <label key={value}><input type="radio" name="glass-export-mode" checked={mode === value} onChange={() => { setMode(value); if (value === "cheatsheet" || value === "bundle") setFormat("markdown"); }} />{t(modeLabel[value])}</label>)}
    </fieldset>
    <div className="glass-export-format">
      <label>{t("格式")}<select value={format} onChange={event => setFormat(event.target.value as typeof format)} disabled={!canPdf}>
        <option value="markdown">{t("Markdown + 资源")}</option>
        <option value="pdf">PDF</option>
      </select></label>
      <label>{t("目标格式")}<select value={target} onChange={event => setTarget(event.target.value as typeof target)} disabled={format === "pdf"}>
        <option value="github">GitHub</option>
        <option value="obsidian">Obsidian</option>
      </select></label>
    </div>
    {mode === "cheatsheet" && <section className="glass-export-order">
      <h3>{t("顺序（拖动调整）")}</h3>
      {!ordered.length && <p>{t("没有磁贴可导出。")}</p>}
      <ol>{ordered.map((magnet, index) => <li key={magnet.id} draggable
        onDragStart={() => setDrag(index)} onDragEnd={() => setDrag(null)}
        onDragOver={event => event.preventDefault()}
        onDrop={event => { event.preventDefault(); if (drag !== null) reorder(drag, index); setDrag(null); }}
        className={drag === index ? "is-dragging" : undefined}>
        <span className="glass-export-grip" aria-hidden="true">⠿</span>
        <input type="checkbox" checked={included.has(magnet.id)} aria-label={magnetLabel(kindOf(magnet), magnet.fields)}
          onChange={event => setIncluded(current => { const next = new Set(current); if (event.target.checked) next.add(magnet.id); else next.delete(magnet.id); return next; })} />
        <span>{magnetLabel(kindOf(magnet), magnet.fields)}</span>
        <button type="button" disabled={index === 0} aria-label={t("上移")} onClick={() => reorder(index, index - 1)}>↑</button>
        <button type="button" disabled={index === ordered.length - 1} aria-label={t("下移")} onClick={() => reorder(index, index + 1)}>↓</button>
      </li>)}</ol>
    </section>}
    <p className="glass-export-note">{t("导出只会新建文件，原笔记与知识库不变。")}</p>
    {message && <p role="alert">{message}</p>}
    <div className="glass-export-actions">
      <button type="button" disabled={busy || !note} onClick={() => void run(exportNow)}>{t("导出")}</button>
      <button type="button" disabled={busy} onClick={() => void run(async () => {
        if (!host.importGlass) throw new Error(t("导入玻璃导出包需要桌面应用"));
        const imported = await host.importGlass();
        if (imported) setMessage(t("玻璃导出包已导入：{{path}}", { path: imported.file }));
      })}>{t("导入玻璃导出包…")}</button>
    </div>
  </Dialog>;
}
