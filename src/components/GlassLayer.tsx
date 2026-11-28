import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import interact from "interactjs";
import { ArrowUpRight, AudioLines, Columns2, Eraser, Eye, EyeOff, FileAudio, FileText, GraduationCap, Grid3x3, Highlighter, History, Image as ImageIcon, LayoutGrid, MessageSquarePlus, Mic, MousePointer2, Paperclip, PenLine, Pencil, Redo2, Ruler, ScanEye, ScanText, Scissors, SquareStack, Star, StickyNote as StickyIcon, Tag, Trash2, Undo2, Wand2 } from "lucide-react";
import type { EditorHandle, ReadingContext } from "../editor/MarkdownEditor";
import type { PageElement } from "../../shared/element-model.mjs";
import { markdownElements } from "../../shared/element-model.mjs";
import { captureAnchor, indexBlocks, liveBlocks, matchIndexed, placeAnchor, resolveAnchor, type BlockIndex, type GlassAnchor, type GlassBlock, type GlassPlacement } from "../glass/anchor-map";
import { bubbleBundle, bubblePayload, findIdentifiers, payloadText, type BubbleBundle, type BubblePayload, type IdentifierFlag } from "../../shared/bubble-context.mjs";
import { centroid, classifyGesture } from "../../shared/glass-gestures.mjs";
import { arrowEndKey, customStickerBytes, type ArrowColor, type ArrowHead, type ArrowStyle } from "../../shared/glass-marks.mjs";
import { fixtureAnchor, glassFixture, rememberFixtureAnchor } from "../glass/glass-state";
import GlassLandmarks, { landmarkSeeds } from "./GlassLandmarks";
import BubbleLayer from "./BubbleLayer";
import ArrowOverlay, { type Hit } from "./ArrowOverlay";
import StickerView from "./StickerView";
import StickerArt from "./StickerArt";
import type { LiveTutor } from "./tutor-live";
import type { TutorReply } from "./tutor-verbs";
import GlassInk, { type InkHistoryApi, type InkPick } from "./GlassInk";
import { inkColors, inkDefaults, inkWidths, type InkTool } from "../../shared/ink-core.mjs";
import type { InkSample, InkStroke } from "../glass/ink-model";
import type { StudyOverlay } from "./learning-overlays";
import {
  anchorOf, nearestBlock, newStickyId, offsetIn, stickyDefaults, stickyFields, stickyFromMagnet, stickyColors,
  type GlassMagnet, type StickyNote,
} from "../glass/glass-model";
import { displayNeeded, imageDefaults, imageTypeOf } from "../../shared/glass-images.mjs";
import { imageFromMagnet, type GlassImage } from "../glass/image-model";
import { imageCopy } from "../glass/glass-assets";
import { cardAnchor, cardFieldsOf, cardFromMagnet, newCardId, pillPlacement, type GlassCard } from "../glass/card-model";
import GlassCardView, { NewCardDialog } from "./GlassCard";
import GlassLabelView from "./GlassLabel";
import ExamPanel, { type ExamItem } from "./ExamPanel";
import { labelCue, labelFieldsOf, labelFromMagnet, labelPoint, newLabelId, type GlassLabel } from "../glass/label-model";
import type { SrsGrade, StudyState } from "../glass/srs-model";
import GlassImageFrame from "./GlassImage";
import { ClipView, CutoutView, ExtraPageView } from "./GlassClippings";
import {
  clipDefaults, clipFields, clipFromMagnet, cutoutDefaults, cutoutFields, cutoutFromMagnet, extraPageDefaults,
  extraPageFields, extraPageFromMagnet, extraPagePapers, newClipId, type ClipPage, type Cutout, type ExtraPage, type SheetStroke,
} from "../glass/clip-model";
import { lassoOf, regionOf, sheetInkColors } from "../../shared/glass-clips.mjs";
import { bulkReanchor, reanchorThresholds, type ReanchorRow } from "../glass/reanchor";
import { glassWindow } from "../glass/glass-window";
import { timelineDefaults, timelineFromMagnet, timestampFromMagnet, transcriptLine, type TimelineMark, type TimestampMark } from "../glass/timeline-model";
import GlassTimeline from "./GlassTimeline";
import { stickerIds, stickerAt, stickerFields, stickerFromMagnet, stickerName, type StickerMark } from "../glass/sticker-model";
import { arrowDefaults, arrowFields, arrowFromMagnet, routeArrows, type ArrowEndContext, type ArrowMark, type ArrowRoute, type EndMark } from "../glass/arrow-model";
import { glassLayerOf, layerCounts, type GlassLayerId } from "../../shared/glass-layers.mjs";
import { publishGlassLayers, useGlassLayers } from "../glass/layers";
import { elementNode } from "../glass/element-node";
import { elementKindName } from "../glass/element-label";
import { snapBox, snapDefaults, snapSetting, type SnapBox, type SnapColumn, type SnapGuide, type SnapLine } from "../../shared/glass-snap.mjs";
import { compareDirection, measurePrecisions, measureUnits, scaleFromLine, type MeasurePrecision, type MeasureUnit, type Point2, type TraceTool } from "../../shared/glass-visual.mjs";
import {
  compareFields, compareFromMagnet, measureFields, measureFromMagnet, newVisualId, sheetLabelFields,
  sheetLabelFromMagnet, traceFields, traceFromMagnet, type CompareMark, type MeasureMark, type SheetLabel, type TraceMark,
} from "../glass/visual-model";
import GlassCompareCard from "./GlassCompareCard";
import GlassVoice from "./GlassVoice";
import { newVoiceId, voiceFromMagnet, voiceMemoDefaults, type VoiceMemo } from "../glass/voice-model";
import {
  blobBase64, blobBase64Async, cancelTranscribe, LectureRecorder, transcribeCapture, VoiceRecorder, voiceInfo,
} from "../voice/voice-client";
import { encodeVoiceWav, lectureDefaults, timestampLabel, voiceDefaults, voiceKeyMatches, type Utterance } from "../../shared/voice.mjs";
import GlassSwapPanel from "./GlassSwapPanel";
import type { MeasureMode } from "./ImageVisuals";
import "./glass.css";
import "./board.css";

const BoardView = lazy(() => import("./BoardView"));

interface SnapContext { others: SnapBox[]; column?: SnapColumn; lines: SnapLine[] }

interface Layout {
  places: Record<string, GlassPlacement>;
  routes: ArrowRoute[];
  names: Record<string, { from: string; to: string }>;
  orphanArrows: string[];
  checks: Record<string, NonNullable<ReanchorRow["candidate"]> extends never ? never : {
    line: number | null; confidence: number; tier: string;
    old: ReanchorRow["old"]; candidate?: ReanchorRow["candidate"];
  }>;
  fixture?: GlassPlacement;
  loaded?: boolean;
}
interface Reply { ok: boolean; value?: GlassReply; error?: string }
interface BoardMark { id: string; name: string; asset: string }

function boardFromMagnet(magnet: GlassMagnet): BoardMark | null {
  const fields = (magnet.fields ?? {}) as Record<string, unknown>;
  if (fields.kind !== "board" || typeof fields.asset !== "string") return null;
  return { id: magnet.id, name: typeof fields.name === "string" && fields.name ? fields.name : typeof fields.title === "string" && fields.title ? fields.title : "Board", asset: fields.asset };
}

// A label rides on a picture magnet or a page image; the pin keeps its fractional spot inside that box.
function labelBox(label: GlassLabel, places: Record<string, GlassPlacement>, boxes: Record<string, EndMark>) {
  if (label.target.kind === "magnet") {
    const place = places[label.target.magnet];
    return place?.status === "resolved" ? { x: place.x, y: place.y, width: place.width, height: place.height } : undefined;
  }
  return boxes[label.target.element];
}
interface MergeRow { kind: "context" | "add" | "remove"; text: string }
interface VoiceRun {
  id: string;
  mode: "dictation" | "memo" | "lecture";
  phase: "recording" | "transcribing" | "saving";
  startedAt: number;
  block: GlassBlock;
  offset: { x: number; y: number };
  segments: { startMs: number; endMs: number; text: string }[];
  marks: { atMs: number; label?: string }[];
  pending: number;
}
interface MergePreview {
  note: string; magnet: string; kind: string; label: string; baseHash: string; baseSize: number; eol: string; bom: boolean;
  diff: MergeRow[]; added: string[]; removed: string[]; attachment: string | null; linkStyle: string; attachmentFolder: string;
  element: { id: string; kind: string; line: number; headings: string[] }; confidence: number; tier: string;
}
interface MergeHistoryEntry { id: string; magnet: string | null; kind: string | null; undone: boolean; at: string | null; attachment: string | null }
interface GlassReply {
  magnets?: GlassMagnet[];
  trash?: GlassMagnet[];
  magnet?: GlassMagnet | null;
  saved?: boolean;
  merge?: MergePreview;
  preview?: MergePreview;
  history?: MergeHistoryEntry[];
  merges?: MergeHistoryEntry[];
  merged?: boolean;
  stale?: boolean;
  undone?: boolean;
  undoStale?: boolean;
  needsUser?: boolean;
  message?: string;
  path?: string;
  note?: string;
  layers?: Partial<Record<GlassLayerId, { visible?: boolean; locked?: boolean; opacity?: number }>>;
  points?: ScrubPoint[];
  at?: number;
  lines?: number;
}
interface Viewport { top: number; height: number; width: number; page: number }
const imageFile = /\.(?:png|jpe?g|gif|webp|avif|heic|heif|tiff?)$/i;
async function glassCall(request: Record<string, unknown>): Promise<GlassReply> {
  const api = window.desktop?.glass;
  if (!api) throw new Error("Glass storage is not available here.");
  const reply: Reply = await api(request);
  if (!reply?.ok) throw new Error(reply?.error ?? "Glass storage refused the change.");
  return reply.value ?? {};
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const glassGridKey = "omarkie-glass-grid";
const glassMagicKey = "omarkie-glass-magic";
const lensRadius = 120;
type GlassGrid = { on: boolean; size: number };
function readGlassGrid(): GlassGrid {
  const off: GlassGrid = { on: false, size: snapDefaults.grid };
  try { return snapSetting(JSON.parse(localStorage.getItem(glassGridKey) ?? "null") ?? off); } catch { return off; }
}
function readGlassMagic(): boolean {
  try { return localStorage.getItem(glassMagicKey) !== "off"; } catch { return true; }
}
interface MagicChip {
  kind: "bubble" | "highlight" | "connector";
  low: boolean;
  at: { x: number; y: number };
  apply?: () => void;
  revert: () => void;
}
interface ScrubPoint { at: number; events: number; kinds: string[] }
interface ScrubView {
  points: ScrubPoint[];
  index: number;
  at: number;
  marks: number;
  bubbles: number;
}
interface XrayView {
  id: string;
  label: string;
  kind: string;
  bundle: BubbleBundle;
  payload: BubblePayload;
  flags: IdentifierFlag[];
}
const imageFiles = (data: DataTransfer | null) => {
  if (!data) return [];
  const files = [...data.files];
  if (!files.length) for (const item of [...data.items]) {
    const file = item.kind === "file" && item.type.startsWith("image/") ? item.getAsFile() : null;
    if (file) files.push(file);
  }
  return files.filter(file => file.type.startsWith("image/") || imageFile.test(file.name));
};
async function fileBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = "";
  for (let index = 0; index < bytes.length; index += 32_768) text += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  return btoa(text);
}
const snippet = (text: string) => text.length > 28 ? `${text.slice(0, 28).toWellFormed()}…` : text;
const magnetLabel = (magnet: GlassMagnet) => {
  if (magnet.kind === "image") return typeof magnet.fields.name === "string" && magnet.fields.name.trim() ? magnet.fields.name.slice(0, 48) : "Image";
  if (magnet.kind === "card") return typeof magnet.fields.title === "string" && magnet.fields.title.trim() ? magnet.fields.title.slice(0, 48) : "Card";
  if (magnet.kind === "sticky") return typeof magnet.fields.text === "string" && magnet.fields.text.trim() ? magnet.fields.text.trim().slice(0, 48) : "Empty note";
  if (magnet.kind === "sticker") return stickerName({ sticker: typeof magnet.fields.sticker === "string" ? magnet.fields.sticker : undefined,
    image: typeof magnet.fields.image === "string" ? magnet.fields.image : undefined });
  if (magnet.kind === "arrow") return typeof magnet.fields.label === "string" && magnet.fields.label.trim() ? `Arrow: ${snippet(magnet.fields.label.trim())}` : "Arrow";
  if (typeof magnet.fields.text === "string" && magnet.fields.text.trim()) return snippet(magnet.fields.text.trim());
  return magnet.kind ? `${magnet.kind[0].toUpperCase()}${magnet.kind.slice(1)}` : "Glass mark";
};

// One sticky note: paper, six colours, fold to a dot, delete to the trash, typing saved as it settles.
function StickyView({ note, place, selected, editing, onSelect, onEdit, onText, onFold, onColor, onDelete, onMerge, onJump }: {
  note: StickyNote; place: GlassPlacement; selected: boolean; editing: boolean; onSelect(): void; onEdit(editing: boolean): void;
  onText(text: string): void; onFold(folded: boolean): void; onColor(color: StickyNote["color"]): void; onDelete(): void;
  onMerge(): void; onJump?(): void;
}) {
  const [draft, setDraft] = useState(note.text);
  const committed = useRef(note.text), latest = useRef(note.text), text = useRef<HTMLTextAreaElement>(null);
  const writeText = useRef(onText);
  writeText.current = onText;
  latest.current = draft;
  const flush = useCallback(() => {
    if (latest.current === committed.current) return;
    committed.current = latest.current;
    writeText.current(latest.current);
  }, []);
  useEffect(() => flush, [flush]);
  useEffect(() => {
    if (draft === committed.current) return;
    const timer = setTimeout(flush, 400);
    return () => clearTimeout(timer);
  }, [draft, flush]);
  // Another hand (an agent, another device) can rewrite the note; adopt it unless typing is pending here.
  useEffect(() => {
    if (note.text === committed.current || latest.current !== committed.current) return;
    committed.current = note.text;
    setDraft(note.text);
  }, [note.text]);
  useEffect(() => { if (editing) text.current?.focus(); }, [editing]);
  if (place.status === "orphan") return null;
  return <div className="glass-note" data-magnet={note.id} data-colour={note.color} data-folded={note.folded || undefined} data-glass-layer="notes"
    data-selected={selected || undefined} data-editing={editing || undefined} tabIndex={0} aria-label={`Sticky note, ${note.color}`}
    style={{ left: `${place.x}px`, top: `${place.y}px`, width: `${note.folded ? stickyDefaults.folded : place.width}px`, height: `${note.folded ? stickyDefaults.folded : place.height}px` }}
    onPointerDown={onSelect} onDoubleClick={() => onEdit(true)} onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter") { event.preventDefault(); onEdit(true); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); onDelete(); }
      else if (event.key === "f" || event.key === "F") { event.preventDefault(); onFold(!note.folded); }
      else if (event.key === "Escape") event.currentTarget.blur();
    }}>
    {note.folded ? <button type="button" className="glass-note-dot" aria-label="Unfold note" title="Unfold note" onClick={() => onFold(false)} /> : <>
      <span className="glass-note-head" aria-hidden="true" />
      <span className="glass-note-mark" aria-hidden="true" />
      <textarea ref={text} className="glass-note-text" aria-label="Sticky note text" value={draft} maxLength={stickyDefaults.textLimit} placeholder="Write a note"
        onChange={event => setDraft(event.target.value)} onBlur={flush} onFocus={() => onEdit(true)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.currentTarget.blur(); } }} />
      <div className="glass-note-tools" role="group" aria-label="Sticky note">
        {stickyColors.map(colour => <button type="button" key={colour} className="glass-note-colour" data-colour={colour}
          aria-label={`${colour} note`} aria-pressed={note.color === colour} onClick={() => onColor(colour)} />)}
        <button type="button" className="glass-note-tool" aria-label="Fold note" title="Fold note" onClick={() => onFold(true)}>–</button>
        {onJump && note.source && <button type="button" className="glass-note-tool" data-glass-jump aria-label="Jump to source" title="Jump to source" onClick={onJump}>↩</button>}
        <button type="button" className="glass-note-tool" data-glass-merge={note.id} aria-label="Merge down" title="Merge down into the page" onClick={onMerge}>⇩</button>
        <button type="button" className="glass-note-tool" aria-label="Move note to trash" title="Move to trash" onClick={onDelete}>×</button>
      </div>
      <span className="glass-note-grip glass-note-grip-right" data-grip="right" aria-hidden="true" />
      <span className="glass-note-grip glass-note-grip-bottom" data-grip="bottom" aria-hidden="true" />
    </>}
  </div>;
}

function MergeDiff({ rows, stamp }: { rows: MergeRow[]; stamp: string }) {
  return <pre className="glass-merge-diff" data-glass-merge-diff={stamp}>
    {rows.map((row, index) => <div key={index} data-diff={row.kind}>
      <span aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}</span>{row.text || " "}
    </div>)}
  </pre>;
}

