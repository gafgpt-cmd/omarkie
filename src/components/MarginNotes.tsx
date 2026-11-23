import { useEffect, useEffectEvent, useState } from "react";
import { ArrowDownToLine, MapPin } from "lucide-react";
import type { ReadingAnchor, ReadingEntry, ReadingLocation, ReadingStore } from "../../shared/reading-store.ts";
import type { EditorHandle } from "../editor/MarkdownEditor";
import { t } from "../i18n";
import { readingBlocks } from "./reading-selection";

type Note = Extract<ReadingEntry, { type: "note" }>;

export default function MarginNotes({ id, enabled, content, revision, store, editor }: {
  id: string; enabled: boolean; content: string; revision: number; store: ReadingStore;
  editor(): EditorHandle | undefined;
}) {
  const [notes, setNotes] = useState<Note[] | null>(null), [locations, setLocations] = useState<ReadingLocation[] | null>(null);
  const [error, setError] = useState(""), [exporting, setExporting] = useState(false);
  const getContext = useEffectEvent(() => editor()?.readingContext());
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setError("");
    void store(id, { action: "list", types: ["note"] }).then(entries => {
      if (alive) setNotes(entries.filter((entry): entry is Note => entry.type === "note"));
    }, error => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [enabled, id, revision, store]);
  useEffect(() => {
    if (!enabled || !notes?.length) return;
    let alive = true;
    const context = getContext();
    if (context) void store(id, { action: "resolve", blocks: readingBlocks(context) }).then(result => {
      if (alive) setLocations(result);
    }, error => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [content, enabled, id, notes, store]);

  async function exportNotes() {
    setExporting(true);
    try { await store(id, { action: "export" }); }
    catch (error) { setError((error as Error).message); }
    finally { setExporting(false); }
  }
  const byId = new Map(locations?.map(location => [location.id, location.line]));
  const anchored = notes?.filter(note => byId.get(note.id) != null).sort((a, b) => byId.get(a.id)! - byId.get(b.id)!);
  const orphans = notes?.filter(note => byId.has(note.id) && byId.get(note.id) === null);
  const reference = (anchor: ReadingAnchor) => <><span>{anchor.headings.join(" › ")}</span><q>{anchor.quote}</q></>;
  return <aside className="layers-margin" aria-label={t("页边笔记")}>
    <header><h2>{t("页边笔记")}</h2><button type="button" title={t("导出笔记和卡片")} aria-label={t("导出笔记和卡片")} disabled={!enabled || exporting} onClick={() => void exportNotes()}><ArrowDownToLine size={17} /></button></header>
    {error && <p role="alert">{error}</p>}
    {!enabled ? <p>{t("请先打开文件夹并保存文档。")}</p> : notes?.length === 0 ? <p>{t("选择文本以添加页边笔记。")}</p> : !error && (!notes || !locations) ? <p role="status">{t("正在读取页边笔记…")}</p> : null}
    {enabled && anchored?.map(note => <article className="layers-note" key={note.id}>
      <button type="button" className="layers-reference" title={t("跳到段落")} onClick={() => editor()?.jump(byId.get(note.id)!)}>
        <MapPin size={14} />{reference(note.anchor)}
      </button>
      <p>{note.body}</p>
    </article>)}
    {enabled && !!orphans?.length && <details open className="layers-orphans">
      <summary>{t("未定位的笔记（{{total}}）", { total: orphans.length })}</summary>
      {orphans.map(note => <article className="layers-note" key={note.id}><div className="layers-reference">{reference(note.anchor)}</div><p>{note.body}</p></article>)}
    </details>}
  </aside>;
}
