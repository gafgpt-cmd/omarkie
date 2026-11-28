import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, Heading, Layers, LayoutDashboard, LockKeyhole, PencilLine, Scissors, Sparkles, StickyNote } from "lucide-react";
import { sourceLines } from "../../shared/source-lines.mjs";
import { studySheetLayer, type GlassLayerId } from "../../shared/glass-layers.mjs";
import type { ConfidenceLevel, ReadingAnchor, ReadingResults, ReadingTarget, SheetColour, StudyItem } from "../../shared/reading-store.ts";
import type { EditorHandle } from "../editor/MarkdownEditor";
import { sourceOffset } from "../editor/model";
import { host } from "../host";
import { t } from "../i18n";
import { Dialog } from "./Dialog";
import ElementHalo from "./ElementHalo";
import GlassLayer from "./GlassLayer";
import GlassLayers from "./GlassLayers";
import SharedGlassLayer from "./SharedGlassLayer";
import { FloatImages, StudyImage, imageTransfer, readImageBytes, scrapDrag } from "./learning-images.tsx";
import { LearningOverlays, type StudyMark, type StudyOverlay } from "./learning-overlays.tsx";
import { readingBlocks, readingSelection, type StudySelection } from "./reading-selection";
import type { Preferences } from "../preferences";
import { safeProposal } from "../editor/markdown";
import TutorCurtain, { ProposalDiff } from "./TutorCurtain";
import { useLiveTutor } from "./tutor-live";
import LearningSearch from "./LearningSearch";
import StudyQueue from "./StudyQueue";
import type { StudySearchMatch } from "../types";
import type { FlashcardPanel } from "./Flashcards";
import type { TutorDraft, TutorReply, TutorVerb } from "./tutor-verbs";
import type { CanvasNode } from "../../shared/json-canvas.mjs";
import { headingNode, snapshotNode } from "../../shared/papercut.mjs";
import { stopLabel, type Stop } from "./fold/stops";
import type { FoldMark, FoldMarks } from "./fold/fold-marks";
import { glassMarks } from "./fold/glass-marks";
import type { GlassMagnet } from "../glass/glass-model";
import { squash } from "../../shared/fold-project.mjs";
import { foldDragType, foldWikiLink, type FoldOut, type FoldPayload, type FoldSent, type FoldTarget } from "./fold/drag";
import { cardAnchor, newCardId } from "../glass/card-model";
import "./reading-layers.css";

type Sheet = Extract<StudyItem, { type: "sheet" }>;
type Scrap = Extract<StudyItem<ReadingAnchor>, { type: "scrap" }>;
type Confidence = Extract<StudyItem<ReadingAnchor>, { type: "confidence" }>;
type Ink = Extract<StudyItem<ReadingAnchor>, { type: "ink" }>;
const levels = ["Not rated", "Lost", "Shaky", "Solid"] as const;
const keyVerb: Readonly<Record<string, TutorVerb>> = { a: "answer", p: "propose", e: "explain", q: "quiz" };
const colours: SheetColour[] = ["amber", "blue", "rose", "green"];
const defaultSheets: Sheet[] = [
  { type: "sheet", id: "notes", name: "Notes", colour: "blue", order: 0, visible: true },
  { type: "sheet", id: "highlights", name: "Highlights", colour: "amber", order: 1, visible: true },
  { type: "sheet", id: "images", name: "Images", colour: "green", order: 2, visible: true },
  { type: "sheet", id: "tutor-answers", name: "Tutor answers", colour: "green", order: 3, visible: true },
  { type: "sheet", id: "proposals", name: "Proposals", colour: "rose", order: 4, visible: true },
  { type: "sheet", id: "doubts", name: "Doubts", colour: "rose", order: 5, visible: true },
  { type: "sheet", id: "exam", name: "Exam points", colour: "amber", order: 6, visible: true },
  { type: "sheet", id: "glossary", name: "Glossary", colour: "blue", order: 7, visible: true },
];
const emptyStudy: ReadingResults["study"] = { entries: [], locations: [] };
const pageScroller = ".writing-area > .document-editor:not([hidden]) .rich-scroller:not([hidden])";

