import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, Layers, StickyNote } from "lucide-react";
import type { ReadingAnchor, ReadingResults, ReadingTarget, SheetColour, StudyItem } from "../../shared/reading-store.ts";
import type { EditorHandle } from "../editor/MarkdownEditor";
import { host } from "../host";
import { t } from "../i18n";
import { LearningOverlays, type StudyMark, type StudyOverlay } from "./learning-overlays.tsx";
import { readingBlocks, readingSelection, type StudySelection } from "./reading-selection";
import "./reading-layers.css";

type Sheet = Extract<StudyItem, { type: "sheet" }>;
type Scrap = Extract<StudyItem<ReadingAnchor>, { type: "scrap" }>;
const colours: SheetColour[] = ["amber", "blue", "rose", "green"];
const defaultSheets: Sheet[] = [
  { type: "sheet", id: "notes", name: "Notes", colour: "blue", order: 0, visible: true },
  { type: "sheet", id: "highlights", name: "Highlights", colour: "amber", order: 1, visible: true },
];
const emptyStudy: ReadingResults["study"] = { entries: [], locations: [] };

export default function LearningMode({ id, content, editor, saved, ready, rendered, showSheets, openFiles, openCard, cards }: {
  id: string; content: string; editor(): EditorHandle | undefined; saved: boolean; ready: boolean; rendered: boolean;
  showSheets: boolean; openFiles(): void; openCard(target?: ReadingTarget): void; cards: ReactNode;
}) {
  const store = host.readingStore!;
  const [selection, select] = useState<StudySelection>(), [draft, setDraft] = useState<string>();
  const [study, setStudy] = useState(emptyStudy), [revision, invalidate] = useState(0);
  const [undo, setUndo] = useState<StudyItem>(), [picking, setPicking] = useState<Scrap>(), [peek, setPeek] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const popup = useRef<HTMLDivElement>(null), keyboardFocus = useRef(false);
  const pending = useRef(false);
  const getContext = useEffectEvent(editor);
  const context = useMemo(() => ready ? editor()?.readingContext() : undefined, [ready, rendered, content]);
  useEffect(() => {
    if (!saved || !ready) return;
    const context = getContext()?.readingContext();
    if (!context) return;
    let current = true;
    void store(id, { action: "study", blocks: readingBlocks(context) }).then(result => {
      if (current) setStudy(result);
    }).catch(error => { if (current) setError(t(error.message)); });
    return () => { current = false; };
  }, [id, saved, ready, content, revision, store]);

  function dismiss(restore = false) {
    select(undefined); setDraft(undefined);
    if (restore) editor()?.focus();
  }
  async function write(item: StudyItem, previous?: StudyItem, focus = false) {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError("");
    try {
      await store(id, { action: "put", item });
      invalidate(value => value + 1);
      setUndo(previous);
      setPicking(undefined);
      dismiss(focus);
      return true;
    } catch (err) { setError(t((err as Error).message)); return false; }
    finally { pending.current = false; setBusy(false); }
  }
  const capture = useEffectEvent((surface: HTMLElement, keyboard: boolean, image?: HTMLImageElement) => {
    if (draft !== undefined || picking || busy) return false;
    const current = editor(), next = current && readingSelection(current, surface, image);
    if (!next) return false;
    keyboardFocus.current = keyboard; select(next); setError("");
    return true;
  });
  const clearPointer = useEffectEvent((target: EventTarget | null) => {
    if (draft === undefined && target instanceof Node && !popup.current?.contains(target)) dismiss();
  });
  const onMoveTarget = useEffectEvent((target: EventTarget | null) => {
    if (!picking || busy || !(target instanceof Element)) return false;
    const block = target.closest<HTMLElement>(".document-editor:not([hidden]) .rich-document > [data-cid]");
    const context = block && editor()?.readingContext();
    if (!context) return false;
    const node = context.nodes.find(node => node.id === block.dataset.cid);
    const match = node && readingBlocks(context).find(candidate => candidate.line === node.line);
    if (!match) return false;
    void write({ ...picking, anchor: { ...match, quote: match.block.trim().slice(0, 240) }, stackOf: null }, picking);
    return true;
  });
  const handleKeys = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing || event.target instanceof HTMLElement && event.target.closest("input,textarea,button,select,[contenteditable=true]")) return;
    if (event.key === "Escape" && picking) { setPicking(undefined); return; }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "`") { setPeek(true); event.preventDefault(); }
    else if (!picking && selection && !busy) {
      if (event.key.toLowerCase() === "n") { event.preventDefault(); setDraft(""); }
      else if (event.key.toLowerCase() === "c") { event.preventDefault(); openCard(selection.target); dismiss(); }
      else if (/^[1-4]$/.test(event.key)) { event.preventDefault(); mark(colours[Number(event.key) - 1]); }
    }
  });
  useEffect(() => {
    if (!saved || !ready) return;
    const surface = (node: EventTarget | null) => {
      const parent = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
      const element = parent?.closest<HTMLElement>(".rich-document,.cm-content");
      return element?.closest(".writing-area > .document-editor:not([hidden])") ? element : null;
    };
    const point = (event: PointerEvent) => {
      if (event.button !== 0 || onMoveTarget(event.target)) return;
      const target = surface(event.target);
      if (target) capture(target, false, event.target instanceof HTMLImageElement ? event.target : undefined);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "`") { setPeek(false); return; }
      if (event.isComposing) return;
      const keyboard = event.altKey && event.key === "Enter";
      const target = surface(event.target) || (keyboard ? surface(window.getSelection()?.focusNode ?? null) : null);
      if (target && (keyboard || event.shiftKey && /^(Arrow|Home|End|Page)/.test(event.key)) && capture(target, keyboard) && keyboard) event.preventDefault();
    };
    const down = (event: KeyboardEvent) => handleKeys(event);
    const dismiss = (event: PointerEvent) => clearPointer(event.target);
    const blur = () => setPeek(false);
    document.addEventListener("pointerup", point);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keyup", up);
    document.addEventListener("keydown", down);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerup", point); document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keyup", up); document.removeEventListener("keydown", down);
      window.removeEventListener("blur", blur);
    };
  }, [saved, ready]);
  useEffect(() => {
    if (!selection || !keyboardFocus.current) return;
    keyboardFocus.current = false; popup.current?.querySelector("button")?.focus();
  }, [selection]);

  const sheets = useMemo(() => {
    const items = new Map(defaultSheets.map(sheet => [sheet.id, sheet]));
    for (const entry of study.entries) if (entry.type === "sheet") items.set(entry.id, entry);
    return [...items.values()].sort((a, b) => a.order - b.order);
  }, [study]);
  const sheetById = new Map(sheets.map(sheet => [sheet.id, sheet]));
  const locations = new Map(study.locations.map(({ id, line }) => [id, line]));
  const scraps = study.entries.filter((entry): entry is Scrap & { document: string; at: string } => entry.type === "scrap" && !!sheetById.get(entry.sheet)?.visible);
  const byId = new Map(scraps.map(scrap => [scrap.id, scrap]));
  const children = new Map<string, Scrap[]>();
  const roots: typeof scraps = [];
  for (const scrap of scraps) {
    const parent = scrap.stackOf && byId.get(scrap.stackOf);
    if (parent && !parent.stackOf) {
      const items = children.get(parent.id);
      if (items) items.push(scrap); else children.set(parent.id, [scrap]);
    } else roots.push(scrap);
  }
  const loose: typeof scraps = [];
  const byLine = new Map<number, { scraps: typeof scraps; marks: StudyMark[] }>();
  function atLine(line: number) {
    let group = byLine.get(line);
    if (!group) byLine.set(line, group = { scraps: [], marks: [] });
    return group;
  }
  for (const scrap of roots) {
    const line = locations.get(scrap.id);
    if (!rendered || line == null) loose.push(scrap);
    else atLine(line).scraps.push(scrap);
  }
  for (const entry of study.entries) if (entry.type === "mark" && sheetById.get(entry.sheet)?.visible) {
    const line = locations.get(entry.id);
    if (line != null) atLine(line).marks.push(entry);
  }

  function mark(colour: SheetColour) {
    if (!selection?.range || selection.range.start >= selection.range.end) return;
    const item = { type: "mark", id: crypto.randomUUID(), sheet: "highlights", anchor: selection.target, colour, ...selection.range } as const;
    void write(item, { ...item, deleted: true }, true);
  }
  function saveNote() {
    const body = draft?.trim();
    if (!body || !selection) return;
    const item = { type: "scrap", id: crypto.randomUUID(), sheet: "notes", kind: "note", anchor: selection.target, body, stackOf: null, folded: false } as const;
    void write(item, { ...item, deleted: true }, true);
  }
  function scrapCard(scrap: Scrap, nested = false) {
    return <article className="study-scrap" key={scrap.id} data-colour={sheetById.get(scrap.sheet)?.colour} aria-label={scrap.body}
      onKeyDown={event => { if (!busy && event.key === "Backspace" && event.target === event.currentTarget) { event.preventDefault(); void write({ ...scrap, deleted: true }, scrap); } }} tabIndex={0}>
      <header><strong>{t(sheetById.get(scrap.sheet)?.name ?? "Notes")}</strong>{!nested && <button type="button" onClick={() => void write({ ...scrap, folded: !scrap.folded }, scrap)} disabled={busy}>{t(scrap.folded ? "Unfold" : "Fold")}</button>}</header>
      {(!scrap.folded || nested) && <>
        {scrap.anchor && <q>{scrap.anchor.quote}</q>}
        <p>{scrap.body}</p>
        <div className="study-actions">
          {rendered && <button type="button" disabled={busy} onClick={() => setPicking(scrap)}>{t("Move")}</button>}
          {picking && picking.id !== scrap.id && !nested && !children.has(picking.id) && <button type="button" disabled={busy} onClick={() => void write({ ...picking, stackOf: scrap.id }, picking)}>{t("Stack here")}</button>}
          {nested && <button type="button" disabled={busy} onClick={() => void write({ ...scrap, stackOf: null, folded: false }, scrap)}>{t("Unstack")}</button>}
          <button type="button" disabled={busy} onClick={() => void write({ ...scrap, deleted: true }, scrap)}>{t("Peel off")}</button>
        </div>
        {children.get(scrap.id)?.map(entry => scrapCard(entry, true))}
      </>}
      {scrap.folded && !nested && <p className="study-snippet">{scrap.body}</p>}
    </article>;
  }
  const groups: StudyOverlay[] = [];
  if (!peek && rendered) for (const [line, { scraps, marks }] of byLine) groups.push({
    line, marks, tabs: scraps.map(scrap => <button key={scrap.id} type="button" className="study-tab" data-colour={sheetById.get(scrap.sheet)?.colour}
      aria-label={t("Fold or unfold: {{note}}", { note: scrap.body })} title={scrap.body} aria-expanded={!scrap.folded} disabled={busy}
      onClick={() => void write({ ...scrap, folded: !scrap.folded }, scrap)}><StickyNote size={13} />{children.has(scrap.id) ? 1 + children.get(scrap.id)!.length : null}</button>),
    tucks: scraps.filter(scrap => !scrap.folded).map(scrap => scrapCard(scrap)),
  });
  const root = context && rendered ? document.querySelector<HTMLElement>(".writing-area > .document-editor:not([hidden]) .rich-scroller:not([hidden]) > .rich-document") : null;
  return <>
    <aside className="layers-rail study-rail" aria-label={t("Sheets")} hidden={!showSheets}>
      <header><h2><Layers size={15} />{t("Sheets")}</h2><button type="button" aria-label={t("文件", { context: "sidebar" })} title={t("文件", { context: "sidebar" })} onClick={openFiles}><FolderOpen size={16} /></button></header>
      {saved ? <>
        <ul>{sheets.map(sheet => <li key={sheet.id}><button type="button" className="study-sheet" data-colour={sheet.colour} aria-pressed={sheet.visible} disabled={busy} onClick={() => void write({ ...sheet, visible: !sheet.visible }, sheet)}>
          <span className="study-swatch" />{t(sheet.name)}
        </button></li>)}</ul>
        <div className="study-actions study-tools">
          <button type="button" aria-pressed={peek} title={t("Hold to peek at the page")} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setPeek(true); }}
            onPointerUp={() => setPeek(false)} onLostPointerCapture={() => setPeek(false)}
            onKeyDown={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); setPeek(true); } }} onKeyUp={() => setPeek(false)} onBlur={() => setPeek(false)}>{t("Peek")}</button>
          <button type="button" onClick={() => openCard()}>{t("学习卡片")}</button>
          <button type="button" disabled={busy} onClick={() => void store(id, { action: "export" }).catch(err => setError(t(err.message)))}>{t("导出笔记和卡片")}</button>
          {undo && <button type="button" disabled={busy} onClick={() => void write(undo)}>{t("撤销")}</button>}
        </div>
        {picking && <div className="study-move" role="status"><p>{t("Choose a paragraph, another scrap, or the loose tray.")}</p><button type="button" onClick={() => setPicking(undefined)}>{t("取消")}</button></div>}
      </> : <p>{t("请先打开文件夹并保存文档。")}</p>}
      {error && <p role="alert">{error}</p>}
    </aside>
    {root && context && groups.length > 0 && <LearningOverlays root={root} nodes={context.nodes} groups={groups} />}
    {saved && !peek && (loose.length > 0 || picking || cards) && <div className="layers-right study-right">
      {(loose.length > 0 || picking) && <aside className="study-tray" aria-label={t("Loose scraps")}>
        <h2>{t("Loose scraps")} <small>{loose.length}</small></h2>
        {picking && <button type="button" disabled={busy} onClick={() => void write({ ...picking, anchor: null, stackOf: null, folded: false }, picking)}>{t("Move to tray")}</button>}
        {loose.map(scrap => scrapCard(scrap))}
      </aside>}
      {cards}
    </div>}
    {!peek && selection && createPortal(<div className="layers-selection" role="group" aria-label={t("选区操作")} ref={popup}
      style={{ left: Math.max(4, Math.min(selection.x, window.innerWidth - 284)), top: Math.max(4, Math.min(selection.y + 6, window.innerHeight - (draft === undefined ? 125 : 148))) }}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); dismiss(true); } }}>
      {draft === undefined ? <>
        <button type="button" disabled={busy} onClick={() => setDraft("")}><StickyNote size={15} />{t("Note")}</button>
        {selection.range && <div className="study-actions" role="group" aria-label={t("高亮")}>
          {colours.map(colour => <button type="button" key={colour} data-colour={colour} disabled={busy} aria-label={t("Highlight: {{colour}}", { colour: t(colour) })} onClick={() => mark(colour)}><span className="study-swatch" /></button>)}
        </div>}
        <button type="button" onClick={() => { openCard(selection.target); dismiss(); }}>{t("制作卡片")}</button>
      </> : <form onSubmit={event => { event.preventDefault(); saveNote(); }}>
        <textarea aria-label={t("Note")} autoFocus value={draft} onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); saveNote(); } }} />
        <div><button type="button" disabled={busy} onClick={() => dismiss(true)}>{t("取消")}</button><button type="submit" disabled={busy || !draft.trim()}>{t("固定笔记")}</button></div>
      </form>}
    </div>, document.body)}
  </>;
}
