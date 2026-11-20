import { useEffect, useMemo, useRef, useState } from "react";
import { sourceLines } from "../../shared/source-lines.mjs";
import { bakeClean, previewClean, type CleanPreview } from "../cleanLayer";
import type { EditorHandle } from "../editor/MarkdownEditor";
import { renderMarkdown } from "../editor/markdown";
import { renderDiagrams } from "../editor/diagrams";
import { renderMath } from "../editor/math";
import { t } from "../i18n";
import type { DocumentRecord } from "../types";
import "./clean-layer.css";

function Changes({ source, markdown }: CleanPreview) {
  const before = sourceLines(source), after = sourceLines(markdown);
  let start = 0, endBefore = before.lines.length, endAfter = after.lines.length;
  const sameLine = (i: number, j: number) => before.lines[i] === after.lines[j] &&
    before.offsets[i + 1] - before.offsets[i] === after.offsets[j + 1] - after.offsets[j] &&
    source.charAt(before.offsets[i] + before.lines[i].length) === markdown.charAt(after.offsets[j] + after.lines[j].length);
  while (start < endBefore && start < endAfter && sameLine(start, start)) start++;
  while (endBefore > start && endAfter > start && sameLine(endBefore - 1, endAfter - 1)) { endBefore--; endAfter--; }
  return <div className="clean-layer-changes">
    <section><h3>{t("清理前")}</h3><pre tabIndex={0}>{source.slice(before.offsets[start], before.offsets[endBefore])}</pre></section>
    <section><h3>{t("清理后")}</h3><pre tabIndex={0}>{markdown.slice(after.offsets[start], after.offsets[endAfter])}</pre></section>
  </div>;
}

export function CleanLayer({ record, current, editor, canBake, close }: {
  record: DocumentRecord;
  current(): DocumentRecord | undefined;
  editor(): EditorHandle | undefined;
  canBake: boolean;
  close(): void;
}) {
  const [snapshot] = useState(record), [preview, setPreview] = useState<CleanPreview>(), [error, setError] = useState("");
  const [changes, setChanges] = useState(false), [baking, setBaking] = useState(false);
  const article = useRef<HTMLElement>(null), back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    back.current?.focus();
    let open = true;
    void previewClean(snapshot).then(result => { if (open) setPreview(result); }, error => { if (open) setError(error.message); });
    return () => { open = false; };
  }, [snapshot]);
  const html = useMemo(() => preview ? renderMarkdown(preview.markdown, preview.id) : "", [preview]);
  useEffect(() => {
    const root = article.current;
    if (root) void Promise.all([renderDiagrams(root), renderMath(root)]).catch(() => {});
  }, [html, changes]);
  const changed = !!preview && preview.markdown !== preview.source;
  async function apply() {
    if (!preview || !canBake || baking) return;
    setError("");
    setBaking(true);
    try { await bakeClean(preview, current, editor); close(); }
    catch (error) { setError((error as Error).message); }
    finally { setBaking(false); }
  }
  return <section className="clean-layer" aria-label={t("清理图层预览")} onKeyDown={event => { if (event.key === "Escape" && !baking) close(); }}>
    <div className="clean-layer-bar">
      <strong>{t("清理图层预览")}</strong>
      <button ref={back} type="button" onClick={close} disabled={baking}>{t("返回源文档")}</button>
      <button type="button" onClick={() => setChanges(value => !value)} disabled={!changed} aria-pressed={changes}>{t("查看差异")}</button>
      <button type="button" onClick={() => void apply()} disabled={!changed || !canBake || baking}>{t("应用到源文档")}</button>
    </div>
    {error ? <p className="clean-layer-notice" role="alert">{error}</p> : !preview ? <p className="clean-layer-notice" role="status">{t("正在清理文本…")}</p> : !changed && <p className="clean-layer-notice" role="status">{t("无需清理。")}</p>}
    <div className="clean-layer-scroll">
      {preview && (changes ? <Changes {...preview} /> : <article ref={article} className="rich-document" onClick={event => {
        const link = event.target instanceof Element && event.target.closest("a[href]");
        if (!link) return;
        event.preventDefault();
        const href = link.getAttribute("href")!;
        if (href.startsWith("#")) {
          const anchor = [...event.currentTarget.querySelectorAll("[id]")].find(item => href === `#${item.id}` || href === `#${encodeURIComponent(item.id)}`);
          anchor?.scrollIntoView();
        }
      }} dangerouslySetInnerHTML={{ __html: html }} />)}
    </div>
  </section>;
}
