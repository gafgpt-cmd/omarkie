import type { EditorView } from "@codemirror/view";
import type { Compartment } from "@codemirror/state";
import { codeMirror, loadCodeMirror } from "./loadCodeMirror.ts";
import { codeSelectionCommand, selectionActions } from "./selectionCommands";
import { ImageDialog } from "../components/ImageDialog";
import { imageReferences } from "./images";
import type { ImageReference } from "./images";
import { textMatches, replaceTextMatches } from "./search";
import {
  forwardRef,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { MarkdownDocument, richTextLimit, sourceOffset, type DocumentNode } from "./model.ts";
import { RichEditor } from "./RichEditor.ts";
import { host } from "../host";
import type { DocumentRecord } from "../types";
import type { Preferences } from "../preferences";
import type { BlockArguments } from "./blockCommands.ts";
import { t } from "../i18n";
import type { Heading } from "./markdown.ts";
import { localImageSources, numberedBlocks, rememberImageSizes, speechText } from "./markdown.ts";
import { ttsTextLimit } from "../../shared/tts.mjs";
export interface ReadingContext {
  nodes: readonly DocumentNode[];
  headings: readonly Heading[];
  from: number;
  to: number;
  index: number;
  text: string;
}
const GrammarCheck = lazy(() => import("./GrammarCheck"));

import { useCitationPicker } from "./CitationPicker";
import { citationDraft } from "./citationSyntax";
export interface EditorHandle {
  view(): EditorView | null;
  find(): void;
  jump(line: number): void;
  wrap(before: string, after?: string): void;
  codeBlock(): void;
  undo(): void;
  redo(): void;
  focus(): void;
  richMode(): boolean;
  command(action: string, args?: BlockArguments): void;
  insert(text: string): void;
  selectionText(markdown?: boolean): string;
  readingText(fromCursor: boolean): string;
  clearFormat(): void;
  findNext(back?: boolean): void;
  context(): string;
  composing(): boolean;
  markdown(): string;
  transform(change: (text: string) => string): void;
  headings(text: string): Heading[] | null;
  numbered(): { line: number; counter: string }[];
  imageOffset(image: HTMLImageElement): number | undefined;
  selectionRange(): { from: number; to: number; context: string } | undefined;
  readingContext(): ReadingContext | undefined;
  trackChanges(listener: (map: (offset: number) => number) => void): () => void;
  replaceRange(from: number, to: number, text: string, expected: string, allowReading?: boolean): boolean;
}
interface Props {
  document: DocumentRecord;
  rendered: boolean;
  active?: boolean;
  readOnly?: boolean;
  reading?: boolean;
  citationVault?: string;
  preferences?: Preferences;
  remoteImages?: boolean;
  typewriter?: boolean;
  onChange(content: string): void;
  onError(error: string): void;
  onCursor(line: number, column: number): void;
  onSelection?(text: string): void;
  onCompositionEnd?(): void;
  onReference?(url: string): Promise<void>;
  onReady?(mode: "rich" | "source" | null): void;
  onSourceFallback?(): void;
}
export const MarkdownEditor = forwardRef<EditorHandle, Props>(
  function MarkdownEditor(
    { document: record, rendered, active = true, readOnly: locked = false, reading = false, citationVault, preferences, remoteImages = preferences?.remoteImages, typewriter = false, onChange, onError, onCursor, onSelection, onCompositionEnd, onReference, onReady, onSourceFallback },
    ref,
  ) {
    const readOnly = locked || reading;
    const root = useRef<HTMLDivElement>(null),
      sourceParent = useRef<HTMLDivElement>(null);
    const model = useRef<MarkdownDocument | null>(null),
      rich = useRef<RichEditor | null>(null),
      source = useRef<EditorView | null>(null);
    const callbacks = useRef({ onChange, onError, onCursor, onSelection, onCompositionEnd, onReference, onReady, onSourceFallback });
    callbacks.current = { onChange, onError, onCursor, onSelection, onCompositionEnd, onReference, onReady, onSourceFallback };
    const initial = useRef(record),
      requested = useRef(rendered),
      activeMode = useRef(rendered);
    const starting = useRef(true);
    const [visibleMode, setVisibleMode] = useState(
      rendered && record.content.length <= richTextLimit,
    );
    const [readyMode, setReadyMode] = useState<"rich" | "source" | null>(null);
    const [jumpLine, setJumpLine] = useState<number | null>(null);
    const oversizedNotice = useRef(false);
    const [editingImage, setEditingImage] = useState<ImageReference | null>(null);
    const imageQueue = useRef(Promise.resolve());
    const [searchOpen, setSearchOpen] = useState(false),
      [query, setQuery] = useState(""),
      [replacement, setReplacement] = useState("");
    const [searchOptions, setSearchOptions] = useState({ regex: false, caseSensitive: false, wholeWord: false });
    const [searchStatus, setSearchStatus] = useState("");
    const searchField = useRef<HTMLInputElement>(null);
    const searchTerms = useRef({ query, replacement, searchOptions }); searchTerms.current = { query, replacement, searchOptions };
    const syncing = useRef(false);
    const sourceComposing = useRef(false);
    const pendingOptions = useRef(false);
    const compositionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isComposing = () => !!(rich.current?.composing || sourceComposing.current || source.current?.composing);
    const picker = useCitationPicker(citationVault, citationContext, !readOnly, onError);
    const citation = useRef(picker); citation.current = picker;
    const citationEnabled = useRef(false); citationEnabled.current = !!citationVault;
    function citationContext() {
      const doc = model.current, richEditor = activeMode.current ? rich.current : null, view = activeMode.current ? null : source.current;
      if (!doc || isComposing() || (!richEditor && !view)) return null;
      const selection = view?.state.selection.main ?? doc.selection;
      function sourceExcluded(at: number) {
        const current = codeMirror!.syntaxTree(view!.state).resolveInner(at, 1);
        for (let node: typeof current | null = current; node; node = node.parent) {
          if (node.name === "Link") {
            const cite = citationDraft(doc!.text, node.to - 1);
            if (cite?.from === node.from && cite.to === node.to) continue;
            return true;
          }
          if (/^(?:FencedCode|CodeBlock|InlineCode|Image|HTMLBlock|HTMLTag)$/.test(node.name)) return true;
        }
        return false;
      }
      return {
        text: doc.text,
        caret: selection.anchor === selection.head ? selection.head : null,
        excluded(at: number) { return richEditor ? richEditor.citationExcluded() : sourceExcluded(at); },
        coords(at: number) {
          if (view) return view.coordsAtPos(at, -1);
          const dom = window.getSelection();
          return dom?.rangeCount ? dom.getRangeAt(0).getBoundingClientRect() : null;
        },
        position(x: number, y: number) {
          if (!view) return richEditor!.citationPosition(x, y);
          const at = view.posAtCoords({ x, y });
          return at == null || sourceExcluded(at) ? null : at;
        },
        insert(from: number, to: number, text: string) {
          if (editingBlocked()) return;
          doc.closeGroup();
          if (!doc.replace(from, to, text, "citation")) return;
          if (richEditor) richEditor.render(); else syncSource();
          publish(); focusEditor();
        },
      };
    }
    function editingBlocked(allowReading = false) {
      if (viewOptions.current.locked || !allowReading && viewOptions.current.readOnly) return true;
      if (!isComposing()) return false;
      callbacks.current.onError(t("请先完成当前输入法组合输入，再修改文档。"));
      return true;
    }
    const richViewOptions = useRef<{ preferences?: Preferences; remoteImages?: boolean; typewriter: boolean; readOnly: boolean } | null>(null);
    function richOptions() {
      const { preferences, typewriter, readOnly } = viewOptions.current;
      return { spellcheck: preferences?.spellcheck ?? false, tabSize: preferences?.tabSize || 2, typewriter, autoPair: preferences?.autoPair ?? false, emoji: preferences?.emoji ?? true, codeLineNumbers: preferences?.codeLineNumbers ?? false, readOnly };
    }
    function applyViewOptions() {
      if (isComposing()) { pendingOptions.current = true; return; }
      pendingOptions.current = false;
      const { preferences, remoteImages, typewriter, readOnly } = viewOptions.current;
      const previous = richViewOptions.current;
      if (rich.current && (!previous || previous.preferences !== preferences || previous.remoteImages !== remoteImages || previous.typewriter !== typewriter || previous.readOnly !== readOnly)) {
        rich.current.setOptions(richOptions());
        model.current?.refreshCaret(); rich.current.render(false);
        richViewOptions.current = viewOptions.current;
      }
      if (source.current) source.current.contentDOM.spellcheck = preferences?.spellcheck ?? false;
      source.current?.dispatch({ effects: sourceBehavior.current!.reconfigure(sourceOptions()) });
      if (typewriter && source.current && !activeMode.current) source.current.dispatch({ effects: codeMirror!.EditorView.scrollIntoView(source.current.state.selection.main.head, { y: "center" }) });
    }
    function compositionFinished() {
      if (pendingOptions.current) applyViewOptions();
      callbacks.current.onCompositionEnd?.();
      setMode(requested.current);
    }
    const sourceBehavior = useRef<Compartment | null>(null);
    const sourceOptions = () => [...(viewOptions.current.preferences?.sourceLineNumbers ? [codeMirror!.lineNumbers()] : []), codeMirror!.EditorState.readOnly.of(viewOptions.current.readOnly), codeMirror!.EditorView.editable.of(!viewOptions.current.readOnly), codeMirror!.indentUnit.of(" ".repeat(viewOptions.current.preferences?.tabSize || 2)), ...(viewOptions.current.preferences?.autoPair ? [codeMirror!.closeBrackets(), codeMirror!.keymap.of(codeMirror!.closeBracketsKeymap)] : [])];
    const viewOptions = useRef({ preferences, remoteImages, typewriter, readOnly, locked });
    viewOptions.current = { preferences, remoteImages, typewriter, readOnly, locked };
    function historyState() {
      if (root.current?.closest(".document-editor")?.hasAttribute("hidden"))
        return;
      if (model.current && window.desktop?.historyState)
        void window.desktop
          .historyState(
            !viewOptions.current.locked && (viewOptions.current.readOnly ? model.current.readingHistory() : model.current.canUndo),
            !viewOptions.current.locked && (viewOptions.current.readOnly ? model.current.readingHistory(true) : model.current.canRedo),
            activeMode.current,
            model.current.nodeAt(model.current.selection.head)?.kind || "",
          )
          .catch(() => {});
    }
    function focusEditor() {
      if (activeMode.current && rich.current) rich.current.restore(rich.current.bookmark());
      else source.current?.focus();
    }
    // Beyond the rich-mode limits (12 MB, or one block over 256 KB) the source view takes over, with one notice per document.
    function richAllowed(doc: MarkdownDocument) {
      if (!doc.oversized()) { oversizedNotice.current = false; return true; }
      if (!oversizedNotice.current) { oversizedNotice.current = true; callbacks.current.onError(t("文档过大，已切换到源码模式。")); }
      return false;
    }
    const editRevision = useRef(0);
    const [grammarRevision, setGrammarRevision] = useState(0);
    function advanceEditRevision() {
      setGrammarRevision(++editRevision.current);
    }
    const publish = () => {
      advanceEditRevision();
      if (activeMode.current && !richAllowed(model.current!)) setMode(false);
      callbacks.current.onChange(model.current!.toMarkdown());
      if (activeMode.current && citationEnabled.current && root.current?.contains(document.activeElement)) citation.current.update(model.current!.text, model.current!.selection.head);
      historyState();
    };
    function matches() {
      try { return textMatches(model.current?.text || "", searchTerms.current.query, searchTerms.current.replacement, searchTerms.current.searchOptions); }
      catch (error) { setSearchStatus(t("表达式无效：{{message}}", { message: (error as Error).message })); return null; }
    }
    function findNext(back = false) {
      const doc = model.current, found = matches(); if (!doc || !found) return;
      if (!found.length) { setSearchStatus(t("未找到匹配内容")); return; }
      const from = Math.min(doc.selection.anchor, doc.selection.head), to = Math.max(doc.selection.anchor, doc.selection.head);
      const exact = found.findIndex(match => match.from === from && match.to === to);
      const index = exact >= 0 ? (exact + (back ? -1 : 1) + found.length) % found.length : back ? found.findLastIndex(match => match.to <= from) : found.findIndex(match => match.from >= to);
      const chosen = index >= 0 ? index : back ? found.length - 1 : 0, match = found[chosen];
      rich.current?.select({ anchor: match.from, head: match.to }, false); setSearchStatus(`${chosen + 1} / ${found.length}`);
    }
    function replaceMatch(all = false) {
      if (viewOptions.current.readOnly) return;
      const doc = model.current, found = matches(); if (!doc || !found) return;
      if (!found.length) { setSearchStatus(t("未找到匹配内容")); return; }
      rich.current?.releaseFence(); doc.closeGroup();
      if (all) { doc.replace(0, doc.text.length, replaceTextMatches(doc.text, found), "replace-all", { anchor: 0, head: 0 }); rich.current?.render(false); publish(); setSearchStatus(t("已替换 {{count}} 处", { count: found.length })); return; }
      const from = Math.min(doc.selection.anchor, doc.selection.head), to = Math.max(doc.selection.anchor, doc.selection.head), match = found.find(item => item.from === from && item.to === to);
      if (!match) { findNext(); return; }
      doc.replace(from, to, match.replacement, "replace"); rich.current?.render(false); publish(); findNext();
    }
    function syncSource() {
      const view = source.current,
        doc = model.current;
      if (!view || !doc) return;
      syncing.current = true;
      view.dispatch({
        changes:
          view.state.doc.toString() === doc.text
            ? undefined
            : { from: 0, to: view.state.doc.length, insert: doc.text },
        selection: { anchor: doc.selection.anchor, head: doc.selection.head },
      });
      syncing.current = false;
    }
    function history(redo = false) {
      const doc = model.current;
      if (!doc || editingBlocked(doc.readingHistory(redo))) return;
      if (!activeMode.current && source.current) {
        const s = source.current.state.selection.main;
        doc.selection = { anchor: s.anchor, head: s.head };
      }
      if (activeMode.current && !viewOptions.current.readOnly) {
        redo ? rich.current?.redo() : rich.current?.undo();
      } else if (redo ? doc.redo() : doc.undo()) {
        if (activeMode.current) rich.current?.render(); else syncSource();
        publish(); focusEditor();
      }
    }
    function insertImage(file: File) { imageQueue.current = imageQueue.current.then(() => insertImageNow(file)); return imageQueue.current; }
    async function insertImageNow(file: File) {
      if (viewOptions.current.readOnly) return;
      try {
        let relative = await host.importImage(
          initial.current.id,
          new Uint8Array(await file.arrayBuffer()),
          file.name, { ...viewOptions.current.preferences, source: model.current?.toMarkdown() },
        );
        if (viewOptions.current.preferences?.imageAutoUpload) { try { const mapped = await host.imageAction(initial.current.id, [relative], "upload", { ...viewOptions.current.preferences }); if (mapped?.[relative]) relative = mapped[relative]; } catch (e) { callbacks.current.onError(t("上传失败，已保留本地图片：{{message}}", { message: (e as Error).message })); } }
        insert(`![${file.name.replace(/[\[\]]/g, "")}](${relative})`, "paste");
      } catch (error) {
        callbacks.current.onError((error as Error).message);
      }
    }
    function insert(text: string, kind = "command") {
      if (editingBlocked()) return;
      if (activeMode.current) rich.current?.insert(text, kind);
      else if (source.current && model.current) {
        const selection = source.current.state.selection.main;
        model.current.selection = {
          anchor: selection.anchor,
          head: selection.head,
        };
        model.current.replace(selection.from, selection.to, text, kind);
        syncSource();
        publish();
        source.current.focus();
      }
    }
    function logicalImageOffset(image: HTMLImageElement) {
      const object = image.closest<HTMLElement>(".md-inline[data-mark='image']");
      if (object) { const leaf = rich.current?.leaves.get(object.closest<HTMLElement>("[data-leaf]")?.dataset.leaf || ""); const position = leaf?.positions[Number(object.dataset.inlineFrom)]; if (position !== undefined) return position; }
      const block = image.closest<HTMLElement>("[data-cid]"), node = model.current?.nodes.find(item => item.id === block?.dataset.cid);
      if (!node || !block) return undefined;
      const index = [...block.querySelectorAll("img")].indexOf(image), reference = imageReferences(node.source)[index];
      return reference ? node.from + reference.from : undefined;
    }
    function ensureSource() {
      if (source.current || !sourceParent.current || !model.current) return;
      const doc = model.current;
      sourceBehavior.current ??= new codeMirror!.Compartment();
      source.current = new codeMirror!.EditorView({
        parent: sourceParent.current,
        state: codeMirror!.EditorState.create({
          doc: doc.text,
          selection: doc.selection,
          extensions: [
            codeMirror!.EditorState.phrases.of({
              Find: t("查找"),
              Replace: t("替换为"),
              next: t("下一个"),
              previous: t("上一个"),
              all: t("全部匹配"),
              "match case": t("区分大小写"),
              regexp: t("正则表达式"),
              "by word": t("整词匹配"),
              replace: t("替换"),
              "replace all": t("全部替换"),
              close: t("关闭查找"),
              "current match": t("当前匹配"),
              "on line": t("所在行"),
            }),
            codeMirror!.drawSelection(),
            codeMirror!.highlightSpecialChars(),
            codeMirror!.EditorView.lineWrapping,
            codeMirror!.highlightActiveLine(),
            codeMirror!.markdown({ base: codeMirror!.markdownLanguage }),
            codeMirror!.syntaxHighlighting(codeMirror!.defaultHighlightStyle),
            codeMirror!.bracketMatching(),
            sourceBehavior.current!.of(sourceOptions()),
            codeMirror!.search({ top: true }),
            codeMirror!.keymap.of([
              {
                key: "Mod-z",
                run: () => {
                  history();
                  return true;
                },
              },
              {
                key: "Mod-Shift-z",
                run: () => {
                  history(true);
                  return true;
                },
              },
              ...codeMirror!.searchKeymap,
              ...codeMirror!.defaultKeymap,
              codeMirror!.indentWithTab,
            ]),
            codeMirror!.EditorView.contentAttributes.of({
              "aria-label": t("Markdown 源码编辑器"),
              spellcheck: "false",
            }),
            codeMirror!.EditorView.updateListener.of((update) => {
              if (syncing.current) return;
              const selected = update.state.selection.main;
              if (update.docChanged) {
                const old = update.startState.selection.main;
                doc.selection = { anchor: old.anchor, head: old.head };
                const kind = sourceComposing.current || update.transactions.some((t) =>
                  t.isUserEvent("input.type.compose"),
                )
                  ? "composition"
                  : update.transactions.some((t) => t.isUserEvent("input.type"))
                    ? "typing"
                    : "source-command";
                const selection = { anchor: selected.anchor, head: selected.head };
                if (doc.tracksLineEndings) {
                  const source = doc.toMarkdown(), parts: string[] = [];
                  let raw = 0, logical = 0;
                  update.changes.iterChanges((from, to, _from, _to, inserted) => {
                    const first = sourceOffset(source, from - logical, raw), last = sourceOffset(source, to - from, first);
                    parts.push(source.slice(raw, first), inserted.toString().replace(/\n/g, doc.lineEnding));
                    raw = last; logical = to;
                  });
                  parts.push(source.slice(raw));
                  doc.replaceSource(parts.join(""), kind, selection);
                } else doc.replace(0, doc.text.length, update.state.doc.toString(), kind, selection);
                publish();
              } else if (update.selectionSet) {
                doc.selection = {
                  anchor: selected.anchor,
                  head: selected.head,
                };
                if (!sourceComposing.current) doc.closeGroup();
              }
              if (update.selectionSet || update.docChanged) {
                const line = update.state.doc.lineAt(selected.head);
                callbacks.current.onCursor(
                  line.number,
                  selected.head - line.from + 1,
                );
                callbacks.current.onSelection?.(update.state.sliceDoc(selected.from, selected.to));
                if (citationEnabled.current && !activeMode.current && document.activeElement === update.view.contentDOM) {
                  if (update.docChanged) citation.current.update(doc.text, selected.head);
                  else citation.current.cursor();
                }
                if (viewOptions.current.typewriter) requestAnimationFrame(() => {
                  if (source.current === update.view) update.view.dispatch({ effects: codeMirror!.EditorView.scrollIntoView(selected.head, { y: "center" }) });
                });
              }
            }),
            codeMirror!.EditorView.domEventHandlers({
              paste(event) {
                const images = [...(event.clipboardData?.files || [])].filter(
                  (file) => file.type.startsWith("image/"),
                );
                if (!images.length) return false;
                event.preventDefault();
                for (const image of images) void insertImage(image);
                return true;
              },
              drop(event) {
                const images = [...(event.dataTransfer?.files || [])].filter(
                  (file) => file.type.startsWith("image/"),
                );
                if (!images.length) return false;
                event.preventDefault();
                for (const image of images) void insertImage(image);
                return true;
              },
              compositionstart() {
                if (compositionTimer.current !== null) { clearTimeout(compositionTimer.current); doc.endComposition(); }
                compositionTimer.current = null;
                sourceComposing.current = true;
                doc.beginComposition();
                return false;
              },
              compositionend() {
                compositionTimer.current = setTimeout(() => {
                  compositionTimer.current = null;
                  sourceComposing.current = false;
                  doc.endComposition();
                  publish();
                  if (citationEnabled.current && source.current?.hasFocus) citation.current.update(doc.text, doc.selection.head);
                  compositionFinished();
                }, 0);
                return false;
              },
            }),
          ],
        }),
      });
      source.current.contentDOM.spellcheck = viewOptions.current.preferences?.spellcheck ?? false;
    }
    function setMode(value: boolean) {
      const doc = model.current;
      if (!doc) return;
      if (value && !richAllowed(doc)) { value = false; callbacks.current.onSourceFallback?.(); }
      if (!value && !codeMirror) { setReadyMode(null); void loadCodeMirror().then(() => { if (model.current) setMode(requested.current); }).catch(error => callbacks.current.onError(error.message)); return; }
      if (isComposing()) return;
      if (value === activeMode.current && (value ? rich.current : source.current)) { setReadyMode(value ? "rich" : "source"); return; }
      doc.closeGroup();
      if (value) {
        if (!activeMode.current && source.current) {
          const s = source.current.state.selection.main;
          doc.selection = { anchor: s.anchor, head: s.head };
        }
        doc.refreshCaret();
        if (rich.current) rich.current.render(false);
        else {
          rich.current = new RichEditor(root.current!, doc, initial.current.id, {
            change: publish,
            cursor: (line, column) => { callbacks.current.onCursor(line, column); callbacks.current.onSelection?.(rich.current?.clipboard().plain || ""); if (citationEnabled.current) citation.current.cursor(); historyState(); },
            image: file => void insertImage(file),
            link: url => void (callbacks.current.onReference && !/^(?:https?:|mailto:)/i.test(url) ? callbacks.current.onReference(url) : /^(?:https?:|mailto:)/i.test(url) ? host.openLink(url) : host.openDocumentLink(initial.current.id, url)).catch(error => callbacks.current.onError(error.message)),
            compositionFinished,
          }, richOptions());
          richViewOptions.current = viewOptions.current;
        }
      } else {
        if (activeMode.current) {
          doc.selection = rich.current?.bookmark() || doc.selection;
          rich.current?.releaseFence();
        }
        ensureSource();
        syncSource();
      }
      activeMode.current = value;
      setVisibleMode(value);
      if (value ? rich.current : source.current) setReadyMode(value ? "rich" : "source");
      if (citationEnabled.current) citation.current.close();
      historyState();
    }
    useImperativeHandle(
      ref,
      () => ({
        view: () => source.current,
        imageOffset: image => { const from = logicalImageOffset(image), doc = model.current; return from === undefined || !doc ? undefined : sourceOffset(doc.toMarkdown(), from); },
        selectionRange: () => { const doc = model.current; if (!doc) return; const selection = activeMode.current && !isComposing() ? rich.current?.bookmark() || doc.selection : doc.selection, source = doc.toMarkdown(); return { from: sourceOffset(source, Math.min(selection.anchor, selection.head)), to: sourceOffset(source, Math.max(selection.anchor, selection.head)), context: activeMode.current ? doc.nodeAt(selection.head)?.kind || "" : "source" }; },
        readingContext: () => {
          const doc = model.current;
          if (!doc || isComposing()) return;
          let { anchor, head } = (activeMode.current && rich.current?.bookmark()) || doc.selection;
          const view = activeMode.current ? null : source.current, selection = view && window.getSelection();
          if (selection?.anchorNode && selection.focusNode && view!.contentDOM.contains(selection.anchorNode) && view!.contentDOM.contains(selection.focusNode)) {
            anchor = view!.posAtDOM(selection.anchorNode, selection.anchorOffset);
            head = view!.posAtDOM(selection.focusNode, selection.focusOffset);
          }
          const from = Math.min(anchor, head), to = Math.max(anchor, head);
          return { nodes: doc.nodes, headings: (doc.environment.headings as Heading[] | undefined) || [], from, to, index: doc.nodeIndexNear(from), text: doc.text };
        },
        trackChanges: listener => {
          const doc = model.current;
          if (!doc) return () => {};
          return doc.onChange((from, to, insert, length) => {
            const changes = codeMirror?.ChangeSet.of({ from, to, insert }, length);
            if (changes) listener(offset => changes.mapPos(offset, 1));
            else listener(offset => offset <= from ? offset : offset >= to ? offset + insert.length - (to - from) : from + insert.length);
          });
        },
        replaceRange: (from, to, text, expected, allowReading) => {
          const doc = model.current;
          if (!doc || editingBlocked(allowReading)) return false;
          doc.closeGroup(); rich.current?.releaseFence();
          const source = doc.toMarkdown();
          if (from < 0 || to < from || to > source.length || source.slice(from, to) !== expected) return false;
          const position = (source.slice(0, from) + text).replace(/\r\n?/g, "\n").length;
          doc.replaceSource(source.slice(0, from) + text + source.slice(to), "reading-command", { anchor: position, head: position });
          if (activeMode.current) rich.current?.render(); else syncSource(); publish(); focusEditor(); return true;
        },
        composing: isComposing,
        markdown: () => model.current?.toMarkdown() || "",
        transform: change => { const doc = model.current; if (!doc || editingBlocked()) return; doc.closeGroup(); const current = doc.toMarkdown(), next = change(current); if (next !== current) { doc.replaceSource(next, "document-command"); if (activeMode.current) rich.current?.render(false); else syncSource(); publish(); } },
        find: () => {
          if (!activeMode.current) {
            ensureSource();
            codeMirror!.openSearchPanel(source.current!);
            return;
          }
          setSearchOpen(true);
          requestAnimationFrame(() => {
            searchField.current?.focus();
            searchField.current?.select();
          });
        },
        jump: setJumpLine,
        wrap: (before, after = "") => {
          if (editingBlocked()) return;
          if (activeMode.current) rich.current?.wrap(before, after);
          else {
            const s = source.current?.state.selection.main;
            if (!s || !model.current) return;
            const selected = model.current.text.slice(s.from, s.to);
            model.current.selection = { anchor: s.anchor, head: s.head };
            model.current.replace(
              s.from,
              s.to,
              before + selected + after,
              "format",
              { anchor: s.from + before.length, head: s.to + before.length },
            );
            syncSource();
            publish();
            source.current?.focus();
          }
        },
        codeBlock: () => {
          if (viewOptions.current.readOnly) return;
          if (activeMode.current) rich.current?.codeBlock();
        },
        command: (action, args) => {
          if (viewOptions.current.readOnly && (!selectionActions.has(action) || action === "delete-word")) return;
          if (activeMode.current) rich.current?.command(action, args);
          else if (source.current) codeSelectionCommand(source.current, action);
        },
        insert: (text) => insert(text),
        selectionText: (markdown = false) => {
          if (activeMode.current) { const value = rich.current?.clipboard(); return (markdown ? value?.markdown : value?.plain) || ""; }
          const view = source.current, native = window.getSelection();
          if (view && native?.anchorNode && native.focusNode && !native.isCollapsed &&
              view.contentDOM.contains(native.anchorNode) && view.contentDOM.contains(native.focusNode)) {
            const anchor = view.posAtDOM(native.anchorNode, native.anchorOffset);
            const head = view.posAtDOM(native.focusNode, native.focusOffset);
            return view.state.sliceDoc(Math.min(anchor, head), Math.max(anchor, head));
          }
          const selected = view?.state.selection.main;
          return selected ? view!.state.sliceDoc(selected.from, selected.to) : "";
        },
        readingText: fromCursor => {
          const doc = model.current, inRichMode = activeMode.current;
          if (!doc) return "";
          const view = source.current?.state;
          const selection = inRichMode ? rich.current?.bookmark() : view?.selection.main;
          if (!selection) return "";
          const { head, anchor } = selection;
          let from = Math.min(head, anchor), to = Math.max(head, anchor);
          if (from === to) {
            if (fromCursor) to = doc.text.length;
            else if (inRichMode) {
              const block = doc.nodeAt(head);
              if (!block || head < block.from || head > block.to || block.kind === "frontmatter") return "";
              ({ from, to } = block);
            } else {
              const lines = view!.doc, line = lines.lineAt(head);
              if (!line.text.trim()) return "";
              let first = line, last = line;
              while (first.number > 1 && lines.line(first.number - 1).text.trim()) first = lines.line(first.number - 1);
              while (last.number < lines.lines && lines.line(last.number + 1).text.trim()) last = lines.line(last.number + 1);
              from = first.from; to = last.to;
            }
          }
          if (to - from > ttsTextLimit) throw new Error(t("朗读文字过长，请选择较短的段落。"));
          if (inRichMode && head !== anchor) return rich.current!.clipboard().plain;
          const text = doc.text.slice(from, to);
          return inRichMode ? speechText(text) : text;
        },
        clearFormat: () => { if (activeMode.current && !viewOptions.current.readOnly) rich.current?.clearFormat(); },
        findNext: (back = false) => { if (activeMode.current) findNext(back); else if (source.current) (back ? codeMirror!.cmFindPrevious : codeMirror!.cmFindNext)(source.current); },
        undo: () => history(),
        redo: () => history(true),
        focus: focusEditor,
        richMode: () => activeMode.current,
        // The rich parse already collected headings; reuse them while the text is unchanged.
        headings: (text: string) => {
          const doc = model.current;
          if (!doc?.nodes.length || doc.toMarkdown() !== text) return null;
          return (doc.environment.headings as Heading[] | undefined) || [];
        },
        numbered: () => { const doc = model.current; return doc ? numberedBlocks(doc.nodes, (doc.environment.headings as Heading[] | undefined) || []) : []; },
        context: () => activeMode.current ? model.current?.nodeAt(model.current.selection.head)?.kind || "" : "source",
      }),
      [],
    );
    useEffect(() => {
      const original = initial.current;
      model.current = new MarkdownDocument(
        original.content,
        original.lineEnding || "\n",
      );
      let cancelled = false, started = false;
      const start = () => {
        if (cancelled || started) return;
        started = true;
        starting.current = false;
        setMode(requested.current);
        if (!root.current?.closest(".document-editor")?.hasAttribute("hidden")) focusEditor();
      };
      // Exact image boxes on the first paint: the host reads natural sizes from the file headers.
      // The first render waits for them briefly; late answers re-render the blocks they size.
      const sources = host.native && requested.current && richAllowed(model.current!) ? localImageSources(original.content) : [];
      if (!sources.length) start();
      else {
        const sizes = host.imageSizes(original.id, sources).then(result => {
          if (cancelled) return;
          rememberImageSizes(original.id, result);
          if (started) rich.current?.render(false);
        }).catch(() => {});
        void Promise.race([sizes, new Promise(resolve => setTimeout(resolve, 400))]).then(start);
      }
      return () => {
        cancelled = true;
        starting.current = true;
        callbacks.current.onReady?.(null);
        if (compositionTimer.current !== null) clearTimeout(compositionTimer.current);
        rich.current?.destroy();
        source.current?.destroy();
        rich.current = null;
        source.current = null;
        model.current = null;
      };
    }, []);
    useEffect(() => {
      requested.current = rendered;
      if (!starting.current) setMode(rendered);
    }, [rendered]);
    useEffect(() => {
      if (
        !model.current ||
        model.current.toMarkdown() === record.content ||
        isComposing()
      )
        return;
      model.current.replaceExternal(record.content, record.lineEnding);
      advanceEditRevision();
      if (activeMode.current) rich.current?.render(false);
      else syncSource();
      historyState();
    }, [record.content]);
    useEffect(() => {
      historyState();
    });
    useLayoutEffect(() => {
      applyViewOptions();
    }, [preferences, remoteImages, typewriter, readOnly]);
    useLayoutEffect(() => {
      if (readyMode && (readyMode === "rich") === visibleMode && (visibleMode ? rich.current : source.current)) callbacks.current.onReady?.(readyMode);
    }, [readyMode, visibleMode]);
    useLayoutEffect(() => {
      // Focus once after the mode's DOM is visible, before keyboard input.
      // A delayed frame can restore an older caret after a navigation key.
      if (!root.current?.closest(".document-editor")?.hasAttribute("hidden"))
        focusEditor();
    }, [visibleMode]);
    useLayoutEffect(() => {
      if (jumpLine === null || !readyMode || (readyMode === "rich") !== visibleMode || activeMode.current !== visibleMode) return;
      if (visibleMode) {
        if (!rich.current) return;
        rich.current.jump(jumpLine);
      } else {
        if (!source.current) return;
        const target = source.current.state.doc.line(Math.max(1, Math.min(jumpLine, source.current.state.doc.lines)));
        source.current.dispatch({
          selection: { anchor: target.from },
          effects: codeMirror!.EditorView.scrollIntoView(target.from, { y: "start", yMargin: 30 }),
        });
        source.current.focus();
      }
      setJumpLine(null);
    }, [jumpLine, readyMode, visibleMode]);
    return (
      <div
        className={`editor-surface ${visibleMode ? "rich-mode" : "source-mode"} ${preferences?.codeLineNumbers ? "code-line-numbers" : ""}`}
        onKeyDownCapture={citationVault ? picker.keydown : undefined}
        onContextMenuCapture={citationVault ? picker.contextMenu : undefined}
        onBlur={citationVault ? event => { if (!event.currentTarget.contains(event.relatedTarget)) picker.close(); } : undefined}
        onPointerDownCapture={citationVault ? event => { if (!(event.target as Element).closest(".emoji-completion")) picker.close(); } : undefined}
      >
        {active && preferences?.grammarEnabled && host.checkGrammar && (
          <Suspense fallback={null}>
            <GrammarCheck key={JSON.stringify([preferences.grammarUrl, preferences.grammarOrigin])}
              url={preferences.grammarUrl} approvedOrigin={preferences.grammarOrigin}
              content={record.content} mode={readyMode} readOnly={readOnly}
              revision={grammarRevision} currentRevision={() => editRevision.current}
              snapshot={() => isComposing() ? null : model.current?.text ?? null}
              surface={() => {
                if (activeMode.current) {
                  const view = rich.current;
                  return view && { root: view.root, range: (from, to) => view.grammarRange(from, to) };
                }
                const view = source.current;
                return view && { root: view.contentDOM, range: (from, to) => {
                  if (!view.visibleRanges.some(range => from >= range.from && to <= range.to)) return null;
                  const start = view.domAtPos(from), end = view.domAtPos(to);
                  const range = document.createRange();
                  range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
                  return range;
                } };
              }}
              apply={(text, { from, to }, replacement) => {
                const doc = model.current;
                if (!doc || editingBlocked() || doc.text !== text) return false;
                doc.closeGroup(); rich.current?.releaseFence();
                doc.replace(from, to, replacement, "grammar-fix");
                if (activeMode.current) rich.current?.render(); else syncSource();
                publish(); focusEditor();
                return true;
              }} />
          </Suspense>
        )}
        {picker.content}
        {searchOpen && visibleMode && (
          <div
            className="rich-search"
            role="search"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setSearchOpen(false);
                rich.current?.restore();
              }
            }}
          >
            <div>
              <input
                ref={searchField}
                aria-label={t("查找内容")}
                placeholder={t("查找")}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSearchStatus("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    findNext(event.shiftKey);
                  }
                }}
              />
              <button onClick={() => findNext(true)} aria-label={t("上一个匹配")}>
                ↑
              </button>
              <button onClick={() => findNext()} aria-label={t("下一个匹配")}>
                ↓
              </button>
              <span role="status">{searchStatus}</span>
              {([["caseSensitive", t("区分大小写")], ["wholeWord", t("全词匹配")], ["regex", t("正则表达式")]] as const).map(([key, label]) => <button key={key} aria-label={label} aria-pressed={searchOptions[key]} className={searchOptions[key] ? "search-option-active" : ""} onClick={() => { setSearchOptions(previous => ({ ...previous, [key]: !previous[key] })); setSearchStatus(""); }}>{key === "caseSensitive" ? "Aa" : key === "wholeWord" ? "W" : ".*"}</button>)}
              <button
                onClick={() => {
                  setSearchOpen(false);
                  rich.current?.restore();
                }}
                aria-label={t("关闭查找")}
              >
                ×
              </button>
            </div>
            <div>
              <input
                aria-label={t("替换内容")}
                placeholder={t("替换为")}
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
              />
              <button disabled={readOnly} onClick={() => replaceMatch()}>{t("替换")}</button>
              <button disabled={readOnly} onClick={() => replaceMatch(true)}>{t("全部替换")}</button>
            </div>
          </div>
        )}
        {editingImage && <ImageDialog image={editingImage} documentId={record.id} options={{ ...preferences }} close={() => { setEditingImage(null); rich.current?.restore(); }} submit={value => {
          const doc = model.current!; if (doc.text.slice(editingImage.from, editingImage.to) !== editingImage.source) { callbacks.current.onError(t("图片源码已变化，请重新选择图片。")); return; }
          doc.closeGroup(); doc.replace(editingImage.from, editingImage.to, value, "image-edit"); rich.current?.render(false); publish();
        }} />}
        <div className="rich-scroller" hidden={!visibleMode} onDoubleClick={event => {
          const image = (event.target as HTMLElement).closest("img"); if (!image || readOnly) return;
          const from = logicalImageOffset(image);
          const reference = imageReferences(model.current?.text || "").find(item => item.from === from);
          if (reference) { event.preventDefault(); setEditingImage(reference); }
        }} onContextMenu={event => { if ((event.target as HTMLElement).closest("img")) { event.preventDefault(); (event.target as HTMLElement).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); } }}>
          <div className="rich-document" ref={root} />
        </div>
        <div
          className={`source-surface ${preferences?.sourceLineNumbers ? "source-line-numbers" : ""}`}
          hidden={visibleMode}
          ref={sourceParent}
        />
      </div>
    );
  },
);