export default function LearningMode({ id, content, editor, note, saved, ready, rendered, preview, togglePreview, sheetsRoot, canWrite, cleanVisible, toggleClean, fold, glass, glassSaved, shared, reloadNote, tutor, askPayload, openFiles, openCard, openSearchHit, cards, boardEnabled, boardRequest, openBoard, tutorRequest }: {
  id: string; content: string; editor(): EditorHandle | undefined; note?: string; saved: boolean; ready: boolean; rendered: boolean;
  sheetsRoot: HTMLElement | null; canWrite: boolean; openFiles(): void; openCard(target?: ReadingTarget, answer?: FlashcardPanel["answer"]): void; openSearchHit(match: StudySearchMatch): Promise<boolean>; cards: ReactNode;
  preview: boolean; togglePreview(): void;
  askPayload?(source: string): void;
  cleanVisible: boolean; toggleClean(): void; fold: { open: boolean; stop: Stop; toggle(): void; marks: FoldMarks; out: RefObject<FoldOut | null> }; glass: boolean; glassSaved: boolean; shared?: boolean; reloadNote?(): void | Promise<unknown>;
  boardEnabled?: boolean; boardRequest?: { note: string; magnet: string; at: number };
  openBoard?(clips?: CanvasNode[]): void; tutorRequest?: { text: string; at: number };
  tutor?: { open: boolean; root: HTMLElement | null; preferences: Preferences; configure(): void; show(): void; close(): void };
}) {
  const store = host.readingStore!;
  const [selection, select] = useState<StudySelection & { payloadSource?: string }>(), [draft, setDraft] = useState<string>();
  const [draftKind, setDraftKind] = useState<"note" | "doubt" | "ink">("note");
  const [study, setStudy] = useState(emptyStudy), [revision, invalidate] = useState(0);
  const [undo, setUndo] = useState<StudyItem>(), [picking, setPicking] = useState<Scrap>(), [peek, setPeek] = useState(false);
  const [activeSheet, setActiveSheet] = useState<string>();
  const [solo, setSolo] = useState<string>();
  const [searching, setSearching] = useState(false);
  const [dragging, setDragging] = useState<string>();
  const [remote, setRemote] = useState<{ url: URL; anchor: ReadingTarget | null; side: "left" | "right" }>();
  const [tutorDraft, setTutorDraft] = useState<TutorDraft>();
  const tutorOpen = tutor?.open ?? false;
  useEffect(() => { if (!tutorOpen) setTutorDraft(undefined); }, [tutorOpen]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const popup = useRef<HTMLDivElement>(null), keyboardFocus = useRef(false);
  const pending = useRef(false);
  const studiedNodes = useRef<NonNullable<ReturnType<EditorHandle["readingContext"]>>["nodes"]>(undefined);
  const writable = useRef(canWrite);
  useLayoutEffect(() => {
    writable.current = canWrite;
    return () => { writable.current = false; };
  }, [canWrite]);
  const [tutorRoute, setTutorRoute] = useState<"local" | "payload">("local");
  const live = useLiveTutor(id, saved && !!tutor, () => invalidate(value => value + 1), receiveTutor);
  const getContext = useEffectEvent(editor);
  const context = useMemo(() => ready ? editor()?.readingContext() : undefined, [ready, rendered, content]);
  const paragraphs = useMemo(() => {
    if (!context) return [];
    const lines = new Set(context.nodes.filter(node => node.kind === "paragraph_open").map(node => node.line));
    return readingBlocks(context).filter(block => lines.has(block.line));
  }, [context]);
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
  function tutorAt(anchor: ReadingTarget, verb: TutorVerb = "answer", text?: string, parent?: string) {
    if (!tutor) return;
    setTutorDraft({ anchor, verb, text, parent }); tutor.show(); dismiss();
  }
  function askTutor(verb: TutorVerb = "answer") { if (tutorParagraph && selection) tutorAt(selection.target, verb); }
  // Board clips arrive only after the user previewed them; the clip text is the whole context, and the
  // curtain still waits for an explicit send.
  const boardTutor = useRef(tutorRequest?.at);
  useEffect(() => {
    if (!tutorRequest || tutorRequest.at === boardTutor.current) return;
    boardTutor.current = tutorRequest.at;
    const text = tutorRequest.text.slice(0, 24_000);
    tutorAt({ block: text, headings: [], line: 1, quote: text.trim().slice(0, 240) }, "answer");
  }, [tutorRequest]);
  function clipToBoard(heading: boolean) {
    if (!selection || !note || !openBoard) return;
    const { target } = selection;
    openBoard([heading ? headingNode({ file: note, headings: target.headings })
      : snapshotNode({ file: note, quote: target.quote, line: target.line, headings: target.headings }, t("Snapshot"))]);
    dismiss();
  }
  function saveTutorReply(reply: TutorReply) {
    const { id, anchor, body, verb, parent, text } = reply;
    const kind = verb === "propose" ? "proposal" : verb === "exam" || verb === "quiz" ? "exam" : verb === "glossary" ? "gloss" : "answer";
    const sheet = kind === "proposal" ? "proposals" : kind === "exam" ? "exam" : kind === "gloss" ? "glossary" : "tutor-answers";
    const item = { id, type: "scrap", kind, sheet, anchor, body, ...(text?.trim() ? { question: text } : {}),
      folded: true, stackOf: parent ?? null, ...(kind === "proposal" ? { before: anchor.block } : {}) } as const;
    return write(item, { ...item, deleted: true });
  }
  async function receiveTutor(reply: TutorReply) {
    const replacement = reply.verb === "propose" ? reply.body : reply.replacement;
    if (replacement && replacement !== reply.anchor.block.trim()) {
      if (!safeProposal(replacement)) throw new Error("Tutor did not return a safe paragraph. Ask for a prose rewrite.");
      await saveTutorReply({ ...reply, id: crypto.randomUUID(), parent: undefined, body: replacement, verb: "propose" });
    }
    if (reply.confidence) await setConfidence(reply.anchor, reply.confidence);
    if (reply.verb === "quiz") await saveTutorReply(reply);
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
    // With the glass on, pictures are glass magnets; Learning mode's own image scraps are legacy.
    if (glass && local.length) return;
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
    const payloadSource = askPayload && !image ? current?.selectionText(true) : undefined;
    if (!next || (!saved && !payloadSource)) return false;
    keyboardFocus.current = keyboard; select({ ...next, payloadSource }); setError("");
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
    if (event.isComposing || event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable=true]")) return;
    if (event.key === "Escape" && picking) { setPicking(undefined); return; }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "`") { setPeek(true); event.preventDefault(); }
    else if (!picking && selection && !busy) {
      const key = event.key.toLowerCase();
      if (key === "n" || key === "d" || key === "w") { event.preventDefault(); beginDraft(key === "n" ? "note" : key === "d" ? "doubt" : "ink"); }
      else if (key === "c") { event.preventDefault(); openCard(selection.target); dismiss(); }
      else if (/^[1-4]$/.test(key)) { event.preventDefault(); mark(colours[Number(key) - 1]); }
      else if (Object.hasOwn(keyVerb, key) && tutorParagraph) { event.preventDefault(); askTutor(keyVerb[key]); }
    }
  });
  useEffect(() => {
    if ((!saved && !askPayload) || !ready) return;
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
    const down = (event: KeyboardEvent) => { if (saved) handleKeys(event); };
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
    // A fold line on the move opens the loose tray as a drop target; Fold view handles the drop.
    const dragStart = (event: DragEvent) => { if (event.dataTransfer?.types.includes(foldDragType)) setDragging(foldDragType); };
    if (saved) {
      document.addEventListener("dragover", dragOver, true);
      document.addEventListener("drop", drop, true);
      document.addEventListener("paste", paste, true);
      document.addEventListener("dragend", dragEnd);
      document.addEventListener("dragstart", dragStart);
    }
    document.addEventListener("pointerup", point);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keyup", up);
    document.addEventListener("keydown", down);
    window.addEventListener("blur", blur);
    // Lazy chunk: these listeners exist only after it loads; mark readiness so tests cannot race the mount.
    document.documentElement.dataset.studySelection = "ready";
    return () => {
      delete document.documentElement.dataset.studySelection;
      document.removeEventListener("pointerup", point); document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keyup", up); document.removeEventListener("keydown", down);
      window.removeEventListener("blur", blur);
      document.removeEventListener("dragover", dragOver, true); document.removeEventListener("drop", drop, true);
      document.removeEventListener("paste", paste, true); document.removeEventListener("dragend", dragEnd); document.removeEventListener("dragstart", dragStart);
    };
  }, [saved, ready, !!askPayload]);
  useEffect(() => {
    if (!selection || !keyboardFocus.current) return;
    keyboardFocus.current = false;
    (popup.current?.querySelector<HTMLButtonElement>("[data-layer-action]:enabled") ?? popup.current?.querySelector<HTMLButtonElement>("button:enabled"))?.focus();
  }, [selection]);

  const sheets = useMemo(() => {
    const items = new Map(defaultSheets.map(sheet => [sheet.id, sheet]));
    for (const entry of study.entries) if (entry.type === "sheet") items.set(entry.id, entry);
    return [...items.values()].sort((a, b) => a.order - b.order);
  }, [study]);
  const sheetById = new Map(sheets.map(sheet => [sheet.id, sheet]));
  const locations = new Map(study.locations.map(({ id, line }) => [id, line]));
  const visibleSheet = (id: string) => solo ? solo === id : sheetById.get(id)?.visible === true;
  const scraps = study.entries.filter((entry): entry is Scrap & { document: string; at: string } => entry.type === "scrap" && visibleSheet(entry.sheet));
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
  for (const entry of study.entries) if (entry.type === "mark" && visibleSheet(entry.sheet)) {
    const line = locations.get(entry.id);
    if (line != null) atLine(line).marks.push(entry);
  }
  // Fold view projects these marks onto its lines; it writes through `highlight` and `undo` only.
  const [magnets, setMagnets] = useState<GlassMagnet[]>();
  const foldOpen = fold.open, foldGlass = foldOpen && glass && !!note;
  useEffect(() => {
    if (!foldGlass || !note) { setMagnets(undefined); return; }
    let current = true;
    const load = () => window.desktop?.glass?.({ note, action: "list" })
      .then((reply: { ok?: boolean; value?: { magnets?: GlassMagnet[] } } | null) => { if (current && reply?.ok) setMagnets(reply.value?.magnets ?? []); }).catch(() => {});
    void load();
    const stop = window.desktop?.onGlassChanged?.((event: { note?: string; action?: string } | undefined) => { if (!event?.note || event.note === note) void load(); });
    return () => { current = false; stop?.(); };
  }, [foldGlass, note]);
  const glassList = useMemo(() => magnets ? glassMarks(magnets, context) : [], [magnets, context]);
  const foldActions = useRef({ highlight: foldHighlight, undo: undoLast });
  foldActions.current = { highlight: foldHighlight, undo: undoLast };
  const published = useRef("");
  useEffect(() => {
    if (!foldOpen) return;
    const marks: FoldMark[] = [];
    for (const entry of study.entries) if (entry.type === "mark" && visibleSheet(entry.sheet))
      marks.push({ id: entry.id, kind: "highlight", line: locations.get(entry.id) ?? null, colour: entry.colour, quote: entry.anchor.quote });
    marks.push(...glassList);
    const signature = JSON.stringify([marks, !!undo]);
    if (signature === published.current) return;
    published.current = signature;
    fold.marks.set({
      marks, canUndo: !!undo,
      study: new Map([...byLine].filter(([, group]) => group.marks.length).map(([line, group]) => [line, group.marks])),
      highlight: (...args) => foldActions.current.highlight(...args), undo: () => foldActions.current.undo(),
    });
  });
  useEffect(() => () => { published.current = ""; fold.marks.set({ marks: [], study: new Map(), canUndo: false, highlight: async () => false, undo: async () => false }); }, [fold.marks]);
  useEffect(() => { if (!foldOpen) published.current = ""; }, [foldOpen]);
  async function foldHighlight(line: number, endLine: number, quote: string, colour: SheetColour) {
    const current = editor()?.readingContext(), needle = squash(quote);
    if (!current || !saved || !needle) return false;
    const blocks = readingBlocks(current).filter(block => block.line >= line && block.line <= endLine);
    const block = blocks.find(candidate => squash(candidate.block).includes(needle)) ?? blocks[0];
    if (!block) return false;
    const start = Math.max(0, block.block.normalize("NFC").replace(/\s+/gu, " ").trimStart().indexOf(quote));
    const item = { type: "mark", id: crypto.randomUUID(), sheet: activeSheet ?? "highlights", anchor: { ...block, quote }, colour, start, end: start + quote.length } as const;
    return write(item, { ...item, deleted: true });
  }
  function undoLast() { return undo ? write(undo) : Promise.resolve(false); }
  // Where Fold view can send a line: a card (or scrap) at its evidence, a study sheet, the loose tray.
  useEffect(() => {
    const out = fold.out;
    out.current = { send: sendFold, targets: () => saved ? [
      { kind: "page", id: "page", label: glass ? t("Card on the page") : t("Scrap on the page") },
      ...sheets.map(sheet => ({ kind: "sheet" as const, id: sheet.id, label: t(sheet.name) })),
      { kind: "tray", id: "tray", label: t("Loose scraps") },
    ] : [] };
    return () => { out.current = null; };
  });
  const ink = new Map<number, Ink[]>(), looseInk: Ink[] = [];
  const confidence = new Map<number, Confidence & { at: string }>();
  for (const item of study.entries) {
    const line = locations.get(item.id);
    if (item.type === "confidence" && line != null) {
      const previous = confidence.get(line);
      if (!previous || item.at >= previous.at) confidence.set(line, item);
    } else if (item.type === "ink" && visibleSheet(item.sheet)) {
      if (line == null || !rendered) looseInk.push(item);
      else { const notes = ink.get(line); if (notes) notes.push(item); else ink.set(line, [item]); atLine(line); }
    }
  }
  // The evidence block the line was cut from, as the page reads it now.
  function foldAnchor(payload: FoldPayload): ReadingTarget | null {
    const context = editor()?.readingContext();
    if (!context) return null;
    const blocks = readingBlocks(context);
    const block = blocks.find(item => item.line === payload.line) ?? blocks.find(item => item.line > payload.line && item.line <= payload.endLine)
      ?? blocks.findLast(item => item.line < payload.line);
    return block ? { ...block, quote: block.block.trim().slice(0, 240) } : null;
  }
  const sendFold = useEffectEvent(async (payload: FoldPayload, target: FoldTarget): Promise<FoldSent> => {
    if (!saved || payload.note !== (note ?? "")) throw new Error(t("Open a saved note in Learning mode to keep this line."));
    const anchor = foldAnchor(payload);
    if (target.kind !== "tray" && !anchor) throw new Error(t("This line has no paragraph to pin to."));
    const api = window.desktop?.glass;
    if (target.kind === "page" && glass && api && note && anchor) {
      const magnet = newCardId();
      const reply = await api({ note, action: "add", magnet, fields: {
        kind: "card", card: "fold", layer: "ai-cards", title: "", question: payload.text, answer: payload.quote, link: foldWikiLink(payload), stop: payload.stop,
        anchor: cardAnchor(anchor), x: 0, y: 0, w: 300, folded: false,
      } });
      if (!reply?.ok) throw new Error(reply?.error ?? t("Could not keep the line."));
      return { message: t("Card pinned beside line {{line}}", { line: anchor.line }), line: anchor.line, undo: async () => {
        const undone = await api({ note, action: "delete", magnet });
        if (!undone?.ok) throw new Error(undone?.error ?? t("Could not keep the line."));
      } };
    }
    const sheet = target.kind === "sheet" ? target.id : activeSheet ?? "notes";
    const item = { type: "scrap", id: crypto.randomUUID(), sheet, kind: "evidence", anchor: target.kind === "tray" ? null : anchor,
      body: payload.text, question: payload.quote.length > 1000 ? `${payload.quote.slice(0, 999).toWellFormed()}…` : payload.quote, stackOf: null, folded: false } as const;
    if (!await write(item, { ...item, deleted: true })) throw new Error(t("Could not keep the line."));
    const name = t(sheetById.get(sheet)?.name ?? "Notes");
    return { message: target.kind === "tray" ? t("Added to loose scraps") : t("Added to {{sheet}}", { sheet: name }),
      line: item.anchor?.line, undo: async () => { if (!await write({ ...item, deleted: true })) throw new Error(t("Could not keep the line.")); } };
  });
  function setConfidence(anchor: ReadingTarget, level: ConfidenceLevel) {
    const previous = confidence.get(anchor.line);
    const item = { id: previous?.id ?? crypto.randomUUID(), type: "confidence", anchor, level } as const;
    return write(item, previous ?? { ...item, level: 0 });
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
      {scrap.question && <p>{scrap.question}</p>}
      <div className="study-actions">
        <button type="button" className="primary-button" disabled={busy || !canWrite} onClick={() => acceptProposal(scrap)}>{t("Accept into Markdown")}</button>
        <button type="button" disabled={busy} onClick={() => void write({ ...scrap, deleted: true }, scrap)}>{t("Reject")}</button>
      </div>
    </section>;
  }

  function mark(colour: SheetColour) {
    if (!selection?.range || selection.range.start >= selection.range.end) return;
    const item = { type: "mark", id: crypto.randomUUID(), sheet: activeSheet ?? "highlights", anchor: selection.target, colour, ...selection.range } as const;
    void write(item, { ...item, deleted: true }, true);
  }
  function beginDraft(kind: typeof draftKind) { setDraftKind(kind); setDraft(""); }
  async function saveNote(check = false) {
    const body = draft?.trim(), anchor = selection?.target;
    if (!body || !anchor) return;
    const id = crypto.randomUUID();
    const item = draftKind === "ink" ? { type: "ink", id, sheet: activeSheet ?? "notes", anchor, from: anchor.quote, to: body } as const
      : { type: "scrap", id, sheet: activeSheet ?? (draftKind === "doubt" ? "doubts" : "notes"), kind: draftKind, anchor, body, stackOf: null, folded: false } as const;
    if (await write(item, { ...item, deleted: true }, !check) && check) tutorAt(anchor, "check", body);
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
        {scrap.kind === "evidence" ? <><p className="study-fold-line">{scrap.body}</p><q>{scrap.question ?? scrap.anchor?.quote}</q></> : <>
          {scrap.anchor && <q>{scrap.anchor.quote}</q>}
          {scrap.question && <p><strong>{scrap.question}</strong></p>}
          <p>{scrap.body}</p>
        </>}
        {scrap.anchor && tutor && (scrap.kind === "doubt" || scrap.kind === "answer") && <div className="study-actions">
          <button type="button" disabled={busy} onClick={() => tutorAt(scrap.anchor!, "simplify", scrap.body.slice(0, 760), scrap.stackOf ?? scrap.id)}>{t("Still lost")}</button>
          <button type="button" disabled={busy} onClick={() => void setConfidence(scrap.anchor!, 3)}>{t("Got it")}</button>
        </div>}
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
  function inkCard(item: Ink) {
    return <article className="study-scrap" key={item.id} data-colour="blue" aria-label={t("Correction on the sheet")}>
      <strong>{t("Correction on the sheet")}</strong>
      <ProposalDiff before={item.from} after={item.to} />
      <div className="study-actions">
        {tutor && <button type="button" onClick={() => tutorAt(item.anchor, "check", item.to)}>{t("Check correction")}</button>}
        <button type="button" disabled={busy} onClick={() => void write({ ...item, deleted: true }, item)}>{t("Peel off")}</button>
      </div>
    </article>;
  }
  const groups: StudyOverlay[] = [];
  if (!peek && rendered) for (const [line, { scraps, marks }] of byLine) if (scraps.length || marks.length || ink.has(line)) groups.push({
    line, marks, tabs: scraps.map(scrap => <button key={scrap.id} type="button" className="study-tab" draggable={!busy && scrap.kind !== "proposal"} onDragStart={event => drag(event, scrap)} data-colour={sheetById.get(scrap.sheet)?.colour}
      aria-label={t("Fold or unfold: {{note}}", { note: scrap.body })} title={scrap.body} aria-expanded={!scrap.folded} disabled={busy}
      onClick={() => void write({ ...scrap, folded: !scrap.folded }, scrap)}><StickyNote size={13} />{children.has(scrap.id) ? 1 + children.get(scrap.id)!.length : null}</button>),
    tucks: [...(ink.get(line) ?? []).map(inkCard), ...scraps.filter(scrap => !scrap.folded).map(scrap => scrapCard(scrap))],
  });
  const root = context && rendered ? document.querySelector<HTMLElement>(".writing-area > .document-editor:not([hidden]) .rich-scroller:not([hidden]) > .rich-document") : null;
  const floats = !peek && root && context ? context.nodes.flatMap(node => {
    const images = byLine.get(node.line)?.images;
    return images?.length ? [{ blockId: node.id, content: images.map(scrap => imageCard(scrap, true)) }] : [];
  }) : [];
  const tutorTarget = useMemo(() => tutorOpen ? tutorDraft?.anchor ?? defaultTutorTarget() : undefined, [tutorOpen, tutorDraft, context]);
  const canPropose = !!tutorTarget && context?.nodes.some(node => node.line === tutorTarget.line && node.kind === "paragraph_open" && node.source === tutorTarget.block) === true;
  const tutorView = tutor?.open && tutor.root && createPortal(<TutorCurtain target={tutorTarget} draft={tutorDraft} preferences={tutor.preferences}
    configure={tutor.configure} close={tutor.close} editable={canWrite} canPropose={canPropose} pendingWrites={busy}
    live={live} localRoute={!!live && tutorRoute === "local"} setRoute={setTutorRoute}
    save={saveTutorReply} receive={receiveTutor} writeError={error}
    makeCard={reply => openCard(reply?.anchor ?? tutorTarget, reply ? { front: reply.text || reply.anchor.quote, back: reply.body } : undefined)}
    proposals={scraps.filter(scrap => scrap.kind === "proposal").map(proposalCard)} />, tutor.root);
  const counts = new Map<string, number>();
  for (const item of study.entries) if ("sheet" in item) counts.set(item.sheet, (counts.get(item.sheet) ?? 0) + 1);
  const studyCounts: Partial<Record<GlassLayerId, number>> = {};
  for (const [sheet, count] of counts) { const layer = studySheetLayer(sheet); studyCounts[layer] = (studyCounts[layer] ?? 0) + count; }
  const previewButton = <button type="button" aria-pressed={preview} onClick={togglePreview}>{t("即时渲染")}</button>;
  const cleanButton = <button type="button" aria-pressed={cleanVisible} onClick={toggleClean}>{t("清理转换文本…")}</button>;
  const foldButton = <button type="button" className="fold-toggle" aria-pressed={fold.open} onClick={fold.toggle}
    aria-label={`${t("Fold view")}: ${stopLabel(fold.stop)}`}>{stopLabel(fold.stop)}<small className="fold-route">{t("local")}</small><small className="fold-age">{t("now")}</small></button>;
  const baseLayer = <span className="layers-canvas"><LockKeyhole size={14} /><small>L0</small>{t("源文档")}</span>;
  async function activateSheet(sheet: Sheet) {
    if (!sheet.visible && !await write({ ...sheet, visible: true }, sheet)) return;
    setSolo(undefined);
    setActiveSheet(sheet.id);
  }
  const sheetButtons = sheets.map(sheet => <li key={sheet.id} className="study-sheet-row" data-fold-drop="sheet" data-sheet={sheet.id}><button type="button" className="study-sheet" data-colour={sheet.colour}
    aria-pressed={visibleSheet(sheet.id)} data-solo={solo === sheet.id || undefined} disabled={busy} onClick={event => {
      if (event.altKey) { setSolo(value => value === sheet.id ? undefined : sheet.id); return; }
      setSolo(undefined); void write({ ...sheet, visible: !sheet.visible }, sheet);
    }}><span className="study-swatch" />{t(sheet.name)}<small aria-hidden="true">{counts.get(sheet.id) || ""}</small></button><button type="button" className="study-sheet-pencil" aria-label={`${t("当前图层")}: ${t(sheet.name)}`} aria-pressed={(activeSheet ?? "notes") === sheet.id} disabled={busy} onClick={() => void activateSheet(sheet)}><PencilLine size={14} /></button></li>);
  const tools = <div className="study-actions study-tools">
    <button type="button" aria-pressed={peek} title={t("Hold to peek at the page")} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setPeek(true); }}
      onPointerUp={() => setPeek(false)} onLostPointerCapture={() => setPeek(false)}
      onKeyDown={event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); setPeek(true); } }} onKeyUp={() => setPeek(false)} onBlur={() => setPeek(false)}>{t("Peek")}</button>
    <button type="button" onClick={() => openCard()}>{t("学习卡片")}</button>
    <button type="button" onClick={() => setSearching(true)}>{t("Search scraps")}</button>
    <StudyQueue note={note} />
    {openBoard && <button type="button" className="study-board" aria-label={t("Papercut board")} onClick={() => openBoard()} title={t("Open the board used last in this folder")}><LayoutDashboard size={14} /><span>{t("Papercut board")}</span></button>}
    <button type="button" disabled={busy} onClick={() => void store(id, { action: "export" }).catch(err => setError(t(err.message)))}>{t("导出笔记和卡片")}</button>
    {undo && <button type="button" disabled={busy} onClick={() => void write(undo)}>{t("撤销")}</button>}
  </div>;
  const understanding = !peek && !!paragraphs.length && <section className="study-confidence" aria-label={t("Understanding")}>
    <strong>{t("Understanding")}</strong><div>{paragraphs.map(block => {
      const level = confidence.get(block.line)?.level ?? 0;
      const label = t("Paragraph {{line}}: {{level}}", { line: block.line, level: t(levels[level]) });
      return <button type="button" key={block.line} data-confidence={level} title={label} aria-label={label} disabled={busy} onClick={() => {
        editor()?.jump(block.line);
        void setConfidence({ ...block, quote: block.block.trim().slice(0, 240) }, ((level + 1) % 4) as ConfidenceLevel);
      }} />;
    })}</div>
  </section>;
  return <>
    {sheetsRoot && createPortal(<aside className="layers-rail study-rail" aria-label={t("Layers")}>
      <header><h2><Layers size={15} />{t("Layers")}</h2><button type="button" aria-label={t("文件", { context: "sidebar" })} title={t("文件", { context: "sidebar" })} onClick={openFiles}><FolderOpen size={16} /></button></header>
      <GlassLayers note={note} glassOn={glass} saved={saved} compact={false} studyCounts={studyCounts} onNotice={setError} />
      {baseLayer}{previewButton}{cleanButton}
      <section className="fold-rail" aria-label={t("Fold", { context: "rail" })}>
        <h3 className="study-sheet-heading">{t("Fold", { context: "rail" })}</h3>
        {foldButton}
        <p className="fold-hint">{t("Local fold · model lines when you choose")}</p>
      </section>
      <h3 className="study-sheet-heading">{t("Study sheets")}</h3>
      {saved ? <><ul>{sheetButtons}</ul>{tools}{understanding}
        {picking && <div className="study-move" role="status"><p>{t("Choose a paragraph, another scrap, or the loose tray.")}</p><button type="button" onClick={() => setPicking(undefined)}>{t("取消")}</button></div>}
      </> : <p>{t("请先打开文件夹并保存文档。")}</p>}
      {error && !tutorOpen && <p role="alert">{error}</p>}
    </aside>, sheetsRoot)}
    <div className="study-chips" role="group" aria-label={t("Layers")}>
      <div className="study-chip-row">{baseLayer}{previewButton}{cleanButton}{foldButton}{saved && <ul>{sheetButtons}</ul>}</div>
      <GlassLayers note={note} glassOn={glass} saved={saved} compact studyCounts={studyCounts} onNotice={setError} />
      {saved && <>{tools}{understanding}</>}
      {error && !tutorOpen && <p role="alert">{error}</p>}
    </div>
    {searching && <LearningSearch id={id} open={openSearchHit} close={() => setSearching(false)} />}
    {root && shared && <SharedGlassLayer key={`shared:${id}:${note}`} root={root} editor={editor} note={note} />}
    {root && context && (glass
      ? <><GlassLayer key={id} editor={editor} root={root} nodes={context.nodes} groups={groups} note={note} saved={glassSaved}
          live={live} reloadNote={reloadNote} boardEnabled={boardEnabled} boardRequest={boardRequest} />
        <ElementHalo key={`halo:${id}`} root={root} editor={editor} /></>
      : groups.length > 0 && <LearningOverlays root={root} nodes={context.nodes} groups={groups} />)}
    {root && floats.length > 0 && <FloatImages root={root} images={floats} />}
    {tutorView}
    {saved && !peek && !tutor?.open && (loose.length > 0 || looseInk.length > 0 || picking || dragging || cards) && <div className="layers-right study-right" data-drop-only={!!dragging && !loose.length && !looseInk.length && !cards || undefined}>
      {(loose.length > 0 || looseInk.length > 0 || picking || dragging) && <aside className="study-tray" aria-label={t("Loose scraps")} data-dragging={!!dragging || undefined} data-fold-drop="tray">
        <h2>{t("Loose scraps")} <small>{loose.length + looseInk.length}</small></h2>
        {picking && <button type="button" disabled={busy} onClick={() => move(picking, null)}>{t("Move to tray")}</button>}
        {loose.map(scrap => scrap.image ? imageCard(scrap) : scrapCard(scrap))}
        {looseInk.map(inkCard)}
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
        {saved && <><button type="button" disabled={busy} data-layer-action={!['doubts', 'highlights'].includes(activeSheet ?? '') || undefined} onClick={() => beginDraft("note")}><StickyNote size={15} />{t("Note")}</button>
        <button type="button" disabled={busy} data-layer-action={activeSheet === "doubts" || undefined} onClick={() => beginDraft("doubt")}>{t("Doubt")}</button>
        <button type="button" disabled={busy} onClick={() => beginDraft("ink")}>{t("This is wrong")}</button>
        {selection.range && <div className="study-actions" role="group" aria-label={t("高亮")}>
          {colours.map(colour => <button type="button" key={colour} data-colour={colour} disabled={busy} data-layer-action={activeSheet === "highlights" || undefined} aria-label={t("Highlight: {{colour}}", { colour: t(colour) })} onClick={() => mark(colour)}><span className="study-swatch" /></button>)}
        </div>}
        <button type="button" onClick={() => { openCard(selection.target); dismiss(); }}>{t("制作卡片")}</button>
        {openBoard && note && <button type="button" title={t("Copy the selected words to the board as a snapshot")} onClick={() => clipToBoard(false)}><Scissors size={15} />{t("Clip to board")}</button>}
        {openBoard && note && selection.target.headings.length > 0 && <button type="button" title={t("Add this section to the board as a live card")} onClick={() => clipToBoard(true)}><Heading size={15} />{t("Heading to board")}</button>}
        {saved && <button type="button" onClick={() => {
          window.dispatchEvent(new CustomEvent("omarkie:comment-request", { detail: { line: selection.target.line, quote: selection.target.quote } }));
          dismiss();
        }}>{t("Comment")}</button>}
        {tutorParagraph && <button type="button" onClick={() => askTutor()}><Sparkles size={15} />{t("Ask Tutor")}</button>}</>}
        {askPayload && selection.payloadSource && <button type="button" onClick={() => { askPayload(selection.payloadSource!); dismiss(); }}><Sparkles size={15} />{t("Payload")}</button>}
      </> : <form onSubmit={event => { event.preventDefault(); void saveNote(); }}>
        <textarea aria-label={t(draftKind === "note" ? "Note" : draftKind === "doubt" ? "Doubt" : "Your correction")} autoFocus value={draft} maxLength={draftKind === "ink" ? 1000 : undefined} onChange={event => setDraft(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void saveNote(draftKind === "ink" && !!tutor && (event.metaKey || event.ctrlKey)); } }} />
        <div><button type="button" disabled={busy} onClick={() => dismiss(true)}>{t("取消")}</button>
          {draftKind === "ink" && tutor && <button type="button" disabled={busy || !draft.trim()} onClick={() => void saveNote(true)}>{t("Check correction")}</button>}
          <button type="submit" disabled={busy || !draft.trim()}>{t(draftKind === "ink" ? "Keep on sheet" : "固定笔记")}</button></div>
      </form>}
    </div>, document.body)}
  </>;
}
