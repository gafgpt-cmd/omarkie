import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, Layers, Sparkles, StickyNote } from "lucide-react";
import { sourceLines } from "../../shared/source-lines.mjs";
import type { ReadingAnchor, ReadingResults, ReadingTarget, SheetColour, StudyItem } from "../../shared/reading-store.ts";
import type { EditorHandle } from "../editor/MarkdownEditor";
import { sourceOffset } from "../editor/model";
import { host } from "../host";
import { t } from "../i18n";
import { Dialog } from "./Dialog";
import { FloatImages, StudyImage, imageTransfer, readImageBytes, scrapDrag } from "./learning-images.tsx";
import { LearningOverlays, type StudyMark, type StudyOverlay } from "./learning-overlays.tsx";
import { readingBlocks, readingSelection, type StudySelection } from "./reading-selection";
import type { Preferences } from "../preferences";
import TutorCurtain, { ProposalDiff, safeProposal } from "./TutorCurtain";
import "./reading-layers.css";

type Sheet = Extract<StudyItem, { type: "sheet" }>;
type Scrap = Extract<StudyItem<ReadingAnchor>, { type: "scrap" }>;
const colours: SheetColour[] = ["amber", "blue", "rose", "green"];
const defaultSheets: Sheet[] = [
  { type: "sheet", id: "notes", name: "Notes", colour: "blue", order: 0, visible: true },
  { type: "sheet", id: "highlights", name: "Highlights", colour: "amber", order: 1, visible: true },
  { type: "sheet", id: "images", name: "Images", colour: "green", order: 2, visible: true },
  { type: "sheet", id: "tutor-answers", name: "Tutor answers", colour: "green", order: 3, visible: true },
  { type: "sheet", id: "proposals", name: "Proposals", colour: "rose", order: 4, visible: true },
];
const emptyStudy: ReadingResults["study"] = { entries: [], locations: [] };
const pageScroller = ".writing-area > .document-editor:not([hidden]) .rich-scroller:not([hidden])";

