import { lazy, Suspense, useEffect, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FilePlus2, Files, FolderOpen, X, AlertCircle } from "lucide-react";
import { conflictCopy, copiesOf } from "../shared/sync-conflicts.mjs";
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
import { configureEmbeds, freezeEmbeds, openVaultNote, renderEmbeds, updateEmbedDrafts, updateEmbedFiles } from "./editor/embeds";
import { exportHtml, portableHtml, conversionMarkdown, imagePage, selectedLines } from "./editor/print";
import { commandForKey, commandKey, commandsByAction } from "./commands";
import { loadPreferences } from "./preferences";
import { applyFonts } from "./fonts";
const PreferencesDialog = lazy(() => import("./components/PreferencesDialog").then(module => ({ default: module.PreferencesDialog })));
import { InsertDialog } from "./components/InsertDialog";
import type { InsertKind } from "./components/InsertDialog";
import { QuickOpen } from "./components/QuickOpen";
import { Dialog } from "./components/Dialog";
import { GlassExport } from "./components/GlassExport";
import { ImageExport, type ImageChoice } from "./components/ImageExport";
import { paintGlassPrint } from "./editor/glass-print";
import { imageReferences, updateImageReferences } from "./editor/images";
import { documentStatistics } from "./editor/statistics";
import { FileOperationDialog, RecentDialog, GlobalSearch } from "./components/WorkspaceDialog";
import type { FileOperation } from "./types";
import type { CanvasRequest } from "./components/CanvasView";
import type { CanvasNode } from "../shared/json-canvas.mjs";
import type { Command, ConversionOptions } from "./types";
import type { ToolTab } from "./components/DocumentTools";
const DocumentTools = lazy(() => import("./components/DocumentTools").then(module => ({ default: module.DocumentTools })));
const CleanLayer = lazy(() => import("./components/CleanLayer").then(module => ({ default: module.CleanLayer })));
const PayloadPanel = lazy(() => import("./components/PayloadPanel"));
const BaseView = lazy(() => import("./components/BaseView").then(module => ({ default: module.BaseView })));
const FoldView = lazy(() => import("./components/fold/FoldView"));
import type { Stop } from "./components/fold/stops";
import type { FlashcardPanel } from "./components/Flashcards";
const Flashcards = lazy(() => import("./components/Flashcards"));
import appIcon from "../design/icon.svg";
import { version as appVersion } from "../package.json";
import { applyTheme, builtInThemes, toggledTheme, type OmarchyPalette } from "./themes";
import { useSettled } from "./useSettled";
import { countCharacters } from "./characters";
import type { PluginRuntime } from "./plugins/runtime";
import { t } from "./i18n";
import { afterDocumentPaint } from "./plugins/startup";
import { bundledPlugins, learningPluginId, loadPluginPreferences, pluginPreferenceKey } from "./plugins/catalog";
import type { PluginDefinition, PluginState } from "./plugins/types";
const PluginsDialog = lazy(() => import("./components/PluginsDialog").then(module => ({ default: module.PluginsDialog })));
import { backgroundRevisionKey, backgroundStyle } from "./background";
import { imeKey } from "./editor/composition";
import type { BackgroundAsset } from "./background";
const LearningMode = lazy(() => import("./components/LearningMode"));
const SyncDialog = lazy(() => import("./components/SyncDialog"));
const VersionCompare = lazy(() => import("./components/VersionCompare"));
const CompanionDialog = lazy(() => import("./components/CompanionDialog"));
const CanvasView = lazy(() => import("./components/CanvasView"));

