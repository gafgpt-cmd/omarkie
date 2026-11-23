import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Dialog } from "./Dialog";
import "./document-workflows.css";
import { t } from "../i18n";
import { host } from "../host";
import type { BibliographyInfo, ConversionOptions, DocumentRecord, VaultSnapshot, FileEntry } from "../types";
import type { Preferences } from "../preferences";
import { makeReady, properties, setProperties, validateOKF } from "../../shared/frontmatter.mjs";
import { referenceIndex, bundlePlan } from "../../shared/references.mjs";
import { sourceLines } from "../../shared/source-lines.mjs";
const VaultGraph = lazy(() => import("./VaultGraph"));
export type ToolTab = "properties" | "references" | "backlinks" | "graph" | "okf" | "writing" | "checks";
interface Change { token?: string; relative: string; before: string; after: string }
interface Template { name: string; content: string }
const decoded = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
const jsonValue = (value: unknown) => { try { return JSON.stringify(value); } catch { return undefined; } };
function templates(): Template[] {
  try { const value = JSON.parse(localStorage.getItem("omarkie-templates") || "[]"); return Array.isArray(value) ? value.filter(item => typeof item?.name === "string" && typeof item?.content === "string").slice(0, 50) : []; } catch { return []; }
}
export function DocumentTools({ record, documents, files, folder, preferences, initial, request, close, open, openFolder, change, create, convert }: {
  record: DocumentRecord; documents: DocumentRecord[]; files: FileEntry[]; folder: string | null; preferences: Preferences; initial: ToolTab; request?: string;
  close(): void; open(token: string, line?: number): Promise<void>;
  openFolder(): Promise<void>;
  change(change: Change): Promise<void>; create(name: string, content: string): Promise<void>;
  convert(format: string, options: ConversionOptions): Promise<void>;
}) {
  const [tab, setTab] = useState(initial), [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Change[]>([]), [report, setReport] = useState<string[]>([]), [tag, setTag] = useState(request?.startsWith("omarkie-tag:") ? decoded(request.slice(12)) : "");
  const [propertyKey, setPropertyKey] = useState("type"), [propertyValue, setPropertyValue] = useState("\"Reference\"");
  const [savedTemplates, setSavedTemplates] = useState(templates), [templateName, setTemplateName] = useState("");
  const [bibliography, setBibliography] = useState<BibliographyInfo | null>(null), [bibliographyDraft, setBibliographyDraft] = useState<string | null>(null);
  const [useCitations, setUseCitations] = useState(false), [letterName, setLetterName] = useState(() => localStorage.getItem("omarkie-letter-name") || ""), [letterDetail, setLetterDetail] = useState(() => localStorage.getItem("omarkie-letter-detail") || "");
  const vaultBibliography = folder ? host.bibliography : undefined;
  const csl = bibliographyDraft ?? bibliography?.csl ?? "";
  useEffect(() => {
    if (!vaultBibliography || !folder || tab !== "writing") return;
    let active = true, revision = 0;
    function refresh() {
      const request = ++revision;
      void vaultBibliography!(folder!, "info").then(
        result => { if (active && request === revision) setBibliography(result); },
        error => { if (active && request === revision) setMessage(t(error.message)); },
      );
    }
    const unsubscribe = host.onCommand(({ action }) => { if (action === "bibliography-changed") refresh(); });
    refresh();
    return () => { active = false; unsubscribe(); };
  }, [folder, tab]);
  async function run(task: () => Promise<unknown> | unknown) { setBusy(true); setMessage(""); try { await task(); } catch (error) { setMessage(t((error as Error).message)); } finally { setBusy(false); } }
  async function scan() {
    const value = await host.vaultSnapshot();
    value.notes = value.notes.map(note => {
      const draft = documents.find(document => document.path === (note.path || files.find(file => file.token === note.token)?.path));
      return draft ? { ...note, content: draft.content } : note;
    });
    setSnapshot(value); return value;
  }
  useEffect(() => { if (["references", "backlinks", "graph"].includes(initial)) void run(scan); }, []);
  const index = useMemo(() => snapshot && referenceIndex(snapshot, preferences), [snapshot, preferences.highlight, preferences.subscript, preferences.superscript, preferences.emoji, preferences.inlineMath]);
  const current = index?.notes.find((note: any) => record.path && record.path === (note.path || files.find(file => file.token === note.token)?.path));
  let values: Record<string, unknown> = {}; let yamlError = "";
  try { values = properties(record.content); } catch (error) { yamlError = (error as Error).message; }
  const target = request?.startsWith("omarkie-wiki:") ? decoded(request.slice(13)) : request && !request.startsWith("omarkie-tag:") ? request : "";
  const resolution = index && current && target ? index.resolve(current, target, request?.startsWith("omarkie-wiki:")) : null;
  useEffect(() => {
    if (snapshot && target && !current && !request?.startsWith("omarkie-wiki:")) void run(async () => { await host.openDocumentLink(record.id, target); close(); });
    else if (resolution?.state === "resolved" && resolution.candidates[0]?.token) void run(async () => { await open(resolution.candidates[0].token, resolution.line); close(); });
  }, [snapshot]);
  async function ready(folder: boolean) {
    const notes = folder ? (await scan()).notes : [{ token: undefined, relative: record.name, content: record.content }];
    setPreview(notes.filter(note => !/(^|\/)(index|log)\.md$/.test(note.relative)).map(note => ({ token: note.token, relative: note.relative, before: note.content, after: makeReady(note.content, note.relative) })).filter(item => item.after !== item.before));
  }
  const options = async (): Promise<ConversionOptions> => {
    const current = useCitations && bibliographyDraft === null && vaultBibliography && folder ? (await vaultBibliography(folder, "info")).csl : csl;
    return { ...(useCitations ? { bibliography: current, style: "vancouver" as const } : {}), ...(letterName || letterDetail ? { letterhead: { name: letterName, detail: letterDetail } } : {}) };
  };
  async function compile(format: "docx" | "pdf") {
    if (!folder) throw new Error(t("请先打开文件夹"));
    // Load project assembly only when the user exports a project.
    const { exportProject } = await import("../editor/projectExport");
    if (await exportProject(format, folder, documents, await options())) setMessage(t("{{format}} 已导出。", { format: format.toUpperCase() }));
  }
  const labels: Record<ToolTab, string> = { properties: t("属性"), references: t("链接与标签"), backlinks: t("反向链接"), graph: t("知识库图谱"), okf: t("OKF"), writing: t("写作与导出"), checks: t("知识库维护") };
  const states: Record<string, string> = { resolved: t("已解析"), external: t("外部链接"), invalid: t("链接无效"), escape: t("链接指向知识库之外"), ambiguous: t("有多个同名目标"), missing: t("未找到目标"), "missing-heading": t("未找到标题") };
  const issues: Record<string, string> = { "index-frontmatter": t("index.md 的前置元数据只能包含 okf_version"), "log-frontmatter": t("log.md 不应包含前置元数据"), "log-date": t("log.md 的日期标题必须是 YYYY-MM-DD"), "missing-frontmatter": t("缺少前置元数据"), "missing-type": t("缺少 type 属性"), "okf-delimiter": t("前置元数据结束标记应为 ---") };
  return <Dialog title={t("文档工具")} close={close}>
    <nav className="workflow-tabs" aria-label={t("文档工具")}>{(["properties", "references", "backlinks", "graph", "okf", "writing", "checks"] as ToolTab[]).map(value => <button key={value} data-tab={value} aria-pressed={tab === value} disabled={busy} onClick={() => { setTab(value); setPreview([]); setReport([]); }}>{labels[value]}</button>)}</nav>
    {message && <p role="alert">{message}</p>}
    {busy && <p role="status">{t("处理中…")}</p>}
    {snapshot?.truncated && <p role="alert">{t("清点不完整，请缩小文件夹范围后再转换或导出。")}</p>}
    {tab === "properties" && <section>
      <p>{t("修改明确可见且可撤销。未知字段、注释与正文保持原样。")}</p>
      {yamlError ? <p role="alert">{yamlError}</p> : <dl>{Object.entries(values).map(([key, value]) => <div key={key}><dt>{key}</dt><dd><code>{jsonValue(value) ?? t("请在源码模式下编辑此 YAML 引用。")}</code><button disabled={busy || jsonValue(value) === undefined} onClick={() => { setPropertyKey(key); setPropertyValue(jsonValue(value)!); }}>{t("编辑属性")}</button></dd></div>)}</dl>}
      <label>{t("属性名称")}<input value={propertyKey} onChange={event => setPropertyKey(event.target.value)} /></label>
      <label>{t("JSON 值")}<textarea aria-label={t("JSON 值")} value={propertyValue} onChange={event => setPropertyValue(event.target.value)} /></label>
      <button disabled={busy || !!yamlError || !propertyKey.trim()} onClick={() => void run(() => { setPreview([{ relative: record.name, before: record.content, after: setProperties(record.content, { [propertyKey.trim()]: JSON.parse(propertyValue) }) }]); })}>{t("预览属性修改")}</button>
    </section>}
    {["references", "backlinks", "graph"].includes(tab) && <section>
      <button disabled={busy} onClick={() => void run(scan)}>{t("刷新知识库索引")}</button>
      {tab === "references" && <>
        {resolution && <><p>{t("链接状态：{{state}}", { state: states[resolution.state] || resolution.state })}</p><ul>{resolution.candidates.filter((note: any) => note.token).map((note: any) => <li key={note.token}><button onClick={() => void run(async () => { await open(note.token, resolution.line); close(); })}>{note.relative}</button></li>)}</ul></>}
        <label>{t("标签搜索")}<input value={tag} onChange={event => setTag(event.target.value.replace(/^#/, ""))} /></label>
        <div>{[...new Set<string>(index?.notes.flatMap((note: any) => note.tags) || [])].sort().map(value => <button key={value} onClick={() => setTag(value)}>#{value}</button>)}</div>
        <ul>{(tag ? index?.tags(tag) || [] : target ? [] : index?.notes || []).map((note: any) => <li key={note.token}><button onClick={() => void run(async () => { await open(note.token); close(); })}>{note.relative}</button></li>)}</ul>
      </>}
      {tab === "backlinks" && <><h3>{t("反向链接")}</h3><ul>{(current ? index.backlinks(current) : []).map((edge: any, at: number) => <li key={at}><button onClick={() => void run(async () => { await open(edge.source.token, edge.ref.line); close(); })}>{edge.source.relative}:{edge.ref.line}</button><blockquote>{sourceLines(edge.source.content).lines[edge.ref.line - 1]}</blockquote></li>)}</ul></>}
      {tab === "graph" && index && <Suspense fallback={null}><VaultGraph index={index} open={token => void run(async () => { await open(token); close(); })} /></Suspense>}
    </section>}
    {tab === "okf" && <section>
      <p>{t("OKF v0.2：type 为必填项；允许未知的类型与属性。已有笔记不会自动迁移。")}</p>
      <button disabled={busy} onClick={() => void run(() => ready(false))}>{t("预览笔记整理")}</button>
      <button disabled={busy} onClick={() => void run(() => ready(true))}>{t("预览文件夹整理")}</button>
      <button disabled={busy} onClick={() => void run(async () => { const value = await scan(); setReport(value.notes.flatMap(note => validateOKF(note.content, note.relative, note.relative === "index.md").map(issue => `${note.relative}: ${issues[issue] || issue}`)).concat(t("校验完成。"))); })}>{t("校验文件夹 OKF")}</button>
      <button disabled={busy} onClick={() => void run(() => { const root = !!folder && record.path?.replaceAll("\\", "/") === folder.replaceAll("\\", "/").replace(/\/?$/, "/") + "index.md"; setReport(validateOKF(record.content, record.name, root).map(issue => issues[issue] || issue).concat(t("校验完成。"))); })}>{t("校验笔记 OKF")}</button>
      <button disabled={busy} onClick={() => void run(async () => { const value = await scan(), plan = bundlePlan(value, undefined, preferences); const destination = await host.exportBundle(plan); if (destination) setMessage(t("已导出副本压缩包：{{path}}", { path: destination })); })}>{t("导出 OKF 副本压缩包")}</button>
    </section>}
    {tab === "writing" && <section>
      <h3>{t("可复用模板")}</h3>
      <label>{t("模板名称")}<input maxLength={120} value={templateName} onChange={event => setTemplateName(event.target.value)} /></label>
      <button disabled={busy || !templateName.trim() || record.content.length > 1000000} onClick={() => void run(() => { const next = [...savedTemplates.filter(item => item.name !== templateName.trim()), { name: templateName.trim(), content: record.content }].slice(-50); localStorage.setItem("omarkie-templates", JSON.stringify(next)); setSavedTemplates(next); })}>{t("将当前笔记存为模板")}</button>
      <ul>{savedTemplates.map(item => <li key={item.name}><button disabled={busy} onClick={() => void run(async () => { await create(item.name + ".md", setProperties(makeReady(item.content, item.name + ".md"), { generated: { by: "process:editor", at: new Date().toISOString() } })); close(); })}>{t("用 {{name}} 新建笔记", { name: item.name })}</button><button disabled={busy} onClick={() => void run(() => { const next = savedTemplates.filter(template => template.name !== item.name); localStorage.setItem("omarkie-templates", JSON.stringify(next)); setSavedTemplates(next); })}>{t("删除模板")}</button></li>)}</ul>
      <h3>{t("引用与信头")}</h3>
      <label><input type="checkbox" checked={useCitations} onChange={event => setUseCitations(event.target.checked)} />{t("通过 Pandoc citeproc 生成 Vancouver 引用")}</label>
      <label>{t("CSL JSON 书目")}<textarea aria-label={t("CSL JSON 书目")} placeholder='[{"id":"key","type":"article-journal","title":"Example"}]' value={csl} onChange={event => setBibliographyDraft(event.target.value)} /></label>
      <label>{t("导入 CSL JSON")}<input type="file" accept=".json" disabled={busy} onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) void run(async () => {
          if (file.size > 2 * 1024 * 1024) throw new Error(t("书目超过 2 MB"));
          const raw = await file.text();
          if (vaultBibliography && folder) { await vaultBibliography(folder, "save", raw); setBibliographyDraft(null); }
          else setBibliographyDraft(raw);
        });
      }} /></label>
      {vaultBibliography && folder && <>
        <button disabled={busy || !csl || bibliographyDraft === null} onClick={() => void run(async () => { await vaultBibliography(folder, "save", csl); setBibliographyDraft(null); })}>{t("保存书目到知识库")}</button>
        <button disabled={busy} onClick={() => void run(async () => { if (await vaultBibliography(folder, "link")) setBibliographyDraft(null); })}>{t("关联 Zotero 自动导出")}</button>
        {bibliography?.source && <>
          <p>{t("Zotero 自动导出：{{name}}", { name: bibliography.source })}</p>
          {bibliography.stale && <p role="alert">{t("无法读取 Zotero 导出，正在使用上次有效的书目。")}</p>}
          <button disabled={busy} onClick={() => void run(async () => { await vaultBibliography(folder, "disconnect"); setBibliographyDraft(null); })}>{t("断开 Zotero 关联")}</button>
        </>}
        <button disabled={busy || !bibliography?.csl && !bibliography?.source} onClick={() => void run(async () => { await vaultBibliography(folder, "clear"); setBibliographyDraft(null); })}>{t("清除知识库书目")}</button>
      </>}
      <label>{t("信头名称")}<input value={letterName} onChange={event => void run(() => { localStorage.setItem("omarkie-letter-name", event.target.value); setLetterName(event.target.value); })} maxLength={200} /></label>
      <label>{t("信头详细信息")}<textarea aria-label={t("信头详细信息")} value={letterDetail} onChange={event => void run(() => { localStorage.setItem("omarkie-letter-detail", event.target.value); setLetterDetail(event.target.value); })} maxLength={2000} /></label>
      <button disabled={busy} onClick={() => void run(async () => convert("docx", await options()))}>{t("导出带信头的 DOCX")}</button>
      <button disabled={busy} onClick={() => void run(async () => convert("pdf", await options()))}>{t("导出带信头的 PDF")}</button>
      {host.native && <>
        <h3>{t("项目导出")}</h3>
        <p>{t("将文件夹中的 Markdown 章节编译成一个文档。")}</p>
        {folder && <p title={folder}>{folder}</p>}
        <button disabled={busy} onClick={() => void run(openFolder)}>{t("选择项目文件夹…")}</button>
        {(["docx", "pdf"] as const).map(format => <button key={format} data-testid={`project-export-${format}`} disabled={busy || !folder} onClick={() => void run(() => compile(format))}>
          {t("导出项目为 {{format}}", { format: format.toUpperCase() })}
        </button>)}
      </>}
    </section>}
    {tab === "checks" && <section>
      <p>{t("仅生成报告。不会删除或修改任何文件。")}</p>
      <button disabled={busy} onClick={() => void run(async () => { await scan(); })}>{t("检查失效链接与未使用图片")}</button>
      {index && <><h3>{t("失效或有歧义的链接")}</h3><ul>{index.broken.map((edge: any, at: number) => <li key={at}>{edge.source.relative}:{edge.ref.line} · {edge.ref.target} · {states[edge.state] || edge.state}</li>)}</ul><h3>{t("本次清点中未被引用的资源")}</h3><ul>{index.unused.map((asset: any) => <li key={asset.relative}>{asset.relative}</li>)}</ul></>}
      <button disabled={busy} onClick={() => void run(async () => { const { lint } = await import("markdownlint/sync"); const result = lint({ strings: { note: record.content }, config: { default: true } }); setReport(result.note.map(issue => `${issue.lineNumber}: ${issue.ruleNames[0]} ${issue.ruleDescription}${issue.errorDetail ? " · " + issue.errorDetail : ""}`).concat(t("校验完成。"))); })}>{t("检查当前 Markdown")}</button>
    </section>}
    {!!preview.length && <section><h3>{t("预览全部建议修改")}</h3><p>{t("修改会写入草稿，之后按常规方式保存。撤销在各已打开的笔记中生效。")}</p>{preview.map(item => <details key={item.relative} open><summary>{item.relative}</summary><h4>{t("修改前")}</h4><pre>{item.before}</pre><h4>{t("修改后")}</h4><pre>{item.after}</pre></details>)}<button disabled={busy || !!snapshot?.truncated} onClick={() => void run(async () => { for (const item of preview) await change(item); setPreview([]); setMessage(t("已应用修改到草稿")); })}>{t("应用预览中的修改")}</button><button disabled={busy} onClick={() => setPreview([])}>{t("取消预览")}</button></section>}
    {!!report.length && <ul>{report.map((line, at) => <li key={at}>{line}</li>)}</ul>}
  </Dialog>;
}