export default function LearningMode({ id, content, editor, saved, ready, rendered, showSheets, canWrite, tutor, openFiles, openCard, cards }: {
  id: string; content: string; editor(): EditorHandle | undefined; saved: boolean; ready: boolean; rendered: boolean;
  showSheets: boolean; canWrite: boolean; openFiles(): void; openCard(target?: ReadingTarget): void; cards: ReactNode;
  tutor?: { open: boolean; root: HTMLElement | null; preferences: Preferences; configure(): void; show(): void; close(): void };
}) {
  const store = host.readingStore!;
  const [selection, select] = useState<StudySelection>(), [draft, setDraft] = useState<string>();
  const [study, setStudy] = useState(emptyStudy), [revision, invalidate] = useState(0);
  const [undo, setUndo] = useState<StudyItem>(), [picking, setPicking] = useState<Scrap>(), [peek, setPeek] = useState(false);
  const [dragging, setDragging] = useState<string>();
  const [remote, setRemote] = useState<{ url: URL; anchor: ReadingTarget | null; side: "left" | "right" }>();
  const [tutorSelection, setTutorSelection] = useState<ReadingTarget>();
  const tutorOpen = tutor?.open ?? false;
  useEffect(() => { if (!tutorOpen) setTutorSelection(undefined); }, [tutorOpen]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const popup = useRef<HTMLDivElement>(null), keyboardFocus = useRef(false);
  const pending = useRef(false);
  const studiedNodes = useRef<NonNullable<ReturnType<EditorHandle["readingContext"]>>["nodes"]>(undefined);
  const writable = useRef(canWrite);
  useLayoutEffect(() => {
    writable.current = canWrite;
    return () => { writable.current = false; };
  }, [canWrite]);
  const getContext = useEffectEvent(editor);
  const context = useMemo(() => ready ? editor()?.readingContext() : undefined, [ready, rendered, content]);
  useEffect(() => {
    if (!saved || !ready) return;
    const context = getContext()?.readingContext();
    if (!context) return;
    let current = true;
    void store(id, { action: "study", blocks: readingBlocks(context) }).then(result => {
      if (current) { studiedNodes.current = context.nodes; setStudy(result); }
    }).catch(error => { if (current) setError(t(error.message)); });
    return () => { current = false; };
  }, [id, saved, ready, content, revision, store]);

  function dismiss(restore = false) {
    select(undefined); setDraft(undefined);
    if (restore) editor()?.focus();
  }
  async function change(run: () => Promise<StudyItem | undefined>, focus = false) {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError("");
    try {
      const previous = await run();
      invalidate(value => value + 1);
      setUndo(previous);
      setPicking(undefined);
      dismiss(focus);
      return true;
    } catch (err) { setError(t((err as Error).message)); return false; }
    finally { pending.current = false; setBusy(false); }
  }
  function write(item: StudyItem, previous?: StudyItem, focus = false) {
    return change(async () => { await store(id, { action: "put", item }); return previous; }, focus);
  }
  function anchorFor(block: HTMLElement, context: ReturnType<EditorHandle["readingContext"]>) {
    const node = context?.nodes.find(node => node.id === block.dataset.cid);
    const match = node && context && readingBlocks(context).find(candidate => candidate.line === node.line);
    return match && { ...match, quote: match.block.trim().slice(0, 240) };
  }

  function defaultTutorTarget() {
    const context = editor()?.readingContext();
    if (!context) return;
    const node = context.nodes[context.index];
    const paragraph = node?.kind === "paragraph_open" ? node : context.nodes.find(candidate => candidate.kind === "paragraph_open");
    const block = paragraph && readingBlocks(context).find(candidate => candidate.line === paragraph.line);
    return block && { ...block, quote: block.block.trim().slice(0, 240) };
  }
  const tutorParagraph = tutor && selection?.range && context?.nodes.some(node => node.line === selection.target.line &&
    node.kind === "paragraph_open" && node.source === selection.target.block);
  function askTutor() {
    if (!tutorParagraph || !selection || !tutor) return;
    setTutorSelection(selection.target); tutor.show(); dismiss();
  }
  function saveTutorReply({ anchor, question, body }: { anchor: ReadingTarget; question: string; body: string }, proposal: boolean) {
    const item = { id: crypto.randomUUID(), type: "scrap", kind: proposal ? "proposal" : "answer",
      sheet: proposal ? "proposals" : "tutor-answers", anchor, body, question, folded: true, stackOf: null,
      ...(proposal ? { before: anchor.block } : {}) } as const;
    return write(item, { ...item, deleted: true });
  }
  function addImages(local: ReturnType<typeof imageTransfer>["local"], anchor: ReadingTarget | null, side: "left" | "right") {
    void change(async () => {
      let previous: StudyItem | undefined;
      for (const { name, image } of local) {
        let entry;
        try {
          entry = await store(id, { action: "putImage", name: name.trim().slice(0, 200) || t("图片"),
            bytes: await readImageBytes(image), id: crypto.randomUUID(), anchor, side, width: 240 });
        } catch (err) {
          if (previous) { invalidate(value => value + 1); setUndo(previous); }
          throw err;
        }
        if (entry.type === "scrap") previous = { ...entry, deleted: true };
      }
      return previous;
    });
  }
  function fetchImage() {
    if (!remote) return;
    const { url, anchor, side } = remote;
    setRemote(undefined);
    void change(async () => {
      const name = url.pathname.split("/").at(-1)?.slice(0, 200) || t("图片");
      const entry = await store(id, { action: "putImage", address: url.href, name, id: crypto.randomUUID(), anchor, side, width: 240 });
      return entry.type === "scrap" ? { ...entry, deleted: true } : undefined;
    });
  }
  function move(scrap: Scrap, anchor: ReadingTarget | null, side?: "left" | "right") {
    const image = scrap.image && side ? { ...scrap.image, side } : scrap.image;
    void write({ ...scrap, anchor, image, stackOf: null, folded: false }, scrap);
  }
  const transfer = useEffectEvent((event: DragEvent | ClipboardEvent, data: DataTransfer) => {
    const target = event.target instanceof Element ? event.target : null;
    const surface = target?.closest(pageScroller)?.querySelector<HTMLElement>(".rich-document");
    const tray = target?.closest(".study-tray");
    const dragged = data.getData(scrapDrag);
    const stack = target?.closest<HTMLElement>(".study-scrap[data-scrap]:not([data-nested])")?.dataset.scrap;
    if (!surface && !(dragged && (tray || stack))) return;
    const x = "clientX" in event ? event.clientX : undefined;
    const context = editor()?.readingContext();
    const current = target?.closest<HTMLElement>(".rich-document > [data-cid]");
    let block: HTMLElement | undefined = current?.matches("p") && current.textContent?.trim() ? current : undefined;
    if (!block && surface && context) {
      const paragraphs = Array.from(surface.querySelectorAll<HTMLElement>(":scope > p[data-cid]")).filter(element => element.textContent?.trim());
      if ("clientY" in event) {
        const distance = (element: HTMLElement) => { const rect = element.getBoundingClientRect(); return Math.max(rect.top - event.clientY, event.clientY - rect.bottom, 0); };
        block = paragraphs.reduce<HTMLElement | undefined>((best, candidate) => !best || distance(candidate) < distance(best) ? candidate : best, undefined);
      } else block = paragraphs.find(element => element.dataset.cid === context.nodes[context.index]?.id) || paragraphs[0];
      block ??= current?.matches("h1,h2,h3,h4,h5,h6") ? current : undefined;
    }
    const anchor = block ? anchorFor(block, context) ?? null : null;
    const bounds = block?.getBoundingClientRect() ?? surface?.getBoundingClientRect();
    const side = bounds && x !== undefined && x < bounds.left + bounds.width / 2 ? "left" : "right";
    if (dragged) {
      event.preventDefault(); event.stopPropagation(); setDragging(undefined);
      const scrap = scraps.find(item => item.id === dragged);
      if (!scrap || busy || scrap.kind === "proposal") return;
      const parent = stack && scraps.find(item => item.id === stack && !item.image && item.kind !== "proposal");
      if (parent && !scrap.image && parent.id !== scrap.id && !children.has(scrap.id)) void write({ ...scrap, stackOf: parent.id }, scrap);
      else if (anchor || tray) move(scrap, anchor, side);
      return;
    }
    const { local, url } = imageTransfer(data);
    if (!local.length && !url) return;
    event.preventDefault(); event.stopPropagation();
    if (local.length) addImages(local, anchor, side);
    else if (url) {
      try {
        const address = new URL(url);
        if (address.protocol !== "https:" || address.username || address.password) throw new Error();
        setRemote({ url: address, anchor, side });
      } catch { setError(t("Use an HTTPS image or paste a copy.")); }
    }
  });
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
    const anchor = block && anchorFor(block, context);
    if (!anchor) return false;
    move(picking, anchor);
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
      else if (event.key.toLowerCase() === "a" && tutorParagraph) { event.preventDefault(); askTutor(); }
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
      if (event.target instanceof Element && event.target.closest(".study-image")) return;
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
    const dragOver = (event: DragEvent) => {
      const types = event.dataTransfer?.types;
      if (!types || !(event.target instanceof Element)) return;
      const internal = types.includes(scrapDrag);
      if (internal ? !event.target.closest(`${pageScroller},.study-tray,.study-scrap`) :
        !event.target.closest(pageScroller) || !types.some(type => ["Files", "text/html", "text/uri-list"].includes(type))) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = internal ? "move" : "copy";
    };
    const drop = (event: DragEvent) => { if (event.dataTransfer) transfer(event, event.dataTransfer); };
    const paste = (event: ClipboardEvent) => { if (event.clipboardData) transfer(event, event.clipboardData); };
    const dragEnd = () => setDragging(undefined);
    document.addEventListener("dragover", dragOver, true);
    document.addEventListener("drop", drop, true);
    document.addEventListener("paste", paste, true);
    document.addEventListener("dragend", dragEnd);
    document.addEventListener("pointerup", point);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keyup", up);
    document.addEventListener("keydown", down);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerup", point); document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keyup", up); document.removeEventListener("keydown", down);
      window.removeEventListener("blur", blur);
      document.removeEventListener("dragover", dragOver, true); document.removeEventListener("drop", drop, true);
      document.removeEventListener("paste", paste, true); document.removeEventListener("dragend", dragEnd);
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
  const byLine = new Map<number, { scraps: typeof scraps; images: typeof scraps; marks: StudyMark[] }>();
  function atLine(line: number) {
    let group = byLine.get(line);
    if (!group) byLine.set(line, group = { scraps: [], images: [], marks: [] });
    return group;
  }
  for (const scrap of roots) {
    const line = locations.get(scrap.id);
    if (!rendered || line == null) loose.push(scrap);
    else if (scrap.image) atLine(line).images.push(scrap);
    else atLine(line).scraps.push(scrap);
  }
  for (const entry of study.entries) if (entry.type === "mark" && sheetById.get(entry.sheet)?.visible) {
    const line = locations.get(entry.id);
    if (line != null) atLine(line).marks.push(entry);
  }

  function acceptProposal(scrap: Scrap) {
    void change(async () => {
      const target = editor();
      if (!target || !writable.current || !scrap.anchor || !scrap.before || !safeProposal(scrap.body)) throw new Error(t("当前不可编辑"));
      const stale = () => new Error(t("The paragraph changed. Ask for a new proposal."));
      if (await host.check(id) || !writable.current || target !== editor()) throw stale();
      const current = target.readingContext(), source = target.markdown();
      if (!current) throw stale();
      const headings = JSON.stringify(scrap.anchor.headings);
      const matches = readingBlocks(current).filter(block => block.block === scrap.before &&
        JSON.stringify(block.headings.map(heading => heading.normalize("NFC").replace(/\s+/gu, " ").trim())) === headings);
      const paragraph = matches.length === 1 && matches[0].line === scrap.anchor.line
        ? current.nodes.find(node => node.line === matches[0].line && node.kind === "paragraph_open") : undefined;
      if (!paragraph) throw stale();
      const from = sourceOffset(source, paragraph.from), to = sourceOffset(source, paragraph.to - paragraph.from, from);
      const expected = source.slice(from, to);
      if (expected.replace(/\r\n?/g, "\n") !== scrap.before || !target.replaceRange(from, to, scrap.body, expected, true)) throw stale();
      await store(id, { action: "put", item: { ...scrap, deleted: true } });
      return undefined;
    }, true);
  }
  function proposalCard(scrap: Scrap) {
    return <section className="study-scrap tutor-proposal" aria-label={t("Edit proposal")} data-colour="rose" key={scrap.id}>
      <h3>{t("Edit proposal")}</h3>
      <ProposalDiff before={scrap.before!} after={scrap.body} />
      <div className="study-actions">
        <button type="button" className="primary-button" disabled={busy || !canWrite} onClick={() => acceptProposal(scrap)}>{t("Accept into Markdown")}</button>
        <button type="button" disabled={busy} onClick={() => void write({ ...scrap, deleted: true }, scrap)}>{t("Reject")}</button>
      </div>
    </section>;
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
  function drag(event: React.DragEvent, scrap: Scrap) {
    if (busy) { event.preventDefault(); return; }
    event.dataTransfer.setData(scrapDrag, scrap.id);
    event.dataTransfer.effectAllowed = "move";
    setDragging(scrap.id);
  }
  function acceptImage(scrap: Scrap, source: string) {
    const target = editor(), before = target?.markdown(), line = locations.get(scrap.id);
    if (!target || !scrap.image || before === undefined || !writable.current) return;
    if (!locationIsCurrent(scrap, line, target)) { setError(t("预览已过期，请重新预览后再应用。")); return; }
    const { side, width } = scrap.image;
    void change(async () => {
      const raw = atob(source.slice(source.indexOf(",") + 1));
      const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
      const relative = await host.importImage(id, bytes, scrap.body, { source: before });
      const offset = line == null ? before.length : sourceLines(before).offsets[line - 1];
      const eol = before.match(/\r\n|\r|\n/)?.[0] || "\n";
      const label = scrap.body.replace(/[\r\n\t]+/g, " ").replace(/[\\[\]]/g, "\\$&");
      const prefix = line == null && before ? eol.repeat(2) : "";
      const next = before.slice(0, offset) + `${prefix}![${label}](${relative}){width=${width} float=${side}}${eol.repeat(2)}` + before.slice(offset);
      if (!writable.current || !target.replaceRange(0, before.length, next, before, true)) throw new Error(t("预览已过期，请重新预览后再应用。"));
      await store(id, { action: "put", item: { ...scrap, deleted: true } });
      return undefined;
    });
  }
  function locationIsCurrent(scrap: Scrap, line: number | null | undefined, target: EditorHandle) {
    if (line == null) return !scrap.anchor;
    const context = target.readingContext();
    return !!context && context.nodes === studiedNodes.current;
  }
  function imageCard(scrap: Scrap, floating?: boolean) {
    return <StudyImage key={scrap.id} id={id} image={scrap.image!} name={scrap.body} busy={busy} floating={floating}
      drag={event => drag(event, scrap)} move={() => setPicking(scrap)}
      resize={width => void write({ ...scrap, image: { ...scrap.image!, width } }, scrap)}
      peel={() => void write({ ...scrap, deleted: true }, scrap)}
      accept={canWrite && (floating || !scrap.anchor) ? source => acceptImage(scrap, source) : undefined} />;
  }
  function scrapCard(scrap: Scrap, nested = false) {
    if (scrap.kind === "proposal") return proposalCard(scrap);
    return <article className="study-scrap" key={scrap.id} data-scrap={scrap.id} data-nested={nested || undefined} data-colour={sheetById.get(scrap.sheet)?.colour} aria-label={scrap.body}
      onKeyDown={event => { if (!busy && event.key === "Backspace" && event.target === event.currentTarget) { event.preventDefault(); void write({ ...scrap, deleted: true }, scrap); } }} tabIndex={0}>
      <header draggable={!busy} onDragStart={event => drag(event, scrap)}><strong>{t(sheetById.get(scrap.sheet)?.name ?? "Notes")}</strong>{!nested && <button type="button" onClick={() => void write({ ...scrap, folded: !scrap.folded }, scrap)} disabled={busy}>{t(scrap.folded ? "Unfold" : "Fold")}</button>}</header>
      {(!scrap.folded || nested) && <>
        {scrap.anchor && <q>{scrap.anchor.quote}</q>}
        {scrap.question && <p><strong>{scrap.question}</strong></p>}
        <p>{scrap.body}</p>
        <div className="study-actions">
          {rendered && <button type="button" disabled={busy} onClick={() => setPicking(scrap)}>{t("Move")}</button>}
          {picking && !picking.image && picking.id !== scrap.id && !nested && !children.has(picking.id) && <button type="button" disabled={busy} onClick={() => void write({ ...picking, stackOf: scrap.id }, picking)}>{t("Stack here")}</button>}
          {nested && <button type="button" disabled={busy} onClick={() => void write({ ...scrap, stackOf: null, folded: false }, scrap)}>{t("Unstack")}</button>}
          <button type="button" disabled={busy} onClick={() => void write({ ...scrap, deleted: true }, scrap)}>{t("Peel off")}</button>
        </div>
        {children.get(scrap.id)?.map(entry => scrapCard(entry, true))}
      </>}
      {scrap.folded && !nested && <p className="study-snippet">{scrap.body}</p>}
    </article>;
  }
  const groups: StudyOverlay[] = [];
  if (!peek && rendered) for (const [line, { scraps, marks }] of byLine) if (scraps.length || marks.length) groups.push({
    line, marks, tabs: scraps.map(scrap => <button key={scrap.id} type="button" className="study-tab" draggable={!busy && scrap.kind !== "proposal"} onDragStart={event => drag(event, scrap)} data-colour={sheetById.get(scrap.sheet)?.colour}
      aria-label={t("Fold or unfold: {{note}}", { note: scrap.body })} title={scrap.body} aria-expanded={!scrap.folded} disabled={busy}
      onClick={() => void write({ ...scrap, folded: !scrap.folded }, scrap)}><StickyNote size={13} />{children.has(scrap.id) ? 1 + children.get(scrap.id)!.length : null}</button>),
    tucks: scraps.filter(scrap => !scrap.folded).map(scrap => scrapCard(scrap)),
  });
  const root = context && rendered ? document.querySelector<HTMLElement>(".writing-area > .document-editor:not([hidden]) .rich-scroller:not([hidden]) > .rich-document") : null;
  const floats = !peek && root && context ? context.nodes.flatMap(node => {
    const images = byLine.get(node.line)?.images;
    return images?.length ? [{ blockId: node.id, content: images.map(scrap => imageCard(scrap, true)) }] : [];
  }) : [];
  const tutorTarget = useMemo(() => tutorOpen ? tutorSelection ?? defaultTutorTarget() : undefined, [tutorOpen, tutorSelection, context]);
  const canPropose = !!tutorTarget && context?.nodes.some(node => node.line === tutorTarget.line && node.kind === "paragraph_open" && node.source === tutorTarget.block) === true;
  const tutorView = tutor?.open && tutor.root && createPortal(<TutorCurtain target={tutorTarget} preferences={tutor.preferences}
    configure={tutor.configure} close={tutor.close} editable={canWrite} canPropose={canPropose} pendingWrites={busy}
    save={saveTutorReply} writeError={error}
    proposals={scraps.filter(scrap => scrap.kind === "proposal").map(proposalCard)} />, tutor.root);
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
      {error && !tutor?.open && <p role="alert">{error}</p>}
    </aside>
    {root && context && groups.length > 0 && <LearningOverlays root={root} nodes={context.nodes} groups={groups} />}
    {root && floats.length > 0 && <FloatImages root={root} images={floats} />}
    {tutorView}
    {saved && !peek && !tutor?.open && (loose.length > 0 || picking || dragging || cards) && <div className="layers-right study-right" data-drop-only={!!dragging && !loose.length && !cards || undefined}>
      {(loose.length > 0 || picking || dragging) && <aside className="study-tray" aria-label={t("Loose scraps")} data-dragging={!!dragging || undefined}>
        <h2>{t("Loose scraps")} <small>{loose.length}</small></h2>
        {picking && <button type="button" disabled={busy} onClick={() => move(picking, null)}>{t("Move to tray")}</button>}
        {loose.map(scrap => scrap.image ? imageCard(scrap) : scrapCard(scrap))}
      </aside>}
      {cards}
    </div>}
    {remote && <Dialog title={t("Download dropped image?")} close={() => setRemote(undefined)}>
      <p className="dialog-note">{t("Download one image from {{origin}}. No note text is sent.", { origin: remote.url.origin })}</p>
      <div className="study-actions"><button type="button" onClick={() => setRemote(undefined)}>{t("取消")}</button>
        <button type="button" disabled={busy} onClick={fetchImage}>{t("Download image")}</button></div>
    </Dialog>}
    {!peek && selection && createPortal(<div className="layers-selection" role="group" aria-label={t("选区操作")} ref={popup}
      style={{ left: Math.max(4, Math.min(selection.x, window.innerWidth - 284)), top: Math.max(4, Math.min(selection.y + 6, window.innerHeight - (draft === undefined ? 125 : 148))) }}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); dismiss(true); } }}>
      {draft === undefined ? <>
        <button type="button" disabled={busy} onClick={() => setDraft("")}><StickyNote size={15} />{t("Note")}</button>
        {selection.range && <div className="study-actions" role="group" aria-label={t("高亮")}>
          {colours.map(colour => <button type="button" key={colour} data-colour={colour} disabled={busy} aria-label={t("Highlight: {{colour}}", { colour: t(colour) })} onClick={() => mark(colour)}><span className="study-swatch" /></button>)}
        </div>}
        <button type="button" onClick={() => { openCard(selection.target); dismiss(); }}>{t("制作卡片")}</button>
        {tutorParagraph && <button type="button" onClick={askTutor}><Sparkles size={15} />{t("Ask Tutor")}</button>}
      </> : <form onSubmit={event => { event.preventDefault(); saveNote(); }}>
        <textarea aria-label={t("Note")} autoFocus value={draft} onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); saveNote(); } }} />
        <div><button type="button" disabled={busy} onClick={() => dismiss(true)}>{t("取消")}</button><button type="submit" disabled={busy || !draft.trim()}>{t("固定笔记")}</button></div>
      </form>}
    </div>, document.body)}
  </>;
}