export default function GlassLayer({ editor, root, nodes, groups, note, saved: documentSaved, live, reloadNote, boardEnabled, boardRequest }: {
  editor(): EditorHandle | undefined; root: HTMLElement; nodes: ReadingContext["nodes"]; groups: StudyOverlay[]; note?: string; saved: boolean;
  live?: LiveTutor; reloadNote?(): void | Promise<unknown>; boardEnabled?: boolean; boardRequest?: { note: string; magnet: string; at: number };
}) {
  const scroller = root.parentElement!;
  // Stored x runs from the inline start; RTL notes mirror it at paint time, never in the journal.
  const rtlNow = () => getComputedStyle(root).direction === "rtl";
  const layers = useGlassLayers(note);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const lockedLayer = (kind: string) => { const id = glassLayerOf(kind); return !!id && layersRef.current[id].locked; };
  const layer = useRef<HTMLDivElement>(null);
  const fixture = useMemo(glassFixture, []);
  const seeds = useMemo(landmarkSeeds, []);
  const [landmarks, setLandmarks] = useState<GlassMagnet[]>([]);
  const [comments, setComments] = useState<GlassMagnet[]>([]);
  const [magnets, setMagnets] = useState<StickyNote[]>([]);
  const [images, setImages] = useState<GlassImage[]>([]);
  const [ink, setInk] = useState<GlassMagnet[]>([]);
  const [inkTool, setInkTool] = useState<InkTool | "eraser">("pen");
  const [inkSize, setInkSize] = useState(inkDefaults("pen").size);
  const [inkColor, setInkColor] = useState(inkDefaults("pen").color);
  const [eraserMode, setEraserMode] = useState<"bite" | "stroke">("bite");
  const [inkHistory, setInkHistory] = useState({ undo: false, redo: false });
  const inkApi = useRef<InkHistoryApi | null>(null);
  const [stickers, setStickers] = useState<StickerMark[]>([]);
  const [arrows, setArrows] = useState<ArrowMark[]>([]);
  const [cards, setCards] = useState<GlassCard[]>([]);
  const [clips, setClips] = useState<ClipPage[]>([]);
  const [extraPages, setExtraPages] = useState<ExtraPage[]>([]);
  const [cutouts, setCutouts] = useState<Cutout[]>([]);
  const [boards, setBoards] = useState<BoardMark[]>([]);
  const [boardOpen, setBoardOpen] = useState<{ id: string; name: string } | null>(null);
  const [boardPicker, setBoardPicker] = useState(false);
  const handledBoard = useRef(0);
  const [cutMode, setCutMode] = useState<"rect" | "lasso">("rect");
  const [pagePaper, setPagePaper] = useState<(typeof extraPagePapers)[number]>("lined");
  const [capturing, setCapturing] = useState(false);
  const [backTo, setBackTo] = useState<{ top: number; id: string; label: string }>();
  const [cutDrag, setCutDrag] = useState<{ start: [number, number]; end: [number, number]; points: [number, number][]; model: "rect" | "lasso" }>();
  const cutDraftRef = useRef<{ start: [number, number]; end: [number, number]; points: [number, number][]; model: "rect" | "lasso" } | undefined>(undefined);
  const [labels, setLabels] = useState<GlassLabel[]>([]);
  const [study, setStudy] = useState<StudyState>({ exam: false, labelsHidden: false });
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [labelEditing, setLabelEditing] = useState<string>();
  const [examOpen, setExamOpen] = useState(false);
  const [examMarkedOnly, setExamMarkedOnly] = useState(true);
  const [examIndex, setExamIndex] = useState(0);
  const [traces, setTraces] = useState<TraceMark[]>([]);
  const [sheetLabels, setSheetLabels] = useState<SheetLabel[]>([]);
  const [measures, setMeasures] = useState<MeasureMark[]>([]);
  const [compares, setCompares] = useState<CompareMark[]>([]);
  const [voices, setVoices] = useState<VoiceMemo[]>([]);
  const [timelines, setTimelines] = useState<TimelineMark[]>([]);
  const [timestamps, setTimestamps] = useState<TimestampMark[]>([]);
  const [voice, setVoice] = useState({ configured: false, valid: false, key: voiceDefaults.defaultKey, language: "auto" });
  const [run, setRun] = useState<VoiceRun>();
  const runRef = useRef<VoiceRun | undefined>(undefined);
  const recorder = useRef<VoiceRecorder | undefined>(undefined);
  const voiceTick = useRef<number | undefined>(undefined);
  const lecture = useRef<{ recorder: LectureRecorder; chain: Promise<void> } | undefined>(undefined);
  const [sheetsOpen, setSheetsOpen] = useState<Record<string, boolean>>({});
  const [traceTool, setTraceTool] = useState<TraceTool>("pen");
  const [traceColor, setTraceColor] = useState(inkDefaults("pen").color);
  const [traceSize, setTraceSize] = useState(inkDefaults("pen").size);
  const [labelMode, setLabelMode] = useState(false);
  const [labelText, setLabelText] = useState("Label");
  const [measureMode, setMeasureMode] = useState<MeasureMode | undefined>();
  const [calibration, setCalibration] = useState<{ image: string; line: [Point2, Point2]; frame: [number, number] } | undefined>();
  const [compareOpen, setCompareOpen] = useState(false);

  const [trash, setTrash] = useState<GlassMagnet[]>([]);
  const [layout, setLayout] = useState<Layout>({ places: {}, routes: [], names: {}, orphanArrows: [], checks: {} });
  const [kept, setKept] = useState<Set<string>>(() => new Set());
  const [focusedMagnet, setFocusedMagnet] = useState<string | undefined>(undefined);
  const [offscreenOpen, setOffscreenOpen] = useState(false);
  const [tool, setTool] = useState<"select" | "sticky" | "label" | "ink" | "sticker" | "arrow" | "grid" | "clip" | "extra-page" | "cutout" | "trace" | "measure" | "voice" | "memo" | "lecture">("select");
  const [stickerChoice, setStickerChoice] = useState<string>(stickerIds[0]);
  const [customImage, setCustomImage] = useState<string>();
  const [arrowStyle, setArrowStyle] = useState<ArrowStyle>(arrowDefaults.style);
  const [arrowColor, setArrowColor] = useState<ArrowColor>(arrowDefaults.color);
  const [arrowHead, setArrowHead] = useState<ArrowHead>(arrowDefaults.head);
  const [cardOpen, setCardOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [selectedArrow, setSelectedArrow] = useState<string>();
  const [grid, setGrid] = useState<GlassGrid>(readGlassGrid);
  const [magic, setMagic] = useState(readGlassMagic);
  const magicRef = useRef(magic);
  magicRef.current = magic;
  const [chip, setChip] = useState<MagicChip | null>(null);
  const [lensOn, setLensOn] = useState(false);
  const [lens, setLens] = useState<{ x: number; y: number } | null>(null);
  const [ocrReady, setOcrReady] = useState(false);
  const [ocrMode, setOcrMode] = useState(false);
  const [scrub, setScrub] = useState<ScrubView | null>(null);
  const [playing, setPlaying] = useState(false);
  const scrubRef = useRef<ScrubView | null>(null);
  scrubRef.current = scrub;
  const scrubFrame = useRef(0);
  const [xray, setXray] = useState<XrayView>();
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const lensFrame = useRef(0);
  const lensOnRef = useRef(false);
  lensOnRef.current = lensOn;
  const guidesEl = useRef<HTMLDivElement>(null);
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const snapCache = useRef<{ id: string; context: SnapContext } | undefined>(undefined);
  useEffect(() => { try { localStorage.setItem(glassGridKey, JSON.stringify(grid)); } catch { /* storage unavailable */ } }, [grid]);
  const [viewport, setViewport] = useState<Viewport>({ top: 0, height: 0, width: 0, page: 0 });
  const [editing, setEditing] = useState<string>();
  const [openTrash, setOpenTrash] = useState(false);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [notice, setNotice] = useState("");
  const [swapTarget, setSwapTarget] = useState<{ id: string; kind: string; line: number }>();
  // Each open gets its own panel instance, so re-opening the same element reads the journal again.
  const [swapOpen, setSwapOpen] = useState(0);
  const [mergeOpen, setMergeOpen] = useState<MergePreview>();
  const [mergeStale, setMergeStale] = useState<MergePreview>();
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeHistory, setMergeHistory] = useState<MergeHistoryEntry[]>([]);
  const [mergeDone, setMergeDone] = useState<MergeHistoryEntry>();
  const [undoPending, setUndoPending] = useState<string>();
  const [underHost, setUnderHost] = useState<HTMLDivElement | null>(null);
  const blocks = useRef<GlassBlock[]>([]), index = useRef<BlockIndex>(indexBlocks([]));
  const spacers = useRef(new Map<string, HTMLSpanElement>());
  const picker = useRef<HTMLInputElement>(null);
  const elements = useRef<{ text: string; list: PageElement[] }>({ text: "", list: [] });
  const elementBoxes = useRef<Record<string, EndMark>>({});
  const placesRef = useRef<Record<string, GlassPlacement>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef({ magnets, images, stickers, arrows, cards, clips, extraPages, cutouts, labels, study, compares, traces, measures, voices, timelines, timestamps, note, tool });
  const fingerprint = useRef(""), mounted = useRef(false), ready = useRef(false), loaded = useRef(!note), dragging = useRef(false);
  const queue = useRef(Promise.resolve<unknown>(undefined));
  const localAt = useRef(0), revision = useRef(0);
  latest.current = { magnets, images, stickers, arrows, cards, clips, extraPages, cutouts, labels, study, compares, traces, measures, voices, timelines, timestamps, note, tool };

  // A wrapped picture reserves its box in the paragraph, so the page text flows around it.
  const flow = useCallback((image: GlassImage, element: HTMLElement, width = image.w, height = image.h) => {
    let spacer = spacers.current.get(image.id);
    if (!spacer) {
      spacer = document.createElement("span");
      spacer.className = "glass-flow";
      spacer.dataset.glassFlow = image.id;
      spacer.contentEditable = "false";
      spacer.setAttribute("aria-hidden", "true");
      spacers.current.set(image.id, spacer);
    }
    if (spacer.parentElement !== element) element.prepend(spacer);
    const side = image.wrap === "left" ? "left" : "right";
    if (spacer.style.cssFloat !== side) spacer.style.cssFloat = side;
    if (spacer.style.width !== `${width}px`) spacer.style.width = `${width}px`;
    if (spacer.style.height !== `${height}px`) spacer.style.height = `${height}px`;
    return spacer;
  }, []);

  const dropSpacers = useCallback((keep: Set<string>) => {
    for (const [id, spacer] of spacers.current) if (!keep.has(id)) { spacer.remove(); spacers.current.delete(id); }
  }, []);

  const measure = useCallback(() => {
    const surface = layer.current;
    if (!surface) return;
    for (const name of ["measure:start", "context", "blocks", "indexed", "anchored", "placed", "page", "measure:end"]) performance.clearMarks(`omarkie:glass-${name}`);
    performance.clearMeasures("omarkie:glass-measure");
    performance.mark("omarkie:glass-measure:start");
    if (!mounted.current) performance.mark("omarkie:glass-open-context");
    performance.mark("omarkie:glass-context");
    blocks.current = liveBlocks(editor()?.readingContext(), root);
    if (!mounted.current) performance.mark("omarkie:glass-open-extracted");
    performance.mark("omarkie:glass-extracted");
    index.current = indexBlocks(blocks.current);
    performance.mark("omarkie:glass-indexed");
    const indexedAt = performance.now();
    const byLine = new Map(blocks.current.map(block => [block.line, block]));
    const frame = surface.getBoundingClientRect();
    const places: Record<string, GlassPlacement> = {};
    const needsArrows = latest.current.arrows.length > 0 || latest.current.tool === "arrow"
      || latest.current.labels.length > 0 || latest.current.tool === "label";
    const lines = new Map<string, number | null>();
    // Exact block first, then the six-landmark resolver: an edited paragraph keeps its mark.
    const matchLine = (anchor: Parameters<typeof matchIndexed>[1] | undefined) => {
      if (!anchor) return null;
      const key = JSON.stringify(anchor.landmarks);
      let line = lines.get(key);
      if (line === undefined) {
        line = matchIndexed(index.current, anchor);
        if (line === null) {
          const hit = resolveAnchor(anchor, blocks.current);
          line = hit.confidence >= reanchorThresholds.check ? hit.line : null;
        }
        lines.set(key, line);
      }
      return line;
    };
    performance.mark("omarkie:glass-anchored");
    const anchored = [...latest.current.magnets, ...latest.current.stickers, ...latest.current.timelines, ...latest.current.images,
      ...latest.current.cards, ...latest.current.voices, ...latest.current.labels, ...latest.current.clips, ...latest.current.cutouts,
      ...latest.current.measures, ...latest.current.compares];
    // One bulk pass answers every mark: the check tray lists what moved, nothing is deleted.
    const checks: Layout["checks"] = {};
    const rows = new Map<string, ReanchorRow>();
    const anchoredEntries = anchored.flatMap(mark => "anchor" in mark && mark.anchor ? [{ id: mark.id, anchor: mark.anchor }] : []);
    for (const row of bulkReanchor(anchoredEntries, blocks.current, index.current)) {
      rows.set(row.id, row);
      // Every unsure mark is listed; the tray puts the ones it could place first, so the reader
      // confirms a spot before hunting for a paragraph that is gone.
      if (row.state !== "placed") checks[row.id] = { line: row.line, confidence: row.confidence, tier: row.tier, old: row.old, ...(row.candidate ? { candidate: row.candidate } : {}) };
    }
    // Placement follows the tray: a mark the resolver could only guess at (state "tray") stays
    // an orphan until the reader says where it belongs.
    const lineOf = (mark: { id: string; anchor?: GlassAnchor }) => {
      const row = rows.get(mark.id);
      if (row) return row.state === "tray" ? null : row.line;
      return matchLine(mark.anchor);
    };
    // Pictures and clipped paper are spatial objects: the saved spot is the placement, so a lost
    // quote never hides them; the resolver still decides which paragraph they ride.
    const spatialOf = (mark: { id: string; anchor?: GlassAnchor }) => {
      const row = rows.get(mark.id);
      return row ? row.line : matchLine(mark.anchor);
    };
    const rtl = rtlNow();
    const paragraphRects = new Map<HTMLElement, DOMRect>();
    performance.mark("omarkie:glass-placed");
    const placedAt = performance.now();
    // A lifted mark has no landmarks and keeps the spot it stood on; it is a paper object, not a stray.
    const freeAt = (id: string, x: number, y: number, w: number, h: number) => {
      places[id] = { status: "resolved", x: rtl ? frame.width - w - x : x, y, width: w, height: h };
    };
    for (const mark of [...latest.current.magnets, ...latest.current.stickers, ...latest.current.timelines]) {
      if (!mark.anchor?.landmarks.length) { freeAt(mark.id, mark.x, mark.y, mark.w, mark.h); continue; }
      // A timeline rides the media block it was made from; like pictures, it keeps its spot.
      const line = "src" in mark ? spatialOf(mark) : lineOf(mark);
      if (line === null) { places[mark.id] = { status: "orphan" }; continue; }
      const element = byLine.get(line)?.element;
      if (element) {
        let rect = paragraphRects.get(element);
        if (!rect) { rect = element.getBoundingClientRect(); paragraphRects.set(element, rect); }
        const start = rtl ? rect.right - frame.left : rect.left - frame.left;
        places[mark.id] = { status: "resolved", x: rtl ? start - mark.w - mark.x : start + mark.x, y: rect.top - frame.top + mark.y, width: mark.w, height: mark.h };
        continue;
      }
      // Offscreen paragraphs keep their content-space top from the editor's height map.
      const top = editor()?.topOfLine(line);
      places[mark.id] = top === null || top === undefined
        ? { status: "orphan" }
        : { status: "resolved", x: rtl ? frame.width - mark.w - mark.x : mark.x, y: top + mark.y, width: mark.w, height: mark.h };
    }
    const flowing = new Set<string>();
    const mediaShown = layers.media.visible;
    for (const memo of latest.current.voices) {
      const line = lineOf(memo);
      const element = line === null ? undefined : byLine.get(line)?.element;
      if (!element) { places[memo.id] = { status: "orphan" }; continue; }
      let rect = paragraphRects.get(element);
      if (!rect) { rect = element.getBoundingClientRect(); paragraphRects.set(element, rect); }
      places[memo.id] = { status: "resolved", x: rect.left - frame.left + memo.x, y: rect.top - frame.top + memo.y, width: memo.w, height: memo.h };
    }
    for (const image of latest.current.images) {
      if (!image.anchor?.landmarks.length) { freeAt(image.id, image.x, image.y, image.w, image.h); continue; }
      const line = spatialOf(image);
      const element = line === null ? undefined : byLine.get(line)?.element;
      if (!element) { places[image.id] = { status: "orphan" }; continue; }
      if (mediaShown && (image.wrap === "left" || image.wrap === "right")) {
        // A float may use at most 60% of the measure, so its text keeps a readable column.
        const limit = Math.round((element.clientWidth || 0) * 0.6);
        const width = limit > 0 ? Math.max(imageDefaults.minW, Math.min(image.w, limit)) : image.w;
        const height = width === image.w ? image.h : Math.max(imageDefaults.minH, Math.round(width / image.aspect));
        const spacer = flow(image, element, width, height);
        const rect = spacer.getBoundingClientRect();
        flowing.add(image.id);
        places[image.id] = { status: "resolved", x: rect.left - frame.left, y: rect.top - frame.top, width, height };
      } else {
        const rect = element.getBoundingClientRect();
        places[image.id] = { status: "resolved", x: rect.left - frame.left + image.x, y: rect.top - frame.top + image.y, width: image.w, height: image.h };
      }
    }
    // Pills keep to the margin column; a pill that would land on another slides down instead of stacking on it.
    const pillSpots: { x: number; y: number }[] = [];
    for (const card of latest.current.cards) {
      const line = lineOf(card);
      const element = line === null ? undefined : byLine.get(line)?.element;
      if (!element) { places[card.id] = { status: "orphan" }; continue; }
      let rect = paragraphRects.get(element);
      if (!rect) { rect = element.getBoundingClientRect(); paragraphRects.set(element, rect); }
      const spot = pillPlacement(rect, frame);
      let x = spot.x + card.x, y = spot.y + card.y;
      while (pillSpots.some(other => Math.abs(other.x - x) < 240 && y < other.y + 24 && other.y < y + 24)) y += 24;
      pillSpots.push({ x, y });
      places[card.id] = { status: "resolved", x, y, width: spot.width, height: 0 };
    }
    // G13: clipped pages, cutouts and extra sheets are pinned to their paragraph like paper.
    for (const clip of latest.current.clips) {
      const line = lineOf(clip);
      const element = line === null ? undefined : byLine.get(line)?.element;
      if (!element) { places[clip.id] = { status: "orphan" }; continue; }
      let rect = paragraphRects.get(element);
      if (!rect) { rect = element.getBoundingClientRect(); paragraphRects.set(element, rect); }
      places[clip.id] = { status: "resolved", x: rect.left - frame.left + clip.x, y: rect.top - frame.top + clip.y,
        width: clip.folded ? clipDefaults.foldedW : clip.w, height: clip.folded ? clipDefaults.foldedH : clip.h };
    }
    for (const page of latest.current.extraPages) {
      const line = matchLine(page.anchor);
      const element = line === null ? undefined : byLine.get(line)?.element;
      if (!element) { places[page.id] = { status: "orphan" }; continue; }
      let rect = paragraphRects.get(element);
      if (!rect) { rect = element.getBoundingClientRect(); paragraphRects.set(element, rect); }
      places[page.id] = { status: "resolved", x: rect.left - frame.left + page.x, y: rect.top - frame.top + page.y, width: page.w, height: page.h };
    }
    for (const cutout of latest.current.cutouts) {
      const line = lineOf(cutout);
      const element = line === null ? undefined : byLine.get(line)?.element;
      if (!element) { places[cutout.id] = { status: "orphan" }; continue; }
      let rect = paragraphRects.get(element);
      if (!rect) { rect = element.getBoundingClientRect(); paragraphRects.set(element, rect); }
      places[cutout.id] = { status: "resolved", x: rect.left - frame.left + cutout.x, y: rect.top - frame.top + cutout.y, width: cutout.w, height: cutout.h };
    }
    for (const compare of latest.current.compares) {
      const line = lineOf(compare);
      const element = line === null ? undefined : byLine.get(line)?.element;
      if (!element) { places[compare.id] = { status: "orphan" }; continue; }
      let rect = paragraphRects.get(element);
      if (!rect) { rect = element.getBoundingClientRect(); paragraphRects.set(element, rect); }
      places[compare.id] = { status: "resolved", x: rect.left - frame.left + compare.x, y: rect.top - frame.top + compare.y,
        width: compare.w, height: compare.h };
    }
    dropSpacers(flowing);
    placesRef.current = places;
    let routed: { routes: ArrowRoute[]; orphans: string[] } = { routes: [], orphans: [] };
    const names: Record<string, { from: string; to: string }> = {};
    // Element boxes and arrow routing cost one rect per paragraph; skip them until arrows need the page.
    if (needsArrows) {
      const text = editor()?.readingContext()?.text;
      if (text !== undefined && text !== elements.current.text) elements.current = { text, list: markdownElements(text) };
      const list = elements.current.list;
      const boxes: Record<string, EndMark> = {};
      for (const element of list) {
        const node = elementNode(root, element, list);
        const rect = node?.getBoundingClientRect();
        if (!rect?.width || !rect.height) continue;
        boxes[element.id] = { x: rect.left - frame.left, y: rect.top - frame.top, width: rect.width, height: rect.height };
      }
      elementBoxes.current = boxes;
      const ends: ArrowEndContext = {
        line: matchLine,
        elementAt: (line, id) => {
          const at = list.filter(element => element.blockLine === line);
          const chosen = (id ? at.find(element => element.id === id) : undefined) ?? at[0];
          return chosen ? boxes[chosen.id] : undefined;
        },
        magnet: id => { const place = places[id]; return place?.status === "resolved" ? place : undefined; },
      };
      routed = routeArrows(latest.current.arrows, ends);
      for (const arrow of latest.current.arrows)
        names[arrow.id] = { from: endName(arrow.from, list, ends, latest.current), to: endName(arrow.to, list, ends, latest.current) };
    } else elementBoxes.current = {};
    let marker: GlassPlacement | undefined;
    if (fixture && !seeds?.length) {
      let anchor = fixtureAnchor();
      if (!anchor) {
        const paragraph = blocks.current.find(block => block.element?.tagName === "P" && !!block.element.textContent?.trim());
        if (paragraph) { anchor = captureAnchor(paragraph, blocks.current); rememberFixtureAnchor(anchor); }
      }
      if (anchor) marker = placeAnchor(anchor, { x: 0, y: 0 }, blocks.current, surface);
    }
    // Size the paper grid after the measurements, so this write never forces a second layout.
    const page = `${Math.max(scroller.scrollHeight, frame.height)}px`;
    if (surface.style.getPropertyValue("--glass-page") !== page) surface.style.setProperty("--glass-page", page);
    performance.mark("omarkie:glass-page");
    if (!mounted.current) { mounted.current = true; performance.mark("omarkie:glass-mounted"); }
    performance.mark("omarkie:glass-measure:end");
    const measured = performance.measure("omarkie:glass-measure", "omarkie:glass-measure:start", "omarkie:glass-measure:end");
    surface.dataset.measureMs = measured.duration.toFixed(2);
    surface.dataset.glassMeasures = String(Number(surface.dataset.glassMeasures ?? 0) + 1);
    const durations = (window as unknown as { __glassDurations?: { total: number; magnet: number }[] }).__glassDurations;
    if (durations) durations.push({ total: measured.duration, magnet: placedAt - indexedAt });
    const labelPins = latest.current.labels.map(label => {
      const box = labelBox(label, places, elementBoxes.current);
      return box ? [label.id, Math.round(labelPoint(box, label.nx, label.ny).x), Math.round(labelPoint(box, label.nx, label.ny).y)] : [label.id, null];
    });
    const serialized = JSON.stringify([places, routed.routes, names, routed.orphans, marker ?? null, loaded.current, labelPins]);
    if (serialized === fingerprint.current) return;
    fingerprint.current = serialized;
    setLayout({ places, routes: routed.routes, names, orphanArrows: routed.orphans, checks, fixture: marker, loaded: loaded.current });
  }, [dropSpacers, editor, fixture, flow, layers, root, scroller, seeds]);

  useEffect(() => () => { for (const spacer of spacers.current.values()) spacer.remove(); spacers.current.clear(); }, []);

  useLayoutEffect(() => {
    if (layout.loaded && !ready.current) { ready.current = true; performance.mark("omarkie:glass-ready"); }
  }, [layout.loaded]);

  // One write at a time, in the order the hand made them: a fresh note must exist before its text lands.
  const send = useCallback((request: Record<string, unknown>) => {
    const path = latest.current.note;
    if (!path) return Promise.resolve(undefined);
    localAt.current = Date.now();
    revision.current += 1;
    const run = queue.current.then(async () => {
      setSaved("saving");
      try {
        const value = await glassCall({ note: path, ...request });
        if (Array.isArray(value.trash)) setTrash(value.trash);
        setSaved("saved");
        return value;
      } catch (error) {
        setSaved("error");
        setNotice(message(error));
        return undefined;
      }
    });
    queue.current = run;
    return run;
  }, []);

  const loadSeq = useRef(0);
  // One mapping from stored magnets to the live layers; the scrub replays the same shapes
  // from the journal without touching the current state.
  const applyMagnets = useCallback((incoming: readonly GlassMagnet[]) => {
    const stickies: StickyNote[] = [], nextImages: GlassImage[] = [], nextStickers: StickerMark[] = [], nextArrows: ArrowMark[] = [], nextCards: GlassCard[] = [], nextLabels: GlassLabel[] = [];
    const nextClips: ClipPage[] = [], nextPages: ExtraPage[] = [], nextCutouts: Cutout[] = [];
    const nextTraces: TraceMark[] = [], nextSheetLabels: SheetLabel[] = [], nextMeasures: MeasureMark[] = [], nextCompares: CompareMark[] = [];
    const nextVoices: VoiceMemo[] = [];
    const nextTimelines: TimelineMark[] = [], nextTimestamps: TimestampMark[] = [];
    const landmarks: GlassMagnet[] = [], nextComments: GlassMagnet[] = [], nextInk: GlassMagnet[] = [];
    for (const magnet of incoming) {
      // A lifted mark keeps its kind in fields while the journal line names the lift itself.
      const kind = (magnet.fields?.kind as string | undefined) ?? magnet.kind;
      if (kind === "sticky") {
        const sticky = stickyFromMagnet(magnet);
        if (sticky) stickies.push(sticky);
      } else if (kind === "image") {
        const picture = imageFromMagnet(magnet);
        if (picture) nextImages.push(picture);
      } else if (kind === "sticker") {
        const stamp = stickerFromMagnet(magnet);
        if (stamp) nextStickers.push(stamp);
      } else if (kind === "arrow") {
        const arrow = arrowFromMagnet(magnet);
        if (arrow) nextArrows.push(arrow);
      } else if (kind === "card") {
        const card = cardFromMagnet(magnet);
        if (card) nextCards.push(card);
      } else if (kind === "label") {
        const label = labelFromMagnet(magnet);
        if (label) nextLabels.push(label);
      } else if (kind === "clip") {
        const clip = clipFromMagnet(magnet);
        if (clip) nextClips.push(clip);
      } else if (kind === "extra-page") {
        const page = extraPageFromMagnet(magnet);
        if (page) nextPages.push(page);
      } else if (kind === "cutout") {
        const cutout = cutoutFromMagnet(magnet);
        if (cutout) nextCutouts.push(cutout);
      } else if (kind === "trace") {
        const trace = traceFromMagnet(magnet);
        if (trace) nextTraces.push(trace);
      } else if (kind === "sheet-label") {
        const label = sheetLabelFromMagnet(magnet);
        if (label) nextSheetLabels.push(label);
      } else if (kind === "measure") {
        const measure = measureFromMagnet(magnet);
        if (measure) nextMeasures.push(measure);
      } else if (kind === "compare") {
        const compare = compareFromMagnet(magnet);
        if (compare) nextCompares.push(compare);
      } else if (kind === "timeline") {
        const timeline = timelineFromMagnet(magnet);
        if (timeline) nextTimelines.push(timeline);
      } else if (kind === "timestamp") {
        const stamp = timestampFromMagnet(magnet);
        if (stamp) nextTimestamps.push(stamp);
      } else if (kind === "voice") {
        const memo = voiceFromMagnet(magnet);
        if (memo) nextVoices.push(memo);
      } else if (kind === "comment") nextComments.push(magnet);
      else if (kind === "ink") nextInk.push(magnet);
      else landmarks.push(magnet);
    }
    setMagnets(stickies);
    setImages(nextImages);
    setStickers(nextStickers);
    setArrows(nextArrows);
    setCards(previous => JSON.stringify(previous) === JSON.stringify(nextCards) ? previous : nextCards);
    setLandmarks(previous => JSON.stringify(previous) === JSON.stringify(landmarks) ? previous : landmarks);
    setComments(previous => JSON.stringify(previous) === JSON.stringify(nextComments) ? previous : nextComments);
    setInk(previous => !previous.length && !nextInk.length ? previous : nextInk);
    setLabels(previous => JSON.stringify(previous) === JSON.stringify(nextLabels) ? previous : nextLabels);
    setClips(previous => JSON.stringify(previous) === JSON.stringify(nextClips) ? previous : nextClips);
    setExtraPages(previous => JSON.stringify(previous) === JSON.stringify(nextPages) ? previous : nextPages);
    setCutouts(previous => JSON.stringify(previous) === JSON.stringify(nextCutouts) ? previous : nextCutouts);
    setTraces(previous => JSON.stringify(previous) === JSON.stringify(nextTraces) ? previous : nextTraces);
    setSheetLabels(previous => JSON.stringify(previous) === JSON.stringify(nextSheetLabels) ? previous : nextSheetLabels);
    setMeasures(previous => JSON.stringify(previous) === JSON.stringify(nextMeasures) ? previous : nextMeasures);
    setCompares(previous => JSON.stringify(previous) === JSON.stringify(nextCompares) ? previous : nextCompares);
    setVoices(previous => JSON.stringify(previous) === JSON.stringify(nextVoices) ? previous : nextVoices);
    setTimelines(previous => JSON.stringify(previous) === JSON.stringify(nextTimelines) ? previous : nextTimelines);
    setTimestamps(previous => JSON.stringify(previous) === JSON.stringify(nextTimestamps) ? previous : nextTimestamps);
    return { marks: stickies.length + nextImages.length + nextStickers.length + nextArrows.length + nextCards.length + nextInk.length,
      bubbles: nextComments.length };
  }, []);

  const load = useCallback(() => {
    const path = latest.current.note;
    if (!path) return;
    const mine = ++loadSeq.current;
    const run = queue.current.then(async () => {
      try {
        const startedAt = revision.current;
        const value = await glassCall({ note: path, action: "list" });
        // A write that landed while this list was in flight wins; its optimistic state is newer.
        if (revision.current !== startedAt || mine !== loadSeq.current) return;
        loaded.current = true;
        applyMagnets(value.magnets ?? []);
        setTrash(value.trash ?? []);
        publishGlassLayers(path, value.layers, layerCounts(value.magnets ?? []));
        setSaved("saved");
        const studyState = await glassCall({ note: path, action: "study-state" }).catch(() => undefined);
        if (studyState && typeof studyState === "object") {
          const state = studyState as { exam?: unknown; labelsHidden?: unknown };
          setStudy(previous => ({
            exam: state.exam === true,
            labelsHidden: state.labelsHidden === true || (state.exam === true && previous.labelsHidden),
          }));
        }
        const history = await glassCall({ note: path, action: "merge-history" }).catch(() => undefined);
        if (Array.isArray(history?.merges)) setMergeHistory(history.merges);
      } catch (error) { setSaved("error"); setNotice(message(error)); }
    });
    queue.current = run;
    return run;
  }, [applyMagnets]);

  useLayoutEffect(() => {
    void load();
    const subscribe = window.desktop?.onGlassChanged;
    const stop = subscribe?.((event: { note?: string; action?: string } | undefined) => {
      if (event && (event.note === latest.current.note || event.action === "bring" && !event.note)) {
        setMergeDone(undefined);
        void load();
      }
    });
    // A focus reload must not clobber a click that just started writing; the journal echo is authoritative.
    const onFocus = () => { if (loaded.current && Date.now() - localAt.current > 500) void load(); };
    window.addEventListener("focus", onFocus);
    return () => { stop?.(); window.removeEventListener("focus", onFocus); };
  }, [load]);

  useEffect(() => {
    const request = boardRequest;
    if (!request || request.note !== note || handledBoard.current === request.at) return;
    handledBoard.current = request.at;
    if (!boardEnabled) { setNotice("Enable the Board add-on in Settings first."); return; }
    const board = boards.find(item => item.id === request.magnet);
    if (!board) { setNotice("Board not found in this note."); return; }
    setBoardOpen({ id: board.id, name: board.name });
  }, [boardRequest, boards, note, boardEnabled]);

  useEffect(() => {
    const surface = layer.current;
    if (!surface) return;
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    const sizes = new ResizeObserver(schedule);
    sizes.observe(scroller);
    sizes.observe(root);
    // Our own boxes are React output; their mutations must not schedule another pass.
    const edits = new MutationObserver(records => { if (records.every(record => surface.contains(record.target))) return; schedule(); });
    edits.observe(scroller, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      sizes.disconnect();
      edits.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [scroller, root, measure]);

  const showingArrows = arrows.length > 0 || tool === "arrow" || labels.length > 0 || tool === "label";
  useLayoutEffect(() => { measure(); }, [magnets, images, stickers, arrows, cards, clips, extraPages, cutouts, labels, compares, traces, measures, timelines, timestamps, tool, showingArrows, measure]);

  // The visible band in content coordinates: it changes with scroll, not with layout, and both the
  // arrow jump chip and the mount window read it.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = { top: scroller.scrollTop, height: scroller.clientHeight, width: scroller.clientWidth, page: Math.max(scroller.scrollHeight, scroller.clientHeight) };
      setViewport(previous => previous.top === next.top && previous.height === next.height && previous.width === next.width && previous.page === next.page ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const sizes = new ResizeObserver(schedule);
    sizes.observe(scroller);
    sizes.observe(root);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      sizes.disconnect();
    };
  }, [scroller, root]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3_000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (selected && !magnets.some(item => item.id === selected) && !images.some(item => item.id === selected) && !stickers.some(item => item.id === selected)
      && !clips.some(item => item.id === selected) && !extraPages.some(item => item.id === selected) && !cutouts.some(item => item.id === selected)) setSelected(undefined);
  }, [magnets, images, stickers, clips, extraPages, cutouts, selected]);

  useEffect(() => {
    if (selectedArrow && !arrows.some(item => item.id === selectedArrow)) setSelectedArrow(undefined);
  }, [arrows, selectedArrow]);

  const patchImage = useCallback((id: string, patch: Partial<GlassImage>, persist = false) => {
    setImages(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
    if (persist) void send({ action: "set", magnet: id, fields: patch as Record<string, unknown> });
  }, [send]);

  const patchCard = useCallback((id: string, patch: Partial<GlassCard>, persist = true) => {
    setCards(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
    if (!persist) return;
    const fields: Record<string, unknown> = {};
    if (patch.folded !== undefined) fields.folded = patch.folded;
    if (patch.answer !== undefined) fields.answer = patch.answer;
    if (patch.answerAt !== undefined) fields.answerAt = patch.answerAt;
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.proposed !== undefined) fields.proposed = patch.proposed;
    if (Object.keys(fields).length) void send({ action: "set", magnet: id, fields });
  }, [send]);

  const patchCompare = useCallback((id: string, patch: Partial<CompareMark>, persist = true) => {
    setCompares(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
    if (!persist) return;
    const fields: Record<string, unknown> = {};
    for (const key of ["left", "right", "value", "direction", "before", "after", "anchor", "x", "y", "w", "h"] as const)
      if (patch[key] !== undefined) fields[key] = patch[key];
    if (Object.keys(fields).length) void send({ action: "set", magnet: id, fields });
  }, [send]);

  const addTrace = useCallback((fields: Record<string, unknown>) => {
    const id = newVisualId("tr"), trace = traceFromMagnet({ id, fields });
    if (!trace) return;
    setTraces(current => [...current, trace]);
    void send({ action: "add", magnet: id, fields: traceFields(trace) });
  }, [send]);

  const addSheetLabel = useCallback((fields: Record<string, unknown>) => {
    const id = newVisualId("sl"), label = sheetLabelFromMagnet({ id, fields });
    if (!label) return;
    setSheetLabels(current => [...current, label]);
    void send({ action: "add", magnet: id, fields: sheetLabelFields(label) });
  }, [send]);

  const addMeasure = useCallback((image: string, type: MeasureMark["type"], points: Point2[]) => {
    const id = newVisualId("ms"), measure = measureFromMagnet({ id, fields: { kind: "measure", layer: "measure", image, type, points } });
    if (!measure) return;
    setMeasures(current => [...current, measure]);
    void send({ action: "add", magnet: id, fields: measureFields(measure) });
  }, [send]);

  const createCompare = useCallback((leftId: string, rightId: string, value = 50) => {
    const left = latest.current.images.find(image => image.id === leftId);
    const right = latest.current.images.find(image => image.id === rightId);
    if (!left || !right || left.id === right.id) return;
    const width = Math.min(420, Math.max(160, left.w));
    const height = Math.round(Math.min(420, Math.max(120, width / left.aspect)));
    const compare: CompareMark = { id: newVisualId("cmp"), left: left.id, right: right.id, value,
      direction: compareDirection(left.aspect, right.aspect), before: "Before", after: "After", anchor: left.anchor,
      x: 0, y: 0, w: width, h: height };
    setCompares(current => [...current, compare]);
    void send({ action: "add", magnet: compare.id, fields: compareFields(compare) });
  }, [send]);

  const createCard = useCallback((card: GlassCard) => {
    if (lockedLayer("card")) { setNotice("AI cards layer is locked."); return Promise.resolve(undefined); }
    const closing = card.folded ? [] : latest.current.cards.filter(item => !item.folded);
    setCards(current => [...current.map(item => closing.some(open => open.id === item.id) ? { ...item, folded: true } : item)
      .filter(item => item.id !== card.id), card]);
    for (const open of closing) void send({ action: "set", magnet: open.id, fields: { folded: true } });
    const fields = cardFieldsOf(card);
    if (card.answer) { fields.answer = card.answer; fields.answerAt = card.answerAt; }
    return send({ action: "add", magnet: card.id, fields });
  }, [send]);

  // One card unfolds at a time: a popup must not bury its neighbours under a stack of panels.
  const toggleCard = useCallback((id: string) => {
    const target = latest.current.cards.find(item => item.id === id);
    if (!target) return;
    const folded = !target.folded;
    const closing = folded ? [] : latest.current.cards.filter(item => item.id !== id && !item.folded);
    setCards(current => current.map(item => item.id === id ? { ...item, folded }
      : closing.some(open => open.id === item.id) ? { ...item, folded: true } : item));
    void send({ action: "set", magnet: id, fields: { folded } });
    for (const open of closing) void send({ action: "set", magnet: open.id, fields: { folded: true } });
  }, [send]);

  // A bubble pins its answer as an AI card on the glass; the markdown note keeps only the comment.
  const pinCard = useCallback(async (reply: TutorReply) => {
    const question = reply.question.trim() || reply.anchor.quote || reply.anchor.block.slice(0, 240);
    const card: GlassCard = {
      id: newCardId(), card: "ai", title: question.split(/\r?\n/)[0]?.slice(0, 200) ?? "",
      link: "", question, answer: reply.body, answerAt: new Date().toISOString(),
      choices: [], formula: "", inputs: [], unit: "", citation: "", precision: 2, proposed: false,
      anchor: cardAnchor(reply.anchor), x: 0, y: 0, w: 300, folded: false, marked: false,
    };
    return !!(await createCard(card))?.magnet;
  }, [createCard]);

  // Guides measure what the hand can see: every placed magnet in the frame, the page text
  // column, and the line boxes of the paragraphs on screen. Built once per pick-up.
  const snapContext = useCallback((skip: string): SnapContext => {
    const surface = layer.current;
    if (!surface) return { others: [], lines: [] };
    const frame = surface.getBoundingClientRect();
    const others = Object.entries(placesRef.current).flatMap(([id, place]) =>
      id === skip || place.status !== "resolved" ? [] : [{ x: place.x, y: place.y, w: place.width, h: place.height }]);
    const column = root.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const lines: SnapLine[] = [];
    for (const block of blocks.current) {
      const element = block.element;
      if (!element || lines.length >= 400) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || rect.bottom < view.top || rect.top > view.bottom) continue;
      const range = document.createRange();
      range.selectNodeContents(element);
      for (const line of range.getClientRects())
        if (line.width > 8 && line.height > 0) lines.push({ y: line.top - frame.top, x: line.left - frame.left, width: line.width });
    }
    return { others, column: { left: column.left - frame.left, right: column.right - frame.left }, lines };
  }, [root, scroller]);

  const paintGuides = useCallback((guides: readonly SnapGuide[], cost: number) => {
    const holder = guidesEl.current;
    if (!holder) return;
    const shown = new Map<string, SnapGuide>();
    for (const guide of guides) {
      const key = guide.kind === "spacing" ? "spacing" : guide.axis;
      if (!shown.has(key)) shown.set(key, guide);
    }
    for (const node of holder.querySelectorAll<HTMLElement>("[data-guide]")) {
      const guide = shown.get(node.dataset.guide!);
      node.hidden = !guide;
      if (!guide) continue;
      node.dataset.kind = guide.kind;
      const cross = guide.from !== undefined && guide.to !== undefined;
      if (guide.axis === "y") {
        node.style.top = `${guide.at}px`;
        node.style.left = `${guide.from ?? 0}px`;
        node.style.width = cross ? `${Math.max(4, guide.to! - guide.from!)}px` : "100%";
        node.style.height = "1px";
      } else {
        node.style.left = `${guide.at}px`;
        node.style.top = `${guide.from ?? 0}px`;
        node.style.height = cross ? `${Math.max(4, guide.to! - guide.from!)}px` : "100%";
        node.style.width = guide.kind === "spacing" ? `${Math.max(2, guide.gap ?? 0)}px` : "1px";
        if (guide.kind === "spacing") node.dataset.label = `${guide.gap ?? 0}`;
      }
    }
    holder.dataset.snapMs = cost.toFixed(2);
    holder.dataset.snap = guides.length ? "on" : "off";
  }, []);

  // The one rule every magnet follows: align to a neighbour or the column, glue the top to a
  // text line, else round to the grid. Alt skips it all.
  const resolveSnap = useCallback((box: SnapBox, context: SnapContext, alt: boolean) => {
    const setting = gridRef.current;
    const started = performance.now();
    const result = snapBox({ box, others: context.others, column: context.column, lines: context.lines,
      grid: setting.on ? setting.size : 0, disabled: alt });
    paintGuides(alt ? [] : result.guides, performance.now() - started);
    return result;
  }, [paintGuides]);

  const settle = useCallback((element: HTMLElement) => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    element.classList.add("is-settling");
    window.setTimeout(() => element.classList.remove("is-settling"), snapDefaults.settleMs + 80);
  }, []);

  useEffect(() => {
    const surface = layer.current;
    if (!surface) return;
    // interact hands listeners the interactable element, not the mark under the pointer, so remember it.
    let downSource: Element | null = null;
    const track = (event: Event) => { downSource = event.target as Element; };
    surface.addEventListener("pointerdown", track, true);
    const markElement = (target: Element) => ((downSource ?? target).closest?.(".glass-note, .glass-sticker, .glass-clip, .glass-extra-page, .glass-cutout") ?? target) as HTMLElement;
    const findMark = (id: string) => {
      const sticky = latest.current.magnets.find(item => item.id === id);
      if (sticky) return { kind: "sticky" as const, x: sticky.x, y: sticky.y, w: sticky.w, h: sticky.h };
      const sticker = latest.current.stickers.find(item => item.id === id);
      if (sticker) return { kind: "sticker" as const, x: sticker.x, y: sticker.y, w: sticker.w, h: sticker.h };
      const clip = latest.current.clips.find(item => item.id === id);
      if (clip) return { kind: "clip" as const, x: clip.x, y: clip.y, w: clip.w, h: clip.h };
      const page = latest.current.extraPages.find(item => item.id === id);
      if (page) return { kind: "extra-page" as const, x: page.x, y: page.y, w: page.w, h: page.h };
      const cutout = latest.current.cutouts.find(item => item.id === id);
      return cutout ? { kind: "cutout" as const, x: cutout.x, y: cutout.y, w: cutout.w, h: cutout.h } : undefined;
    };
    const place = (id: string, patch: { x: number; y: number; w?: number; h?: number }) => {
      setMagnets(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
      setStickers(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
      setClips(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
      setExtraPages(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
      setCutouts(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
      const fields: Record<string, number> = { x: patch.x, y: patch.y };
      if (patch.w !== undefined) fields.w = patch.w;
      if (patch.h !== undefined) fields.h = patch.h;
      void send({ action: "set", magnet: id, fields });
    };
    const instance = interact(surface);
    let drag: { element: HTMLElement; id: string; x: number; y: number; pageX: number; pageY: number;
      place?: SnapBox; context?: SnapContext } | undefined;
    instance.draggable({
      allowFrom: ".glass-note, .glass-note-head, .glass-sticker, .glass-clip, .glass-sheet-head, .glass-cutout",
      ignoreFrom: ".glass-note-text, .glass-note-tools, .glass-note-grip, .glass-note-dot, .glass-sticker-grip, .glass-sticker-rotate, .glass-sticker-delete, .glass-sheet-text, .glass-sheet-ink, .glass-sheet-actions, .glass-sheet-ink-toggle, .glass-sheet-grip, .glass-sheet-body, .glass-cutout-actions, .glass-cutout-grip, textarea, input, button",
      listeners: {
        start(event) {
          const element = markElement(event.target);
          const id = element.dataset.magnet ?? "";
          const mark = findMark(id);
          if (!mark) return;
          const placed = placesRef.current[id];
          dragging.current = true;
          element.classList.add("is-lifting");
          // Guides are built after the press has painted: picking up 200 magnets must stall neither
          // the press nor the first move.
          // The style a drag starts from is what the last measure wrote, to the pixel.
          const box = element.getBoundingClientRect();
          drag = { element, id, x: mark.x, y: mark.y, pageX: event.pageX, pageY: event.pageY,
            place: { x: Number.parseFloat(element.style.left) || box.left, y: Number.parseFloat(element.style.top) || box.top, w: box.width, h: box.height } };
          const warming = drag;
          setTimeout(() => { if (drag === warming && !warming.context) warming.context = snapContext(id); }, 0);
        },
        move(event) {
          if (!drag) return;
          const startedAt = performance.now();
          const dx = event.pageX - drag.pageX, dy = event.pageY - drag.pageY;
          let x = dx, y = dy;
          if (drag.place) {
            drag.context ??= snapContext(drag.id);
            const proposal = { x: drag.place.x + dx, y: drag.place.y + dy, w: drag.place.w, h: drag.place.h };
            const result = resolveSnap(proposal, drag.context, event.altKey);
            x += result.x - proposal.x;
            y += result.y - proposal.y;
          }
          drag.element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
          surface.dataset.dragMs = (performance.now() - startedAt).toFixed(2);
        },
        end(event) {
          const start = drag;
          drag = undefined;
          dragging.current = false;
          if (!start) return;
          start.element.classList.remove("is-lifting");
          start.element.style.removeProperty("transform");
          const dx = event.pageX - start.pageX, dy = event.pageY - start.pageY;
          const rtl = rtlNow();
          let x = start.x + (rtl ? -dx : dx), y = start.y + dy;
          if (start.place) {
            const proposal = { x: start.place.x + dx, y: start.place.y + dy, w: start.place.w, h: start.place.h };
            const result = resolveSnap(proposal, start.context ?? snapContext(start.id), event.altKey);
            const moved = result.x - start.place.x, raised = result.y - start.place.y;
            x = start.x + (rtl ? -moved : moved);
            y = start.y + raised;
          } else if (gridRef.current.on) {
            x = Math.round(x / gridRef.current.size) * gridRef.current.size;
            y = Math.round(y / gridRef.current.size) * gridRef.current.size;
          }
          paintGuides([], 0);
          place(start.id, { x: Math.round(x), y: Math.round(y) });
          settle(start.element);
        },
      },
    }).resizable({
      edges: { right: ".glass-note-grip-right, .glass-sticker-grip, .glass-sheet-grip", bottom: ".glass-note-grip-bottom, .glass-cutout-grip" },
      listeners: {
        start(event) {
          const element = markElement(event.target);
          const mark = findMark(element.dataset.magnet ?? "");
          if (!mark) return;
          dragging.current = true;
          const rect = element.getBoundingClientRect();
          const limits = mark.kind === "clip" ? [clipDefaults.minW, clipDefaults.minH]
            : mark.kind === "extra-page" ? [extraPageDefaults.minW, extraPageDefaults.minH]
            : mark.kind === "cutout" ? [cutoutDefaults.minW, cutoutDefaults.minH] : [stickyDefaults.minW, stickyDefaults.minH];
          element.dataset.resize = JSON.stringify({ id: element.dataset.magnet, kind: mark.kind, width: rect.width, height: rect.height,
            minW: limits[0], minH: limits[1], pageX: event.pageX, pageY: event.pageY });
        },
        move(event) {
          const element = markElement(event.target), data = element.dataset.resize;
          if (!data) return;
          const start = JSON.parse(data);
          if (start.kind === "sticker") {
            const size = Math.max(24, Math.min(1200, Math.round(start.width + event.pageX - start.pageX)));
            element.style.width = `${size}px`;
            element.style.height = `${size}px`;
            element.dataset.size = String(size);
            return;
          }
          const width = Math.max(start.minW ?? stickyDefaults.minW, start.width + event.pageX - start.pageX), height = Math.max(start.minH ?? stickyDefaults.minH, start.height + event.pageY - start.pageY);
          element.style.width = `${width}px`;
          element.style.height = `${height}px`;
          element.dataset.size = JSON.stringify({ width, height });
        },
        end(event) {
          const element = markElement(event.target), data = element.dataset.resize;
          dragging.current = false;
          if (!data) return;
          const start = JSON.parse(data), size = element.dataset.size;
          const step = gridRef.current.on ? gridRef.current.size : 1;
          delete element.dataset.resize;
          delete element.dataset.size;
          if (size === undefined) return;
          if (start.kind === "sticker") {
            const id = element.dataset.magnet!;
            const edge = Math.round(Math.max(24, Number(size)) / step) * step;
            place(id, { x: findMark(id)?.x ?? 0, y: findMark(id)?.y ?? 0, w: edge, h: edge });
            return;
          }
          const id = element.dataset.magnet!;
          const box = JSON.parse(size);
          place(id, { x: findMark(id)?.x ?? 0, y: findMark(id)?.y ?? 0, w: Math.round(box.width / step) * step, h: Math.round(box.height / step) * step });
        },
      },
    });
    return () => { surface.removeEventListener("pointerdown", track, true); instance.unset(); };
  }, [paintGuides, resolveSnap, send, settle, snapContext]);

  const create = useCallback((point: { x: number; y: number }) => {
    const surface = layer.current;
    if (!surface || !latest.current.note) return;
    if (lockedLayer("sticky")) { setNotice("Notes & stickers layer is locked."); return; }
    const block = nearestBlock(blocks.current, point);
    if (!block) return;
    // A click drops the note exactly under the pointer; the eight-pixel grid is for drags.
    const rtl = rtlNow(), at = block.element?.getBoundingClientRect();
    const offset = at
      ? { x: Math.round((rtl ? at.right - point.x : point.x - at.left) * 100) / 100, y: Math.round((point.y - at.top) * 100) / 100 }
      : offsetIn(block, point, rtl);
    const stickie: StickyNote = {
      id: newStickyId(), text: "", color: stickyColors[0], anchor: anchorOf(block),
      x: offset.x, y: offset.y, w: stickyDefaults.w, h: stickyDefaults.h, folded: false,
    };
    setMagnets(current => [...current, stickie]);
    setSelected(stickie.id);
    setSelectedArrow(undefined);
    setEditing(stickie.id);
    void send({ action: "add", magnet: stickie.id, fields: stickyFields(stickie) });
  }, [send]);

  // G21: one recorder at a time, a pill that names the state, and audio that never leaves the vault.
  const setVoiceRun = (next: VoiceRun | undefined) => { runRef.current = next; setRun(next); };
  const leaveVoiceTool = () => { if (["voice", "memo", "lecture"].includes(latest.current.tool)) setTool("select"); };
  const clearVoiceTimers = () => {
    if (voiceTick.current) { clearInterval(voiceTick.current); voiceTick.current = undefined; }
  };
  const beginVoice = async (mode: VoiceRun["mode"], point: { x: number; y: number }) => {
    if (runRef.current || !latest.current.note) return;
    if (!voice.configured) { setNotice("Set OMARKIE_STT to use voice."); return; }
    const block = nearestBlock(blocks.current, point);
    if (!block) { setNotice("Click a paragraph to record there."); return; }
    if (mode === "memo" && lockedLayer("image")) { setNotice("Media layer is locked."); return; }
    if (mode === "dictation" && lockedLayer("sticky")) { setNotice("Notes & stickers layer is locked."); return; }
    const next: VoiceRun = { id: crypto.randomUUID(), mode, phase: "recording", startedAt: Date.now(), block,
      offset: offsetIn(block, point, rtlNow()), segments: [], marks: [], pending: 0 };
    const capture = mode === "lecture" ? new LectureRecorder(utterance => queueUtterance(next.id, utterance)) : new VoiceRecorder();
    try { await capture.start(); }
    catch (failure) { capture.cancel(); setNotice((failure as Error).message); return; }
    if (!latest.current.note) { capture.cancel(); return; }
    if (capture instanceof LectureRecorder) lecture.current = { recorder: capture, chain: Promise.resolve() };
    else recorder.current = capture;
    setVoiceRun(next);
    voiceTick.current = window.setInterval(() => {
      if (lecture.current && lecture.current.recorder.durationMs >= lectureDefaults.seconds * 1000) void saveLecture();
      setRun(current => current ? { ...current } : current);
    }, 500);
  };

  // Each utterance is transcribed in order while the lecture goes on; Save waits for the queue to drain.
  function queueUtterance(id: string, utterance: Utterance) {
    const current = lecture.current, run = runRef.current;
    if (!current || run?.id !== id) return;
    const wav = encodeVoiceWav(utterance.samples, voiceDefaults.rate);
    setVoiceRun({ ...run, pending: run.pending + 1 });
    current.chain = current.chain.then(async () => {
      if (runRef.current?.id !== id) return;
      const result = await transcribeCapture(wav, { mode: "lecture", language: voice.language, id })
        .catch((failure: Error) => ({ ok: false, code: "failed", text: null, message: failure.message }));
      const after = runRef.current;
      if (after?.id !== id) return;
      const heard = result.ok && result.text;
      if (!result.ok && result.code !== "no-speech" && result.code !== "cancelled") setNotice(result.message ?? "A lecture passage was not transcribed.");
      setVoiceRun({ ...after, pending: after.pending - 1,
        segments: heard ? [...after.segments, { startMs: utterance.startMs, endMs: utterance.endMs, text: result.text! }] : after.segments });
    });
  }

  async function finishVoice() {
    const current = runRef.current, capture = recorder.current;
    if (!current) return;
    clearVoiceTimers();
    if (current.mode === "lecture") { await saveLecture(); return; }
    setVoiceRun({ ...current, phase: "transcribing" });
    let part;
    try { part = await capture!.stop(); }
    catch (failure) { recorder.current = undefined; setVoiceRun(undefined); leaveVoiceTool(); setNotice((failure as Error).message); return; }
    recorder.current = undefined;
    const result = await transcribeCapture(part.wav, { mode: current.mode, language: voice.language, id: current.id });
    if (current.mode === "dictation") {
      if (!result.ok || !result.text) { setVoiceRun(undefined); leaveVoiceTool(); setNotice(result.message ?? "No speech was heard."); return; }
      const stickie: StickyNote = { id: newStickyId(), text: result.text, color: stickyColors[0], anchor: anchorOf(current.block),
        x: current.offset.x, y: current.offset.y, w: stickyDefaults.w, h: stickyDefaults.h, folded: false };
      setMagnets(items => [...items, stickie]);
      setVoiceRun(undefined); leaveVoiceTool();
      void send({ action: "add", magnet: stickie.id, fields: stickyFields(stickie) });
      return;
    }
    if (!result.ok) { setVoiceRun(undefined); leaveVoiceTool(); setNotice(result.message ?? "The memo was not transcribed."); return; }
    const id = newVoiceId();
    const audio = { base64: await blobBase64(part.blob), mime: part.blob.type };
    setVoiceRun({ ...current, phase: "saving" });
    await send({ action: "voice-memo", magnet: id, text: result.text ?? "", durationMs: part.durationMs, lang: voice.language,
      audio, anchor: anchorOf(current.block), x: current.offset.x, y: current.offset.y,
      w: voiceMemoDefaults.w, h: voiceMemoDefaults.h });
    setVoiceRun(undefined); leaveVoiceTool();
    await load();
  }

  async function saveLecture() {
    const current = runRef.current, capture = lecture.current;
    if (!current || current.phase !== "recording" || !capture) return;
    clearVoiceTimers();
    setVoiceRun({ ...current, phase: "transcribing" });
    let audio = null;
    try { audio = await capture.recorder.stop(); } catch (failure) { setNotice((failure as Error).message); }
    await capture.chain;
    const done = runRef.current;
    if (done?.id !== current.id) return;
    lecture.current = undefined;
    if (!done.segments.length) { setVoiceRun(undefined); leaveVoiceTool(); setNotice("Nothing was transcribed."); return; }
    setVoiceRun({ ...done, phase: "saving" });
    let payload = null;
    try { payload = audio ? { base64: await blobBase64Async(audio.blob), mime: audio.mime } : null; }
    catch (failure) { setNotice((failure as Error).message); }
    // Times move onto the archive's clock, so every stamp and section seeks to its own words.
    const offset = payload && audio ? audio.offsetMs : 0, onArchive = (ms: number) => Math.max(0, ms - offset);
    const value = await send({ action: "voice-lecture", note: latest.current.note,
      transcript: done.segments.map(segment => ({ ...segment, startMs: onArchive(segment.startMs), endMs: onArchive(segment.endMs) })),
      marks: done.marks.map(mark => ({ atMs: onArchive(mark.atMs) })), audio: payload, language: voice.language });
    setVoiceRun(undefined); leaveVoiceTool();
    setNotice(value?.note ? `Saved ${String(value.note)}` : "The lecture was not saved.");
  }

  function markMoment() {
    const current = runRef.current;
    if (!current || current.mode !== "lecture" || !lecture.current) return;
    setVoiceRun({ ...current, marks: [...current.marks, { atMs: lecture.current.recorder.durationMs }] });
  }

  function cancelVoice() {
    const current = runRef.current;
    clearVoiceTimers();
    recorder.current?.cancel();
    recorder.current = undefined;
    lecture.current?.recorder.cancel();
    lecture.current = undefined;
    if (current) cancelTranscribe(current.id);
    setVoiceRun(undefined); leaveVoiceTool();
  }

  const blockSource = useCallback((block: GlassBlock, path: string) => ({
    element: block.element?.dataset.cid ?? `block-${block.line}`, line: block.line, path,
    ...(block.kind ? { kind: block.kind } : {}),
  }), []);

  // G13: a paper clip holds its own mini-page; a blank extra sheet sits beside a paragraph.
  const createSheet = useCallback((kind: "clip" | "extra-page", point: { x: number; y: number }) => {
    if (!latest.current.note) { setNotice("Save this note first."); return; }
    if (lockedLayer(kind)) { setNotice("Notes & stickers layer is locked."); return; }
    const block = nearestBlock(blocks.current, point);
    if (!block) return;
    const offset = offsetIn(block, point);
    const id = newClipId();
    if (kind === "clip") {
      const clip: ClipPage = { id, text: "", title: "", anchor: anchorOf(block), x: offset.x + 12, y: offset.y + 12,
        w: clipDefaults.w, h: clipDefaults.h, folded: false, strokes: [], notePath: null, savedAt: "",
        source: blockSource(block, latest.current.note) };
      setClips(current => [...current, clip]);
      setSelected(id);
      setSelectedArrow(undefined);
      setTool("select");
      void send({ action: "add", magnet: id, fields: clipFields(clip) });
      return;
    }
    const page: ExtraPage = { id, text: "", title: "Extra page", paper: pagePaper, anchor: anchorOf(block),
      x: offset.x + 12, y: offset.y + 12, w: extraPageDefaults.w, h: extraPageDefaults.h, strokes: [] };
    setExtraPages(current => [...current, page]);
    setSelected(id);
    setSelectedArrow(undefined);
    setTool("select");
    void send({ action: "add", magnet: id, fields: extraPageFields(page) });
  }, [blockSource, pagePaper, send]);

  const patchClip = useCallback((id: string, patch: Partial<ClipPage>, persist = true) => {
    setClips(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
    if (!persist) return;
    const fields: Record<string, unknown> = {};
    for (const key of ["text", "title", "folded", "strokes"] as const)
      if (patch[key] !== undefined) fields[key] = patch[key];
    if (Object.keys(fields).length) void send({ action: "set", magnet: id, fields });
  }, [send]);

  const patchPage = useCallback((id: string, patch: Partial<ExtraPage>, persist = true) => {
    setExtraPages(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
    if (!persist) return;
    const fields: Record<string, unknown> = {};
    for (const key of ["text", "title", "paper", "strokes"] as const)
      if (patch[key] !== undefined) fields[key] = patch[key];
    if (Object.keys(fields).length) void send({ action: "set", magnet: id, fields });
  }, [send]);

  // One new note per clip; a second press returns the same file, never a duplicate.
  const saveClip = useCallback(async (id: string) => {
    if (!latest.current.note) return;
    try {
      // The textarea flushes on blur; let that write land before the note is written.
      await queue.current;
      const value = await glassCall({ note: latest.current.note, action: "clip-save", magnet: id });
      const saved = typeof value.path === "string" ? value.path : "";
      const stored = value.magnet ? clipFromMagnet(value.magnet) : undefined;
      setClips(current => current.map(item => item.id === id
        ? { ...(stored ?? item), ...(saved ? { notePath: saved } : {}) } : item));
      setNotice(saved ? `Saved as ${saved}` : "Saved as a note.");
    } catch (error) { setNotice(message(error)); }
  }, []);

  const anchorLine = (anchor: ClipPage["anchor"]) => {
    for (const landmark of anchor.landmarks) if (landmark.kind === "block" && landmark.line) return landmark.line;
    return 1;
  };

  const jumpWithBack = useCallback((id: string, line: number, label: string) => {
    setBackTo({ top: scroller.scrollTop, id, label });
    editor()?.jump(line);
  }, [editor, scroller]);

  // Scissors: rectangle or freehand lasso. Image sources keep fractions; page regions use a small snapshot.
  const cutoutAt = useCallback(async (box: { x: number; y: number; width: number; height: number }, lasso: [number, number][]) => {
    if (!latest.current.note) { setNotice("Save this note first."); return; }
    if (lockedLayer("cutout")) { setNotice("Media layer is locked."); return; }
    if (box.width < cutoutDefaults.minCropPx || box.height < cutoutDefaults.minCropPx) { setNotice("Cut at least 10 px."); return; }
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const block = nearestBlock(blocks.current, point);
    if (!block?.element) { setNotice("Cut over a paragraph or a picture."); return; }
    const elementBox = block.element.getBoundingClientRect();
    const region = regionOf({ x: elementBox.left, y: elementBox.top, width: elementBox.width, height: elementBox.height }, box);
    const picture = block.element.tagName === "IMG" ? block.element as HTMLImageElement : block.element.querySelector("img");
    const offset = offsetIn(block, { x: box.x + 12, y: box.y + 12 });
    const w = Math.round(Math.min(360, Math.max(cutoutDefaults.minW, box.width)));
    const aspect = Math.max(0.1, box.width / Math.max(1, box.height));
    const id = newClipId();
    const draft: Cutout = { id, name: picture ? "Cutout" : "Page cutout", asset: null, display: null,
      sourceKind: picture ? "image" : "region", bytes: 0, aspect, w, h: Math.max(cutoutDefaults.minH, Math.round(w / aspect)),
      x: offset.x, y: offset.y, anchor: anchorOf(block), source: blockSource(block, latest.current.note),
      region, lasso: lasso.length >= 3 ? lasso : null, locked: false };
    setCutouts(current => [...current, draft]);
    setSelected(id);
    setSelectedArrow(undefined);
    const fields = cutoutFields(draft);
    try {
      if (picture) {
        const value = await send({ action: "add", magnet: id, fields });
        const stored = value?.magnet && cutoutFromMagnet(value.magnet);
        if (stored) setCutouts(current => current.map(item => item.id === id ? stored : item));
        setTool("select");
        return;
      }
      setCapturing(true);
      document.documentElement.classList.add("glass-capturing");
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      // capturePage reads the compositor's last frame; give the hidden overlay one frame to settle.
      await new Promise(resolve => setTimeout(resolve, 120));
      let snapshot = "";
      try {
        const reply = await window.desktop?.captureRegion({ x: Math.round(box.x), y: Math.round(box.y),
          width: Math.round(box.width), height: Math.round(box.height) });
        if (!reply?.ok || !reply.value?.base64) throw new Error(reply?.error ?? "The cutout could not be captured.");
        snapshot = reply.value.base64;
      } finally {
        document.documentElement.classList.remove("glass-capturing");
        setCapturing(false);
      }
      const value = await send({ action: "add", magnet: id, fields,
        image: { base64: snapshot, name: `${draft.name}.png`, width: w } });
      const stored = value?.magnet && cutoutFromMagnet(value.magnet);
      if (stored) setCutouts(current => current.map(item => item.id === id ? stored : item));
      else setNotice("The cutout was saved without its picture.");
      setTool("select");
    } catch (error) {
      setCutouts(current => current.filter(item => item.id !== id));
      setNotice(message(error));
    }
  }, [blockSource, send]);

  // A pin only lands on a picture: a placed image magnet or an image in the page.
  const labelTargetAt = useCallback((point: { x: number; y: number }) => {
    const places = placesRef.current;
    for (const image of latest.current.images) {
      const place = places[image.id];
      if (place?.status !== "resolved") continue;
      if (point.x < place.x || point.y < place.y || point.x > place.x + place.width || point.y > place.y + place.height) continue;
      return { target: { kind: "magnet" as const, magnet: image.id }, box: { x: place.x, y: place.y, width: place.width, height: place.height } };
    }
    for (const [id, box] of Object.entries(elementBoxes.current)) {
      if (point.x < box.x || point.y < box.y || point.x > box.x + box.width || point.y > box.y + box.height) continue;
      const element = elements.current.list.find(item => item.id === id);
      if (!element || !["image", "embed"].includes(element.kind)) continue;
      return { target: { kind: "element" as const, element: id, anchor: element.landmarks as GlassAnchor }, box };
    }
    return undefined;
  }, []);

  const createLabel = useCallback((point: { x: number; y: number }) => {
    if (!latest.current.note) return;
    const found = labelTargetAt(point);
    if (!found) { setNotice("Click on a picture to pin a label."); return; }
    const { box, target } = found;
    const label: GlassLabel = {
      id: newLabelId(), target, text: "Label",
      nx: Math.min(1, Math.max(0, (point.x - box.x) / Math.max(1, box.width))),
      ny: Math.min(1, Math.max(0, (point.y - box.y) / Math.max(1, box.height))),
      dx: 20, dy: -16, hidden: false, marked: false,
    };
    setLabels(current => [...current, label]);
    setLabelEditing(label.id);
    setTool("select");
    void send({ action: "add", magnet: label.id, ...(target.kind === "element" ? { anchor: target.anchor } : {}), fields: labelFieldsOf(label) });
  }, [labelTargetAt, send]);

  const patchLabel = useCallback((id: string, patch: Partial<GlassLabel>, persist = true) => {
    setLabels(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
    if (persist) void send({ action: "set", magnet: id, fields: patch });
  }, [send]);

  const labelContext = useCallback((label: GlassLabel) => {
    const target = label.target;
    if (target.kind === "magnet") return latest.current.images.find(image => image.id === target.magnet)?.name ?? "";
    const element = elements.current.list.find(item => item.id === target.element);
    return element?.text.trim().slice(0, 80) || "";
  }, []);

  const gradeLabel = useCallback((label: GlassLabel, grade: "again" | "good") => {
    if (!latest.current.note) return;
    setRevealed(values => new Set(values).add(label.id));
    const picture = labelContext(label);
    const front = picture ? `Name the pinned structure on ${picture}` : "Name the pinned structure";
    const back = label.text || "No label text";
    // A miss makes the card due now; the review itself is the first grade, so it is not recorded twice.
    void send(grade === "again"
      ? { action: "srs-card", magnet: label.id, front, back, source: "label" }
      : { action: "srs-answer", magnet: label.id, front, back, grade, create: false, source: "label" })
      .then(() => window.dispatchEvent(new CustomEvent("omarkie:study-changed")));
  }, [labelContext, send]);

  const setStudyMode = useCallback((patch: Partial<StudyState>) => {
    setStudy(current => ({ ...current, ...patch }));
    if (patch.labelsHidden !== undefined) setRevealed(new Set());
    void send({ action: "study-set", ...patch });
  }, [send]);

  const revealItem = useCallback((id: string) => setRevealed(values => new Set(values).add(id)), []);

  const examItems = useMemo<ExamItem[]>(() => {
    const items: ExamItem[] = labels.map((label, position) => ({
      id: label.id, kind: "label", cue: labelCue(position), answer: label.text || "No label text", marked: label.marked,
    }));
    for (const card of cards) {
      const answer = card.card === "menu" ? card.choices.map(choice => `${choice.label}: ${choice.body}`.trim()).join(" · ")
        : card.card === "ai" ? card.answer : card.link;
      items.push({ id: card.id, kind: "card", cue: card.title || card.question || "Card", answer, marked: card.marked });
    }
    for (const magnet of comments) {
      const fields = magnet.fields ?? {};
      const thread = Array.isArray(fields.thread) ? fields.thread : [];
      const said = thread.filter(entry => entry && typeof entry === "object" && "role" in entry && entry.role === "agent"
        && "text" in entry && typeof entry.text === "string").at(-1);
      const headings = Array.isArray(fields.headings) ? fields.headings.filter(heading => typeof heading === "string") : [];
      const text = typeof fields.text === "string" ? fields.text : "";
      const answer = said && typeof said === "object" && "text" in said ? String(said.text) : text;
      items.push({ id: magnet.id, kind: "bubble", cue: text || headings.at(-1) || "Comment", answer, marked: fields.marked === true });
    }
    return items;
  }, [labels, cards, comments]);

  // Exam grades are previews only: no review record, so due dates do not move.
  const previewGrade = useCallback((grade: SrsGrade, item: ExamItem) => {
    if (!latest.current.note) return;
    void glassCall({ note: latest.current.note, action: "srs-answer", magnet: item.id, grade, preview: true, create: false }).catch(() => undefined);
  }, []);

  // Timeline: attach to the first audio or video on the page, keep the transcript lines that follow it.
  const createTimeline = useCallback(async () => {
    if (!latest.current.note) { setNotice("Save the note first."); return; }
    const media = root.querySelector<HTMLMediaElement>("audio, video");
    if (!media) { setNotice("This note has no audio or video to pin."); return; }
    const src = media.currentSrc || media.src || media.querySelector("source")?.src;
    if (!src) { setNotice("That audio or video has no source."); return; }
    const element = media.closest<HTMLElement>("[data-cid]");
    const block = blocks.current.find(item => item.element === element) ?? blocks.current.find(item => item.element?.contains(media)) ?? blocks.current[0];
    if (!block) { setNotice("Put the audio or video in a paragraph."); return; }
    const cues: ReturnType<typeof transcriptLine>[] = [];
    for (let next = element?.nextElementSibling; next && cues.length < timelineDefaults.maxTranscript; next = next.nextElementSibling) {
      if (next.matches("h1, h2, h3, h4, h5, h6")) continue;
      const direct = transcriptLine((next.textContent ?? "").trim());
      if (direct) cues.push(direct);
      else {
        const nested = [...next.querySelectorAll("li, p")].map(item => transcriptLine((item.textContent ?? "").trim())).filter(Boolean);
        if (!nested.length) break;
        cues.push(...nested);
      }
    }
    const id = `tl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const name = latest.current.note.split(/[\\/]/u).at(-1)?.replace(/\.[^.]+$/u, "") || "Lecture";
    const timeline: TimelineMark = {
      id, kind: "timeline", src, title: name, media: media.tagName === "VIDEO" ? "video" : "audio",
      duration: Number.isFinite(media.duration) ? media.duration : 0,
      transcript: cues.filter((cue): cue is NonNullable<typeof cue> => !!cue),
      anchor: anchorOf(block), x: 32, y: 32, w: 380, h: 320,
    };
    setTimelines(current => [...current, timeline]);
    setSelected(id);
    setSelectedArrow(undefined);
    try {
      const value = await send({ action: "add", magnet: id, fields: {
        kind: "timeline", src, title: timeline.title, media: timeline.media, duration: timeline.duration,
        transcript: timeline.transcript, anchor: timeline.anchor, x: timeline.x, y: timeline.y, w: timeline.w, h: timeline.h,
      } });
      const stored = value?.magnet && timelineFromMagnet(value.magnet);
      if (stored) setTimelines(current => current.map(item => item.id === id ? stored : item));
    } catch (error) {
      setTimelines(current => current.filter(item => item.id !== id));
      setNotice(message(error));
    }
  }, [root, send]);

  const pinTimestamp = useCallback((timeline: TimelineMark, source: number, label: string) => {
    const id = `ts-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const fields = { kind: "timestamp", timeline: timeline.id, t: source, label: label.slice(0, 500) };
    const stamp = timestampFromMagnet({ id, fields });
    if (!stamp) return;
    setTimestamps(current => [...current, stamp]);
    void send({ action: "add", magnet: id, fields }).then(value => {
      const stored = value?.magnet && timestampFromMagnet(value.magnet);
      if (stored) setTimestamps(current => current.map(item => item.id === id ? stored : item));
    }).catch(error => {
      setTimestamps(current => current.filter(item => item.id !== id));
      setNotice(message(error));
    });
  }, [send]);

  const setTimelineDuration = useCallback((id: string, duration: number) => {
    if (!(duration > 0)) return;
    setTimelines(current => current.map(item => item.id === id ? { ...item, duration } : item));
    void send({ action: "set", magnet: id, fields: { duration } });
  }, [send]);

  const removeTimeline = useCallback((id: string) => {
    setTimelines(current => current.filter(item => item.id !== id));
    setTimestamps(current => current.filter(item => item.timeline !== id));
    void send({ action: "delete", magnet: id });
  }, [send]);

  const chooseInk = useCallback((next: InkTool | "eraser") => {
    setTool("ink");
    setInkTool(next);
    if (next === "eraser") return;
    setInkSize(current => inkWidths[next].includes(current) ? current : inkDefaults(next).size);
    setInkColor(current => inkColors[next].includes(current) ? current : inkDefaults(next).color);
  }, []);

  const inkHistoryChange = useCallback((undo: boolean, redo: boolean) => {
    setInkHistory(current => current.undo === undo && current.redo === redo ? current : { undo, redo });
  }, []);

  const createAtCenter = useCallback(() => {
    const surface = layer.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    create({ x: rect.left + rect.width / 2 - stickyDefaults.w / 2, y: rect.top + Math.min(rect.height / 2, 320) });
  }, [create]);

  // Drop, paste or choose a file: the original is kept and a light copy is made for big photos.
  const addImages = useCallback(async (files: File[], point: { x: number; y: number }) => {
    if (lockedLayer("image")) { setNotice("Media layer is locked."); return; }
    if (!latest.current.note) { setNotice("Save this note first."); return; }
    for (const file of files) {
      if (file.size > imageDefaults.maxBytes) { setNotice(`${file.name} is larger than ${Math.round(imageDefaults.maxBytes / 1024 / 1024)} MB.`); continue; }
      const block = nearestBlock(blocks.current, point) ?? blocks.current[0];
      if (!block) { setNotice("Put the picture on a paragraph."); continue; }
      const box = block.element?.getBoundingClientRect();
      const width = Math.round(Math.max(180, Math.min(360, (box?.width ?? 640) / 2)));
      const type = imageTypeOf(new Uint8Array(await file.slice(0, 32).arrayBuffer()));
      if (!type) { setNotice(`${file.name} is not an image Omarkie can store.`); continue; }
      const size = await imageCopy(file, dimensions => displayNeeded({ ...dimensions, bytes: file.size, type }));
      const display = size?.base64;
      const aspect = size && size.width > 0 && size.height > 0 ? size.width / size.height : 4 / 3;
      const id = newStickyId();
      const wrap = point.x < (box?.left ?? 0) + (box?.width ?? 0) / 2 ? "left" : "right";
      const draft: GlassImage = { id, name: file.name || "Image", asset: "", display: null, bytes: file.size, w: width,
        h: Math.max(imageDefaults.minH, Math.round(width / aspect)), aspect, rot: 0, wrap, tape: false, locked: false,
        anchor: anchorOf(block), x: 0, y: 0, sheets: [], activeSheet: null, scale: null };
      setImages(current => [...current, draft]);
      setSelected(id);
      setSelectedArrow(undefined);
      try {
        const value = await send({ action: "add", magnet: id, fields: { anchor: draft.anchor, w: width, aspect },
          image: { base64: await fileBase64(file), name: file.name, displayBase64: display, wrap } });
        const stored = value?.magnet && imageFromMagnet(value.magnet);
        if (stored) setImages(current => current.map(item => item.id === id ? stored : item));
      } catch (error) {
        setImages(current => current.filter(item => item.id !== id));
        setNotice(message(error));
      }
    }
  }, [send]);

  useEffect(() => {
    if (!note) return;
    const images = (data: DataTransfer | null) => imageFiles(data);
    const over = (event: DragEvent) => {
      if (!event.dataTransfer || event.dataTransfer.types.includes("application/x-omarkie-scrap")) return;
      if (!images(event.dataTransfer).length) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer || event.dataTransfer.types.includes("application/x-omarkie-scrap")) return;
      const files = images(event.dataTransfer);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      void addImages(files, { x: event.clientX, y: event.clientY });
    };
    const paste = (event: ClipboardEvent) => {
      const files = images(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      const box = (layer.current?.getBoundingClientRect() ?? { left: 0, top: 0 });
      void addImages(files, { x: box.left + 120, y: box.top + 160 });
    };
    scroller.addEventListener("dragover", over, true);
    scroller.addEventListener("drop", drop, true);
    window.addEventListener("paste", paste, true);
    return () => {
      scroller.removeEventListener("dragover", over, true);
      scroller.removeEventListener("drop", drop, true);
      window.removeEventListener("paste", paste, true);
    };
  }, [addImages, note, scroller]);

  const imageDrop = useCallback((image: GlassImage, drop: { dx: number; dy: number; clientX: number; clientY: number }) => {
    if (image.wrap === "left" || image.wrap === "right") {
      const block = nearestBlock(blocks.current, { x: drop.clientX, y: drop.clientY });
      if (!block) return;
      patchImage(image.id, { anchor: anchorOf(block), x: 0, y: 0 }, true);
      return;
    }
    const step = gridRef.current.on ? gridRef.current.size : 1;
    patchImage(image.id, { x: Math.round((image.x + drop.dx) / step) * step, y: Math.round((image.y + drop.dy) / step) * step }, true);
    paintGuides([], 0);
  }, [patchImage, paintGuides]);

  // Pictures follow the same guides as paper: a floating photo aligns and glues while it moves.
  const imageSnap = useCallback((image: GlassImage, dx: number, dy: number, alt: boolean) => {
    const place = placesRef.current[image.id];
    if (!place || place.status !== "resolved" || image.wrap === "left" || image.wrap === "right") { paintGuides([], 0); return { dx, dy }; }
    if (snapCache.current?.id !== image.id) snapCache.current = { id: image.id, context: snapContext(image.id) };
    const proposal = { x: place.x + dx, y: place.y + dy, w: place.width, h: place.height };
    const result = resolveSnap(proposal, snapCache.current.context, alt);
    return { dx: dx + result.x - proposal.x, dy: dy + result.y - proposal.y };
  }, [paintGuides, resolveSnap, snapContext]);

  const liveImageSize = useCallback((id: string, width: number, height: number) => {
    const spacer = spacers.current.get(id);
    if (spacer) { spacer.style.width = `${width}px`; spacer.style.height = `${height}px`; }
  }, []);

  // A sticker lands on the Notes & stickers layer: built-in sheet art or one custom image.
  const placeSticker = useCallback((point: { x: number; y: number }) => {
    if (!latest.current.note) return;
    const block = nearestBlock(blocks.current, point);
    if (!block) return;
    const offset = offsetIn(block, point);
    const mark = stickerAt(block, offset);
    if (stickerChoice === "custom") {
      if (!customImage) { setNotice("Choose a custom image first."); fileInput.current?.click(); return; }
      mark.image = customImage;
      delete mark.sticker;
    } else mark.sticker = stickerChoice;
    setStickers(current => [...current, mark]);
    setSelected(mark.id);
    setSelectedArrow(undefined);
    void send({ action: "add", magnet: mark.id, fields: stickerFields(mark) });
  }, [customImage, send, stickerChoice]);

  const pickSticker = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!/^image\/(?:png|jpeg|webp|gif)$/.test(file.type)) { setNotice("Sticker images must be PNG, JPEG, WebP or GIF."); return; }
    if (file.size > customStickerBytes) { setNotice("Sticker image is too large (max 300 KB)."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const image = typeof reader.result === "string" ? reader.result : "";
      if (!image.startsWith("data:image/") || image.length > customStickerBytes) { setNotice("That image could not be used as a sticker."); return; }
      setCustomImage(image);
      setStickerChoice("custom");
    };
    reader.onerror = () => setNotice("That image could not be read.");
    reader.readAsDataURL(file);
  }, []);

  // An arrow joins two marks or page elements; both ends stay anchored.
  const createArrow = useCallback((from: ArrowMark["from"], to: ArrowMark["to"]) => {
    if (!latest.current.note || arrowEndKey(from) === arrowEndKey(to)) return undefined;
    if (lockedLayer("arrow")) { setNotice("Notes & stickers layer is locked."); return undefined; }
    const arrow: ArrowMark = { id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      from, to, style: arrowStyle, color: arrowColor, head: arrowHead, label: "" };
    setArrows(current => [...current, arrow]);
    setSelectedArrow(arrow.id);
    setSelected(undefined);
    void send({ action: "add", magnet: arrow.id, fields: arrowFields(arrow) });
    return arrow.id;
  }, [arrowColor, arrowHead, arrowStyle, send]);

  const updateArrow = useCallback((id: string, patch: Partial<ArrowMark>) => {
    setArrows(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
    const fields: Record<string, unknown> = {};
    for (const key of ["style", "color", "head", "label", "from", "to"] as const)
      if (patch[key] !== undefined) fields[key] = patch[key];
    if (Object.keys(fields).length) void send({ action: "set", magnet: id, fields });
  }, [send]);

  const hitTest = useCallback((clientX: number, clientY: number, known?: DOMRect): Hit | undefined => {
    const surface = layer.current;
    if (!surface) return;
    // A drag frame already read this rect; the second read would force another layout.
    const frame = known ?? surface.getBoundingClientRect();
    const x = clientX - frame.left, y = clientY - frame.top;
    let best: { hit: Hit; area: number } | undefined;
    const inside = (box: { x: number; y: number; width: number; height: number }) =>
      x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
    // No per-frame allocation: this runs inside every drag frame over the whole page.
    for (const id in placesRef.current) {
      const mark = placesRef.current[id];
      if (!mark || mark.status !== "resolved" || !inside(mark)) continue;
      const sticky = latest.current.magnets.find(item => item.id === id);
      const sticker = latest.current.stickers.find(item => item.id === id);
      const area = mark.width * mark.height;
      if (!best || area < best.area) best = { area, hit: { end: { kind: "magnet", magnet: id }, box: mark,
        name: sticky ? (sticky.text.trim() ? snippet(sticky.text.trim()) : "Sticky note") : sticker ? stickerName(sticker) : "Glass mark" } };
    }
    for (const id in elementBoxes.current) {
      const box = elementBoxes.current[id];
      if (!box || !inside(box)) continue;
      const area = box.width * box.height;
      if (best && area >= best.area) continue;
      const element = elements.current.list.find(item => item.id === id);
      if (!element) continue;
      const block = blocks.current.find(item => item.element?.dataset.cid === id) ?? blocks.current.find(item => item.line === element.blockLine);
      const anchor = block ? anchorOf(block) : { landmarks: [{ kind: "block" as const, block: element.text, headings: element.headings, line: element.line }] };
      best = { area, hit: { end: { kind: "element", element: id, anchor }, box, name: `${elementKindName(element.kind)}: ${snippet(element.text)}` } };
    }
    return best?.hit;
  }, []);

  const forget = useCallback((id: string) => {
    setMagnets(current => current.filter(item => item.id !== id));
    setImages(current => current.filter(item => item.id !== id));
    setStickers(current => current.filter(item => item.id !== id));
    setArrows(current => current.filter(item => item.id !== id));
    setCards(current => current.filter(item => item.id !== id));
    setLabels(current => current.filter(item => item.id !== id));
    setTraces(current => current.filter(item => item.id !== id && item.image !== id));
    setSheetLabels(current => current.filter(item => item.id !== id && item.image !== id));
    setMeasures(current => current.filter(item => item.id !== id && item.image !== id));
    setCompares(current => current.filter(item => item.id !== id && item.left !== id && item.right !== id));
    setSelected(current => current === id ? undefined : current);
    setSelectedArrow(current => current === id ? undefined : current);
  }, []);

  const removeMark = useCallback((id: string) => {
    const kind = magnets.some(item => item.id === id) ? "sticky" : stickers.some(item => item.id === id) ? "sticker"
      : arrows.some(item => item.id === id) ? "arrow" : cards.some(item => item.id === id) ? "card"
      : images.some(item => item.id === id) ? "image" : undefined;
    if (kind && lockedLayer(kind)) { setNotice("That layer is locked."); return; }
    forget(id);
    void send({ action: "delete", magnet: id });
  }, [arrows, cards, forget, images, magnets, send, stickers]);

  // Every page line in view, so a flat underline knows whether it sits under words.
  const lineRects = useCallback((points: readonly (readonly [number, number])[]) => {
    if (!points.length) return [];
    let top = Infinity, bottom = -Infinity;
    for (const [, y] of points) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
    const lines: { top: number; bottom: number }[] = [];
    for (const block of blocks.current) {
      const element = block.element;
      if (!element) continue;
      const box = element.getBoundingClientRect();
      if (box.bottom < top - 80 || box.top > bottom + 80) continue;
      const range = document.createRange();
      range.selectNodeContents(element);
      for (const line of range.getClientRects()) if (line.width > 8 && line.height > 0) lines.push({ top: line.top, bottom: line.bottom });
      if (lines.length > 240) break;
    }
    return lines;
  }, []);

  // The words inside a drawn loop: per-character hit test against the loop's ellipse, so a
  // sloppy circle still catches its sentence and an empty circle catches nothing.
  const enclosedText = useCallback((points: readonly (readonly [number, number])[]) => {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const [x, y] of points) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    const rx = Math.max(8, (right - left) / 2), ry = Math.max(8, (bottom - top) / 2);
    if (right - left < 12 || bottom - top < 12) return "";
    const chars: string[] = [];
    let lastTop: number | undefined, lastRight: number | undefined;
    for (const block of blocks.current) {
      const element = block.element;
      if (!element) continue;
      const box = element.getBoundingClientRect();
      if (box.right < left || box.left > right || box.bottom < top || box.top > bottom) continue;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node && chars.length < 400; node = walker.nextNode()) {
        const data = node.textContent ?? "";
        for (let index = 0; index < data.length && chars.length < 400; index++) {
          const character = data[index];
          if (!character.trim()) {
            if (!/[\r\n]/.test(character) && chars.at(-1) !== " ") chars.push(" ");
            continue;
          }
          range.setStart(node, index); range.setEnd(node, index + 1);
          const rect = range.getBoundingClientRect();
          if (!rect.width) continue;
          const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
          if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
          // Word spans in the rich page carry no literal space between them; a pixel gap is the space.
          if ((lastTop !== undefined && Math.abs(rect.top - lastTop) > rect.height * 0.6) ||
              (lastRight !== undefined && rect.left - lastRight > 1)) {
            if (chars.at(-1) !== " ") chars.push(" ");
          }
          chars.push(character); lastTop = rect.top; lastRight = rect.right;
        }
      }
    }
    return chars.join("").replace(/\s+/g, " ").trim().slice(0, 240);
  }, []);

  // An arrow gesture lands on marks and page elements only; a stroke into blank paper stays ink.
  const arrowEndAt = useCallback((clientX: number, clientY: number): ArrowMark["from"] | undefined => {
    const surface = layer.current;
    if (!surface) return undefined;
    const frame = surface.getBoundingClientRect();
    const x = clientX - frame.left, y = clientY - frame.top;
    let best: { area: number; end: ArrowMark["from"] } | undefined;
    const inside = (box: { x: number; y: number; width: number; height: number }) =>
      x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
    for (const [id, mark] of Object.entries(placesRef.current)) {
      if (mark.status !== "resolved" || !inside(mark)) continue;
      const area = mark.width * mark.height;
      if (!best || area < best.area) best = { area, end: { kind: "magnet", magnet: id } };
    }
    for (const block of blocks.current) {
      const node = block.element, id = node?.dataset.cid;
      if (!node || !id) continue;
      const box = node.getBoundingClientRect();
      const insideBox = clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
      if (!insideBox) continue;
      const area = box.width * box.height;
      if (best && area >= best.area) continue;
      const anchor = anchorOf(block);
      best = { area, end: { kind: "element", element: id, anchor } };
    }
    return best?.end;
  }, []);

  // Circle = bubble on the enclosed words; underline = highlight; stroke between marks = connector.
  // A weak guess never silently rewrites the page: its chip offers "use gesture" first.
  const onInkStroke = useCallback((stroke: InkStroke, samples: readonly InkSample[]) => {
    if (!magicRef.current) return;
    const points = samples.map(sample => [sample.x, sample.y] as [number, number]);
    if (points.length < 3) return;
    const result = classifyGesture(points, { lines: lineRects(points) });
    if (result.kind === "none") return;
    const at = { x: points.at(-1)![0], y: points.at(-1)![1] };
    const low = result.confidence < 0.8;
    const chipKind = result.kind === "circle" ? "bubble" : result.kind === "underline" ? "highlight" : "connector";
    const startChip = (make: () => { apply: () => void; revert: () => void }) => {
      const actions = make();
      if (low) setChip({ kind: chipKind, low: true, at, apply: actions.apply, revert: () => {} });
      else { actions.apply(); setChip({ kind: chipKind, low: false, at, revert: actions.revert }); }
    };
    if (result.kind === "underline") {
      startChip(() => {
        const apply = () => inkApi.current?.setFields(stroke.id, {
          tool: "highlighter", size: inkWidths.highlighter[0], color: inkColors.highlighter[0] });
        const revert = () => inkApi.current?.setFields(stroke.id, { tool: stroke.tool, size: stroke.size, color: stroke.color });
        return { apply, revert };
      });
      return;
    }
    if (result.kind === "circle") {
      const center = centroid(points);
      const block = nearestBlock(blocks.current, center);
      const id = block?.element?.dataset.cid;
      const quote = enclosedText(points);
      // A circle around nothing keeps its ink: a stray loop must not open an empty bubble.
      if (!block || !id || !quote) return;
      startChip(() => ({
        apply: () => window.dispatchEvent(new CustomEvent("omarkie:comment-request", { detail: { id, line: block.line, quote } })),
        revert: () => window.dispatchEvent(new CustomEvent("omarkie:comment-cancel")),
      }));
      return;
    }
    if (result.kind === "arrow") {
      const from = arrowEndAt(points[0][0], points[0][1]);
      const to = arrowEndAt(at.x, at.y);
      if (!from || !to || arrowEndKey(from) === arrowEndKey(to)) return;
      startChip(() => {
        let arrow: string | undefined;
        return {
          apply: () => { arrow = createArrow(from, to); inkApi.current?.remove(stroke.id); },
          revert: () => { if (arrow) removeMark(arrow); inkApi.current?.restore(stroke); },
        };
      });
    }
  }, [arrowEndAt, createArrow, enclosedText, lineRects, removeMark]);

  // Alt+? asks about the paragraph under the pointer; the page supplies the anchor, no HWR.
  const askHere = useCallback((point?: { x: number; y: number }) => {
    const surface = layer.current;
    if (!surface) return;
    const frame = surface.getBoundingClientRect();
    const at = point ?? { x: frame.left + Math.min(frame.width / 2, 320), y: frame.top + 160 };
    const block = nearestBlock(blocks.current, at);
    const id = block?.element?.dataset.cid;
    if (!block || !id) { setNotice("Point at the page, then Alt+? or Ask here."); return; }
    window.dispatchEvent(new CustomEvent("omarkie:comment-request", { detail: { id, line: block.line } }));
  }, []);

  const pageElements = useCallback(() => {
    const text = editor()?.readingContext()?.text;
    if (text === undefined) return elements.current.list;
    if (elements.current.text !== text) elements.current = { text, list: markdownElements(text) };
    return elements.current.list;
  }, [editor]);

  const openXray = useCallback((id: string) => {
    const sticky = magnets.find(item => item.id === id);
    const sticker = stickers.find(item => item.id === id);
    const card = cards.find(item => item.id === id);
    const image = images.find(item => item.id === id);
    const arrow = arrows.find(item => item.id === id);
    if (!sticky && !sticker && !card && !image && !arrow) return;
    const marks = [...magnets, ...stickers, ...cards, ...images];
    const from = arrow?.from;
    let anchor: GlassAnchor | undefined;
    if (from?.kind === "element") anchor = from.anchor;
    else if (from?.kind === "magnet") anchor = marks.find(item => item.id === from.magnet)?.anchor;
    else if (!arrow) anchor = (sticky ?? sticker ?? card ?? image)?.anchor;
    if (!anchor) { setNotice("That mark has no page anchor to inspect."); return; }
    const context = editor()?.readingContext();
    if (!context) { setNotice("Open a note to inspect what an agent sees."); return; }
    const list = pageElements();
    const line = matchIndexed(index.current, anchor) ?? anchor.landmarks.find(landmark => landmark.kind === "block")?.line;
    const element = (line !== undefined ? list.find(item => item.blockLine === line || item.line === line) : undefined) ?? list[0];
    if (!element) { setNotice("The page has no readable element there."); return; }
    const text = sticky ? sticky.text : arrow ? arrow.label || "Connector"
      : card ? card.question || card.title || "Card" : sticker ? stickerName(sticker) : image ? image.name : "Glass mark";
    const bundle = bubbleBundle(list, element, { note: note ?? "", quote: element.markdown ?? element.text });
    const payload = bundle ? bubblePayload(bundle, text) : undefined;
    if (!bundle || !payload) { setNotice("That mark's paragraph is gone."); return; }
    setXray({ id, label: text, kind: element.kind, bundle, payload, flags: findIdentifiers(payloadText(payload), { limit: Infinity }) });
  }, [arrows, cards, editor, images, magnets, note, pageElements, stickers]);

  const ocrPick = useCallback(async (pick: InkPick) => {
    const png = inkApi.current?.pngOf(pick.stroke.id);
    if (!png) { setNotice("That stroke is not on screen to read."); return; }
    try {
      const reply = await window.desktop?.glassOcr?.({ png });
      const failed = reply && "ok" in reply && reply.ok === false;
      if (failed) throw new Error(reply.error || "The OCR hook failed.");
      const text = reply && "value" in reply ? reply.value?.text : undefined;
      if (!text) throw new Error("The OCR hook found no text in that ink.");
      const point = { x: pick.rect.x + pick.rect.width / 2, y: pick.rect.y + pick.rect.height / 2 };
      const block = nearestBlock(blocks.current, point) ?? blocks.current[0];
      if (!block) return;
      const offset = offsetIn(block, point);
      const note: StickyNote = { id: newStickyId(), text, color: stickyColors[0], anchor: anchorOf(block),
        x: offset.x, y: offset.y, w: 264, h: 168, folded: false };
      setMagnets(current => [...current, note]);
      setSelected(note.id); setEditing(note.id);
      await send({ action: "add", magnet: note.id, fields: stickyFields(note) });
      setNotice("Read the ink into a sticky note.");
      setOcrMode(false);
    } catch (error) { setNotice(message(error)); }
  }, [send]);

  useEffect(() => {
    let live = true;
    const check = async () => {
      try {
        const reply = await window.desktop?.ocrAvailable?.();
        if (!live || !reply) return;
        const value = "value" in reply ? reply.value : reply;
        setOcrReady(!!value?.available);
      } catch { /* no hook means no button */ }
    };
    void check();
    return () => { live = false; };
  }, []);

  // Time scrub: the journal's HLC order replayed as glass states, read-only until "return to now".
  const replayScrub = useCallback(async (points: ScrubView["points"], index: number) => {
    if (!latest.current.note) return;
    const point = points[Math.max(0, Math.min(points.length - 1, index))];
    const value = await glassCall({ note: latest.current.note, action: "scrub", at: point.at });
    const counts = applyMagnets(value.magnets ?? []);
    setScrub({ points, index, at: point.at, marks: counts.marks, bubbles: counts.bubbles });
  }, [applyMagnets]);

  const openScrub = useCallback(async () => {
    if (!latest.current.note) return;
    try {
      const value = await glassCall({ note: latest.current.note, action: "timeline" });
      const points = Array.isArray(value.points) ? value.points as ScrubView["points"] : [];
      if (!points.length) { setNotice("No glass history to replay yet."); return; }
      setSelected(undefined); setSelectedArrow(undefined); setEditing(undefined); setChip(null); setTool("select");
      await replayScrub(points, points.length - 1);
    } catch (error) { setNotice(message(error)); }
  }, [replayScrub]);

  const scrubTo = useCallback((index: number) => {
    const current = scrubRef.current;
    if (!current) return;
    if (scrubFrame.current) cancelAnimationFrame(scrubFrame.current);
    scrubFrame.current = requestAnimationFrame(() => {
      scrubFrame.current = 0;
      void replayScrub(current.points, index);
    });
  }, [replayScrub]);

  const returnToNow = useCallback(() => {
    if (scrubFrame.current) cancelAnimationFrame(scrubFrame.current);
    scrubFrame.current = 0;
    setScrub(null); scrubRef.current = null;
    setSelected(undefined); setSelectedArrow(undefined); setEditing(undefined);
    void load();
  }, [load]);

  useEffect(() => () => { if (scrubFrame.current) cancelAnimationFrame(scrubFrame.current); }, []);

  useEffect(() => {
    if (!playing || !scrub) return;
    if (scrub.index >= scrub.points.length - 1) { setPlaying(false); return; }
    const timer = setTimeout(() => scrubTo(scrub.index + 1), 450);
    return () => clearTimeout(timer);
  }, [playing, scrub, scrubTo]);

  useEffect(() => { try { localStorage.setItem(glassMagicKey, magic ? "on" : "off"); } catch { /* private mode */ } }, [magic]);

  useEffect(() => {
    if (tool === "select") return;
    setLensOn(false); setLens(null);
  }, [tool]);

  // Hold Alt: a clear circle follows the pointer and hides the glass inside it. Alt while
  // dragging still means "no snap", so the lens waits for a free pointer.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key !== "Alt" || event.repeat || latest.current.tool !== "select" || dragging.current) return;
      const target = event.target instanceof Element ? event.target : null;
      setLensOn(true);
      if (pointer.current) setLens(pointer.current);
      // Alt in a text field may be an input chord (AltGr); peek without swallowing it.
      if (target?.closest("input, textarea, [contenteditable='true'], .cm-content")) return;
      event.preventDefault();
    };
    const up = (event: KeyboardEvent) => { if (event.key === "Alt") setLensOn(false); };
    const blur = () => setLensOn(false);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
    };
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      if (!lensOn || latest.current.tool !== "select" || dragging.current || lensFrame.current) return;
      lensFrame.current = requestAnimationFrame(() => {
        lensFrame.current = 0;
        setLens(pointer.current ?? null);
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    const onScroll = () => { if (lensOn) setLens(pointer.current ?? null); };
    scroller.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      scroller.removeEventListener("scroll", onScroll, true);
      if (lensFrame.current) cancelAnimationFrame(lensFrame.current);
    };
  }, [lensOn, scroller]);

  // Even-odd path cuts one transparent hole: the page shows through, no overlay copies it.
  useLayoutEffect(() => {
    const surface = layer.current;
    if (!surface) return;
    if (!lensOn || !lens || tool !== "select") {
      surface.style.removeProperty("clip-path");
      delete surface.dataset.glassLens;
      return;
    }
    const frame = surface.getBoundingClientRect();
    const x = lens.x - frame.left, y = lens.y - frame.top;
    const width = Math.max(scroller.clientWidth, frame.width, 1), height = Math.max(scroller.scrollHeight, frame.height, 1);
    surface.style.clipPath = `path(evenodd, "M0 0H${width}V${height}H0Z M${x + lensRadius} ${y}A${lensRadius} ${lensRadius} 0 1 0 ${x - lensRadius} ${y}A${lensRadius} ${lensRadius} 0 1 0 ${x + lensRadius} ${y}Z")`;
    surface.dataset.glassLens = "on";
  }, [lens, lensOn, scroller, tool]);

  // Alt+? anywhere on the page asks about that spot; the pencil-case button asks at the pointer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.defaultPrevented) return;
      const question = event.key === "?" || (event.code === "Slash" && event.shiftKey);
      if (!question) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea")) return;
      event.preventDefault();
      askHere(pointer.current);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [askHere]);

  // Leaving the page (or a note switch) never leaves a stale magic chip or a scrubbed view.
  useEffect(() => {
    if (!note) { setChip(null); setScrub(null); }
  }, [note]);

  const restore = useCallback(async (magnet: GlassMagnet) => {
    const value = await send({ action: "restore", magnet: magnet.id });
    if (!value?.magnet) return;
    const restored = value.magnet;
    if (restored.kind === "sticky") {
      const note = stickyFromMagnet(restored);
      if (note) setMagnets(current => [...current, note]);
    } else if (restored.kind === "image") {
      const picture = imageFromMagnet(restored);
      if (picture) setImages(current => [...current, picture]);
    } else if (restored.kind === "sticker") {
      const mark = stickerFromMagnet(restored);
      if (mark) setStickers(current => [...current, mark]);
    } else if (restored.kind === "arrow") {
      const arrow = arrowFromMagnet(restored);
      if (arrow) setArrows(current => [...current, arrow]);
    } else if (restored.kind === "card") {
      const card = cardFromMagnet(restored);
      if (card) setCards(current => [...current, card]);
    } else if (restored.kind === "timeline") {
      const timeline = timelineFromMagnet(restored);
      if (timeline) setTimelines(current => [...current, timeline]);
    } else if (restored.kind === "timestamp") {
      const stamp = timestampFromMagnet(restored);
      if (stamp) setTimestamps(current => [...current, stamp]);
    } else if (restored.kind === "label") {
      const label = labelFromMagnet(restored);
      if (label) setLabels(current => [...current, label]);
    } else if (restored.kind === "trace") {
      const trace = traceFromMagnet(restored);
      if (trace) setTraces(current => [...current, trace]);
    } else if (restored.kind === "sheet-label") {
      const label = sheetLabelFromMagnet(restored);
      if (label) setSheetLabels(current => [...current, label]);
    } else if (restored.kind === "measure") {
      const measure = measureFromMagnet(restored);
      if (measure) setMeasures(current => [...current, measure]);
    } else if (restored.kind === "compare") {
      const compare = compareFromMagnet(restored);
      if (compare) setCompares(current => [...current, compare]);
    } else void load();
    setOpenTrash(false);
  }, [load, send]);

  // Merge down is the only path into the page: preview first, the user presses Accept, the page is reloaded.
  const openMerge = useCallback(async (magnet: string) => {
    if (!latest.current.note) return;
    if (!documentSaved) { setNotice("Save the note before merging down."); return; }
    setMergeBusy(true);
    try {
      const value = await glassCall({ note: latest.current.note, action: "merge-preview", magnet });
      if (value?.merge) { setMergeOpen(value.merge); setMergeStale(undefined); setUndoPending(undefined); }
    } catch (error) { setNotice(message(error)); }
    finally { setMergeBusy(false); }
  }, [documentSaved]);

  const acceptMerge = useCallback(async (preview: MergePreview) => {
    if (!latest.current.note) return;
    setMergeBusy(true);
    try {
      const value = await glassCall({ note: latest.current.note, action: "merge-accept", magnet: preview.magnet,
        expectedHash: preview.baseHash, approved: true });
      if (value?.stale && value.preview) { setMergeStale(value.preview); return; }
      if (!value?.merged) return;
      setMergeOpen(undefined);
      setMergeStale(undefined);
      setMergeDone(Array.isArray(value.history) ? value.history.find(entry => !entry.undone) : undefined);
      setMergeHistory(Array.isArray(value.history) ? value.history : []);
      await reloadNote?.();
      await load();
    } catch (error) { setNotice(message(error)); }
    finally { setMergeBusy(false); }
  }, [load, reloadNote]);

  const undoMerge = useCallback(async (id?: string) => {
    if (!latest.current.note) return;
    const key = id ?? "latest";
    const force = undoPending === key;
    try {
      const value = await glassCall({ note: latest.current.note, action: "merge-undo", ...(id ? { merge: id } : {}), ...(force ? { force: true } : {}) });
      if (value?.undoStale) {
        setUndoPending(key);
        setNotice("The note changed after the merge. Press Undo again to restore it anyway.");
        return;
      }
      if (!value?.undone) return;
      setNotice("Merge undone. The page is byte-identical to before.");
      setMergeDone(undefined);
      setUndoPending(undefined);
      setMergeHistory(Array.isArray(value.history) ? value.history : []);
      await reloadNote?.();
      await load();
    } catch (error) { setNotice(message(error)); }
  }, [load, reloadNote, undoPending]);

  const jumpToSource = useCallback((source: { line: number }) => {
    editor()?.jump(source.line);
  }, [editor]);

  const liftUp = useCallback(async (detail: { id?: string }) => {
    if (!latest.current.note || !detail.id) return;
    if (!documentSaved) { setNotice("Save the note before lifting an element."); return; }
    try {
      const value = await glassCall({ note: latest.current.note, action: "lift-up", element: detail.id });
      if (!value?.magnet) return;
      await load();
      setNotice("Lifted onto the glass. The page is unchanged.");
    } catch (error) { setNotice(message(error)); }
  }, [documentSaved, load]);

  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.action === "lift") void liftUp(detail);
      if (detail?.action === "change") {
        if (!documentSaved) { setNotice("Save the note before changing an element."); return; }
        setSwapTarget({ id: detail.id, kind: detail.kind, line: detail.line });
        setSwapOpen(value => value + 1);
      }
    };
    window.addEventListener("omarkie:element-action", onAction);
    return () => window.removeEventListener("omarkie:element-action", onAction);
  }, [documentSaved, liftUp]);

  useEffect(() => {
    if (!documentSaved && mergeOpen) {
      setMergeOpen(undefined);
      setMergeStale(undefined);
      setNotice("Save the note before merging down.");
    }
  }, [documentSaved, mergeOpen]);

  useEffect(() => {
    if (!mergeOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMergeOpen(undefined);
      setMergeStale(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mergeOpen]);

  useEffect(() => {
    if (!mergeDone) return;
    const timer = setTimeout(() => setMergeDone(undefined), 8_000);
    return () => clearTimeout(timer);
  }, [mergeDone]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      // An open dialog or a focused select owns the keyboard: no mark may appear behind an overlay,
      // and a select must keep its type-ahead. Escape still releases the selection.
      if (target?.closest("select")) return;
      if (event.key !== "Escape" && document.querySelector('[role="dialog"], dialog[open]')) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === "k" || event.key === "K")
        && !target?.closest("input, textarea, [contenteditable='true'], .cm-content")) {
        event.preventDefault();
        const view = editor()?.view();
        const line = view ? view.state.doc.lineAt(view.state.selection.main.head).number : -1;
        const block = blocks.current.find(item => item.line === line && item.element)
          ?? nearestBlock(blocks.current, { x: scroller.getBoundingClientRect().left + 120, y: scroller.getBoundingClientRect().top + 120 });
        const rect = block?.element?.getBoundingClientRect();
        if (rect) createSheet("clip", { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 24) });
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (target?.closest("input, textarea, [contenteditable='true'], .cm-content")) return;
      if (event.key === "n" || event.key === "N") { event.preventDefault(); createAtCenter(); }
      else if (event.key === "p" || event.key === "P") { event.preventDefault(); chooseInk("pen"); }
      else if (event.key === "h" || event.key === "H") { event.preventDefault(); chooseInk("highlighter"); }
      else if (event.key === "e" || event.key === "E") { event.preventDefault(); chooseInk("eraser"); }
      else if (event.key === "Escape") { setTool(current => current === "ink" ? "select" : current); setSelected(undefined); setSelectedArrow(undefined); setEditing(undefined); setOpenTrash(false); }
      else if ((event.key === "Delete" || event.key === "Backspace") && selectedArrow) { event.preventDefault(); removeMark(selectedArrow); }
      else if ((event.key === "Delete" || event.key === "Backspace") && selected && stickers.some(item => item.id === selected)) {
        event.preventDefault();
        removeMark(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chooseInk, createAtCenter, createSheet, editor, removeMark, scroller, selected, selectedArrow, stickers]);

  const keepPlacement = useCallback((id: string) => { setKept(current => new Set(current).add(id)); }, []);
  // Accepting writes the new landmark stack; the old one stays in the journal.
  const placeHere = useCallback((id: string, line: number | null) => {
    const block = line === null ? undefined : blocks.current.find(item => item.line === line);
    if (!block) { setNotice("That paragraph is not on screen; scroll to it first."); return; }
    const anchor = captureAnchor(block, blocks.current);
    setMagnets(current => current.map(item => item.id === id ? { ...item, anchor } : item));
    // The user decided; stop asking about this mark until the text changes under it again.
    setKept(current => new Set(current).add(id));
    void send({ action: "set", magnet: id, fields: { anchor } }).then(() => load());
  }, [load, send]);

  const checkRows = Object.entries(layout.checks).filter(([id]) => !kept.has(id))
    .sort(([a], [b]) => Number(layout.places[b]?.status === "resolved") - Number(layout.places[a]?.status === "resolved"));
  const orphans = [...magnets, ...images, ...stickers, ...cards].filter(mark => layout.places[mark.id]?.status === "orphan");
  // Only what the viewport can show is mounted; everything else stays one keyboard step away.
  const glassMounts = useMemo(() => {
    const items = [];
    for (const mark of [...magnets, ...images, ...stickers, ...cards, ...timelines]) {
      const place = layout.places[mark.id];
      if (place?.status === "resolved") items.push({ id: mark.id, y: place.y, height: Math.max(24, place.height) });
    }
    // Real notes run tens, not hundreds: mounting all of them keeps small scenes simple, and the
    // window only earns its keep past a hundred and fifty marks.
    if (items.length <= 150) return { mounted: new Set(items.map(item => item.id)), total: items.length, inView: items.length, culled: 0, forced: [] };
    const force = [selected, editing, focusedMagnet].filter((id): id is string => !!id);
    return glassWindow(items, { top: viewport.top, height: viewport.height }, { force });
  }, [magnets, images, stickers, cards, timelines, layout.places, selected, editing, focusedMagnet, viewport.top, viewport.height]);
  const offscreen = useMemo(() => [...magnets, ...images, ...stickers, ...cards, ...timelines]
    .filter(mark => layout.places[mark.id]?.status === "resolved" && !glassMounts.mounted.has(mark.id)), [magnets, images, stickers, cards, timelines, layout.places, glassMounts]);
  const plainMarkName = (mark: StickyNote | GlassImage | StickerMark | GlassCard | TimelineMark) =>
    "text" in mark ? (mark.text.trim() ? snippet(mark.text.trim()) : "Sticky note")
      : "name" in mark ? mark.name : "title" in mark ? mark.title || "Card" : stickerName(mark);
  const visible = magnets.filter(stickie => layout.places[stickie.id]?.status === "resolved" && glassMounts.mounted.has(stickie.id));
  const shown = images.filter(image => layout.places[image.id]?.status === "resolved" && glassMounts.mounted.has(image.id));
  const shownCards = cards.filter(card => layout.places[card.id]?.status === "resolved" && glassMounts.mounted.has(card.id));
  const under = shown.filter(image => image.wrap === "behind");
  const above = shown.filter(image => image.wrap !== "behind");
  const visibleStickers = stickers.filter(mark => layout.places[mark.id]?.status === "resolved");
  const orphanArrows = arrows.filter(arrow => layout.orphanArrows.includes(arrow.id));
  const statusLabel = !note ? "Save this note first" : saved === "saving" ? "Saving" : saved === "error" ? "Not saved" : saved === "saved" ? "Saved" : "Glass";

  useEffect(() => {
    if (!under.length) return;
    root.classList.add("glass-above");
    return () => root.classList.remove("glass-above");
  }, [under.length, root]);

  const frame = (image: GlassImage) => {
    const place = layout.places[image.id];
    if (place?.status !== "resolved") return null;
    const line = matchIndexed(index.current, image.anchor);
    const column = image.wrap === "behind" || image.wrap === "front" ? 0 : blocks.current.find(block => block.line === line)?.element?.clientWidth ?? 0;
    const maxWidth = column ? Math.max(imageDefaults.minW, Math.round(column * 0.6)) : undefined;
    return <GlassImageFrame key={image.id} image={image} place={place} selected={selected === image.id} note={note} scroller={scroller}
      paintHost={underHost} maxWidth={maxWidth} onSelect={() => { setSelected(image.id); setSelectedArrow(undefined); setEditing(undefined); }}
      onPatch={(patch, persist) => patchImage(image.id, patch, persist)}
      onDrop={drop => imageDrop(image, drop)}
      onSnap={(dx, dy, alt) => imageSnap(image, dx, dy, alt)}
      onSnapEnd={() => { snapCache.current = undefined; paintGuides([], 0); }}
      onSettle={settle}
      onLiveSize={(width, height) => liveImageSize(image.id, width, height)}
      onMerge={() => void openMerge(image.id)}
      {...(image.source ? { onJump: () => jumpToSource(image.source!) } : {})}
      visual={{
        sheets: image.sheets, activeSheet: image.activeSheet,
        traces: traces.filter(trace => trace.image === image.id), labels: sheetLabels.filter(label => label.image === image.id),
        measures: measures.filter(measure => measure.image === image.id), scale: image.scale,
        sheetsOpen: !!sheetsOpen[image.id], tracing: tool === "trace", traceTool, traceColor, traceSize, labelMode, labelText,
        measuring: tool === "measure" ? measureMode ?? null : null,
        onActiveSheet: id => patchImage(image.id, { activeSheet: id }, true),
        onTrace: fields => addTrace(fields), onLabel: fields => addSheetLabel(fields),
        onMeasure: (type, points) => addMeasure(image.id, type, points),
        onCalibration: line => setCalibration({ image: image.id, line, frame: [place.width, place.height] }),
        onDraw: () => { setTool("trace"); setMeasureMode(undefined); setSelected(image.id); },
        onRemoveSheet: sheetId => {
          for (const mark of [...traces, ...sheetLabels]) if (mark.image === image.id && mark.sheet === sheetId) removeMark(mark.id);
        },
        onToggleSheets: () => setSheetsOpen(previous => ({ ...previous, [image.id]: !previous[image.id] })),
        onSheetsOpen: open => setSheetsOpen(previous => ({ ...previous, [image.id]: open })),
      }}
      onDelete={() => removeMark(image.id)} />;
  };

  const marksPalette = tool === "sticker" ? <div className="glass-palette" role="group" aria-label="Stickers" data-glass-palette="sticker">
    <p className="glass-palette-title">Stickers</p>
    <div className="glass-palette-row">
      {stickerIds.map(id => <button type="button" key={id} data-sticker={id} aria-pressed={stickerChoice === id}
        aria-label={stickerName({ sticker: id })} title={stickerName({ sticker: id })}
        onClick={() => { setStickerChoice(id); setCustomImage(undefined); }}>
        <StickerArt id={id} label={stickerName({ sticker: id })} />
      </button>)}
    </div>
    <div className="glass-palette-row">
      <button type="button" className="glass-palette-custom" data-sticker-custom aria-pressed={stickerChoice === "custom"}
        onClick={() => fileInput.current?.click()}>Custom image…</button>
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden data-sticker-file onChange={pickSticker} />
      {customImage && <span className="glass-palette-hint">Custom sticker ready</span>}
    </div>
    <p className="glass-palette-hint">Pick a sticker, then click a paragraph.</p>
  </div> : tool === "arrow" ? <div className="glass-palette" role="group" aria-label="Arrows" data-glass-palette="arrow">
    <p className="glass-palette-title">Arrows</p>
    <div className="glass-palette-row">
      <button type="button" data-arrow-style="straight" aria-pressed={arrowStyle === "straight"} aria-label="Straight arrow" title="Straight"
        onClick={() => setArrowStyle("straight")}>╱</button>
      <button type="button" data-arrow-style="curved" aria-pressed={arrowStyle === "curved"} aria-label="Curved arrow" title="Curved"
        onClick={() => setArrowStyle("curved")}>⌒</button>
      <span className="glass-tray-rule" aria-hidden="true" />
      {(["ink", "red", "blue", "green"] as const).map(colour => <button type="button" key={colour} data-arrow-pick-colour={colour}
        aria-pressed={arrowColor === colour} aria-label={`${colour} arrow`} title={colour} className="glass-arrow-swatch"
        style={{ color: colour === "red" ? "#cf3b32" : colour === "blue" ? "#2f6fb5" : colour === "green" ? "#2f9e5f" : "var(--ink, #333)" }}
        onClick={() => setArrowColor(colour)}>●</button>)}
      <span className="glass-tray-rule" aria-hidden="true" />
      {(["solid", "open", "none"] as const).map(shape => <button type="button" key={shape} data-arrow-pick-head={shape}
        aria-pressed={arrowHead === shape} aria-label={`${shape} head`} title={shape} onClick={() => setArrowHead(shape)}>
        {shape === "solid" ? "▸" : shape === "open" ? "›" : "—"}</button>)}
    </div>
    <p className="glass-palette-hint">Drag from a paragraph or sticker to another; the far end scrolls into view.</p>
  </div> : tool === "grid" ? <div className="glass-palette" role="group" aria-label="Grid" data-glass-palette="grid">
    <p className="glass-palette-title">Grid</p>
    <div className="glass-palette-row">
      <button type="button" data-grid-size="off" aria-pressed={!grid.on} onClick={() => setGrid(current => ({ ...current, on: false }))}>Off</button>
      {snapDefaults.sizes.map(size => <button type="button" key={size} data-grid-size={size} aria-pressed={grid.on && grid.size === size}
        aria-label={`Grid ${size}`} onClick={() => setGrid({ on: true, size })}>{size}</button>)}
    </div>
    <p className="glass-palette-hint">Magnets line up with the grid, each other and the text column. Hold Alt to move free.</p>
  </div> : null;
  const cardPoint = () => {
    const surface = scroller.getBoundingClientRect();
    const view = editor()?.view();
    const line = view ? view.state.doc.lineAt(view.state.selection.main.head).number : -1;
    const block = blocks.current.find(item => item.line === line && item.element)
      ?? nearestBlock(blocks.current, { x: surface.left + 160, y: surface.top + 140 });
    const rect = block?.element?.getBoundingClientRect();
    return rect ? { x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + 4 } : { x: surface.left + 160, y: surface.top + 140 };
  };

  // The hook decides whether voice exists at all; without OMARKIE_STT the buttons never appear.
  useEffect(() => {
    let live = true;
    void voiceInfo().then(info => {
      if (live) setVoice({ configured: info.configured, valid: info.valid, key: info.key, language: info.language });
    });
    return () => { live = false; };
  }, []);

  useEffect(() => () => {
    clearVoiceTimers();
    recorder.current?.cancel();
    recorder.current = undefined;
    lecture.current?.recorder.cancel();
    lecture.current = undefined;
    runRef.current = undefined;
  }, []);

  // Hold the configured key to talk; a quick tap keeps recording until the next tap.
  useEffect(() => {
    if (!voice.configured) return;
    let downAt = 0, holding = false;
    const down = (event: KeyboardEvent) => {
      if (!voiceKeyMatches(event, voice.key) || event.repeat || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (runRef.current) { void finishVoice(); return; }
      downAt = Date.now();
      holding = true;
      void beginVoice("dictation", cardPoint());
    };
    const up = (event: KeyboardEvent) => {
      if (!voiceKeyMatches(event, voice.key) || !holding) return;
      event.preventDefault();
      holding = false;
      if (Date.now() - downAt >= 250) void finishVoice();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !runRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancelVoice();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [voice.configured, voice.key, voice.language]);

  const createBoard = useCallback(async () => {
    if (!latest.current.note) { setNotice("Save this note first."); return; }
    if (lockedLayer("board")) { setNotice("The Media layer is locked."); return; }
    const point = cardPoint();
    const block = nearestBlock(blocks.current, point);
    const id = `b${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const request: Record<string, unknown> = { action: "board", mode: "add", magnet: id, name: "Board" };
    if (block) {
      const offset = offsetIn(block, point);
      request.anchor = anchorOf(block);
      request.x = offset.x + 12;
      request.y = offset.y + 12;
      request.w = 280;
      request.h = 190;
    }
    const value = await send(request);
    if (!value) return;
    const asset = (value as { asset?: unknown }).asset;
    const board = { id, name: "Board", asset: typeof asset === "string" ? asset : "" };
    setBoards(current => [...current, board]);
    setBoardPicker(false);
    setBoardOpen({ id, name: board.name });
  }, [send]);

  // The bottom panels sit above the pencil case. The case wraps to a second row on narrow windows,
  // so its height is published for CSS instead of guessing the one-row 38 px.
  const trayObserver = useRef<ResizeObserver | null>(null);
  const measureTray = useCallback((element: HTMLDivElement | null) => {
    trayObserver.current?.disconnect();
    trayObserver.current = null;
    if (!element) { document.documentElement.style.removeProperty("--glass-tray-height"); return; }
    const publish = () => document.documentElement.style.setProperty("--glass-tray-height", `${Math.round(element.getBoundingClientRect().height)}px`);
    publish();
    trayObserver.current = new ResizeObserver(publish);
    trayObserver.current.observe(element);
  }, []);
  useEffect(() => () => {
    trayObserver.current?.disconnect();
    trayObserver.current = null;
    document.documentElement.style.removeProperty("--glass-tray-height");
  }, []);

  const tray = <div className="glass-tray" ref={measureTray} role="toolbar" aria-label="Pencil case" data-glass-tray>
    <button type="button" data-glass-tool="select" aria-pressed={tool === "select"} aria-label="Select" title="Select, move, resize" onClick={() => setTool("select")}><MousePointer2 size={15} /></button>
    <button type="button" data-glass-tool="timeline" aria-label="Timeline" title="Timeline: pin audio or video, link the transcript"
      onClick={() => void createTimeline()}><AudioLines size={15} /></button>
    <button type="button" data-glass-tool="sticky" aria-pressed={tool === "sticky"} aria-label="Sticky note" title="Sticky note (N)" onClick={() => setTool("sticky")}><StickyIcon size={15} /></button>
    <button type="button" data-glass-tool="image" aria-label="Image" title="Image: drop, paste or choose a file" onClick={() => picker.current?.click()}><ImageIcon size={15} /></button>
    {boardEnabled && <button type="button" data-glass-board aria-label="Boards" title="Boards: optional Excalidraw diagrams"
      onClick={() => boards.length ? setBoardPicker(true) : void createBoard()}><LayoutGrid size={15} />{boards.length > 0 && <span className="glass-tray-count">{boards.length}</span>}</button>}
    <button type="button" data-glass-tool="label" aria-pressed={tool === "label"} aria-label="Label" title="Label: pin a name on a picture" onClick={() => setTool("label")}><Tag size={15} /></button>
    {voice.configured && <>
      <button type="button" data-glass-tool="voice" aria-pressed={tool === "voice"} aria-label="Voice to sticky" title={`Voice: hold ${voice.key}, or click a paragraph`} onClick={() => setTool("voice")}><Mic size={15} /></button>
      <button type="button" data-glass-tool="memo" aria-pressed={tool === "memo"} aria-label="Voice memo" title="Voice memo: audio plus transcript on the Media layer" onClick={() => setTool("memo")}><AudioLines size={15} /></button>
      <button type="button" data-glass-tool="lecture" aria-pressed={tool === "lecture"} aria-label="Lecture recording" title="Lecture: transcribe a long session, save it as a new note" onClick={() => setTool("lecture")}><FileAudio size={15} /></button>
    </>}
    <input ref={picker} type="file" accept="image/*,.heic,.heif,.tif,.tiff" multiple hidden data-glass-file
      onChange={event => {
        const files = [...(event.target.files ?? [])];
        event.target.value = "";
        const surface = layer.current?.getBoundingClientRect();
        if (files.length) void addImages(files, { x: (surface?.left ?? 0) + 120, y: (surface?.top ?? 0) + 160 });
      }} />
    <span className="glass-tray-rule" aria-hidden="true" />
    <button type="button" data-glass-tool="ink" aria-pressed={tool === "ink" && inkTool !== "eraser"} aria-label="Pen" title="Pen (P)" onClick={() => chooseInk("pen")}><PenLine size={15} /></button>
    <button type="button" data-glass-tool="highlighter" aria-pressed={tool === "ink" && inkTool === "highlighter"} aria-label="Highlighter" title="Highlighter (H)" onClick={() => chooseInk("highlighter")}><Highlighter size={15} /></button>
    <button type="button" data-glass-tool="eraser" aria-pressed={tool === "ink" && inkTool === "eraser"} aria-label="Eraser" title="Eraser (E)" onClick={() => chooseInk("eraser")}><Eraser size={15} /></button>
    <button type="button" data-glass-tool="sticker" aria-pressed={tool === "sticker"} aria-label="Sticker" title="Stickers" onClick={() => setTool("sticker")}><Star size={15} /></button>
    <button type="button" data-glass-tool="arrow" aria-pressed={tool === "arrow"} aria-label="Arrow" title="Arrow between two things" onClick={() => setTool("arrow")}><ArrowUpRight size={15} /></button>
    <span className="glass-tray-rule" aria-hidden="true" />
    <button type="button" data-glass-tool="clip" aria-pressed={tool === "clip"} aria-label="Paper clip" title="Paper clip: a mini-page pinned to a paragraph (⌘⇧K)" onClick={() => setTool("clip")}><Paperclip size={15} /></button>
    <button type="button" data-glass-tool="extra-page" aria-pressed={tool === "extra-page"} aria-label="Extra page" title="Extra page: a blank sheet beside a paragraph" onClick={() => setTool("extra-page")}><FileText size={15} /></button>
    <button type="button" data-glass-tool="cutout" aria-pressed={tool === "cutout"} aria-label="Scissors" title="Scissors: cut a rectangle or lasso from the page" onClick={() => setTool("cutout")}><Scissors size={15} /></button>
    <button type="button" data-glass-tool="trace" aria-pressed={tool === "trace"} aria-label="Tracing sheet" title="Tracing sheets: draw over a picture"
      onClick={() => { setTool("trace"); setMeasureMode(undefined); setTraceColor(inkDefaults(traceTool).color); setTraceSize(inkDefaults(traceTool).size); }}><Pencil size={15} /></button>
    <button type="button" data-glass-tool="measure" aria-pressed={tool === "measure"} aria-label="Ruler and angle" title="Measure: set scale, then line or angle"
      onClick={() => setTool("measure")}><Ruler size={15} /></button>
    <button type="button" data-glass-compare aria-haspopup="dialog" aria-expanded={compareOpen} aria-label="Compare images" title="Compare two images"
      onClick={() => setCompareOpen(true)}><Columns2 size={15} /></button>
    <button type="button" data-glass-grid aria-pressed={grid.on} aria-expanded={tool === "grid"} aria-label="Grid" title="Grid: line magnets up with the paper" onClick={() => setTool(current => current === "grid" ? "select" : "grid")}><Grid3x3 size={15} /></button>
    <span className="glass-tray-rule" aria-hidden="true" />
    <button type="button" data-glass-magic aria-pressed={magic} aria-label="Smart ink" title="Smart ink: circle words, underline, draw an arrow"
      onClick={() => { const next = !magic; setMagic(next); if (!next) setChip(null); setNotice(next ? "Smart ink on: circles, underlines and arrows become glass." : "Smart ink off: every stroke stays ink."); }}><Wand2 size={15} /></button>
    <button type="button" data-glass-ask aria-label="Ask here" title="Ask here (Alt+?)"
      onClick={() => askHere(pointer.current)}><MessageSquarePlus size={15} /></button>
    {ocrReady && <button type="button" data-glass-ocr aria-pressed={ocrMode} aria-label="Read ink" title="Read a drawn stroke with the OCR hook"
      onClick={() => { setOcrMode(current => !current); setTool("select"); setChip(null); setNotice(ocrMode ? "Ink reading off." : "Click an ink stroke to read it."); }}><ScanText size={15} /></button>}
    <button type="button" data-glass-scrub-open aria-label="Time scrub" title="Time scrub: replay how the glass grew"
      onClick={() => void openScrub()}><History size={15} /></button>
    <span className="glass-tray-rule" aria-hidden="true" />
    <button type="button" data-glass-tool="card" aria-haspopup="dialog" aria-label="Card" title="Card: section, tutor answer or quiz"
      onClick={() => setCardOpen(true)}><SquareStack size={15} /></button>
    <button type="button" data-labels-hide aria-pressed={study.labelsHidden} aria-label={study.labelsHidden ? "Show labels" : "Hide labels"}
      title={study.labelsHidden ? "Show labels" : "Hide labels: quiz yourself on the pinned names"}
      onClick={() => setStudyMode({ labelsHidden: !study.labelsHidden })}>{study.labelsHidden ? <Eye size={15} /> : <EyeOff size={15} />}</button>
    <button type="button" data-exam-toggle aria-pressed={study.exam} aria-label="Exam mode" title="Exam mode: fold every bubble, card and label to a cue"
      onClick={() => {
        if (latest.current.study.exam) { setStudyMode({ exam: false }); setExamOpen(false); setRevealed(new Set()); return; }
        setStudyMode({ exam: true }); setExamIndex(0); setRevealed(new Set()); setExamOpen(true);
      }}><GraduationCap size={15} /></button>
    <span className="glass-tray-rule" aria-hidden="true" />
    <button type="button" data-ink-undo aria-label="Undo ink" title="Undo ink" disabled={!inkHistory.undo}
      onClick={() => inkApi.current?.undo()}><Undo2 size={15} /></button>
    <button type="button" data-ink-redo aria-label="Redo ink" title="Redo ink" disabled={!inkHistory.redo}
      onClick={() => inkApi.current?.redo()}><Redo2 size={15} /></button>
    <span className="glass-tray-rule" aria-hidden="true" />
    {ink.length > 0 && <button type="button" data-glass-merge-ink aria-label="Merge ink down" title="Merge the newest ink stroke into the page"
      onClick={() => void openMerge(ink[ink.length - 1].id)}>⇩</button>}
    {mergeHistory.some(entry => !entry.undone) && <button type="button" data-glass-merge-undo aria-label="Undo last merge" title="Undo the last merge down"
      onClick={() => void undoMerge()}>↺</button>}
    <span className="glass-tray-rule" aria-hidden="true" />
    <button type="button" data-glass-trash aria-expanded={openTrash} aria-haspopup="dialog" aria-label={`Glass trash, ${trash.length}`}
      title="Glass trash" onClick={() => setOpenTrash(open => !open)}><Trash2 size={15} /><span className="glass-tray-count" data-glass-trash-count>{trash.length}</span></button>
    <span className="glass-tray-status" data-glass-saved={saved} role="status">{statusLabel}</span>
  </div>;
  const inkPalette = tool === "ink" ? <div className="glass-palette" role="group" aria-label="Ink colours and widths" data-ink-palette>
    {inkTool === "eraser" ? <>
      <button type="button" data-ink-eraser="bite" aria-pressed={eraserMode === "bite"} title="Rub out part of a stroke" onClick={() => setEraserMode("bite")}>Bite</button>
      <button type="button" data-ink-eraser="stroke" aria-pressed={eraserMode === "stroke"} title="Rub out whole strokes" onClick={() => setEraserMode("stroke")}>Whole stroke</button>
    </> : <>
      {inkColors[inkTool].map(colour => <button type="button" key={colour} className="glass-palette-colour" data-ink-colour={colour}
        aria-label={`Ink ${colour}`} aria-pressed={inkColor === colour} style={{ background: colour }} onClick={() => setInkColor(colour)} />)}
      {inkTool === "pen" && <span className="glass-tray-rule" aria-hidden="true" />}
      {inkTool === "pen" && inkWidths.pen.map(width => <button type="button" key={width} data-ink-width={width}
        aria-label={`Pen width ${width}`} aria-pressed={inkSize === width} onClick={() => setInkSize(width)}>
        <span className="glass-palette-tip" style={{ height: `${width}px` }} />
      </button>)}
    </>}
  </div> : null;
  const cutoutPalette = tool === "cutout" ? <div className="glass-palette" role="group" aria-label="Cut shape" data-glass-palette="cutout">
    <p className="glass-palette-title">Scissors</p>
    <div className="glass-palette-row">
      <button type="button" data-cutout-mode="rect" aria-pressed={cutMode === "rect"} onClick={() => setCutMode("rect")}>Rectangle</button>
      <button type="button" data-cutout-mode="lasso" aria-pressed={cutMode === "lasso"} onClick={() => setCutMode("lasso")}>Lasso</button>
    </div>
    <p className="glass-palette-hint">Drag over a paragraph or picture. Images keep a lossless crop; Esc cancels tool.</p>
    <button type="button" data-cutout-cancel onClick={() => setTool("select")}>Done</button>
  </div> : null;
  const pagePalette = tool === "extra-page" ? <div className="glass-palette" role="group" aria-label="Extra page paper" data-glass-palette="extra-page">
    <p className="glass-palette-title">Extra page</p>
    <div className="glass-palette-row">
      {extraPagePapers.map(paper => <button type="button" key={paper} data-page-paper={paper}
        aria-pressed={pagePaper === paper} onClick={() => setPagePaper(paper)}>{paper[0]!.toUpperCase() + paper.slice(1)}</button>)}
    </div>
    <p className="glass-palette-hint">Pick paper, then click a paragraph. The sheet never pushes text.</p>
  </div> : null;
  const visualPalette = tool === "trace" ? <div className="glass-palette" role="group" aria-label="Tracing sheet pen" data-glass-palette="trace">
    <p className="glass-palette-title">Tracing sheet</p>
    <div className="glass-palette-row">
      {(["pen", "highlighter"] as const).map(kind => <button type="button" key={kind} data-trace-tool={kind} aria-pressed={traceTool === kind}
        aria-label={kind === "pen" ? "Tracing pen" : "Tracing highlighter"} title={kind === "pen" ? "Pen" : "Highlighter"}
        onClick={() => { setTraceTool(kind); setTraceColor(inkDefaults(kind).color); setTraceSize(inkDefaults(kind).size); }}>{kind === "pen" ? "Pen" : "Highlighter"}</button>)}
      <span className="glass-tray-rule" aria-hidden="true" />
      <button type="button" data-trace-label-mode aria-pressed={labelMode} title="Click the picture to pin a label"
        onClick={() => setLabelMode(current => !current)}>Label</button>
      <input className="glass-label-input" data-trace-label-text aria-label="Sheet label text" value={labelText} maxLength={200}
        onChange={event => setLabelText(event.target.value)} />
    </div>
    <div className="glass-palette-row">
      {inkColors[traceTool].map(colour => <button type="button" key={colour} className="glass-palette-colour" data-trace-colour={colour}
        aria-label={`Tracing ink ${colour}`} aria-pressed={traceColor === colour} style={{ background: colour }} onClick={() => setTraceColor(colour)} />)}
      {inkWidths.pen.map(width => <button type="button" key={width} data-trace-width={width} aria-label={`Tracing width ${width}`}
        aria-pressed={traceSize === width} onClick={() => setTraceSize(width)}><span className="glass-palette-tip" style={{ height: `${width}px` }} /></button>)}
    </div>
    <p className="glass-palette-hint">Open the picture's sheets, pick Muscles, Nerves or Vessels, then draw. Each sheet flips on its own.</p>
  </div> : tool === "measure" ? <div className="glass-palette" role="group" aria-label="Ruler and angle" data-glass-palette="measure">
    <p className="glass-palette-title">Measure</p>
    <div className="glass-palette-row">
      <button type="button" data-measure-mode="scale" aria-pressed={measureMode === "scale"} title="Draw a known length and type its real value"
        onClick={() => setMeasureMode("scale")}>Set scale</button>
      <button type="button" data-measure-mode="line" aria-pressed={measureMode === "line"} onClick={() => setMeasureMode("line")}>Line</button>
      <button type="button" data-measure-mode="angle" aria-pressed={measureMode === "angle"} onClick={() => setMeasureMode("angle")}>Angle</button>
    </div>
    <p className="glass-palette-hint">Set the scale once per picture, then measure. Units are never converted behind your back.</p>
  </div> : null;
  const voicePalette = (tool === "voice" || tool === "memo" || tool === "lecture") ? <div className="glass-palette glass-palette-voice" data-voice-palette={tool} role="group" aria-label="Voice">
    <strong>{tool === "memo" ? "Voice memo" : tool === "lecture" ? "Lecture" : "Voice to note"}</strong>
    <p className="glass-palette-hint">{tool === "memo"
      ? "Click a paragraph: audio stays on this machine in .omarkie/assets, its transcript is searchable."
      : tool === "lecture"
        ? "Start once. Every pause closes a sentence that is transcribed locally; Save writes one note with its audio and the marked moments."
        : `Click a paragraph, or hold ${voice.key}. A quick tap keeps recording until the next tap.`}</p>
    <p className="glass-palette-hint" data-voice-language>Language: {voice.language === "auto" ? "auto (ES/EN)" : voice.language}</p>
    {!voice.valid && <p className="glass-palette-hint" role="alert">OMARKIE_STT is not readable. Check the setting value.</p>}
  </div> : null;
  const voicePill = run ? <div className="voice-pill" data-voice-pill={run.phase} data-voice-mode={run.mode} role="status">
    <Mic size={13} aria-hidden="true" />
    <span className="voice-pill-state">{run.phase === "recording" ? run.mode === "memo" ? "Memo" : run.mode === "lecture" ? "Lecture" : "Dictation" : run.phase === "saving" ? "Saving" : "Transcribing"}</span>
    {run.phase === "recording" && <time data-voice-clock>{timestampLabel(lecture.current?.recorder.durationMs ?? Date.now() - run.startedAt)}</time>}
    {run.mode === "lecture" && run.pending > 0 && <span className="voice-pill-pending" data-voice-pending={run.pending}
      title="Sentences still being transcribed">{run.pending}</span>}
    {run.mode === "lecture" && run.phase === "recording" && <button type="button" data-voice-mark onClick={markMoment}>Mark{run.marks.length ? ` (${run.marks.length})` : ""}</button>}
    {run.phase === "recording" && <button type="button" data-voice-stop={run.mode === "lecture" ? "save" : "stop"}
      onClick={() => void (run.mode === "lecture" ? saveLecture() : finishVoice())}>{run.mode === "lecture" ? "Save" : "Stop"}</button>}
    <button type="button" data-voice-cancel onClick={cancelVoice}>Cancel</button>
  </div> : null;
  const panel = <>{tray}{voicePalette}{voicePill}{inkPalette ?? marksPalette}{cutoutPalette ?? pagePalette ?? visualPalette}{(selected || selectedArrow) && <div className="glass-selection-actions" role="group" aria-label="Selected mark" data-glass-selection>
    <button type="button" data-glass-xray-open={selected ?? selectedArrow} aria-haspopup="dialog" title="X-ray: exactly what the agent will see"
      onClick={() => { const id = selected ?? selectedArrow; if (id) openXray(id); }}><ScanEye size={14} /> X-ray</button>
  </div>}{openTrash && <div className="glass-trash" role="dialog" aria-label="Glass trash">
    <strong>Glass trash</strong>
    {trash.length ? <ul>{trash.map(magnet => <li key={magnet.id}>
      <span>{magnetLabel(magnet)}</span>
      <button type="button" data-glass-restore={magnet.id} onClick={() => void restore(magnet)}>Undo</button>
    </li>)}</ul> : <p>Nothing deleted.</p>}
  </div>}{Object.keys(layout.checks).length > 0 && <div className="glass-check" role="group" aria-label="Check placement">
    <strong>{checkRows.length > 0
      ? `${checkRows.length} magnet${checkRows.length === 1 ? "" : "s"} need${checkRows.length === 1 ? "s" : ""} a look`
      : "Every moved mark is placed"}</strong>
    <ul>{checkRows.slice(0, 20).map(([id, check]) => {
      const mark = [...magnets, ...images, ...stickers, ...cards, ...timelines].find(item => item.id === id);
      return <li key={id} data-glass-check={id} data-glass-confidence={check.confidence.toFixed(2)}>
        <span className="glass-check-name">{"text" in (mark ?? {}) ? ((mark as StickyNote).text.trim().slice(0, 40) || "Sticky note")
          : mark && "name" in mark ? mark.name.slice(0, 40) : mark && "title" in mark ? mark.title.slice(0, 40) : "Glass mark"}</span>
        <div className="glass-check-context">
          <div className="glass-check-side glass-check-old"><small>Old</small><q dir="auto">{check.old.quote.slice(0, 160)}</q><small>{check.old.heading}</small></div>
          <div className="glass-check-side glass-check-new"><small>New</small><q dir="auto">{check.candidate?.quote.slice(0, 160) ?? "No matching paragraph"}</q><small>{check.candidate?.heading ?? ""}</small></div>
        </div>
        <span className="glass-check-score">{Math.round(check.confidence * 100)}%</span>
        <span className="glass-check-actions">
          <button type="button" data-glass-place={id} disabled={!check.candidate} onClick={() => placeHere(id, check.line)}>Place here</button>
          <button type="button" data-glass-keep={id} onClick={() => keepPlacement(id)}>Keep old spot</button>
        </span>
      </li>;
    })}</ul>
    {checkRows.length > 20 && <p>{checkRows.length - 20} more below.</p>}
  </div>}{(orphans.length > 0 || orphanArrows.length > 0) && <div className="glass-orphans" role="group" aria-label="Marks whose paragraph is gone">
    <strong>Anchor lost</strong>
    {orphans.filter(mark => !kept.has(mark.id)).map(mark => <span key={mark.id} data-glass-orphan={mark.id}>
      <span>{"text" in mark ? mark.text.trim().slice(0, 32) || "Empty note" : "name" in mark ? mark.name.slice(0, 32) : "card" in mark ? mark.title.slice(0, 32) || "Card" : stickerName(mark)}</span>
      {layout.checks[mark.id]?.candidate && <button type="button" data-glass-place={mark.id} onClick={() => placeHere(mark.id, layout.checks[mark.id].line)}>Place here</button>}
      <button type="button" data-glass-keep={mark.id} onClick={() => keepPlacement(mark.id)}>Keep</button>
      <button type="button" aria-label="Move orphan to trash" onClick={() => removeMark(mark.id)}>×</button>
    </span>)}
    {orphanArrows.map(arrow => <span key={arrow.id} data-glass-orphan-arrow={arrow.id}>
      <span>{arrow.label.trim() ? `Arrow: ${snippet(arrow.label.trim())}` : "Arrow with a lost end"}</span>
      <button type="button" aria-label="Move orphan arrow to trash" onClick={() => removeMark(arrow.id)}>×</button>
    </span>)}
  </div>}{cardOpen && note && <NewCardDialog blocks={blocks.current}
    point={cardPoint()}
    close={() => setCardOpen(false)} create={card => { void createCard(card); setCardOpen(false); }} />}{backTo && <div className="glass-back" role="status" data-glass-back>
    <button type="button" data-glass-back-skip onClick={() => {
      scroller.scrollTo({ top: backTo.top });
      setSelected(backTo.id);
      setBackTo(undefined);
    }}>Back to {backTo.label}</button>
  </div>}
  {compareOpen && <CompareDialog images={images} selected={selected} close={() => setCompareOpen(false)}
    create={(left, right) => { createCompare(left, right); setCompareOpen(false); }} />}
  {calibration && <ScaleDialog line={calibration.line} frame={calibration.frame} close={() => setCalibration(undefined)}
    apply={(length, unit, precision) => {
      patchImage(calibration.image, { scale: scaleFromLine(calibration.line, length, unit, precision, calibration.frame) }, true);
      setCalibration(undefined);
    }} />}
  
{notice && <p className={["voice", "memo", "lecture"].includes(tool) ? "glass-notice glass-notice-high" : "glass-notice"} role="status">{notice}</p>}
  {mergeDone && <div className="glass-merge-done" role="status" data-glass-merge-done>
    <span>Merged into the page.</span>
    <button type="button" data-glass-merge-undo={mergeDone.id} onClick={() => void undoMerge(mergeDone.id)}>Undo</button>
  </div>}</>;
  const mergeDialog = mergeOpen && <div className="glass-merge-dialog" role="dialog" aria-modal="true" aria-label="Merge down preview" data-glass-merge-dialog>
    <header>
      <div><strong>{mergeOpen.label}</strong><span>{mergeOpen.element.kind} · line {mergeOpen.element.line}</span></div>
      <button type="button" className="glass-merge-close" aria-label="Cancel merge" data-glass-merge-cancel
        onClick={() => { setMergeOpen(undefined); setMergeStale(undefined); }}>×</button>
    </header>
    <p className="glass-merge-meta">
      {["image", "ink"].includes(mergeOpen.kind) ? `${mergeOpen.linkStyle === "wikilink" ? "Vault links use ![[…]]" : "Vault links use ![](…)"} · attachment folder ${mergeOpen.attachmentFolder || "next to the note"} · ` : ""}{Math.round((mergeOpen.confidence <= 1 ? mergeOpen.confidence * 100 : mergeOpen.confidence))}% match
    </p>
    <p className="glass-merge-counts">{mergeOpen.added.length} line{mergeOpen.added.length === 1 ? "" : "s"} added, {mergeOpen.removed.length} removed, everything else stays byte-identical.</p>
    <MergeDiff rows={mergeOpen.diff} stamp="preview" />
    {mergeStale ? <section className="glass-merge-stale" data-glass-merge-stale>
      <p role="alert">The note changed since this preview. Nothing has been written. Choose which version to merge into.</p>
      <p className="glass-merge-counts">Your preview was based on {mergeOpen.baseSize} bytes; the note now has {mergeStale.baseSize} bytes.</p>
      <h4>Your preview</h4>
      <MergeDiff rows={mergeOpen.diff} stamp="old" />
      <h4>The note now</h4>
      <MergeDiff rows={mergeStale.diff} stamp="current" />
      <div className="glass-merge-actions">
        <button type="button" className="glass-merge-accept" disabled={mergeBusy} data-glass-merge-accept={mergeStale.magnet}
          onClick={() => void acceptMerge(mergeStale)}>Merge into the updated note</button>
        <button type="button" data-glass-merge-cancel onClick={() => { setMergeOpen(undefined); setMergeStale(undefined); }}>Cancel</button>
      </div>
    </section> : <div className="glass-merge-actions">
      <button type="button" className="glass-merge-accept" disabled={mergeBusy} data-glass-merge-accept={mergeOpen.magnet}
        onClick={() => void acceptMerge(mergeOpen)}>Accept</button>
      <button type="button" data-glass-merge-cancel onClick={() => { setMergeOpen(undefined); setMergeStale(undefined); }}>Cancel</button>
    </div>}
  </div>;

  return <>
    <GlassLandmarks editor={editor} root={root} nodes={nodes} groups={groups} note={note}
      saved={documentSaved} magnets={landmarks} seeds={seeds} />
    {note && !scrub && <BubbleLayer editor={editor} root={root} note={note} live={live} pin={pinCard} magnets={comments} reload={load}
      exam={study.exam} reveal={revealItem} />}
    {createPortal(<>
    {tool === "cutout" && !capturing && <div className={`glass-scissors-overlay ${cutMode}`} aria-label="Cut a selection"
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const point: [number, number] = [event.clientX, event.clientY];
        const draft = { start: point, end: point, points: [point], model: cutMode };
        cutDraftRef.current = draft;
        setCutDrag(draft);
      }}
      onPointerMove={event => {
        const current = cutDraftRef.current;
        if (!current) return;
        const point: [number, number] = [event.clientX, event.clientY];
        const next = { ...current, end: point,
          points: current.model === "lasso" ? [...current.points, point] : current.points };
        cutDraftRef.current = next;
        setCutDrag(next);
      }}
      onPointerUp={event => {
        const current = cutDraftRef.current;
        if (!current) return;
        cutDraftRef.current = undefined;
        const end: [number, number] = current.end;
        const bounds = current.model === "lasso" && current.points.length >= 3 ? current.points : [current.start, end];
        const left = Math.min(...bounds.map(point => point[0])), right = Math.max(...bounds.map(point => point[0]));
        const top = Math.min(...bounds.map(point => point[1])), bottom = Math.max(...bounds.map(point => point[1]));
        const box = { x: left, y: top, width: right - left, height: bottom - top };
        const lasso = current.model === "lasso" && current.points.length >= 3 && box.width > 0 && box.height > 0
          ? current.points.map(([x, y]) => [Math.round(((x - box.x) / box.width) * 1000) / 10,
            Math.round(((y - box.y) / box.height) * 1000) / 10] as [number, number]) : [];
        setCutDrag(undefined);
        if (box.width >= cutoutDefaults.minCropPx && box.height >= cutoutDefaults.minCropPx) void cutoutAt(box, lasso);
        else setNotice("Cut at least 10 px.");
      }}
      onPointerCancel={() => { cutDraftRef.current = undefined; setCutDrag(undefined); }}>
      {cutDrag && cutDrag.model === "rect"
        ? <div className="glass-scissors-rect" style={{ left: Math.min(cutDrag.start[0], cutDrag.end[0]),
            top: Math.min(cutDrag.start[1], cutDrag.end[1]), width: Math.abs(cutDrag.end[0] - cutDrag.start[0]),
            height: Math.abs(cutDrag.end[1] - cutDrag.start[1]) }} />
        : cutDrag ? <svg className="glass-scissors-lasso" aria-hidden="true">
            <polyline points={cutDrag.points.map(([x, y]) => `${x},${y}`).join(" ")} />
          </svg> : null}
    </div>}
    {note && offscreen.length > 0 && <nav className="glass-sr-marks" aria-label="Glass magnets off screen" data-glass-offscreen-list>
      <button type="button" data-glass-offscreen-toggle aria-expanded={offscreenOpen}
        aria-label={`${offscreen.length} magnets off screen${offscreenOpen ? "" : "; open the list"}`}
        onClick={() => setOffscreenOpen(open => !open)}>{offscreenOpen ? "Hide" : `${offscreen.length} off screen`}</button>
      {offscreenOpen && offscreen.map(mark => <button key={mark.id} type="button" data-glass-offscreen={mark.id}
        onClick={() => { setSelected(mark.id); setFocusedMagnet(mark.id); }}>{plainMarkName(mark)}</button>)}
    </nav>}
    <div className="glass-layer" ref={layer} data-glass="on" data-grid={grid.on ? grid.size : "off"}
      data-mounted={glassMounts.mounted.size} data-glass-total={glassMounts.total} data-glass-culled={glassMounts.culled}
      onFocusCapture={event => {
        const id = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-magnet]")?.dataset.magnet : undefined;
        setFocusedMagnet(id);
      }}
      onBlurCapture={() => setFocusedMagnet(undefined)}
      data-glass-scrub={scrub ? "on" : undefined} data-glass-lens={lensOn && lens ? "on" : undefined}>
      {grid.on && <div className="glass-grid" aria-hidden="true" data-glass-grid={grid.size} />}
      <div className="glass-guides" ref={guidesEl} aria-hidden="true" data-snap="off">
        <span className="glass-guide" data-guide="x" hidden />
        <span className="glass-guide" data-guide="y" hidden />
        <span className="glass-guide" data-guide="spacing" hidden />
      </div>
      {(ink.length > 0 || tool === "ink" || inkHistory.undo || inkHistory.redo) && <GlassInk
        editor={editor} root={root} note={note} tool={scrub ? null : tool === "ink" ? inkTool : null} color={inkColor} size={inkSize}
        magnets={ink} send={send} reloadInk={load} saved={saved} eraser={eraserMode} api={inkApi} onHistory={inkHistoryChange} onNotice={setNotice}
        onStroke={onInkStroke} ocr={ocrMode && !scrub} onOcrPick={ocrPick} />}
      {(tool === "sticky" || tool === "sticker" || tool === "clip" || tool === "extra-page" || tool === "label" || tool === "voice" || tool === "memo" || tool === "lecture") && note && <div className="glass-surface" data-glass-surface data-placement={tool} data-glass-layer="notes" onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        if (tool === "sticker") placeSticker({ x: event.clientX, y: event.clientY });
        else if (tool === "clip" || tool === "extra-page") createSheet(tool, { x: event.clientX, y: event.clientY });
        else if (tool === "label") {
          const frame = layer.current?.getBoundingClientRect();
          createLabel({ x: event.clientX - (frame?.left ?? 0), y: event.clientY - (frame?.top ?? 0) });
        } else if (tool === "voice" || tool === "memo" || tool === "lecture") {
          if (runRef.current) { if (tool !== "lecture") void finishVoice(); }
          else void beginVoice(tool === "voice" ? "dictation" : tool, { x: event.clientX, y: event.clientY });
        } else create({ x: event.clientX, y: event.clientY });
      }} />}
      {clips.map(clip => { const place = layout.places[clip.id]; return place?.status !== "resolved" ? null :
        <ClipView key={clip.id} clip={clip} place={place} selected={selected === clip.id} savedNote={clip.notePath}
          note={note} inkColor={sheetInkColors[0]} inkSize={inkSize}
          onSelect={() => { setSelected(clip.id); setSelectedArrow(undefined); }}
          onText={text => patchClip(clip.id, { text })}
          onFold={() => patchClip(clip.id, { folded: !clip.folded })}
          onStrokes={strokes => patchClip(clip.id, { strokes })}
          onSave={() => void saveClip(clip.id)}
          onJump={() => jumpWithBack(clip.id, anchorLine(clip.anchor), clip.title || "Clip")}
          onDelete={() => removeMark(clip.id)} />; })}
      {extraPages.map(page => { const place = layout.places[page.id]; return place?.status !== "resolved" ? null :
        <ExtraPageView key={page.id} page={page} place={place} selected={selected === page.id}
          inkColor={sheetInkColors[1]} inkSize={inkSize}
          onSelect={() => { setSelected(page.id); setSelectedArrow(undefined); }}
          onText={text => patchPage(page.id, { text })}
          onStrokes={strokes => patchPage(page.id, { strokes })}
          onJump={() => jumpWithBack(page.id, anchorLine(page.anchor), page.title || "Extra page")}
          onDelete={() => removeMark(page.id)} />; })}
      {cutouts.map(cutout => { const place = layout.places[cutout.id]; if (place?.status !== "resolved") return null;
        const block = blocks.current.find(item => (item.element?.dataset.cid ?? `block-${item.line}`) === cutout.source.element);
        const picture = block?.element?.tagName === "IMG" ? block.element as HTMLImageElement : block?.element?.querySelector("img");
        return <CutoutView key={cutout.id} cutout={cutout} place={place} selected={selected === cutout.id} note={note}
          sourceImage={picture?.currentSrc || picture?.src || undefined}
          onSelect={() => { setSelected(cutout.id); setSelectedArrow(undefined); }}
          onJump={() => jumpWithBack(cutout.id, cutout.source.line, cutout.name)}
          onDelete={() => removeMark(cutout.id)} />; })}
      {layout.fixture && (layout.fixture.status === "resolved"
        ? <div className="glass-debug" data-glass-object="fixture" data-glass-status="resolved"
            style={{ left: `${layout.fixture.x}px`, top: `${layout.fixture.y}px`, width: `${layout.fixture.width}px`, height: `${layout.fixture.height}px` }} />
        : <div className="glass-debug" data-glass-object="fixture" data-glass-status="orphan" />)}
      {visible.map(stickie => <StickyView key={stickie.id} note={stickie} place={layout.places[stickie.id]} selected={selected === stickie.id}
        editing={editing === stickie.id} onSelect={() => { setSelected(stickie.id); setSelectedArrow(undefined); setEditing(undefined); }}
        onEdit={editingNow => {
          if (editingNow && lockedLayer("sticky")) { setNotice("Notes & stickers layer is locked."); return; }
          setEditing(editingNow ? stickie.id : undefined);
        }}
        onText={text => { setMagnets(current => current.map(item => item.id === stickie.id ? { ...item, text } : item)); void send({ action: "set", magnet: stickie.id, fields: { text } }); }}
        onFold={folded => { setMagnets(current => current.map(item => item.id === stickie.id ? { ...item, folded } : item)); void send({ action: "set", magnet: stickie.id, fields: { folded } }); }}
        onColor={color => { setMagnets(current => current.map(item => item.id === stickie.id ? { ...item, color } : item)); void send({ action: "set", magnet: stickie.id, fields: { color } }); }}
        onMerge={() => void openMerge(stickie.id)}
        {...(stickie.source ? { onJump: () => jumpToSource(stickie.source!) } : {})}
        onDelete={() => removeMark(stickie.id)} />)}
      {timelines.map(timeline => {
        const place = layout.places[timeline.id];
        if (place?.status !== "resolved") return null;
        return <GlassTimeline key={timeline.id} mark={timeline} timestamps={timestamps} place={{ x: place.x, y: place.y, width: place.width, height: place.height }}
          selected={selected === timeline.id} onSelect={() => { setSelected(timeline.id); setSelectedArrow(undefined); }}
          onPin={(time, label) => pinTimestamp(timeline, time, label)}
          onDuration={duration => setTimelineDuration(timeline.id, duration)}
          onDelete={() => removeTimeline(timeline.id)} />;
      })}
      {labels.map(label => {
        const box = labelBox(label, layout.places, elementBoxes.current);
        if (!box) return null;
        const hidden = label.hidden || study.labelsHidden || study.exam;
        return <GlassLabelView key={label.id} label={label} box={box} hidden={hidden} revealed={revealed.has(label.id)}
          exam={study.exam} editing={labelEditing === label.id} selected={selected === label.id}
          onSelect={() => { setSelected(label.id); setSelectedArrow(undefined); }}
          onReveal={() => revealItem(label.id)}
          onEdit={value => setLabelEditing(value ? label.id : undefined)}
          onText={text => patchLabel(label.id, { text })}
          onMove={(dx, dy) => patchLabel(label.id, { dx, dy })}
          onMark={marked => patchLabel(label.id, { marked })}
          onGrade={grade => { if (!latest.current.study.exam) gradeLabel(label, grade); }}
          onDelete={() => { setLabelEditing(undefined); removeMark(label.id); }} />;
      })}
      {shownCards.map(card => { const place = layout.places[card.id]; return place?.status !== "resolved" ? null :
        <GlassCardView key={card.id} card={study.exam ? { ...card, folded: true } : card} place={{ x: place.x, y: place.y, width: place.width }} note={note!} live={live}
          onToggle={() => { if (!latest.current.study.exam) toggleCard(card.id); }}
          onCached={(answer, answerAt) => patchCard(card.id, { answer, answerAt })}
          onMark={marked => patchCard(card.id, { marked })}
          onAccept={() => patchCard(card.id, { proposed: false })}
          onDelete={() => removeMark(card.id)} onMerge={() => void openMerge(card.id)} />; })}
      {compares.map(compare => { const place = layout.places[compare.id];
        if (place?.status !== "resolved" || !note) return null;
        return <GlassCompareCard key={compare.id} compare={compare} place={place} note={note} images={images}
          onChange={value => patchCompare(compare.id, { value }, false)}
          onCommit={value => patchCompare(compare.id, { value })}
          onSwap={() => patchCompare(compare.id, { left: compare.right, right: compare.left })}
          onDelete={() => removeMark(compare.id)} />; })}
      {voices.map(memo => { const place = layout.places[memo.id];
        return place?.status !== "resolved" ? null :
          <GlassVoice key={memo.id} memo={memo} place={place} note={note!} selected={selected === memo.id}
            onSelect={() => { setSelected(memo.id); setSelectedArrow(undefined); }}
            onDelete={() => removeMark(memo.id)} />; })}
      {above.map(frame)}
      {under.map(frame)}
      {visibleStickers.map(sticker => <StickerView key={sticker.id} sticker={sticker} place={layout.places[sticker.id]} selected={selected === sticker.id}
        onSelect={() => { setSelected(sticker.id); setSelectedArrow(undefined); }}
        onRotate={rotate => { setStickers(current => current.map(item => item.id === sticker.id ? { ...item, rotate } : item)); void send({ action: "set", magnet: sticker.id, fields: { rotate } }); }}
        onNudge={(dx, dy) => {
          const step = grid.on ? grid.size : 1;
          const x = Math.round((sticker.x + dx) / step) * step, y = Math.round((sticker.y + dy) / step) * step;
          setStickers(current => current.map(item => item.id === sticker.id ? { ...item, x, y } : item));
          void send({ action: "set", magnet: sticker.id, fields: { x, y } });
        }}
        onDelete={() => removeMark(sticker.id)} />)}
      {note && (arrows.length > 0 || tool === "arrow") && <ArrowOverlay routes={layout.routes} arrows={arrows} selected={selectedArrow} view={viewport} names={layout.names}
        tool={tool === "arrow"} style={arrowStyle} color={arrowColor} scroller={scroller} hitTest={hitTest}
        onCreate={createArrow} onSelect={id => { setSelectedArrow(id); if (id) setSelected(undefined); }}
        onDelete={removeMark} onUpdate={updateArrow} onMissing={() => setNotice("Start on a paragraph or a sticker.")} />}
    </div></>, scroller)}
    {mergeDialog && createPortal(mergeDialog, document.body)}
    {createPortal(<div className="glass-under" data-glass-under><div className="glass-under-host" ref={setUnderHost} /></div>, scroller)}
    {study.exam && examOpen && <ExamPanel items={examItems} revealed={revealed} index={examIndex} markedOnly={examMarkedOnly}
      onIndex={setExamIndex} onReveal={revealItem} onMarkedOnly={setExamMarkedOnly} onGrade={previewGrade}
      onClose={() => { setStudyMode({ exam: false }); setExamOpen(false); setRevealed(new Set()); }} />}
    {!scrub && createPortal(panel, document.body)}
    {swapTarget && note && <GlassSwapPanel key={`${swapTarget.id}:${swapOpen}`} note={note} element={swapTarget} live={live}
      onClose={() => setSwapTarget(undefined)}
      onApplied={async () => { await reloadNote?.(); await load(); }} />}
    {chip && createPortal(<div className="glass-chip" role="status" data-glass-gesture={chip.kind} data-glass-low={chip.low || undefined}
      style={{ left: `${chip.at.x}px`, top: `${chip.at.y}px` }}>
      <span>{chip.low ? `Possible ${chip.kind}` : chip.kind === "bubble" ? "Bubble on the circled words" : chip.kind === "highlight" ? "Underline became a highlight" : "Connector made"}</span>
      {chip.low && chip.apply && <button type="button" data-gesture-use onClick={() => { chip.apply?.(); setChip(null); }}>Use gesture</button>}
      <button type="button" data-gesture-keep onClick={() => { chip.revert(); setChip(null); }}>Keep as ink</button>
      {!chip.low && <button type="button" data-gesture-undo onClick={() => { chip.revert(); setChip(null); }}>Undo gesture</button>}
      <button type="button" data-gesture-dismiss aria-label="Dismiss gesture chip" title="Dismiss" onClick={() => setChip(null)}>×</button>
    </div>, document.body)}
    {lensOn && lens && createPortal(<div className="glass-lens" data-glass-lens-ring aria-hidden="true"
      style={{ left: `${lens.x - lensRadius}px`, top: `${lens.y - lensRadius}px`, width: `${lensRadius * 2}px`, height: `${lensRadius * 2}px` }} />, document.body)}
    {scrub && createPortal(<div className="glass-scrub" role="dialog" aria-label="Time scrub" data-glass-scrub>
      <History size={15} aria-hidden="true" />
      <span data-glass-scrub-count>{scrub.marks} marks · {scrub.bubbles} bubbles</span>
      <input type="range" min={0} max={scrub.points.length - 1} value={scrub.index} aria-label="Glass history"
        data-glass-scrub-range onChange={event => { setPlaying(false); scrubTo(Number(event.target.value)); }} />
      <output data-glass-scrub-at={`${scrub.index + 1}/${scrub.points.length}`}>{new Date(scrub.at).toLocaleTimeString()}</output>
      <button type="button" data-glass-scrub-play aria-pressed={playing} disabled={scrub.index >= scrub.points.length - 1}
        onClick={() => setPlaying(value => !value)}>{playing ? "Pause" : "Play"}</button>
      <button type="button" data-glass-scrub-now onClick={() => { setPlaying(false); returnToNow(); }}>Return to now</button>
    </div>, document.body)}
    {xray && createPortal(<div className="glass-xray" role="dialog" aria-modal="true" aria-label="What the agent sees" data-glass-xray>
      <header>
        <div><strong>{xray.label}</strong><span>{elementKindName(xray.kind)} · line {xray.bundle.element.line}</span></div>
        <button type="button" className="glass-xray-close" aria-label="Close X-ray" data-glass-xray-close onClick={() => setXray(undefined)}>×</button>
      </header>
      <p className="glass-xray-meta" data-glass-xray-flags={xray.flags.length}>
        {xray.flags.length ? `${xray.flags.length} identifier${xray.flags.length === 1 ? "" : "s"} redacted before any model call.` : "No identifiers found."}
      </p>
      <div className="glass-xray-body">
        <section><h4>Page context</h4><pre>{xray.payload.text}</pre></section>
        <section data-glass-xray-payload><h4>Sends to the agent</h4><pre>{payloadText(xray.payload)}</pre></section>
      </div>
    </div>, document.body)}
    {boardPicker && createPortal(<div className="board-picker-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setBoardPicker(false); }}>
      <section className="board-picker" role="dialog" aria-modal="true" aria-label="Boards">
        <header><h2>Boards</h2><button type="button" aria-label="Close boards" onClick={() => setBoardPicker(false)}>×</button></header>
        <ul>{boards.map(board => <li key={board.id}><button type="button" data-board-open={board.id}
          onClick={() => { setBoardPicker(false); setBoardOpen({ id: board.id, name: board.name }); }}>{board.name}</button></li>)}</ul>
        <button type="button" className="board-picker-new" data-board-new onClick={() => void createBoard()}>New board</button>
      </section>
    </div>, document.body)}
    {boardOpen && note && <Suspense fallback={<div className="board-loading board-loading-fixed" role="status">Loading board…</div>}>
      <BoardView note={note} magnet={boardOpen.id} name={boardOpen.name} close={() => setBoardOpen(null)} />
    </Suspense>}
  </>;
}

// The calibration dialog: one drawn line, its real length, and the unit, which is never converted.
function ScaleDialog({ line, frame, close, apply }: {
  line: [Point2, Point2]; frame: [number, number]; close(): void;
  apply(length: number, unit: MeasureUnit, precision: MeasurePrecision): void;
}) {
  const [length, setLength] = useState("10");
  const [unit, setUnit] = useState<MeasureUnit>("mm");
  const [precision, setPrecision] = useState<MeasurePrecision>(1);
  const pixels = Math.round(Math.hypot((line[1][0] - line[0][0]) * frame[0], (line[1][1] - line[0][1]) * frame[1]));
  const value = Number(length);
  const valid = Number.isFinite(value) && value > 0;
  return <div className="glass-dialog glass-scale-dialog" role="dialog" aria-modal="true" aria-label="Set image scale" data-scale-dialog>
    <strong>Set scale</strong>
    <p className="glass-dialog-hint">Your line is {pixels}px on the glass. Type the real length it represents.</p>
    <label>Real length <input data-scale-length type="number" min="0.0001" step="any" value={length}
      onChange={event => setLength(event.target.value)} /></label>
    <label>Unit <select data-scale-unit value={unit} onChange={event => setUnit(event.target.value as MeasureUnit)}>
      {measureUnits.map(name => <option key={name} value={name}>{name}</option>)}
    </select></label>
    <label>Decimals <select data-scale-precision value={precision} onChange={event => setPrecision(Number(event.target.value) as MeasurePrecision)}>
      {measurePrecisions.map(count => <option key={count} value={count}>{count}</option>)}
    </select></label>
    <p className="glass-dialog-hint">Changing the unit keeps the number: nothing is converted silently.</p>
    <div className="glass-dialog-row">
      <button type="button" data-scale-apply disabled={!valid} onClick={() => apply(value, unit, precision)}>Use scale</button>
      <button type="button" data-scale-cancel onClick={close}>Cancel</button>
    </div>
  </div>;
}

// Pick the two pictures for one compare card; swap lives on the card itself.
function CompareDialog({ images, selected, close, create }: {
  images: GlassImage[]; selected?: string; close(): void; create(left: string, right: string): void;
}) {
  const preferred = images.find(image => image.id === selected)?.id ?? images[0]?.id ?? "";
  const [left, setLeft] = useState(preferred);
  const [right, setRight] = useState(images.find(image => image.id !== preferred)?.id ?? "");
  const valid = images.length > 1 && !!left && !!right && left !== right;
  return <div className="glass-dialog glass-compare-dialog" role="dialog" aria-modal="true" aria-label="Compare two images" data-compare-dialog>
    <strong>Compare</strong>
    <p className="glass-dialog-hint">Both pictures stay local on the glass.</p>
    <label>Before <select data-compare-left value={left} onChange={event => setLeft(event.target.value)}>
      {images.map(image => <option key={image.id} value={image.id}>{image.name}</option>)}
    </select></label>
    <label>After <select data-compare-right value={right} onChange={event => setRight(event.target.value)}>
      {images.map(image => <option key={image.id} value={image.id}>{image.name}</option>)}
    </select></label>
    <div className="glass-dialog-row">
      <button type="button" data-compare-create disabled={!valid} onClick={() => create(left, right)}>Add compare</button>
      <button type="button" data-compare-cancel onClick={close}>Cancel</button>
    </div>
  </div>;
}

// The jump chip names the far end: a page element's kind and words, or the mark itself.
function endName(end: ArrowMark["from"], list: readonly PageElement[], ends: ArrowEndContext,
  latest: { magnets: StickyNote[]; stickers: StickerMark[] }) {
  if (end.kind === "magnet") {
    const sticky = latest.magnets.find(item => item.id === end.magnet);
    if (sticky) return sticky.text.trim() ? snippet(sticky.text.trim()) : "Sticky note";
    const sticker = latest.stickers.find(item => item.id === end.magnet);
    return sticker ? stickerName(sticker) : "Glass mark";
  }
  const line = ends.line(end.anchor);
  const candidates = line === null ? [] : list.filter(element => element.blockLine === line);
  const element = candidates.find(item => item.id === end.element) ?? candidates[0];
  return element ? `${elementKindName(element.kind)}: ${snippet(element.text)}` : "Page element";
}