function vaultRelative(folder: string | null | undefined, file: string | null | undefined) {
  if (!folder || !file) return;
  const root = folder.replaceAll("\\", "/").replace(/\/+$/u, ""), path = file.replaceAll("\\", "/");
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return /^(?:[a-z]:)?\//iu.test(path) ? undefined : path;
}

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
  const embedSession = useRef(session);
  embedSession.current = session;
  useEffect(() => configureEmbeds({
    read: relatives => host.readNotes ? host.readNotes(relatives) : Promise.resolve([]),
    note: id => {
      const current = embedSession.current, record = current.documents.find(item => item.id === id);
      return record && { relative: vaultRelative(current.folder, record.path) ?? "", content: record.content };
    },
    open: async (relative, line) => {
      if (/\.base$/i.test(relative)) { setBaseOpen(relative); return; }
      const file =embedSession.current.files.find(item => item.isDirectory !== "true" && item.relative.replaceAll("\\", "/") === relative);
      const record = file && await embedSession.current.openToken(file.token);
      if (record) jumpTo(record.id, line);
    },
  }), []);
  useEffect(() => { updateEmbedFiles(session.folder ? session.files : []); }, [session.files, session.folder]);
  useEffect(() => {
    updateEmbedDrafts(session.documents.flatMap(record => { const relative = vaultRelative(session.folder, record.path); return relative ? [{ relative, content: record.content }] : []; }));
  }, [session.documents, session.folder]);
  const [preferences, setPreferences] = useState(() => { const initial = loadPreferences(); setMarkdownOptions(initial); return initial; });
  const initialPreferences = useRef(preferences);
  const [themes, setThemes] = useState<{ id: string; name: string; css: string }[]>([]);
  const [background,setBackground] = useState<BackgroundAsset | null>(null);
  const backgroundRequest = useRef(0);
  const [installedPlugins, setInstalledPlugins] = useState<PluginDefinition[]>([]);
  const [pluginPreferences, setPluginPreferences] = useState(loadPluginPreferences);
  const initialPluginPreferences = useRef(pluginPreferences);

  const [pluginStates, setPluginStates] = useState<Record<string, PluginState>>({});
  const [readOnly, setReadOnly] = useState(false);
  const pluginRuntime = useRef<PluginRuntime | null>(null);
  const [typewriter, setTypewriter] = useState(false);
  const [dialog, setDialog] = useState<"preferences" | "plugins" | "quick-open" | "statistics" | "recent" | "global-search" | "encoding" | "glass-export" | "image-export" | InsertKind | null>(null);
  const [fileOperation, setFileOperation] = useState<FileOperation | null>(null);
  const [tools, setTools] = useState<{ tab: ToolTab; id: string; request?: string } | null>(null);
  const [cleanId, setCleanId] = useState<string | null>(null);
  const [foldId, setFoldId] = useState<string | null>(null), [foldStop, setFoldStop] = useState<Stop>("key"), foldStart = useRef(1);
  const [payload, setPayload] = useState<{ id: string; sequence: number; mode: "summary" | "question"; source: string; selection: boolean } | null>(null);
  const [tutor, setTutor] = useState<string | null>(null), shell = useRef<HTMLDivElement>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [sheetsRoot, setSheetsRoot] = useState<HTMLDivElement | null>(null);
  const [halfTile, setHalfTile] = useState(() => window.matchMedia("(max-width: 820px)").matches);
  const [drawer, setDrawer] = useState(false);
  const [glassOffer, setGlassOffer] = useState<{ count: number; notes?: { path: string; title?: string }[] } | null>(null);
  const [glassBusy, setGlassBusy] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  // Bases (`.base`) in the file list open as read-only views; everything else opens as a document.
  const [baseOpen, setBaseOpen] = useState<string | null>(null);
  function openListed(token: string) {
    const file = session.files.find(item => item.token === token), relative = file?.relative.replaceAll("\\", "/");
    if (relative && /\.base$/i.test(relative)) { setBaseOpen(relative); return Promise.resolve(true); }
    return session.openToken(token);
  }
  const [boardRequest, setBoardRequest] = useState<{ note: string; magnet: string; at: number }>();
  const [canvasRequest, setCanvasRequest] = useState<CanvasRequest | null>(null);
  const [tutorRequest, setTutorRequest] = useState<{ text: string; at: number }>();
  const glassDismissed = useRef(false);
  useEffect(() => {
    glassDismissed.current = false;
    setGlassOffer(null);
    if (!session.ready || !session.folder || !host.glass) return;
    let current = true, received = false;
    const apply = (status: { bring?: NonNullable<typeof glassOffer> | null } | null) => {
      if (!current || glassDismissed.current) return;
      setGlassOffer(status?.bring?.count ? status.bring : null);
    };
    const stop = host.onGlassStorage?.(status => { received = true; apply(status); });
    void host.glass({ action: "status" }).then(status => {
      if (!received) apply(status as Parameters<typeof apply>[0]);
    }).catch(() => {});
    return () => { current = false; stop?.(); };
  }, [session.ready, session.folder]);
  async function bringGlass() {
    if (!host.glass) return;
    setGlassBusy(true);
    try {
      const result = await host.glass({ action: "bring" }) as { brought?: unknown[] };
      setGlassOffer(null);
      if (Array.isArray(result?.brought)) session.setMessage(t("Glass brought for {{count}} notes.", { count: result.brought.length }));
    } catch (error) {
      session.setMessage((error as Error).message);
    } finally {
      setGlassBusy(false);
    }
  }
  useEffect(() => {
    const tile = window.matchMedia("(max-width: 820px)");
    const changed = () => { setHalfTile(tile.matches); setDrawer(false); };
    tile.addEventListener("change", changed);
    return () => tile.removeEventListener("change", changed);
  }, []);
  const [selectedText, setSelectedText] = useState("");
  const [selection, setSelection] = useState("");
  const [countUnit, setCountUnit] = useState<"characters" | "words">(() => localStorage.getItem("omarkie-count-unit") === "words" ? "words" : "characters");
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const imageRange = useRef<{ from: number; to: number } | null>(null);
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
  const [compare, setCompare] = useState<"disk" | "copy" | null>(null);
  // Conflict copies exist only where the folder scan saw them; hosts without conflict tools skip the banners.
  const conflictCopies = useMemo(() => active?.path && host.resolveConflict ? copiesOf(active.path, session.files) : [], [active?.path, session.files]);
  const activeCopy = active?.path && host.resolveConflict ? conflictCopy(active.name) : null;
  const activeBase = activeCopy && session.files.find(file => file.path === active!.path!.slice(0, -active!.name.length) + activeCopy.base);
  const readingSupported = !!window.desktop?.readingStore;
  const glassSupported = !!window.desktop?.glassState;
  const [glassOn, setGlassOn] = useState(false);
  // The last press owns the state: a slow write from an earlier toggle must not flip it back.
  const glassOnRef = useRef(false), glassSeq = useRef(0), glassPending = useRef(0);
  const settleGlass = (visible: boolean) => { glassOnRef.current = visible; setGlassOn(visible); };
  useEffect(() => {
    if (!glassSupported) return;
    let current = true;
    void window.desktop!.glassState({ action: "read" }).then((response: { ok: boolean; value?: { visible?: boolean } }) => {
      if (current && response?.ok) settleGlass(response.value?.visible === true);
    }).catch(() => {});
    // A broadcast from a write this window did not start wins; our own late echoes do not.
    const stop = window.desktop!.onGlass?.((event: { visible?: boolean }) => { if (!glassPending.current) settleGlass(event?.visible === true); });
    return () => { current = false; stop?.(); };
  }, [glassSupported, session.folder]);
  function toggleGlass() {
    if (!glassSupported) return;
    const visible = !glassOnRef.current, seq = ++glassSeq.current;
    glassPending.current += 1;
    settleGlass(visible);
    if (visible) performance.mark("omarkie:glass-toggle");
    void window.desktop!.glassState({ action: "write", visible }).then((response: { ok: boolean; error?: string; value?: { visible?: boolean } }) => {
      glassPending.current = Math.max(0, glassPending.current - 1);
      if (seq !== glassSeq.current) return;
      if (response?.ok) settleGlass(response.value?.visible === true);
      else { settleGlass(!visible); session.setMessage(response?.error ?? t("当前不可编辑")); }
    }).catch((error: Error) => {
      glassPending.current = Math.max(0, glassPending.current - 1);
      if (seq === glassSeq.current) { settleGlass(!visible); session.setMessage(error.message); }
    });
  }
  const sharedSupported = !!window.desktop?.sharedGlassState;
  const [sharedOn, setSharedOn] = useState(false);
  useEffect(() => {
    if (!sharedSupported) return;
    let current = true;
    void host.sharedGlassState!({ action: "read" }).then(value => { if (current) setSharedOn(value.shared === true); }).catch(() => {});
    return () => { current = false; };
  }, [sharedSupported, session.folder]);
  function toggleSharedGlass() {
    if (!sharedSupported) return;
    const shared = !sharedOn;
    setSharedOn(shared);
    void host.sharedGlassState!({ action: "write", shared })
      .then(value => setSharedOn(value.shared === true))
      .catch((error: Error) => { setSharedOn(!shared); session.setMessage(error.message); });
  }
  const learningEnabled = readingSupported && !!pluginPreferences[learningPluginId]?.enabled;
  const readingVisible = learningEnabled && !!active && !focus && painted;
  const cleanVisible = !!active && cleanId === active.id;
  function closeClean() {
    setCleanId(null);
    const id = cleanId;
    if (id) requestAnimationFrame(() => editors.current.get(id)?.focus());
  }
  function openClean() {
    if (active && !editor()?.composing()) setCleanId(active.id);
  }
  function toggleClean() {
    if (cleanVisible) closeClean();
    else { setFoldId(null); openClean(); }
  }
  const foldVisible = !!active && readingVisible && foldId === active.id && !cleanVisible;
  const foldScroller = ".writing-area > .document-editor:not([hidden]) .rich-scroller:not([hidden])";
  // The source line at the top of the page, so the fold opens where the reader was.
  function editorTopLine() {
    const handle = editor(), scroller = document.querySelector<HTMLElement>(foldScroller);
    if (!active || !handle || !scroller) return 1;
    let low = 1, high = active.content.split("\n").length, best = 1;
    while (low <= high) {
      const middle = (low + high) >> 1, top = handle.topOfLine(middle);
      if (top === null) break;
      if (top <= scroller.scrollTop + 1) { best = middle; low = middle + 1; } else high = middle - 1;
    }
    return best;
  }
  const activeIdRef = useRef(active?.id);
  activeIdRef.current = active?.id;
  useEffect(() => { if (!readingVisible && !(learningEnabled && !focus)) setFoldId(null); }, [readingVisible, learningEnabled, focus]);
  useEffect(() => { setFoldId(null); }, [active?.id]);
  function toggleFold() {
    if (!active || editor()?.composing()) return;
    if (foldVisible) { setFoldId(null); return; }
    foldStart.current = editorTopLine();
    if (cleanVisible) setCleanId(null);
    if (!learningEnabled) toggleReading();
    else if (focus) setFocus(false);
    setFoldId(active.id);
  }
  // Back on the page at the fold's top line. Learning mode keeps the page read-only, so focus returns to the fold toggle.
  function leaveFold(id: string, line: number, focused: boolean) {
    requestAnimationFrame(() => {
      if (activeIdRef.current !== id) return;
      const handle = editors.current.get(id);
      const top = handle?.topOfLine(line), scroller = document.querySelector<HTMLElement>(foldScroller);
      if (scroller && top !== null && top !== undefined) scroller.scrollTop = top;
      if (!focused) return;
      const toggle = [...document.querySelectorAll<HTMLElement>(".fold-toggle")].find(element => element.getClientRects().length > 0);
      if (toggle) toggle.focus({ preventScroll: true }); else handle?.focus();
    });
  }
  const activeEditorReady = active ? readyEditors[active.id] : undefined;
  const payloadSupported = !!window.desktop?.payloadRequest;
  const payloadEnabled = preferences.payloadEnabled && payloadSupported;
  const learningSaved = readingVisible && !!active.path && !!session.folder &&
    active.path.replaceAll("\\", "/").startsWith(session.folder.replaceAll("\\", "/").replace(/\/?$/, "/"));
  const tutorKey = learningSaved && payloadSupported && activeEditorReady ? `${active.id}:${active.path}:${session.folder}` : null;
  const tutorOpen = !!tutorKey && tutor === tutorKey;
  // Payload and the Tutor curtain share the side slot; the editor being ready is not a Tutor.
  // Keying this on tutorKey hid Payload in every Learning session whose editor stayed mounted.
  const payloadAvailable = payloadEnabled && !tutorOpen;
  const activePayload = payload && payload.id === active?.id && payloadAvailable ? payload : null;
  const sidebarVisible = readingVisible && halfTile ? drawer && !activePayload && !tutorOpen : sidebar;
  const filesVisible = sidebarVisible && (!readingVisible || showFiles);
  useEffect(() => { if (readingVisible && !halfTile) setSidebar(true); }, [readingVisible, halfTile]);
  useEffect(() => { if (tutor && tutor !== tutorKey) setTutor(null); }, [tutor, tutorKey]);
  function openTutor() {
    if (!tutorKey) return;
    setTutor(tutorKey); closeFlashcards();
    if (halfTile) setDrawer(false);
  }
  function closeTutor() { setTutor(null); editor()?.focus(); }
  function openCanvas(clips?: CanvasNode[], last = false) {
    if (!host.canvas || !session.folder) { session.setMessage(t("Open a notes folder to use canvas boards.")); return; }
    setCanvasRequest({ last, clips, at: Date.now() });
  }
  async function openCanvasNote(file: string, line: number) {
    setCanvasRequest(null);
    const item = session.files.find(entry => entry.isDirectory !== "true" && entry.relative.replaceAll("\\", "/") === file);
    const record = item && await session.openToken(item.token);
    if (!record) { session.setMessage(t("The file no longer exists.")); return; }
    jumpTo(record.id, line);
  }
  function openFilesRail() {
    setShowFiles(true);
    openSidebar();
  }
  useEffect(() => {
    if (payload && !activePayload) setPayload(null);
  }, [payload, activePayload]);
  function openPayload(mode: "summary" | "question", selection?: string) {
    if (!active || !payloadAvailable) return;
    if (learningEnabled && halfTile) setDrawer(false);
    const target = editor(), selected = selection ?? target?.selectionText(true);
    const source = selected || target?.markdown() || active.content;
    setPayload(previous => ({ id: active.id, sequence: (previous?.sequence ?? 0) + 1, mode, source, selection: !!selected }));
  }
  function appendPayload(summary: string) {
    const target = editor();
    if (!active || active.conflict || !target || readOnly || session.fileOperationBusy) throw new Error(t("当前不可编辑"));
    const source = target.markdown(), eol = active.lineEnding;
    const callout = ["> [!summary] " + t("Payload summary"), ...summary.split(/\r\n?|\n/).map(line => line ? `> ${line}` : ">")].join(eol);
    if (!target.replaceRange(source.length, source.length, (source ? eol.repeat(2) : "") + callout + eol, "", true)) throw new Error(t("当前不可编辑"));
  }
  const [learningViews, setLearningViews] = useState<Record<string, boolean>>({});
  const renderedFor = (id: string) => learningEnabled ? learningViews[id] ?? rendered : rendered;
  const renderedView = active ? renderedFor(active.id) : rendered;
  const suppressRemoteImages = readingVisible || cleanVisible;
  const remoteImages = preferences.remoteImages && !suppressRemoteImages;
  useInsertionEffect(() => {
    // Rich editors read the parser policy in descendant layout effects.
    setMarkdownOptions({ ...preferences, remoteImages });
  }, [preferences, remoteImages]);
  function setRenderedView(value: boolean) {
    if (learningEnabled && active) setLearningViews(previous => ({ ...previous, [active.id]: value }));
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
  const pluginContext = useRef({ active, editor, preferences, notify: session.setMessage, session, importCards });
  pluginContext.current = { active, editor, preferences, notify: session.setMessage, session, importCards };
  const pluginDefinitions = useMemo(() => [...bundledPlugins, ...installedPlugins].map(definition => ({ ...definition, config: { ...definition.config, ...pluginPreferences[definition.id]?.config } })), [installedPlugins, pluginPreferences]);
  const runtimeDefinitions = useMemo(() => pluginDefinitions.filter(definition => !definition.renderer), [pluginDefinitions]);
  const runtimeEnabled = runtimeDefinitions.some(definition => pluginPreferences[definition.id]?.enabled);
  useEffect(() => {
    if (!painted || !runtimeEnabled) { setRuntimeReady(false); return; }
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
      // Obsidian ports read through this; capabilities.ts decides which port may call what.
      ports: {
        snapshot: async () => {
          const { session } = pluginContext.current;
          if (!session.folder) throw new Error(t("Open a folder first. Queries read only notes in the open folder."));
          const value = await host.vaultSnapshot();
          return {
            truncated: value.truncated, assets: value.assets.map(asset => ({ relative: asset.relative.replaceAll("\\", "/") })),
            notes: value.notes.map(note => {
              const path = note.path || session.files.find(file => file.token === note.token)?.path;
              const draft = session.documents.find(record => record.path && record.path === path);
              return { relative: note.relative.replaceAll("\\", "/"), content: draft ? draft.content : note.content };
            }),
          };
        },
        activeNote: () => {
          const { active, editor, session } = pluginContext.current;
          return { relative: vaultRelative(session.folder, active?.path) ?? null, content: editor()?.markdown() ?? active?.content ?? "" };
        },
        open: async relative => {
          const { session } = pluginContext.current;
          const file = session.files.find(item => item.isDirectory !== "true" && item.relative.replaceAll("\\", "/") === relative);
          return !!file && !!await session.openToken(file.token);
        },
        draftCards: (drafts, found) => pluginContext.current.importCards(drafts, found),
      },
    });
    loaded = runtime; pluginRuntime.current = runtime; setRuntimeReady(true);
    }).catch(error => session.setMessage(error.message));
    return () => { cancelled = true; pluginRuntime.current = null; void loaded?.destroy(); };
  }, [painted, runtimeEnabled]);
  useEffect(() => {
    if (!painted) return;
    void host.plugins().then(items => setInstalledPlugins(items.map(item => ({ ...item, description: t("本地插件，通过兼容接口运行。"), config: {} })))).catch(error => session.setMessage(error.message));
  }, [painted, dialog === "plugins"]);
  useLayoutEffect(() => {
    if (window.desktop?.savePluginPreferences) {
      if (pluginPreferences !== initialPluginPreferences.current || localStorage.getItem(pluginPreferenceKey) !== null)
        window.desktop.savePluginPreferences(JSON.stringify(pluginPreferences));
    } else localStorage.setItem(pluginPreferenceKey, JSON.stringify(pluginPreferences));
  }, [pluginPreferences]);

  useEffect(() => {
    if (!session.ready || !active) return;
    for (const definition of runtimeDefinitions) if (!pluginPreferences[definition.id]?.enabled) void pluginRuntime.current?.setEnabled(definition, false);
    if (!activeEditorReady || paintedDocument !== active.id || !runtimeEnabled) return;
    return afterDocumentPaint(() => {
      for (const definition of runtimeDefinitions) if (pluginPreferences[definition.id]?.enabled) void pluginRuntime.current?.setEnabled(definition, true);
    });
  }, [runtimeDefinitions, pluginPreferences, session.ready, active?.id, activeEditorReady, paintedDocument, runtimeReady, runtimeEnabled]);
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
  useLayoutEffect(() => {
    if (window.desktop?.savePreferences) {
      if (preferences !== initialPreferences.current || localStorage.getItem("omarkie-preferences") !== null)
        window.desktop.savePreferences(JSON.stringify(preferences));
    } else localStorage.setItem("omarkie-preferences", JSON.stringify(preferences));
  }, [preferences]);
  useEffect(() => {
    document.documentElement.style.setProperty("--editor-font-size", `${preferences.fontSize}px`);
    document.documentElement.style.setProperty("--editor-line-height", String(preferences.lineHeight));
    document.documentElement.style.setProperty("--editor-columns", `${preferences.editorColumns}ch`);
    document.documentElement.style.setProperty("--standalone-image-scale", String(preferences.standaloneImageScale));
    pluginRuntime.current?.event("displayChanged");
  }, [preferences]);
  const checked = { source: !renderedView, focus, typewriter, sidebar: sidebarVisible, outline: filesVisible && tab === "outline", files: filesVisible && tab === "files", "file-tree": filesVisible && tab === "tree", "reading-layers": learningEnabled, fold: foldVisible, glass: glassOn, "shared-glass": sharedOn };
  const menuContext = editor()?.context() || "";
  useEffect(() => { if (window.desktop?.viewState) void window.desktop.viewState(focus, typewriter, sidebarVisible, checked, !active, menuContext).catch(() => {}); }, [focus, typewriter, sidebarVisible, filesVisible, renderedView, learningEnabled, foldVisible, glassOn, sharedOn, tab, active?.id, menuContext]);
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
  function openFlashcards(target?: FlashcardPanel["target"], answer?: FlashcardPanel["answer"]) {
    if (window.desktop?.readingStore && active?.path && session.folder) {
      setTutor(null);
      if (halfTile) setDrawer(false);
      setFlashcardPanel({ id: active.id, path: active.path, folder: session.folder, target, answer });
    }
  }
  // Spaced Repetition port drafts open in Study cards for review; Learning mode hosts that panel, so it turns on.
  function importCards(drafts: NonNullable<FlashcardPanel["imported"]>["drafts"], found: number) {
    if (!readingSupported) throw new Error(t("Study cards need the desktop app."));
    if (!active?.path || !session.folder) throw new Error(t("Save this note in the open folder to import its cards."));
    if (editor()?.composing()) return;
    if (!learningEnabled) {
      setPluginPreferences(previous => ({ ...previous, [learningPluginId]: { ...previous[learningPluginId], enabled: true } }));
      setShowFiles(false);
      setFocus(false);
    }
    setTutor(null);
    if (halfTile) setDrawer(false);
    setFlashcardPanel({ id: active.id, path: active.path, folder: session.folder, imported: { drafts, found } });
  }
  function toggleReading() {
    if (!readingSupported || editor()?.composing()) return;
    setPluginPreferences(previous => ({ ...previous, [learningPluginId]: { enabled: !learningEnabled } }));
    setShowFiles(false);
    setDrawer(false);
    if (learningEnabled) {
      closeFlashcards();
      setTutor(null);
      requestAnimationFrame(() => editor()?.focus());
    } else setFocus(false);
  }
  function openSidebar() {
    if (readingVisible && halfTile) {
      setTutor(null); setPayload(null); closeFlashcards(); setDrawer(true);
    } else setSidebar(true);
  }
  function toggleSidebar() {
    if (readingVisible && halfTile) {
      if (sidebarVisible) setDrawer(false);
      else openSidebar();
    } else setSidebar(value => !value);
  }
  function closeDialog() { setDialog(null); queueMicrotask(() => editor()?.focus()); }
  function changePreferences(next: typeof preferences) { setPreferences(next); }
  async function exportDocument(kind: string, options?: ConversionOptions, glassScope?: "page" | "flat" | "handout", image?: ImageChoice) {
    if (exportingRef.current || !active || !printDocument.current) return;
    if (editor()?.composing()) { session.setMessage(t("请先完成当前输入法组合输入，再导出。")); return; }
    exportingRef.current = true; setExporting(true); document.body.classList.add("printing");
    if (glassScope === "handout") document.body.classList.add("printing-handout");
    try {
      await host.persist({ documents: session.documents, activeId: session.activeId });
      await loadHighlighting();
      printDocument.current.innerHTML = renderMarkdown(image?.selection && imageRange.current ? selectedLines(active.content, imageRange.current) : active.content, active.id, { smartPunctuation: preferences.smartPunctuation });
      await fontFacesReady();
      await renderEmbeds(printDocument.current, active.id); freezeEmbeds(printDocument.current, active.id);
      await Promise.all([renderDiagrams(printDocument.current), renderMath(printDocument.current), document.fonts.ready]);
      const glassNote = vaultRelative(session.folder, active.path);
      if (glassScope && glassNote && host.glass) {
        const glass = await host.glass({ action: "list", note: glassNote });
        const magnets = (Array.isArray(glass?.magnets) ? glass.magnets : []).filter((magnet: { deleted?: boolean }) => !magnet.deleted);
        if (magnets.length) await paintGlassPrint(printDocument.current, { note: glassNote, title: active.name, magnets, scope: glassScope });
      }
      // Image export never fetches: remote pictures become their alt text.
      if (kind === "png") for (const remote of printDocument.current.querySelectorAll<HTMLImageElement>('img[src^="http:" i],img[src^="https:" i]')) remote.replaceWith(remote.alt);
      const result = kind === "png" ? await (host.exportImage ? host.exportImage(active.name, imagePage(await portableHtml(printDocument.current, active.name, image?.light ? builtInThemes.find(theme => theme.id === "light") : undefined)), { scale: image?.scale ?? 1 }) : Promise.reject(new Error(t("Image export needs the desktop app.")))) : options ? await host.exportConverted(active.id, kind, await conversionMarkdown(active.content, printDocument.current), await portableHtml(printDocument.current, active.name), options) : kind === "pdf" ? await host.exportPdf(exportHtml(printDocument.current), { paper: preferences.pdfPaper, margin: preferences.pdfMargin, header: preferences.pdfHeader, footer: preferences.pdfFooter, title: active.name }) : kind === "html" ? await host.exportHtml(active.name, await portableHtml(printDocument.current, active.name)) : await host.exportConverted(active.id, kind, await conversionMarkdown(active.content, printDocument.current), await portableHtml(printDocument.current, active.name));
      if (result) session.setMessage(t("{{format}} 已导出。", { format: kind.toUpperCase() }));
    } catch (error) { session.setMessage((error as Error).message); }
    finally { document.body.classList.remove("printing", "printing-handout"); exportingRef.current = false; setExporting(false); }
  }
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("omarkie-theme", theme);
  }, [theme]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === pluginPreferenceKey && !window.desktop?.savePluginPreferences) setPluginPreferences(loadPluginPreferences());
      if (event.key === "omarkie-theme") setTheme(event.newValue || "light");
      if (event.key === "omarkie-preferences" && !window.desktop?.savePreferences) setPreferences(loadPreferences());
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
  commands.current = ({ action, document: opened, anchor, line, message, note: boardNote, magnet: boardMagnet }) => {
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
    else if (action === "clean-converted" && active) toggleClean();
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
    else if (action === "fold") toggleFold();
    else if (action === "glass") toggleGlass();
    else if (action === "shared-glass") toggleSharedGlass();
    else if (action === "glass-export" && active) setDialog("glass-export");
    else if (action === "image-export" && active) { const range = editor()?.selectionRange(); imageRange.current = range && range.to > range.from ? range : null; setDialog("image-export"); }
    else if (action === "sync") setSyncOpen(true);
    else if (action === "canvas-boards") openCanvas();
    else if (action === "open-board") {
      if (!boardNote || !boardMagnet) return;
      if (!preferences.boardEnabled) { session.setMessage(t("Enable the Board add-on in Settings first.")); return; }
      void (async () => {
        const current = vaultRelative(session.folder, active?.path);
        if (current !== boardNote) {
          const file = session.files.find(item => item.isDirectory !== "true" && item.relative.replaceAll("\\", "/") === boardNote);
          if (!file) { session.setMessage(t("Board note is not in this folder.")); return; }
          const record = await session.openToken(file.token);
          if (!record) return;
        }
        setBoardRequest({ note: boardNote, magnet: boardMagnet, at: Date.now() });
      })().catch((error: Error) => session.setMessage(error.message));
    }
    else if (action === "sidebar") toggleSidebar();
    else if (action === "outline" || action === "files" || action === "file-tree") {
      openFilesRail();
      setTab(action === "file-tree" ? "tree" : action);
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
      if (!painted) void window.desktop?.painted?.();
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
      const printable = action ? commandsByAction.get(action)?.key : undefined;
      if (printable && /^[A-Za-z]$/.test(printable) && event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
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
    preferences={preferences} editable={!readOnly && !active?.conflict && !session.fileOperationBusy} append={appendPayload}
    configure={() => setDialog("preferences")} close={() => { setPayload(null); editor()?.focus(); }}
  /></Suspense>;
  return (
    <div
      ref={shell} className={`app-shell ${sidebarVisible ? "" : "sidebar-hidden"} ${focus ? "focus-mode" : ""} ${typewriter ? "typewriter-mode" : ""}${readingVisible ? " learning-mode" : ""}${activePayload || tutorOpen ? " payload-open" : ""}${tutorOpen ? " tutor-open" : ""}`}
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
        learning={readingSupported ? learningEnabled : undefined}
        sync={window.desktop ? window.desktop.sync && session.folder ? { open: syncOpen, show: () => setSyncOpen(true) } : undefined : { open: syncOpen, show: () => setSyncOpen(true), companion: true }}
        tutor={tutorKey ? { open: tutorOpen, show: tutorOpen ? closeTutor : openTutor } : undefined}
        payload={payloadAvailable ? { open: !!activePayload, show: () => activePayload ? setPayload(null) : openPayload("summary") } : undefined}
      />
      {glassOffer && (
        <div className="glass-banner" role="status">
          <span>{t("{{count}} notes here already have glass on this computer.", { count: glassOffer.count })}</span>
          <button disabled={glassBusy} onClick={() => void bringGlass()}>{t("Bring glass")}</button>
          <button className="glass-banner-dismiss" aria-label={t("Dismiss")} onClick={() => { glassDismissed.current = true; setGlassOffer(null); }}><X size={15} /></button>
        </div>
      )}
      <Sidebar
        operation={operation => { if (operation.action === "trash" || operation.action === "undo" || operation.target) void session.fileOperation(operation).catch(e => session.setMessage(e.message)); else setFileOperation(operation); }}
        search={() => setDialog("global-search")} recent={() => setDialog("recent")} notify={session.setMessage}
        documents={session.documents}
        activeId={session.activeId}
        files={session.files}
        folder={session.folder}
        headings={headings}
        tab={tab}
        setTab={value => { setTab(value); if (readingVisible) setShowFiles(true); }}
        sheets={readingVisible ? { selected: !showFiles, show: () => setShowFiles(false), mount: setSheetsRoot } : undefined}
        select={session.setActiveId}
        openToken={token => void openListed(token)}
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
            <span>{active.missing ? t("This note is gone from disk: deleted or moved away by another app. Your text is kept here.") : t("文件在磁盘上已改变。当前草稿已保留。")}</span>
            {host.resolveConflict ? (active.missing
              ? <button onClick={() => void session.resolveConflict(active.id, { action: "restore", text: active.content })
                  .then(() => session.setMessage(t("Restored “{{name}}” on disk.", { name: active.name })), error => session.setMessage(error instanceof Error ? error.message : String(error)))}>{t("Restore file")}</button>
              : <button onClick={() => setCompare("disk")}>{t("Compare versions")}</button>)
            : <>
              <button onClick={() => void session.reload()}>{t("重新载入")}</button>
              <button onClick={() => void session.save(false, active.id, true)}>{t("覆盖磁盘")}</button>
            </>}
            <button onClick={() => void session.save(true)}>{t("另存副本")}</button>
          </div>
        )}
        {active && !active.conflict && conflictCopies.length > 0 && (
          <div className="conflict-banner sync-banner" role="status">
            <Files size={17} aria-hidden="true" />
            <span>{t("A sync app kept another version of this note.")}</span>
            <button onClick={() => setCompare("copy")}>{t("Compare versions")}</button>
          </div>
        )}
        {active?.path && activeCopy && (
          <div className="conflict-banner sync-banner" role="status">
            <Files size={17} aria-hidden="true" />
            {activeBase ? <>
              <span>{t("This file is another version of “{{name}}”.", { name: activeCopy.base })}</span>
              <button onClick={() => void session.openToken(activeBase.token)}>{t("Open “{{name}}”", { name: activeCopy.base })}</button>
            </> : <>
              <span>{t("This is the only version left of “{{name}}”.", { name: activeCopy.base })}</span>
              <button disabled={active.content !== active.savedContent} onClick={() => void session.fileOperation({ action: "rename", path: active.path!, name: activeCopy.base }).catch(error => session.setMessage(error instanceof Error ? error.message : String(error)))}>{t("Restore as “{{name}}”", { name: activeCopy.base })}</button>
            </>}
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
                hidden={record.id !== session.activeId || cleanVisible || foldVisible}
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
                  rendered={renderedFor(record.id)}
                  active={record.id === session.activeId}
                  readOnly={readOnly}
                  reading={learningEnabled}
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
            {foldVisible && <Suspense fallback={null}><FoldView
              key={active.id} id={active.id} title={active.name.replace(/\.(?:md|markdown|mdown|mkd)$/i, "")} content={active.content} stop={foldStop} setStop={setFoldStop} close={() => setFoldId(null)}
              startLine={foldStart.current} leave={(line, focused) => leaveFold(active.id, line, focused)}
            /></Suspense>}
            {readingVisible && <Suspense fallback={null}><LearningMode
              key={`${active.id}:${active.path}:${session.folder}`} id={active.id} content={settledContent} editor={editor}
              note={vaultRelative(session.folder, active.path)}
              saved={learningSaved} cleanVisible={cleanVisible} toggleClean={toggleClean} fold={{ open: foldVisible, stop: foldStop, toggle: toggleFold }} glass={glassOn && glassSupported} shared={sharedOn && sharedSupported}
              boardEnabled={preferences.boardEnabled === true} boardRequest={boardRequest}
              openBoard={host.canvas && session.folder ? clips => openCanvas(clips, true) : undefined} tutorRequest={tutorRequest}
              glassSaved={active.content === active.savedContent}
              reloadNote={session.reload}
              ready={!!activeEditorReady} rendered={activeEditorReady === "rich"} sheetsRoot={sheetsRoot}
              preview={renderedView} togglePreview={() => setRenderedView(!renderedView)}
              canWrite={!readOnly && !active.conflict && !session.fileOperationBusy}
              tutor={tutorKey ? { open: tutorOpen, root: shell.current, preferences, show: openTutor, close: closeTutor,
                configure: () => setDialog("preferences") } : undefined}
              openFiles={openFilesRail} openCard={openFlashcards}
              askPayload={payloadAvailable ? source => openPayload("question", source) : undefined}
              openSearchHit={async match => {
                const file = session.files.find(item => item.isDirectory !== "true" && item.relative.replaceAll("\\", "/") === match.document);
                const record = file && await session.openToken(file.token);
                if (!record) return false;
                if (match.line != null) jumpTo(record.id, match.line);
                return true;
              }}
              cards={flashcardsVisible && flashcardPanel && <Suspense fallback={null}><Flashcards
                id={active.id} content={active.content} panel={flashcardPanel} close={() => { closeFlashcards(); editor()?.focus(); }}
              /></Suspense>}
            /></Suspense>}
            <article
              className="print-document"
              ref={printDocument}
            />
          </>
        )}
      </main>
      {payloadView}
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
      {dialog === "glass-export" && active && <GlassExport key={active.id} note={vaultRelative(session.folder, active.path) ?? ""} close={closeDialog} pdf={scope => exportDocument("pdf", undefined, scope)} />}
      {dialog === "image-export" && active && <ImageExport key={active.id} selection={Boolean(imageRange.current)} close={closeDialog} run={choice => { closeDialog(); return exportDocument("png", undefined, undefined, choice); }} />}
      {dialog === "recent" && <RecentDialog entries={session.recent} action={session.recentAction} close={closeDialog} />}
      {dialog === "global-search" && <GlobalSearch folder={session.folder} close={closeDialog} open={async match => { const record = await session.openToken(match.token); if (record) jumpTo(record.id, match.line); }} />}
      <Suspense fallback={null}>{syncOpen && (window.desktop ? <SyncDialog close={() => setSyncOpen(false)} notify={session.setMessage} />
        : <CompanionDialog close={() => setSyncOpen(false)} notify={session.setMessage} mounted={session.refresh} />)}</Suspense>
      <Suspense fallback={null}>{compare && active && <VersionCompare record={active} mode={compare} copies={conflictCopies} close={() => setCompare(null)}
        resolve={request => session.resolveConflict(active.id, request)} notify={session.setMessage} />}</Suspense>
      <Suspense fallback={null}>{canvasRequest && session.folder && host.canvas && <CanvasView key={session.folder} vault={session.folder} request={canvasRequest}
        close={() => { setCanvasRequest(null); editor()?.focus(); }} openNote={(file, line) => void openCanvasNote(file, line)}
        askTutor={tutorKey ? text => { setCanvasRequest(null); setTutorRequest({ text, at: Date.now() }); } : undefined} />}</Suspense>
      <Suspense fallback={null}>{dialog === "preferences" && <PreferencesDialog value={preferences} change={changePreferences} theme={theme} changeTheme={chooseTheme} themes={themes} installTheme={installTheme} background={background} chooseBackground={chooseBackground} clearBackground={clearBackground} plugins={() => setDialog("plugins")} close={closeDialog} />}
      </Suspense>
      <Suspense fallback={null}>{dialog === "plugins" && <PluginsDialog definitions={pluginDefinitions} preferences={pluginPreferences} states={pluginStates} toggle={(id, enabled) => setPluginPreferences(previous => ({ ...previous, [id]: { ...previous[id], enabled } }))} configure={(id, config) => setPluginPreferences(previous => ({ ...previous, [id]: { ...previous[id], config } }))} invoke={async (id,action) => { await pluginRuntime.current?.invoke(id,action); }} actions={id => pluginRuntime.current?.actions(id) || []} install={installPlugin} remove={removePlugin} close={closeDialog} />}</Suspense>
      {dialog === "quick-open" && <QuickOpen documents={session.documents} files={session.files} recent={session.recent} openRecent={path => session.recentAction("open", path)} select={session.setActiveId} open={openListed} close={closeDialog} />}
      <Suspense fallback={null}>{baseOpen && <BaseView key={baseOpen} relative={baseOpen} close={() => setBaseOpen(null)} open={relative => openVaultNote(relative)} />}</Suspense>
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
