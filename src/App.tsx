import { lazy, Suspense, useEffect, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FilePlus2, FolderOpen, X, AlertCircle } from "lucide-react";
import { useDocuments } from "./useDocuments";
import { EncodingDialog, encodingNames } from "./components/EncodingDialog";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { MarkdownEditor } from "./editor/MarkdownEditor";
import type { EditorHandle } from "./editor/MarkdownEditor";
import { fontFacesReady } from "./fontFaces.ts";
import { loadHighlighting, extractHeadings, renderMarkdown, setMarkdownOptions } from "./editor/markdown";
import { host } from "./host";
import { refreshDiagrams, renderDiagrams } from "./editor/diagrams";
import { renderMath } from "./editor/math";
import { exportHtml, portableHtml, conversionMarkdown } from "./editor/print";
import { commandForKey, commandKey, commandsByAction } from "./commands";
import { loadPreferences } from "./preferences";
import { applyFonts } from "./fonts";
const PreferencesDialog = lazy(() => import("./components/PreferencesDialog").then(module => ({ default: module.PreferencesDialog })));
import { InsertDialog } from "./components/InsertDialog";
import type { InsertKind } from "./components/InsertDialog";
import { QuickOpen } from "./components/QuickOpen";
import { Dialog } from "./components/Dialog";
import { imageReferences, updateImageReferences } from "./editor/images";
import { documentStatistics } from "./editor/statistics";
import { FileOperationDialog, RecentDialog, GlobalSearch } from "./components/WorkspaceDialog";
import type { FileOperation } from "./types";
import type { Command, ConversionOptions } from "./types";
import type { ToolTab } from "./components/DocumentTools";
const DocumentTools = lazy(() => import("./components/DocumentTools").then(module => ({ default: module.DocumentTools })));
const CleanLayer = lazy(() => import("./components/CleanLayer").then(module => ({ default: module.CleanLayer })));
const PayloadPanel = lazy(() => import("./components/PayloadPanel"));
import type { FlashcardPanel } from "./components/Flashcards";
const Flashcards = lazy(() => import("./components/Flashcards"));
import appIcon from "../design/icon.svg";
import { version as appVersion } from "../package.json";
import { applyTheme, toggledTheme, type OmarchyPalette } from "./themes";
import { useSettled } from "./useSettled";
import { countCharacters } from "./characters";
import type { PluginRuntime } from "./plugins/runtime";
import { t } from "./i18n";
import { afterDocumentPaint } from "./plugins/startup";
import { bundledPlugins, loadPluginPreferences, pluginPreferenceKey } from "./plugins/catalog";
import type { PluginDefinition, PluginState } from "./plugins/types";
const PluginsDialog = lazy(() => import("./components/PluginsDialog").then(module => ({ default: module.PluginsDialog })));
import { backgroundRevisionKey, backgroundStyle } from "./background";
import { imeKey } from "./editor/composition";
import type { BackgroundAsset } from "./background";
import type { ReadingLayerState } from "./components/ReadingLayers";
const ReadingLayers = lazy(() => import("./components/ReadingLayers"));
const defaultReadingLayers: ReadingLayerState = { active: "note", note: true, visual: true };
export default function App() {
  const [painted, setPainted] = useState(false);
  const [readyEditors, setReadyEditors] = useState<Record<string, "rich" | "source">>({});
  const firstDocumentPainted = useRef(false);
  const [paintedDocument, setPaintedDocument] = useState<string | null>(null);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const editors = useRef(new Map<string, EditorHandle>());
  const pendingJump = useRef<{ id: string; line: number } | null>(null);
  function jumpTo(id: string, line: number) {
    pendingJump.current = null;
    const target = editors.current.get(id);
    if (target) target.jump(line);
    else pendingJump.current = { id, line };
  }
  const [mountedDocuments, setMountedDocuments] = useState(() => new Set<string>());
  const session = useDocuments(() => ![...editors.current.values()].some(editor => editor.composing()));
  const [preferences, setPreferences] = useState(() => { const initial = loadPreferences(); setMarkdownOptions(initial); return initial; });
  const [themes, setThemes] = useState<{ id: string; name: string; css: string }[]>([]);
  const [background,setBackground] = useState<BackgroundAsset | null>(null);
  const backgroundRequest = useRef(0);
  const [installedPlugins, setInstalledPlugins] = useState<PluginDefinition[]>([]);
  const [pluginPreferences, setPluginPreferences] = useState(loadPluginPreferences);
  const [pluginStates, setPluginStates] = useState<Record<string, PluginState>>({});
  const [readOnly, setReadOnly] = useState(false);
  const pluginRuntime = useRef<PluginRuntime | null>(null);
  const [typewriter, setTypewriter] = useState(false);
  const [dialog, setDialog] = useState<"preferences" | "plugins" | "quick-open" | "statistics" | "recent" | "global-search" | "encoding" | InsertKind | null>(null);
  const [fileOperation, setFileOperation] = useState<FileOperation | null>(null);
  const [tools, setTools] = useState<{ tab: ToolTab; id: string; request?: string } | null>(null);
  const [cleanId, setCleanId] = useState<string | null>(null);
  const [payload, setPayload] = useState<{ id: string; sequence: number; mode: "summary" | "question"; source: string; selection: boolean; vault?: string | null } | null>(null);
  const [readingPreference, setReadingPreference] = useState<{ vault: string | null; open: boolean }>();
  const [readingViews, setReadingViews] = useState<Record<string, ReadingLayerState>>({});
  const [selectedText, setSelectedText] = useState("");
  const [selection, setSelection] = useState("");
  const [countUnit, setCountUnit] = useState<"characters" | "words">(() => localStorage.getItem("omarkie-count-unit") === "words" ? "words" : "characters");
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const [rendered, setRendered] = useState(true),
    [sidebar, setSidebar] = useState(() => window.innerWidth > 760),
    [focus, setFocus] = useState(false);
  const [tab, setTab] = useState<"files" | "outline" | "tree">("files"),
    [theme, setTheme] = useState(
      () => localStorage.getItem("omarkie-theme") || "light",
    );
  const [cursor, setCursor] = useState({ line: 1, column: 1 }),
    [about, setAbout] = useState(false);
  const [flashcardPanel, setFlashcardPanel] = useState<(FlashcardPanel & { id: string; path: string; folder: string }) | null>(null);
  const editor = () => editors.current.get(session.activeId);
  const printDocument = useRef<HTMLElement>(null);
  const commands = useRef<(command: Command) => void>(() => {});
  const active = session.active;
  const readingSupported = !!window.desktop?.readingStore;
  const readingVault = session.folder;
  const readingKey = readingSupported && readingVault ? `omarkie-reading-layers:${readingVault}` : null;
  const readingOpen = useMemo(() => readingPreference?.vault === readingVault
    ? readingPreference.open
    : !!readingKey && localStorage.getItem(readingKey) === "true", [readingPreference, readingVault, readingKey]);
  const readingVisible = readingOpen && !!active && !focus;
  const filesVisible = sidebar && !readingVisible;
  function setReadingOpen(open: boolean) {
    if (readingKey) localStorage.setItem(readingKey, String(open));
    setReadingPreference({ vault: readingVault, open });
  }
  const cleanVisible = !!active && cleanId === active.id;
  function closeClean() {
    setCleanId(null);
    const id = cleanId;
    if (id) requestAnimationFrame(() => editors.current.get(id)?.focus());
  }
  function openClean() {
    if (active && !editor()?.composing()) setCleanId(active.id);
  }
  const activeEditorReady = active ? readyEditors[active.id] : undefined;
  const payloadSupported = !!window.desktop?.payloadRequest;
  const payloadEnabled = preferences.payloadEnabled && payloadSupported;
  const currentPayload = payload && payload.id === active?.id &&
    (payload.vault === undefined ? payloadEnabled : payload.vault === readingVault) ? payload : null;
  const activePayload = currentPayload && (readingVisible || currentPayload.vault === undefined) ? currentPayload : null;
  useEffect(() => {
    if (payload && !currentPayload) setPayload(null);
  }, [payload, currentPayload]);
  function openPayload(mode: "summary" | "question", selectedSource?: string, inLayers = false) {
    if (!active || !(inLayers ? payloadSupported : payloadEnabled)) return;
    const target = editor();
    const selected = selectedSource ?? (inLayers ? undefined : target?.selectionText(true));
    if (selectedSource !== undefined && !selectedSource.trim()) return;
    const source = selected || target?.markdown() || active.content;
    setPayload(previous => ({ id: active.id, sequence: (previous?.sequence ?? 0) + 1, mode, source, selection: !!selected, vault: inLayers ? readingVault : undefined }));
  }
  function appendPayload(summary: string) {
    const target = editor();
    if (!active || active.conflict || !target || readOnly || session.fileOperationBusy) throw new Error(t("当前不可编辑"));
    const source = target.markdown(), eol = active.lineEnding;
    const callout = ["> [!summary] " + t("Payload summary"), ...summary.split(/\r\n?|\n/).map(line => line ? `> ${line}` : ">")].join(eol);
    if (!target.replaceRange(source.length, source.length, (source ? eol.repeat(2) : "") + callout + eol, "", true)) throw new Error(t("当前不可编辑"));
  }
  const readingView = readingViews[session.activeId] || defaultReadingLayers;
  const renderedView = readingVisible ? readingView.visual : rendered;
  const suppressRemoteImages = readingVisible || cleanVisible;
  const remoteImages = preferences.remoteImages && !suppressRemoteImages;
  useInsertionEffect(() => {
    // Rich editors read the parser policy in descendant layout effects.
    setMarkdownOptions({ ...preferences, remoteImages });
  }, [preferences, remoteImages]);
  function setRenderedView(value: boolean) {
    if (readingVisible) setReadingViews(current => ({ ...current, [session.activeId]: { ...readingView, visual: value } }));
    else setRendered(value);
  }
  useEffect(() => {
    setMountedDocuments(current => {
      let removed = false;
      for (const id of current) if (!session.documents.some(record => record.id === id)) { removed = true; break; }
      if (!removed && (!session.activeId || current.has(session.activeId))) return current;
      return new Set(session.documents.filter(record => record.id === session.activeId || current.has(record.id)).map(record => record.id));
    });
  }, [session.activeId, session.documents]);
  const pluginContext = useRef({ active, editor, preferences, notify: session.setMessage });
  pluginContext.current = { active, editor, preferences, notify: session.setMessage };
  const pluginDefinitions = useMemo(() => [...bundledPlugins, ...installedPlugins].map(definition => ({ ...definition, config: { ...definition.config, ...pluginPreferences[definition.id]?.config } })), [installedPlugins, pluginPreferences]);
  useEffect(() => {
    if (!painted || !Object.values(pluginPreferences).some(value => value.enabled)) { setRuntimeReady(false); return; }
    let cancelled = false;
    let loaded: PluginRuntime | null = null;
    void import("./plugins/runtime").then(({ PluginRuntime }) => {
    if (cancelled) return;
    const runtime = new PluginRuntime({
      getMarkdown: () => pluginContext.current.editor()?.markdown() ?? pluginContext.current.active?.content ?? "", getPath: () => pluginContext.current.active?.path || null,
      getSelection: () => pluginContext.current.editor()?.selectionText() || "",
      getDocumentId: () => pluginContext.current.active?.id || "",
      getNumbered: () => pluginContext.current.editor()?.numbered() || [],
      composing: () => !!pluginContext.current.editor()?.composing(),
      editable: () => !!pluginContext.current.active && !!pluginContext.current.editor()?.richMode(),
      getHeadings: () => { const current = pluginContext.current.editor(), text = current?.markdown() || ""; return current?.headings(text) || extractHeadings(text); },
      jump: line => pluginContext.current.editor()?.jump(line),
      imageOffset: image => pluginContext.current.editor()?.imageOffset(image),
      selectionRange: () => pluginContext.current.editor()?.selectionRange(),
      replaceRange: (from, to, text, expected) => pluginContext.current.editor()?.replaceRange(from, to, text, expected) ?? false,
      getWidth: () => pluginContext.current.preferences.editorColumns,
      setWidth: editorColumns => setPreferences(previous => ({ ...previous, editorColumns: Math.max(40, Math.min(160, Math.round(editorColumns))) })),
      insert: text => pluginContext.current.editor()?.insert(text), replace: text => pluginContext.current.editor()?.transform(() => text),
      setReadOnly, notify: text => pluginContext.current.notify(text), changed: (id, state) => setPluginStates(previous => ({ ...previous, [id]: state })),
      reservedHotkeys: [...commandsByAction.values()].map(command => commandKey(command) || "").filter(Boolean),
      saveConfig: (id, config) => setPluginPreferences(previous => ({ ...previous, [id]: { ...previous[id], config: { ...previous[id]?.config, ...config } } })),
    });
    loaded = runtime; pluginRuntime.current = runtime; setRuntimeReady(true);
    }).catch(error => session.setMessage(error.message));
    return () => { cancelled = true; pluginRuntime.current = null; void loaded?.destroy(); };
  }, [painted, Object.values(pluginPreferences).some(value => value.enabled)]);
  useEffect(() => {
    if (!painted) return;
    void host.plugins().then(items => setInstalledPlugins(items.map(item => ({ ...item, description: t("本地插件，通过兼容接口运行。"), config: {} })))).catch(error => session.setMessage(error.message));
  }, [painted, dialog === "plugins"]);
  useEffect(() => { localStorage.setItem(pluginPreferenceKey, JSON.stringify(pluginPreferences)); }, [pluginPreferences]);
  useEffect(() => {
    if (!session.ready || !active) return;
    for (const definition of pluginDefinitions) if (!pluginPreferences[definition.id]?.enabled) void pluginRuntime.current?.setEnabled(definition, false);
    if (!activeEditorReady || paintedDocument !== active.id || !pluginDefinitions.some(definition => pluginPreferences[definition.id]?.enabled)) return;
    return afterDocumentPaint(() => {
      for (const definition of pluginDefinitions) if (pluginPreferences[definition.id]?.enabled) void pluginRuntime.current?.setEnabled(definition, true);
    });
  }, [pluginDefinitions, pluginPreferences, session.ready, active?.id, activeEditorReady, paintedDocument, runtimeReady]);
  useEffect(() => { if (preferences.spellcheck) void host.spellcheckLanguages(preferences.spellcheckLanguages).catch(() => {}); }, [preferences.spellcheck, preferences.spellcheckLanguages]);
  useEffect(() => { void host.setRemoteImages(remoteImages).catch(() => {}); }, [remoteImages]);
  useEffect(() => {
    if (!activeEditorReady || paintedDocument !== active?.id || !pluginRuntime.current) return;
    return afterDocumentPaint(() => pluginRuntime.current?.documentChanged());
  }, [active?.id, active?.path, active?.content, activeEditorReady, paintedDocument, runtimeReady]);
  useEffect(() => { pluginRuntime.current?.event("beforeToggleSourceMode", !renderedView); }, [renderedView]);
  useEffect(() => { pluginRuntime.current?.event("afterToggleSidebar", filesVisible); }, [filesVisible]);
  async function installPlugin(folder = false) { const installed = await host.installPlugin(folder); if (installed) setInstalledPlugins(previous => [...previous.filter(item => item.id !== installed.id), { ...installed, description: t("本地插件，通过兼容接口运行。"), config: {} }]); }
  async function removePlugin(id: string) {
    const definition = pluginDefinitions.find(item => item.id === id); if (!definition || definition.builtin) return;
    await pluginRuntime.current?.setEnabled(definition, false); await host.removePlugin(id);
    setInstalledPlugins(previous => previous.filter(item => item.id !== id));
    setPluginPreferences(previous => { const next = { ...previous }; delete next[id]; return next; });
  }
  const settledContent = useSettled(active?.content || "", active?.id);
  const headings = useMemo(
    () => filesVisible && tab === "outline" ? (active && editors.current.get(active.id)?.headings(settledContent)) || extractHeadings(settledContent) : [],
    [settledContent, preferences, filesVisible, tab, active?.id],
  );
  const characters = useMemo(
    () => countCharacters(settledContent),
    [settledContent],
  );
  const wholeStatistics = useMemo(() => countUnit === "words" || dialog === "statistics" ? documentStatistics(settledContent, undefined, preferences.readingSpeed) : null, [settledContent, preferences, countUnit, dialog]);
  const statistics = useMemo(() => dialog === "statistics" && selection ? documentStatistics(selection, selection, preferences.readingSpeed) : wholeStatistics, [dialog, selection, wholeStatistics]);
  const selectionCharacters = useMemo(() => Array.from(selection.replace(/\s/g, "")).length, [selection]);
  useEffect(() => { localStorage.setItem("omarkie-count-unit", countUnit); }, [countUnit]);
  useEffect(() => {
    localStorage.setItem("omarkie-preferences", JSON.stringify(preferences));
    document.documentElement.style.setProperty("--editor-font-size", `${preferences.fontSize}px`);
    document.documentElement.style.setProperty("--editor-line-height", String(preferences.lineHeight));
    document.documentElement.style.setProperty("--editor-columns", `${preferences.editorColumns}ch`);
    document.documentElement.style.setProperty("--standalone-image-scale", String(preferences.standaloneImageScale));
    pluginRuntime.current?.event("displayChanged");
  }, [preferences]);
  const checked = { source: !renderedView, focus, typewriter, sidebar: filesVisible, outline: filesVisible && tab === "outline", files: filesVisible && tab === "files", "file-tree": filesVisible && tab === "tree", "reading-layers": readingVisible };
  const menuContext = editor()?.context() || "";
  useEffect(() => { if (window.desktop?.viewState) void window.desktop.viewState(focus, typewriter, filesVisible, checked, !active, menuContext).catch(() => {}); }, [focus, typewriter, filesVisible, renderedView, readingVisible, tab, active?.id, menuContext]);
  async function refreshThemes() { const items = await host.themes(); setThemes(items); return items; }
  useEffect(() => { if (painted) void refreshThemes().catch(e => session.setMessage(e.message)); }, [painted]);
  const [omarchy, setOmarchy] = useState<OmarchyPalette | null>(null), themeUnset = useRef(!localStorage.getItem("omarkie-theme-chosen"));
  // omarkie-theme also stores the automatic default; only a theme the user picked is kept over Omarchy.
  function chooseTheme(next: string | ((value: string) => string)) { localStorage.setItem("omarkie-theme-chosen", "true"); themeUnset.current = false; setTheme(next); }
  async function refreshOmarchy() {
    const palette = await host.omarchyTheme().catch(() => null); setOmarchy(palette);
    if (palette && themeUnset.current) { themeUnset.current = false; setTheme("omarchy"); }
  }
  useEffect(() => { if (painted) void refreshOmarchy(); }, [painted]);
  useLayoutEffect(() => { const remove = applyTheme(theme, themes, omarchy); void refreshDiagrams().catch(() => {}); return remove; }, [theme, themes, omarchy]);
  useLayoutEffect(() => applyFonts(preferences, omarchy?.font ?? null), [preferences.documentFont, preferences.headingFont, preferences.codeFont, preferences.interfaceFont, omarchy]);
  async function refreshBackground() {
    const request = ++backgroundRequest.current, asset = await host.background();
    if (request === backgroundRequest.current) setBackground(asset);
  }
  useEffect(() => { void refreshBackground().catch(error => session.setMessage(error.message)); }, []);
  async function chooseBackground() {
    const asset = await host.chooseBackground(); if (!asset) return;
    ++backgroundRequest.current; setBackground(asset); localStorage.setItem(backgroundRevisionKey,crypto.randomUUID());
  }
  async function clearBackground() {
    await host.clearBackground(); ++backgroundRequest.current; setBackground(null); localStorage.setItem(backgroundRevisionKey,crypto.randomUUID());
  }
  async function installTheme() { const selected = await host.installTheme(); if (selected) { await refreshThemes(); chooseTheme("custom:" + selected); } }
  async function importDocument() {
    try { const imported = await host.importDocument(); if (!imported) return; const content = imported.markdown ?? (await import("./editor/clipboard")).htmlToMarkdown(imported.html || ""), record = { id: crypto.randomUUID(), path: null, name: imported.name, content, savedContent: "", diskHash: null, lineEnding: "\n" }; await host.registerDraft(record); await session.add(record); }
    catch (e) { session.setMessage((e as Error).message); }
  }
  const flashcardsVisible = !!flashcardPanel && flashcardPanel.id === active?.id
    && flashcardPanel.path === active.path && flashcardPanel.folder === session.folder;
  const closeFlashcards = () => setFlashcardPanel(null);
  function openFlashcards(target?: FlashcardPanel["target"]) {
    if (window.desktop?.readingStore && active?.path && session.folder)
      setFlashcardPanel({ id: active.id, path: active.path, folder: session.folder, target });
  }
  const readingSaved = !!active?.path && !!session.folder;
  function closeReading() {
    setReadingOpen(false);
    if (cleanVisible) closeClean();
    if (flashcardsVisible) closeFlashcards();
    setPayload(null);
    requestAnimationFrame(() => editor()?.focus());
  }
  function toggleReading() {
    if (!readingSupported || !active || !activeEditorReady || editor()?.composing()) return;
    if (readingVisible) closeReading();
    else { setFocus(false); setReadingOpen(true); }
  }
  function toggleSidebar() {
    if (readingVisible) {
      closeReading();
      setSidebar(true);
    } else setSidebar(value => !value);
  }
  function closeDialog() { setDialog(null); queueMicrotask(() => editor()?.focus()); }
  function changePreferences(next: typeof preferences) { setPreferences(next); }
  async function exportDocument(kind: string, options?: ConversionOptions) {
    if (exportingRef.current || !active || !printDocument.current) return;
    if (editor()?.composing()) { session.setMessage(t("请先完成当前输入法组合输入，再导出。")); return; }
    exportingRef.current = true; setExporting(true); document.body.classList.add("printing");
    try {
      await host.persist({ documents: session.documents, activeId: session.activeId });
      await loadHighlighting();
      printDocument.current.innerHTML = renderMarkdown(active.content, active.id);
      await fontFacesReady();
      await Promise.all([renderDiagrams(printDocument.current), renderMath(printDocument.current), document.fonts.ready]);
      const result = options ? await host.exportConverted(active.id, kind, await conversionMarkdown(active.content, printDocument.current), await portableHtml(printDocument.current, active.name), options) : kind === "pdf" ? await host.exportPdf(exportHtml(printDocument.current), { paper: preferences.pdfPaper, margin: preferences.pdfMargin, header: preferences.pdfHeader, footer: preferences.pdfFooter, title: active.name }) : kind === "html" ? await host.exportHtml(active.name, await portableHtml(printDocument.current, active.name)) : await host.exportConverted(active.id, kind, await conversionMarkdown(active.content, printDocument.current), await portableHtml(printDocument.current, active.name));
      if (result) session.setMessage(t("{{format}} 已导出。", { format: kind.toUpperCase() }));
    } catch (error) { session.setMessage((error as Error).message); }
    finally { document.body.classList.remove("printing"); exportingRef.current = false; setExporting(false); }
  }
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("omarkie-theme", theme);
  }, [theme]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === pluginPreferenceKey) setPluginPreferences(loadPluginPreferences());
      if (event.key === "omarkie-theme") setTheme(event.newValue || "light");
      if (event.key === "omarkie-preferences") setPreferences(loadPreferences());
      if (event.key === backgroundRevisionKey) void refreshBackground().catch(error => session.setMessage(error.message));
    };
    window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync);
  }, []);
  useEffect(() => {
    document.title = active ? `${active.name} — Omarkie` : "Omarkie";
  }, [active?.name]);
  useEffect(() => {
    editor()?.focus();
  }, [session.activeId]);
  commands.current = ({ action, document: opened, anchor, line, message }) => {
    if (["new", "newWindow", "newTab", "open"].includes(action) && window.desktop?.windowAction) { void host.windowAction(action).catch((error: Error) => session.setMessage(error.message)); return; }
    const context = commandsByAction.get(action)?.context;
    if (readOnly && ((context && context !== "document") || ["delete-word", "undo", "redo", "paste-plain", "image", "table", "link", "reference-link", "footnote", "copy-all-images", "move-all-images", "upload-all-images"].includes(action))) { session.setMessage(t("只读模式已开启，请先在插件管理中关闭或切换只读效果。")); return; }
    if (context && !active) return;
    if (["rich", "table"].includes(context || "") && !editor()?.richMode()) return;
    if (action === "notice") { if (message) session.setMessage(message); }
    else if (action === "omarchy-theme") void refreshOmarchy();
    else if (action === "opened") {
      if (opened) void session.add(opened).then(record => { if (record && (anchor || line)) { const heading = anchor ? extractHeadings(record.content).find(heading => heading.id === anchor || heading.text === anchor) : undefined; jumpTo(record.id, line || heading?.line || 1); } });
    } else if (["new", "newWindow", "newTab"].includes(action)) void session.create();
    else if (action === "open") void session.open();
    else if (action === "folder") void session.openFolder();
    else if (action === "showcase") void session.openShowcase();
    else if (action === "save") void session.save();
    else if (["document-tools", "properties", "backlinks", "graph"].includes(action) && active) setTools({ tab: action === "document-tools" ? "okf" : action as ToolTab, id: active.id });
    else if (action === "clean-converted" && active) {
      if (cleanVisible) closeClean();
      else openClean();
    }
    else if (action === "collect-reading" && active) {
      const current = editor();
      if (current?.composing()) { session.setMessage(t("Finish composing text before collecting highlights and callouts.")); return; }
      const markdown = current?.markdown() ?? active.content;
      void import("../shared/reading-collector.ts").then(({ collectReadingItems, readingSummary }) => {
        const items = collectReadingItems(markdown);
        if (!items.length) { session.setMessage(t("No highlights or callouts in this note.")); return; }
        const title = t("Reading summary");
        return session.create({ name: `${title}.md`, body: readingSummary(items, title, t("Source: {{name}}", { name: active.name })) });
      }).catch(error => session.setMessage(error.message));
    }
    else if (action === "encoding") setDialog("encoding");
    else if (action === "saveAs") void session.save(true);
    else if (action === "close") void session.close();
    else if (action === "reopen") {
      if (window.desktop?.windowAction) void host.windowAction("reopen")
        .then((handled: unknown) => { if (!handled) return session.reopen(); })
        .catch((error: Error) => session.setMessage(error.message));
      else void session.reopen();
    }
    else if (action === "quit") void session.quit();
    else if (action === "close-window") void session.closeWindow();
    else if (["text-larger", "text-smaller", "text-reset"].includes(action)) setPreferences(previous => ({ ...previous, fontSize: action === "text-reset" ? 16 : Math.max(12, Math.min(28, previous.fontSize + (action === "text-larger" ? 1 : -1))) }));
    else if (action === "source") setRenderedView(!renderedView);
    else if (action === "reading-layers") toggleReading();
    else if (action === "sidebar") toggleSidebar();
    else if (action === "outline" || action === "files" || action === "file-tree") {
      if (readingVisible) closeReading();
      setTab(action === "file-tree" ? "tree" : action);
      setSidebar(true);
    } else if (action === "theme")
      chooseTheme(value => toggledTheme(value, omarchy?.mode !== "light"));
    else if (action === "focus") setFocus((value) => !value);
    else if (action === "typewriter") setTypewriter(value => !value);
    else if (action === "tts-paragraph" || action === "tts-cursor" || action === "tts-stop") {
      if (!window.desktop?.readAloud) return;
      try {
        const text = action === "tts-stop" ? null : editor()?.readingText(action === "tts-cursor") ?? "";
        void host.readAloud!(text).catch(error => session.setMessage(error.message));
      } catch (error) { session.setMessage((error as Error).message); }
    }
    else if (action === "new-file" || action === "new-folder") setFileOperation({ action, path: session.folder || undefined, name: action === "new-file" ? t("未命名.md") : t("新文件夹") });
    else if (action === "undo-file") void session.fileOperation({ action: "undo" }).catch(e => session.setMessage(e.message));
    else if (["preferences", "plugins", "quick-open", "statistics", "recent", "global-search", "table", "link", "reference-link", "footnote"].includes(action)) {
      setSelectedText(editor()?.selectionText() || ""); setDialog(action as typeof dialog);
    }
    else if (action === "find") editor()?.find();
    else if (action === "find-next") editor()?.findNext();
    else if (action === "find-previous") editor()?.findNext(true);
    else if (action === "undo") editor()?.undo();
    else if (action === "redo") editor()?.redo();
    else if (["cut", "copy", "paste", "select-all"].includes(action)) {
      editor()?.focus();
      void window.desktop?.editRole(action === "select-all" ? "selectAll" : action);
    }
    else if (action === "bold") editor()?.wrap("**", "**");
    else if (action === "italic") editor()?.wrap("*", "*");
    else if (action === "underline") editor()?.wrap("<u>", "</u>");
    else if (action === "comment") editor()?.wrap("<!-- ", " -->");
    else if (action === "strike") editor()?.wrap("~~", "~~");
    else if (action === "inline-code") editor()?.wrap("`", "`");
    else if (action === "highlight") editor()?.wrap("==", "==");
    else if (action === "superscript") editor()?.wrap("^", "^");
    else if (action === "subscript") editor()?.wrap("~", "~");
    else if (action === "clear-format") editor()?.clearFormat();
    else if (action === "code") editor()?.codeBlock();
    else if (action === "autosave") session.setAutosave((value) => !value);
    else if (action === "about") setAbout(true);
    else if (["pdf", "html", "docx", "rtf", "odt", "epub", "latex", "rst", "mediawiki", "textile", "opml", "revealjs"].includes(action)) void exportDocument(action);
    else if (action === "import") void importDocument();
    else if (["copy-all-images", "move-all-images", "upload-all-images"].includes(action) && active) {
      const source = active.content, sources = [...new Set(imageReferences(source).map(image => image.url))];
      if (!sources.length) { session.setMessage(t("当前文档没有图片。")); return; }
      void host.persist({ documents: session.documents, activeId: session.activeId }).then(() => host.imageAction(active.id, sources, action.split("-")[0], { ...preferences })).then(mapping => { if (mapping) editors.current.get(active.id)?.transform(text => updateImageReferences(text, mapping)); }).catch(e => session.setMessage(e.message));
    }
    else if (action === "copy-markdown") void host.writeClipboard(editor()?.selectionText(true) || "").catch(error => session.setMessage(error.message));
    else if (action === "paste-plain") void host.readClipboard().then(text => editor()?.insert(text)).catch(error => session.setMessage(error.message));
    else if (action === "image" && active) void (async () => {
      await host.persist({ documents: session.documents, activeId: session.activeId });
      const image = await host.chooseImage(active.id, { ...preferences, source: active.content }); if (!image) return;
      if (preferences.imageAutoUpload) { try { const mapping = await host.imageAction(active.id, [image.path], "upload", { ...preferences }); if (mapping?.[image.path]) image.path = mapping[image.path]; } catch (e) { session.setMessage(t("上传失败，已保留本地图片：{{message}}", { message: (e as Error).message })); } }
      editors.current.get(active.id)?.insert(`![${image.alt.replace(/[\[\]]/g, "")}](${image.path})`);
    })().catch(error => session.setMessage(error.message));
    else editor()?.command(action);
  };
  useEffect(() => {
    if (!session.ready) return;
    performance.mark("omarkie:session-restored");
    void window.desktop?.ready?.();
  }, [session.ready]);
  useEffect(() => {
    if (!session.ready || active && !activeEditorReady) return;
    const id = active?.id;
    return afterDocumentPaint(() => {
      if (pluginContext.current.active?.id !== id) return;
      if (id && !firstDocumentPainted.current) {
        performance.mark("omarkie:first-document-painted", { detail: { id, mode: activeEditorReady } });
        firstDocumentPainted.current = true;
      }
      setPaintedDocument(id || null);
      setPainted(true);
    });
  }, [session.ready, active?.id, activeEditorReady]);
  useEffect(() => host.onCommand((command) => commands.current(command)), []);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (imeKey(event) || pluginContext.current.editor()?.composing() || document.querySelector(".utility-dialog") || (event.target as HTMLElement)?.closest('input,textarea,select,[role="dialog"]')) return;
      if (event.key === "Escape") {
        setFocus(false);
        setAbout(false);
      }
      const action = commandForKey(event);
      if (window.desktop?.windowAction && ["new", "newWindow", "newTab", "open", "save", "saveAs", "close-window"].includes(action || "")) return;
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        commands.current({ action });
      }
    };
    document.addEventListener("keydown", shortcut, true);
    return () => document.removeEventListener("keydown", shortcut, true);
  }, []);
  useEffect(() => {
    if (!session.message) return;
    const timer = setTimeout(() => session.setMessage(""), 6500);
    return () => clearTimeout(timer);
  }, [session.message]);
  const status = session.saving
    ? t("正在保存…")
    : active?.conflict
      ? t("磁盘修改冲突")
      : active?.content !== active?.savedContent
        ? active?.path
          ? session.autosave
            ? t("等待保存")
            : t("未保存")
          : t("本地草稿")
        : active?.path
          ? t("已保存")
          : t("本地草稿");
  const payloadView = activePayload && <Suspense fallback={null}><PayloadPanel
    key={activePayload.sequence} mode={activePayload.mode} source={activePayload.source} selection={activePayload.selection}
    followUp={readingVisible} preferences={preferences} editable={!readOnly && !active?.conflict && !session.fileOperationBusy} append={appendPayload}
    configure={() => setDialog("preferences")} close={() => { setPayload(null); editor()?.focus(); }}
  /></Suspense>;
  return (
    <div
      className={`app-shell ${filesVisible ? "" : "sidebar-hidden"} ${focus ? "focus-mode" : ""} ${typewriter ? "typewriter-mode" : ""}${activePayload && !readingVisible ? " payload-open" : ""}`}
    >
      <Toolbar
        checked={checked}
        name={active?.name || ""}
        edited={!!active && active.content !== active.savedContent}
        rendered={renderedView}
        setRendered={setRenderedView}
        sidebar={toggleSidebar}
        command={(action) => commands.current({ action })}
        autosave={session.autosave}
        disabled={!active}
        context={editor()?.context() || ""}
        reading={readingSupported && active ? { open: readingVisible, enabled: !!activeEditorReady } : undefined}
        payload={payloadEnabled ? { open: !!activePayload, show: () => activePayload ? setPayload(null) : openPayload("summary") } : undefined}
      />
      <Sidebar
        operation={operation => { if (operation.action === "trash" || operation.action === "undo" || operation.target) void session.fileOperation(operation).catch(e => session.setMessage(e.message)); else setFileOperation(operation); }}
        search={() => setDialog("global-search")} recent={() => setDialog("recent")} notify={session.setMessage}
        documents={session.documents}
        activeId={session.activeId}
        files={session.files}
        folder={session.folder}
        headings={headings}
        tab={tab}
        setTab={setTab}
        select={session.setActiveId}
        openToken={session.openToken}
        openFolder={session.openFolder}
        create={() => void session.create()}
        refresh={session.refresh}
        close={session.close}
        jump={(line) => editor()?.jump(line)}
        theme={theme}
        toggleTheme={() => chooseTheme(value => toggledTheme(value, omarchy?.mode !== "light"))}
      />
      <main className={`writing-area ${background ? "has-background" : ""}`} aria-label={t("写作空间")} inert={session.fileOperationBusy}>
        {background && <div className="background-image editor-background" data-editor-background="true" aria-hidden="true" style={backgroundStyle(background,preferences)} />}
        {active?.conflict && (
          <div className="conflict-banner" role="alert">
            <AlertCircle size={17} />
            <span>{t("文件在磁盘上已改变。当前草稿已保留。")}</span>
            <button onClick={() => void session.save(true)}>{t("另存副本")}</button>
            <button onClick={() => void session.reload()}>{t("重新载入")}</button>
            <button onClick={() => void session.save(false, active.id, true)}>
              {t("覆盖磁盘")}
            </button>
          </div>
        )}
        {!session.ready ? (
          <div className="empty-document">{t("正在恢复文档…")}</div>
        ) : !active ? (
          <div className="empty-document">
            <h1>Omarkie</h1>
            <p>{t("新建或打开 Markdown 文档。")}</p>
            <div>
              <button onClick={() => void session.create()}>
                <FilePlus2 size={18} />
                {t("新建文档")}
              </button>
              <button onClick={() => void session.open()}>
                <FolderOpen size={18} />
                {t("打开文件")}
              </button>
            </div>
          </div>
        ) : (
          <>
            {session.documents.map((record) => record.id === session.activeId || mountedDocuments.has(record.id) ? (
              <div
                className="document-editor"
                hidden={record.id !== session.activeId || cleanVisible}
                key={record.id}
              >
                <MarkdownEditor
                  key={`${record.id}-${record.lineEnding}`}
                  ref={(handle) => {
                    if (handle) {
                      editors.current.set(record.id, handle);
                      if (pendingJump.current?.id === record.id) jumpTo(record.id, pendingJump.current.line);
                    } else editors.current.delete(record.id);
                  }}
                  document={record}
                  rendered={record.id === session.activeId ? renderedView : rendered}
                  active={record.id === session.activeId}
                  readOnly={readOnly}
                  reading={readingVisible && record.id === session.activeId}
                  citationVault={painted && record.id === session.activeId && host.bibliography ? session.folder ?? undefined : undefined}
                  preferences={preferences}
                  remoteImages={remoteImages}
                  typewriter={typewriter}
                  onChange={(content) => session.update(record.id, { content })}
                  onError={session.setMessage}
                  onCursor={(line, column) => {
                    if (record.id === session.activeId)
                      setCursor({ line, column });
                  }}
                  onSelection={text => { if (record.id === session.activeId) setSelection(text); }}
                  onCompositionEnd={() => { if (record.id === session.activeId) pluginRuntime.current?.documentChanged(); }}
                  onSourceFallback={() => { if (record.id === session.activeId) setRenderedView(false); }}
                  onReady={mode => {
                    if (mode && record.id === session.activeId) performance.mark("omarkie:editor-ready", { detail: { id: record.id, mode } });
                    setReadyEditors(current => {
                      if (mode) return current[record.id] === mode ? current : { ...current, [record.id]: mode };
                      if (!Object.hasOwn(current, record.id)) return current;
                      const next = { ...current }; delete next[record.id]; return next;
                    });
                  }}
                  onReference={async url => {
                    if (url.startsWith("#")) { const heading = extractHeadings(record.content).find(heading => heading.id === decodeURIComponent(url.slice(1))); if (heading) editors.current.get(record.id)?.jump(heading.line); return; }
                    if (session.folder || /^omarkie-(wiki|tag):/.test(url)) setTools({ tab: "references", id: record.id, request: url });
                    else await host.openDocumentLink(record.id, url);
                  }}
                />
              </div>
            ) : null)}
            {cleanVisible && <Suspense fallback={<p className="layers-clean-loading" role="status">{t("正在清理文本…")}</p>}><CleanLayer
              key={active.id} record={active} current={() => pluginContext.current.active} editor={() => pluginContext.current.editor()}
              canBake={!readOnly && !active.conflict && !session.fileOperationBusy} close={closeClean}
            /></Suspense>}
            {readingVisible && painted && <Suspense fallback={null}><ReadingLayers
              key={`${active.id}:${active.path}:${session.folder}`} id={active.id} content={settledContent} editor={editor}
              saved={readingSaved} state={readingView}
              change={value => setReadingViews(current => ({ ...current, [active.id]: value }))}
              actions={{
                clean: { visible: cleanVisible, open: openClean, close: closeClean },
                ask: payloadSupported ? { visible: !!activePayload, open: target => openPayload(target ? "question" : "summary", target?.quote, true), close: () => setPayload(null) } : undefined,
                card: readingSaved ? { visible: flashcardsVisible, open: openFlashcards, close: closeFlashcards } : undefined,
              }}
              payload={payloadView}
              cards={flashcardsVisible && flashcardPanel && <Suspense fallback={null}><Flashcards
                id={active.id} content={active.content} panel={flashcardPanel} close={() => { closeFlashcards(); editor()?.focus(); }}
              /></Suspense>}
              close={closeReading}
            /></Suspense>}
            <article
              className="print-document"
              ref={printDocument}
            />
          </>
        )}
      </main>
      {!readingVisible && payloadView}
      <footer className="statusbar">
        <button id="footer-word-count-label" onClick={() => setDialog("statistics")}
          title={t("{{status}} · 第 {{line}} 行，第 {{column}} 列 · Markdown · {{encoding}}", { status, line: cursor.line, column: cursor.column, encoding: encodingNames[active?.encoding || "utf-8"] })}
          aria-label={t("{{count}} 字，{{status}}", { count: characters, status })}
        >
          {countUnit === "characters" ? t("{{count}} 字", { count: selection ? selectionCharacters : characters }) : t("{{count}} 词", { count: selection ? documentStatistics(selection, selection, preferences.readingSpeed).words : wholeStatistics?.words || 0 })}{selection && t("（选中）")}{exporting && t(" · 正在导出…")}
        </button>
        {active && <button data-testid="text-encoding" aria-label={t("更改文本编码")} title={t("文本编码与字节顺序标记")} onClick={() => setDialog("encoding")}>{encodingNames[active.encoding || "utf-8"]}{active.bom ? " BOM" : ""}</button>}
      </footer>
      {focus && (
        <button className="leave-focus" onClick={() => setFocus(false)}>
          {t("退出专注 · Esc")}
        </button>
      )}
      {session.message && (
        <div className="toast" role="status">
          <span>{t(session.message)}</span>
          <button aria-label={t("关闭提示")} onClick={() => session.setMessage("")}>
            <X size={15} />
          </button>
        </div>
      )}
      <Suspense fallback={null}>{tools && session.documents.find(record => record.id === tools.id) && <DocumentTools
        key={JSON.stringify([tools.id, tools.request, session.folder])} record={session.documents.find(record => record.id === tools.id)!} documents={session.documents} files={session.files} folder={session.folder} preferences={preferences} initial={tools.tab} request={tools.request}
        close={() => setTools(null)}
        open={async (token, line) => { const opened = await session.openToken(token); if (opened && line) jumpTo(opened.id, line); }}
        openFolder={async () => {
          setTools(current => current && { ...current, tab: "writing" });
          await session.openFolder();
        }}
        change={async item => {
          if (readOnly || session.fileOperationBusy) throw new Error(t("当前不可编辑"));
          const record = item.token ? await session.openToken(item.token) : session.documents.find(record => record.id === tools.id);
          if (!record) throw new Error(t("文档不可用"));
          for (let attempt = 0; !editors.current.has(record.id) && attempt < 120; attempt++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const target = editors.current.get(record.id);
          if (!target || target.composing()) throw new Error(t("当前不可编辑"));
          if (target.markdown() !== item.before) throw new Error(t("预览已过期，请重新预览后再应用。"));
          target.transform(() => item.after);
        }}
        create={async (name, content) => { const record = { id: crypto.randomUUID(), path: null, name, content, savedContent: "", diskHash: null, lineEnding: "\n" }; await host.registerDraft(record); await session.add(record); }}
        convert={async (format, options) => { if (session.activeId !== tools.id) throw new Error(t("请先选择原笔记再导出")); await exportDocument(format, options); }}
      />}</Suspense>
      {fileOperation && <FileOperationDialog operation={fileOperation} files={session.files} folder={session.folder} run={session.fileOperation} close={() => setFileOperation(null)} />}
      {dialog === "encoding" && active && <EncodingDialog key={active.id} record={active} change={session.changeEncoding} close={closeDialog} />}
      {dialog === "recent" && <RecentDialog entries={session.recent} action={session.recentAction} close={closeDialog} />}
      {dialog === "global-search" && <GlobalSearch folder={session.folder} close={closeDialog} open={async match => { const record = await session.openToken(match.token); if (record) jumpTo(record.id, match.line); }} />}
      <Suspense fallback={null}>{dialog === "preferences" && <PreferencesDialog value={preferences} change={changePreferences} theme={theme} changeTheme={chooseTheme} themes={themes} installTheme={installTheme} background={background} chooseBackground={chooseBackground} clearBackground={clearBackground} plugins={() => setDialog("plugins")} close={closeDialog} />}
      </Suspense>
      <Suspense fallback={null}>{dialog === "plugins" && <PluginsDialog definitions={pluginDefinitions} preferences={pluginPreferences} states={pluginStates} toggle={(id, enabled) => setPluginPreferences(previous => ({ ...previous, [id]: { ...previous[id], enabled } }))} configure={(id, config) => setPluginPreferences(previous => ({ ...previous, [id]: { ...previous[id], config } }))} invoke={async (id,action) => { await pluginRuntime.current?.invoke(id,action); }} actions={id => pluginRuntime.current?.actions(id) || []} install={installPlugin} remove={removePlugin} close={closeDialog} />}</Suspense>
      {dialog === "quick-open" && <QuickOpen documents={session.documents} files={session.files} recent={session.recent} openRecent={path => session.recentAction("open", path)} select={session.setActiveId} open={session.openToken} close={closeDialog} />}
      {dialog && ["table", "link", "reference-link", "footnote"].includes(dialog) && <InsertDialog kind={dialog as InsertKind} selected={selectedText} close={closeDialog} submit={value => {
        if (dialog === "link") editor()?.insert(`[${(value.label || value.value || "链接").replace(/[\[\]]/g, character => "\\" + character)}](${value.value})`);
        else editor()?.command(dialog, value);
        closeDialog();
      }} />}
      {dialog === "statistics" && statistics && <Dialog title={t("字数统计")} close={closeDialog}><dl className="document-statistics"><dt>{t("范围")}</dt><dd>{statistics.selected ? t("选中文字") : t("全文")}</dd><dt>{t("单词")}</dt><dd>{statistics.words}</dd><dt>{t("字符（不含空白）")}</dt><dd>{statistics.compactCharacters}</dd><dt>{t("字符（含空白）")}</dt><dd>{statistics.characters}</dd><dt>{t("行数")}</dt><dd>{statistics.lines}</dd><dt>{t("预计阅读")}</dt><dd>{t("{{count}} 分钟", { count: statistics.minutes })}</dd></dl><label>{t("底部显示")}<select aria-label={t("底部显示")} value={countUnit} onChange={e => setCountUnit(e.target.value as typeof countUnit)}><option value="characters">{t("字符数")}</option><option value="words">{t("单词数")}</option></select></label><p className="dialog-note">{t("单词不计格式符号，中文按每字一词；字符包含源码符号。阅读速度按每分钟 {{count}} 词估算。", { count: preferences.readingSpeed })}</p></Dialog>}
      {about && (
        <div className="dialog-backdrop" onClick={() => setAbout(false)}>
          <section
            className="about-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("关于 Omarkie")}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="icon-button close-about"
              aria-label={t("关闭关于")}
              autoFocus
              onClick={() => setAbout(false)}
            >
              <X size={18} />
            </button>
            <img className="app-mark" src={appIcon} width={96} height={96} alt="" />
            <h2>Omarkie</h2>
            <p>{t("让文字，回到文字。")}</p>
            <p className="about-details">
              {appVersion} ({document.querySelector<HTMLMetaElement>('meta[name="omarkie-build"]')?.content || "dev"}) · {t("本地 Markdown 写作空间")}
              <br />
              {t("MIT 开源 · 独立实现")}
            </p>
            <button className="folder-button" onClick={() => setAbout(false)}>
              {t("回到写作")}
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
