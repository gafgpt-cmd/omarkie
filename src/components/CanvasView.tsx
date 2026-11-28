import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  Background, ConnectionMode, Controls, Handle, MarkerType, MiniMap, NodeResizer, Panel, Position, ReactFlow, ReactFlowProvider,
  useReactFlow,
  type Connection, type Edge, type EdgeChangeset, type Node, type NodeChange, type NodeChangeset, type NodeProps, type OnSelectionChangeParams, type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { BookOpen, ExternalLink, FileText, Group, Link2, Loader2, Redo2, Save, Sparkles, StickyNote, Trash2, Undo2, X } from "lucide-react";
import {
  addEdge, addNode, canvasEdges, canvasHistory, canvasIds, canvasLimits, canvasNodes, canvasSubpath, commitCanvas, groupMembers, groupNodes,
  locateSubpath, moveNodes, newCanvasId, parseCanvas, redoCanvas, removeItems, serializeCanvas, setGeometry, snapToGrid, undoCanvas, updateNode,
  type CanvasEdge, type CanvasHistory, type CanvasIssue, type CanvasNode, type CanvasSide, type JsonCanvas,
} from "../../shared/json-canvas.mjs";
import { clipSource, quoteLine, type ClipSource } from "../../shared/papercut.mjs";
import { host } from "../host";
import { t } from "../i18n";
import { renderMarkdown } from "../editor/markdown";
import type { CanvasBoard, CanvasNote } from "../types";
import "./board.css";
import "./canvas.css";

type Card = Node<{ node: CanvasNode }>;
type NoteState = { loading?: boolean; text?: string; missing?: boolean; error?: string };
type Status = "loading" | "ready" | "saving" | "saved" | "error";
// last: reopen the board used last in this folder (the Papercut path); without it and a file the picker opens.
export interface CanvasRequest { file?: string; last?: boolean; clips?: CanvasNode[]; at: number }
export interface CanvasViewProps {
  vault: string;
  request: CanvasRequest;
  close(): void;
  openNote(file: string, line: number): void;
  askTutor?(text: string): void;
}

const known = new Set(["text", "file", "link", "group"]);
const presets: Record<string, string> = { "1": "var(--canvas-red)", "2": "var(--canvas-orange)", "3": "var(--canvas-yellow)", "4": "var(--canvas-green)", "5": "var(--canvas-cyan)", "6": "var(--canvas-purple)" };
const tint = (color: unknown) => typeof color === "string" ? presets[color] ?? color : undefined;
const sides: [CanvasSide, Position][] = [["top", Position.Top], ["right", Position.Right], ["bottom", Position.Bottom], ["left", Position.Left]];
const noteFile = /\.(md|markdown|mdown)$/i;
const editable = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest("input,textarea,select,[contenteditable='true']");
const viewportKey = (vault: string, file: string) => `omarkie-canvas-viewport:${vault}:${file}`;
export const lastBoardKey = (vault: string) => `omarkie-canvas-last:${vault}`;
const finite = (node: CanvasNode) => [node.x, node.y, node.width, node.height].every(Number.isFinite);

// Card bodies render through the note renderer, then lose every media element: a board never fetches.
function cardHtml(markdown: string) {
  const template = document.createElement("template");
  template.innerHTML = renderMarkdown(markdown);
  for (const element of template.content.querySelectorAll("img")) element.replaceWith(document.createTextNode(element.getAttribute("alt") || ""));
  for (const element of template.content.querySelectorAll("iframe,video,audio,source,object,embed,link,style,script")) element.remove();
  return template.innerHTML;
}

function nearestSides(from: CanvasNode, to: CanvasNode): [CanvasSide, CanvasSide] {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2), dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

function flowNodes(canvas: JsonCanvas, selected: Set<string>, readOnly: boolean): Card[] {
  return canvasNodes(canvas).filter(finite).map(node => ({
    id: node.id, type: known.has(node.type) ? node.type : "unknown", position: { x: node.x, y: node.y }, width: node.width, height: node.height,
    data: { node }, selected: selected.has(node.id), draggable: !readOnly, connectable: !readOnly, deletable: !readOnly,
    className: node.type === "group" ? "canvas-flow-group" : undefined, ariaLabel: cardLabel(node),
    // Groups paint beneath every card, as in Obsidian, so a new group never covers a card outside it.
    zIndex: node.type === "group" ? -1 : undefined,
  }));
}

function cardLabel(node: CanvasNode) {
  if (node.type === "text") return t("Text card: {{text}}", { text: String(node.text ?? "").replace(/\s+/g, " ").slice(0, 80) });
  if (node.type === "file") return t("Note card: {{file}}", { file: `${node.file}${node.subpath ?? ""}` });
  if (node.type === "link") return t("Link card: {{url}}", { url: String(node.url) });
  if (node.type === "group") return t("Group: {{label}}", { label: String(node.label ?? "") });
  return t("Card Omarkie cannot show: {{type}}", { type: String(node.type) });
}

function flowEdges(canvas: JsonCanvas, selected: Set<string>): Edge[] {
  const byId = new Map(canvasNodes(canvas).map(node => [node.id, node]));
  return canvasEdges(canvas).flatMap(edge => {
    const from = byId.get(edge.fromNode), to = byId.get(edge.toNode);
    if (!from || !to || !finite(from) || !finite(to)) return [];
    const [fromSide, toSide] = nearestSides(from, to);
    const color = tint(edge.color);
    const marker = { type: MarkerType.ArrowClosed, width: 18, height: 18, ...(color ? { color } : {}) };
    return [{
      id: edge.id, source: edge.fromNode, target: edge.toNode, sourceHandle: edge.fromSide ?? fromSide, targetHandle: edge.toSide ?? toSide,
      label: typeof edge.label === "string" ? edge.label : undefined, selected: selected.has(edge.id),
      markerEnd: edge.toEnd === "none" ? undefined : marker, markerStart: edge.fromEnd === "arrow" ? marker : undefined,
      style: color ? { stroke: color } : undefined,
    }];
  });
}

interface CardContext {
  readOnly: boolean;
  editing: string | null;
  notes: Record<string, NoteState>;
  edit(id: string | null): void;
  commitText(id: string, key: "text" | "label", value: string): void;
  resizeStart(): void;
  resized(id: string, rect: { x: number; y: number; width: number; height: number }): void;
  openFile(file: string, subpath?: string): void;
  openSource(node: CanvasNode): void;
}
const Cards = createContext<CardContext | null>(null);
const useCards = () => useContext(Cards)!;

function Handles() {
  return <>{sides.map(([side, position]) => <Handle key={side} id={side} type="source" position={position} className="canvas-handle" />)}</>;
}

function Resizer({ id, selected }: { id: string; selected: boolean }) {
  const cards = useCards();
  if (cards.readOnly) return null;
  return <NodeResizer isVisible={selected} minWidth={canvasLimits.minSize} minHeight={canvasLimits.minSize} onResizeStart={cards.resizeStart}
    onResizeEnd={(_, rect) => cards.resized(id, rect)} lineClassName="canvas-resize-line" handleClassName="canvas-resize-handle" />;
}

// Text edits happen in place; Escape restores the card, leaving the textarea commits one change.
function Editor({ id, value, field, multiline }: { id: string; value: string; field: "text" | "label"; multiline: boolean }) {
  const cards = useCards();
  const cancelled = useRef(false);
  const finish = (text: string) => { cards.edit(null); if (!cancelled.current && text !== value) cards.commitText(id, field, text); };
  const props = {
    className: "canvas-editor nodrag nowheel nopan", defaultValue: value, autoFocus: true, "aria-label": field === "text" ? t("Card text") : t("Group name"),
    onBlur: (event: { currentTarget: { value: string } }) => finish(event.currentTarget.value),
    onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Escape") { cancelled.current = true; event.currentTarget.blur(); }
      else if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.blur(); }
    },
  };
  return multiline ? <textarea {...props} /> : <input {...props} />;
}

const inert = (event: ReactMouseEvent) => { if ((event.target as HTMLElement).closest("a")) event.preventDefault(); };

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => cardHtml(text), [text]);
  return <div className="canvas-markdown" onClick={inert} dangerouslySetInnerHTML={{ __html: html }} />;
}

const TextCard = memo(function TextCard({ id, data, selected }: NodeProps<Card>) {
  const cards = useCards();
  const node = data.node as CanvasNode & { text: string };
  const source = clipSource(node);
  const moved = source && sourceMoved(source, cards.notes[source.file]);
  return <div className="canvas-card canvas-text" style={{ "--card": tint(node.color) } as React.CSSProperties} onDoubleClick={() => !cards.readOnly && cards.edit(id)}>
    <Resizer id={id} selected={selected} />
    {source && <div className="canvas-card-kind">
      <span className="canvas-chip">{t("Snapshot")}</span>
      {moved && <span className="canvas-chip canvas-chip-warning" role="status">{t("Source moved")}</span>}
      <button type="button" className="canvas-card-action nodrag" onClick={() => cards.openSource(node)} aria-label={t("Jump to source")} title={t("Jump to source")}><BookOpen size={13} /></button>
    </div>}
    {cards.editing === id ? <Editor id={id} value={node.text} field="text" multiline /> : <Markdown text={node.text} />}
    <Handles />
  </div>;
});

function sourceMoved(source: ClipSource, note?: NoteState) {
  if (!note || note.loading) return false;
  if (note.missing || note.text === undefined) return true;
  return quoteLine(note.text, source) === null;
}

const FileCard = memo(function FileCard({ id, data, selected }: NodeProps<Card>) {
  const cards = useCards();
  const node = data.node as CanvasNode & { file: string; subpath?: string };
  const note = cards.notes[node.file];
  const markdown = noteFile.test(node.file);
  const section = note?.text !== undefined ? canvasSubpath(note.text, node.subpath) : undefined;
  const name = node.file.split("/").pop()!.replace(noteFile, "");
  return <div className="canvas-card canvas-file" style={{ "--card": tint(node.color) } as React.CSSProperties}>
    <Resizer id={id} selected={selected} />
    <div className="canvas-card-kind">
      <FileText size={13} aria-hidden="true" />
      <span className="canvas-file-name" title={node.file}>{name}{node.subpath && <em>{node.subpath.replace(/^#\^?/, " › ").replaceAll("#", " › ")}</em>}</span>
      <span className="canvas-chip">{t("Live")}</span>
      {markdown && !note?.missing && <button type="button" className="canvas-card-action nodrag" onClick={() => cards.openFile(node.file, node.subpath)} aria-label={t("Open note")} title={t("Open note")}><ExternalLink size={13} /></button>}
    </div>
    {!markdown ? <p className="canvas-card-state">{t("Preview not available for this file.")}</p>
      : !note || note.loading ? <p className="canvas-card-state"><Loader2 size={13} className="board-spin" /> {t("Loading note…")}</p>
      : note.missing ? <p className="canvas-card-state canvas-card-warning" role="status">{t("Note not found")}</p>
      : note.error ? <p className="canvas-card-state canvas-card-warning">{t(note.error)}</p>
      : section === null ? <p className="canvas-card-state canvas-card-warning" role="status">{t("Heading not found in note")}</p>
      : <Markdown text={section ?? ""} />}
    <Handles />
  </div>;
});

const LinkCard = memo(function LinkCard({ id, data, selected }: NodeProps<Card>) {
  const node = data.node as CanvasNode & { url: string };
  let label = node.url;
  try { label = new URL(node.url).host || node.url; } catch {}
  return <div className="canvas-card canvas-link" style={{ "--card": tint(node.color) } as React.CSSProperties}>
    <Resizer id={id} selected={selected} />
    <div className="canvas-card-kind"><Link2 size={13} aria-hidden="true" /><span className="canvas-file-name">{label}</span>
      <button type="button" className="canvas-card-action nodrag" onClick={() => void host.openLink(node.url)} aria-label={t("Open link")} title={t("Open link")}><ExternalLink size={13} /></button>
    </div>
    <p className="canvas-url">{node.url}</p>
    <Handles />
  </div>;
});

const GroupCard = memo(function GroupCard({ id, data, selected }: NodeProps<Card>) {
  const cards = useCards();
  const node = data.node as CanvasNode & { label?: string };
  return <div className="canvas-group" style={{ "--card": tint(node.color) } as React.CSSProperties}>
    <Resizer id={id} selected={selected} />
    <div className="canvas-group-label" onDoubleClick={() => !cards.readOnly && cards.edit(id)}>
      {cards.editing === id ? <Editor id={id} value={node.label ?? ""} field="label" multiline={false} /> : node.label || <span className="canvas-muted">{t("Group")}</span>}
    </div>
    <Handles />
  </div>;
});

function UnknownCard({ data }: NodeProps<Card>) {
  return <div className="canvas-card canvas-unknown"><p className="canvas-card-state canvas-card-warning">{t("Omarkie cannot show “{{type}}” cards yet. It is kept as is.", { type: String(data.node.type) })}</p></div>;
}

const nodeTypes = { text: TextCard, file: FileCard, link: LinkCard, group: GroupCard, unknown: UnknownCard };

function errorText(error: unknown) { return t((error as Error)?.message || "Not saved"); }

function Board({ board: initial, vault, clips, close, openNote, askTutor }: { board: CanvasBoard; vault: string; clips?: CanvasNode[]; close(): void; openNote(file: string, line: number): void; askTutor?(text: string): void }) {
  const flow = useReactFlow();
  const parsed = useMemo(() => parseCanvas(initial.text), [initial]);
  const [meta, setMeta] = useState({ file: initial.file, name: initial.name, hash: initial.hash });
  const [issues, setIssues] = useState<CanvasIssue[]>(parsed.issues);
  const readOnly = !parsed.editable || issues.some(issue => issue.kind !== "dangling-edge");
  const [history, setHistory] = useState<CanvasHistory>(() => canvasHistory(parsed.canvas));
  const historyRef = useRef(history); historyRef.current = history;
  const metaRef = useRef(meta); metaRef.current = meta;
  const saved = useRef<JsonCanvas>(parsed.canvas);
  const selection = useRef<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedEdges, setSelectedEdges] = useState<string[]>([]);
  const [nodes, setNodes] = useState<Card[]>(() => flowNodes(parsed.canvas, new Set(), readOnly));
  const [edges, setEdges] = useState<Edge[]>(() => flowEdges(parsed.canvas, new Set()));
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("ready");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [notes, setNotes] = useState<Record<string, NoteState>>({});
  const [preview, setPreview] = useState<string | null>(null);
  const drag = useRef<{ start: Map<string, { x: number; y: number }>; followers: Map<string, string[]> } | null>(null);
  const resizing = useRef(false);
  const saving = useRef(false), queued = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const conflictRef = useRef(false); conflictRef.current = conflict;
  const closed = useRef(false);
  const dirty = () => historyRef.current.canvas !== saved.current;
  const canvas = history.canvas;

  useEffect(() => {
    const chosen = new Set(selection.current);
    setNodes(flowNodes(canvas, chosen, readOnly));
    setEdges(current => flowEdges(canvas, new Set(current.filter(edge => edge.selected).map(edge => edge.id))));
  }, [canvas, readOnly]);

  const loadNotes = useCallback((files: string[], refresh = false) => {
    const wanted = [...new Set(files)].filter(file => noteFile.test(file));
    setNotes(current => {
      const next = { ...current };
      for (const file of wanted) if (refresh || !next[file]) {
        if (!next[file]) next[file] = { loading: true };
        void host.canvas!({ action: "note", file }).then((note: CanvasNote) => {
          if (!closed.current) setNotes(latest => ({ ...latest, [file]: note.missing ? { missing: true } : { text: note.text } }));
        }).catch(error => { if (!closed.current) setNotes(latest => ({ ...latest, [file]: { error: (error as Error).message } })); });
      }
      return next;
    });
  }, []);
  const noteFiles = useMemo(() => canvasNodes(canvas).flatMap(node => {
    const source = clipSource(node);
    return node.type === "file" && typeof node.file === "string" ? [node.file] : source ? [source.file] : [];
  }), [canvas]);
  useEffect(() => { loadNotes(noteFiles); }, [noteFiles, loadNotes]);

  const save = useCallback(async () => {
    clearTimeout(timer.current); timer.current = undefined;
    if (readOnly || conflictRef.current) return;
    if (saving.current) { queued.current = true; return; }
    const target = historyRef.current.canvas;
    if (target === saved.current) { setStatus("saved"); return; }
    saving.current = true;
    setStatus("saving");
    try {
      const result = await host.canvas!({ action: "save", file: metaRef.current.file, text: serializeCanvas(target), base: metaRef.current.hash });
      saved.current = target;
      metaRef.current = { ...metaRef.current, hash: result.hash };
      if (!closed.current) { setMeta(metaRef.current); setError(""); setStatus(historyRef.current.canvas === target ? "saved" : "ready"); }
    } catch (failure) {
      if (closed.current) return;
      if ((failure as { code?: string }).code === "EXTERNAL_CHANGE") setConflict(true);
      else setError(errorText(failure));
      setStatus("error");
    } finally {
      saving.current = false;
      if (queued.current) { queued.current = false; void save(); }
    }
  }, [readOnly]);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 600);
  }, [save]);

  const commit = useCallback((next: JsonCanvas | ((current: JsonCanvas) => JsonCanvas)) => {
    if (readOnly) return;
    const current = historyRef.current.canvas;
    let value: JsonCanvas;
    try { value = typeof next === "function" ? next(current) : next; }
    catch (failure) { setNotice(t((failure as Error).message)); return; }
    if (value === current) { setNodes(flowNodes(current, new Set(selection.current), readOnly)); return; }
    const updated = commitCanvas(historyRef.current, value);
    historyRef.current = updated;
    setHistory(updated);
    setStatus("ready");
    schedule();
  }, [readOnly, schedule]);

  const undo = useCallback(() => { const next = undoCanvas(historyRef.current); if (next !== historyRef.current) { historyRef.current = next; setHistory(next); setStatus("ready"); schedule(); } }, [schedule]);
  const redo = useCallback(() => { const next = redoCanvas(historyRef.current); if (next !== historyRef.current) { historyRef.current = next; setHistory(next); setStatus("ready"); schedule(); } }, [schedule]);

  // Clips from Learning arrive as one gesture, placed beside whatever is in view.
  const placed = useRef<CanvasNode[] | undefined>(undefined);
  useEffect(() => {
    if (!clips?.length || placed.current === clips) return;
    placed.current = clips;
    if (readOnly) { setNotice(t("This board is read-only; the clip was not added.")); return; }
    const box = document.querySelector(".canvas-flow")?.getBoundingClientRect();
    const center = box ? flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }) : { x: 0, y: 0 };
    commit(current => {
      const taken = canvasIds(current);
      let next = current, offset = 0;
      for (const clip of clips) {
        const id = newCanvasId(taken); taken.add(id);
        next = addNode(next, { ...clip, id, x: snapToGrid(center.x - clip.width / 2 + offset), y: snapToGrid(center.y - clip.height / 2 + offset) });
        offset += canvasLimits.grid * 2;
      }
      return next;
    });
    setNotice(t("Clip added to the board."));
  }, [clips, commit, flow, readOnly]);

  const reload = useCallback((board: CanvasBoard) => {
    const next = parseCanvas(board.text);
    saved.current = next.canvas;
    const fresh = canvasHistory(next.canvas);
    historyRef.current = fresh;
    setHistory(fresh);
    setIssues(next.issues);
    metaRef.current = { file: board.file, name: board.name, hash: board.hash };
    setMeta(metaRef.current);
    setConflict(false);
    setStatus("saved");
  }, []);

  // Another app may edit the board: a clean board follows the disk, a dirty one asks first.
  useEffect(() => {
    const check = () => {
      if (closed.current || saving.current || conflictRef.current) return;
      void host.canvas!({ action: "read", file: metaRef.current.file }).then((board: CanvasBoard) => {
        if (closed.current || board.hash === metaRef.current.hash) return;
        if (dirty()) { setConflict(true); return; }
        reload(board);
        setNotice(t("Reloaded the board from disk."));
      }).catch(() => {});
      loadNotes(noteFiles, true);
    };
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [loadNotes, noteFiles, reload]);

  const keepMine = async () => {
    try {
      const disk: CanvasBoard = await host.canvas!({ action: "read", file: metaRef.current.file });
      metaRef.current = { ...metaRef.current, hash: disk.hash };
      conflictRef.current = false;
      setConflict(false);
      saved.current = {};
      await save();
    } catch (failure) { setError(errorText(failure)); }
  };
  const loadDisk = async () => {
    try { reload(await host.canvas!({ action: "read", file: metaRef.current.file })); setNotice(t("Reloaded the board from disk.")); }
    catch (failure) { setError(errorText(failure)); }
  };
  const saveCopy = async () => {
    try {
      const file = metaRef.current.file, slash = file.lastIndexOf("/");
      const copy: CanvasBoard = await host.canvas!({ action: "create", folder: slash < 0 ? "" : file.slice(0, slash), name: t("{{name}} copy", { name: metaRef.current.name.replace(/\.canvas$/i, "") }) });
      const text = serializeCanvas(historyRef.current.canvas);
      const result = await host.canvas!({ action: "save", file: copy.file, text, base: copy.hash });
      saved.current = historyRef.current.canvas;
      metaRef.current = { file: copy.file, name: copy.name, hash: result.hash };
      setMeta(metaRef.current);
      localStorage.setItem(lastBoardKey(vault), copy.file);
      setConflict(false);
      setStatus("saved");
      setNotice(t("Saved your edits as {{name}}.", { name: copy.name }));
    } catch (failure) { setError(errorText(failure)); }
  };

  const dismiss = useCallback(() => {
    if (conflictRef.current && dirty() && !window.confirm(t("Close and discard your unsaved board edits?"))) return false;
    if (timer.current || (dirty() && !conflictRef.current)) void save();
    closed.current = true;
    close();
    return true;
  }, [close, save]);

  const savedViewport = useMemo(() => {
    try {
      const value = JSON.parse(localStorage.getItem(viewportKey(vault, initial.file)) || "null");
      return value && [value.x, value.y, value.zoom].every(Number.isFinite) ? value as Viewport : undefined;
    } catch { return undefined; }
  }, [vault, initial.file]);

  const onNodesChange = useCallback((changeset: NodeChangeset<Card>) => {
    const changes = changeset.toArray();
    const moving = drag.current;
    const extra: NodeChange<Card>[] = [];
    if (moving) for (const change of changes) {
      if (change.type !== "position" || !change.position || !moving.followers.has(change.id)) continue;
      const origin = moving.start.get(change.id)!;
      const dx = change.position.x - origin.x, dy = change.position.y - origin.y;
      for (const member of moving.followers.get(change.id)!) {
        if (changes.some(item => item.type === "position" && item.id === member)) continue;
        const start = moving.start.get(member);
        if (start) extra.push({ type: "position", id: member, position: { x: start.x + dx, y: start.y + dy } });
      }
    }
    // Arrow keys move selected cards; each press is one gesture so undo steps back one move.
    if (!moving && !resizing.current) {
      const keyed = changes.filter(change => change.type === "position" && change.dragging === false && change.position);
      if (keyed.length) {
        const first = keyed[0] as Extract<NodeChange<Card>, { type: "position" }>;
        const node = canvasNodes(historyRef.current.canvas).find(item => item.id === first.id);
        if (node) { commit(current => moveNodes(current, keyed.map(change => (change as { id: string }).id), first.position!.x - node.x, first.position!.y - node.y)); return; }
      }
    }
    if (extra.length) changeset.add(extra);
    setNodes(current => changeset.applyTo(current));
  }, [commit]);

  const onEdgesChange = useCallback((changes: EdgeChangeset) => setEdges(current => changes.applyTo(current)), []);

  const onNodeDragStart = useCallback((_: unknown, __: Card, dragged: Card[]) => {
    const current = historyRef.current.canvas, byId = new Map(canvasNodes(current).map(node => [node.id, node]));
    const start = new Map<string, { x: number; y: number }>(), followers = new Map<string, string[]>();
    for (const node of dragged) {
      start.set(node.id, { ...node.position });
      if (node.type === "group") followers.set(node.id, groupMembers(current, node.id));
    }
    for (const members of followers.values()) for (const id of members) if (!start.has(id) && byId.has(id)) start.set(id, { x: byId.get(id)!.x, y: byId.get(id)!.y });
    drag.current = { start, followers };
  }, []);

  const onNodeDragStop = useCallback((_: unknown, lead: Card, dragged: Card[]) => {
    const moving = drag.current;
    drag.current = null;
    if (!moving) return;
    const origin = moving.start.get(lead.id) ?? lead.position;
    const dx = lead.position.x - origin.x, dy = lead.position.y - origin.y;
    commit(current => dx || dy ? moveNodes(current, dragged.map(node => node.id), dx, dy) : current);
  }, [commit]);

  const onSelectionChange = useCallback(({ nodes: chosen, edges: lines }: OnSelectionChangeParams) => {
    const ids = new Set(chosen.map(node => node.id));
    selection.current = [...selection.current.filter(id => ids.has(id)), ...chosen.map(node => node.id).filter(id => !selection.current.includes(id))];
    setSelected(selection.current);
    setSelectedEdges(lines.map(edge => edge.id));
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source === connection.target) return;
    commit(current => addEdge(current, {
      id: newCanvasId(canvasIds(current)), fromNode: connection.source, toNode: connection.target,
      ...(connection.sourceHandle ? { fromSide: connection.sourceHandle as CanvasSide } : {}), ...(connection.targetHandle ? { toSide: connection.targetHandle as CanvasSide } : {}),
    }));
  }, [commit]);

  const remove = useCallback((nodeIds: string[], edgeIds: string[]) => {
    if (!nodeIds.length && !edgeIds.length) return;
    selection.current = selection.current.filter(id => !nodeIds.includes(id));
    commit(current => removeItems(current, nodeIds, edgeIds));
  }, [commit]);

  const onBeforeDelete = useCallback(async ({ nodes: gone, edges: lines }: { nodes: Card[]; edges: Edge[] }) => {
    remove(gone.map(node => node.id), lines.map(edge => edge.id));
    return false;
  }, [remove]);

  const addText = useCallback(() => {
    const box = document.querySelector(".canvas-flow")?.getBoundingClientRect();
    const center = box ? flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }) : { x: 0, y: 0 };
    const id = newCanvasId(canvasIds(historyRef.current.canvas));
    selection.current = [id];
    commit(current => addNode(current, { id, type: "text", text: "", x: snapToGrid(center.x - 130), y: snapToGrid(center.y - 70), width: 260, height: 140 }));
    setEditing(id);
  }, [commit, flow]);

  const group = useCallback(() => {
    if (!selection.current.length) return;
    let created = "";
    commit(current => { const result = groupNodes(current, selection.current, { id: newCanvasId(canvasIds(current)), label: t("Group") }); created = result.group.id; return result.canvas; });
    if (created) { selection.current = [created]; setEditing(created); }
  }, [commit]);

  const connect = useCallback(() => {
    const [from, to] = selection.current;
    if (!from || !to) return;
    commit(current => {
      const byId = new Map(canvasNodes(current).map(node => [node.id, node]));
      const [fromSide, toSide] = nearestSides(byId.get(from)!, byId.get(to)!);
      return addEdge(current, { id: newCanvasId(canvasIds(current)), fromNode: from, fromSide, toNode: to, toSide });
    });
  }, [commit]);

  const cards = useMemo<CardContext>(() => ({
    readOnly, editing, notes, edit: setEditing,
    commitText: (id, key, value) => commit(current => updateNode(current, id, { [key]: value })),
    resizeStart: () => { resizing.current = true; },
    resized: (id, rect) => {
      resizing.current = false;
      commit(current => setGeometry(current, { [id]: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(canvasLimits.minSize, snapToGrid(rect.width)), height: Math.max(canvasLimits.minSize, snapToGrid(rect.height)) } }));
    },
    openFile: (file, subpath) => {
      const text = notes[file]?.text;
      const found = text === undefined ? null : locateSubpath(text, subpath);
      if (subpath && !found) { setNotice(t("Heading not found in note")); return; }
      if (!dismiss()) return;
      openNote(file, (found?.start ?? 0) + 1);
    },
    openSource: node => {
      const source = clipSource(node);
      if (!source) return;
      const text = notes[source.file]?.text;
      const line = text === undefined ? null : quoteLine(text, source);
      if (line === null) { setNotice(t("The source passage moved or changed. The snapshot is kept as clipped.")); return; }
      if (!dismiss()) return;
      openNote(source.file, line);
    },
  }), [readOnly, editing, notes, commit, dismiss, openNote]);

  const clipText = useMemo(() => {
    const byId = new Map(canvasNodes(canvas).map(node => [node.id, node]));
    return selected.map(id => byId.get(id)).filter((node): node is CanvasNode & { text: string } => !!node && node.type === "text" && !!clipSource(node))
      .map(node => String(node.text)).join("\n\n---\n\n");
  }, [canvas, selected]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (editable(event.target)) return;
    const mod = event.metaKey || event.ctrlKey, key = event.key.toLowerCase();
    if (mod && key === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    else if (mod && key === "y") { event.preventDefault(); redo(); }
    else if (mod && key === "g" && !readOnly) { event.preventDefault(); group(); }
    else if (mod && key === "l" && !readOnly) { event.preventDefault(); connect(); }
    else if (mod && key === "enter" && !readOnly) { event.preventDefault(); addText(); }
    else if ((event.key === "Enter" || event.key === "F2") && !readOnly && selection.current.length === 1) {
      // Enter on another focused card selects that card; it must not edit the one selected before.
      const focused = (event.target as HTMLElement).closest?.(".react-flow__node")?.getAttribute("data-id");
      if (focused && focused !== selection.current[0]) return;
      const node = canvasNodes(canvas).find(item => item.id === selection.current[0]);
      if (node && (node.type === "text" || node.type === "group")) { event.preventDefault(); setEditing(node.id); }
    }
    else if (event.key === "Escape" && !selection.current.length && !preview) { event.preventDefault(); dismiss(); }
  };

  const dangling = issues.some(issue => issue.kind === "dangling-edge");
  const colorMode = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const aria = useMemo(() => ({
    "node.a11yDescription.default": t("Press Enter or Space to select a card. Arrow keys move it, Delete removes it, Enter edits text."),
    "node.a11yDescription.keyboardDisabled": t("Press Enter or Space to select a card."),
    "node.a11yDescription.ariaLiveMessage": ({ x, y }: { x: number; y: number }) => t("Moved card to {{x}}, {{y}}", { x, y }),
    "edge.a11yDescription.default": t("Press Enter or Space to select a connection. Delete removes it."),
    "controls.ariaLabel": t("Board view controls"), "controls.zoomIn.ariaLabel": t("Zoom in"), "controls.zoomOut.ariaLabel": t("Zoom out"),
    "controls.fitView.ariaLabel": t("Fit board to view"), "controls.interactive.ariaLabel": t("Lock board"), "minimap.ariaLabel": t("Board overview"),
    "handle.ariaLabel": t("Connection point"),
  }), []);

  return <div className="board-backdrop canvas-backdrop" role="dialog" aria-modal="true" aria-label={meta.name} onKeyDown={onKeyDown}>
    <section className="board-shell canvas-shell">
      <header className="board-heading">
        <div><strong>{meta.name.replace(/\.canvas$/i, "")}</strong><span className="board-hint">{meta.file} · {t("JSON Canvas · opens in Obsidian")}</span></div>
        <div className="board-status" role="status" aria-live="polite">
          {status === "saving" && <Loader2 size={14} className="board-spin" />}
          {status === "saved" && <Save size={14} />}
          <span>{readOnly ? t("Read-only") : status === "saving" ? t("Saving…") : status === "error" ? t("Not saved") : status === "saved" ? t("Saved") : dirty() ? t("Unsaved changes") : t("Saved")}</span>
        </div>
        <button type="button" className="board-close" aria-label={t("Close board")} onClick={dismiss}><X size={18} /></button>
      </header>
      {readOnly && <p className="board-warning" role="alert">{t("This board has cards Omarkie cannot edit. It is open read-only so nothing is lost.")}</p>}
      {dangling && !readOnly && <p className="board-warning">{t("Some connections point to missing cards and are hidden.")}</p>}
      {conflict && <div className="board-warning canvas-conflict" role="alert">
        <span>{t("The board changed on disk. Your edits are kept.")}</span>
        <button type="button" onClick={() => void keepMine()}>{t("Keep my version")}</button>
        <button type="button" onClick={() => void loadDisk()}>{t("Load disk version")}</button>
        <button type="button" onClick={() => void saveCopy()}>{t("Save mine as a copy")}</button>
      </div>}
      {error && <p className="board-warning" role="alert">{error}</p>}
      {notice && <p className="canvas-notice" role="status" onAnimationEnd={() => setNotice("")}>{notice}</p>}
      <Cards.Provider value={cards}>
        <div className="board-canvas canvas-flow">
          <ReactFlow<Card> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onNodeDragStart={onNodeDragStart} onNodeDragStop={onNodeDragStop} onSelectionDragStart={(event, dragged) => onNodeDragStart(event, dragged[0], dragged)}
            onSelectionDragStop={(event, dragged) => dragged[0] && onNodeDragStop(event, dragged[0], dragged)}
            onSelectionChange={onSelectionChange} onConnect={onConnect} onBeforeDelete={onBeforeDelete} isValidConnection={connection => connection.source !== connection.target}
            connectionMode={ConnectionMode.Loose} snapToGrid snapGrid={[canvasLimits.grid, canvasLimits.grid]} elevateNodesOnSelect={false} elevateEdgesOnSelect
            nodesDraggable={!readOnly} nodesConnectable={!readOnly} edgesReconnectable={false} deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
            multiSelectionKeyCode={["Shift", "Meta", "Control"]} zoomOnDoubleClick={false} minZoom={0.1} maxZoom={4}
            defaultViewport={savedViewport} fitView={!savedViewport} fitViewOptions={{ padding: 0.15 }}
            onMoveEnd={(_, viewport) => localStorage.setItem(viewportKey(vault, meta.file), JSON.stringify(viewport))}
            forceColorMode={colorMode} ariaLabelConfig={aria} proOptions={{ hideAttribution: true }} aria-label={t("Board cards")}>
            <Background gap={canvasLimits.grid} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable />
            <Panel position="top-left" className="canvas-toolbar" aria-label={t("Board tools")}>
              {!readOnly && <>
                <button type="button" onClick={addText} title={`${t("Add text card")} (Ctrl+Enter)`}><StickyNote size={15} />{t("Text card")}</button>
                <button type="button" onClick={group} disabled={!selected.length} title={`${t("Group selected cards")} (Ctrl+G)`}><Group size={15} />{t("Group")}</button>
                <button type="button" onClick={connect} disabled={selected.length < 2} title={`${t("Connect the first selected card to the second")} (Ctrl+L)`}><Link2 size={15} />{t("Connect")}</button>
                <button type="button" onClick={() => remove(selection.current, selectedEdges)} disabled={!selected.length && !selectedEdges.length} title={`${t("Delete")} (Delete)`} aria-label={t("Delete")}><Trash2 size={15} /></button>
                <button type="button" onClick={undo} disabled={!history.past.length} title={`${t("Undo")} (Ctrl+Z)`} aria-label={t("Undo")}><Undo2 size={15} /></button>
                <button type="button" onClick={redo} disabled={!history.future.length} title={`${t("Redo")} (Ctrl+Shift+Z)`} aria-label={t("Redo")}><Redo2 size={15} /></button>
              </>}
              {askTutor && <button type="button" onClick={() => setPreview(clipText)} disabled={!clipText} title={t("Ask Tutor about the selected clips")}><Sparkles size={15} />{t("Ask Tutor")}</button>}
            </Panel>
          </ReactFlow>
        </div>
      </Cards.Provider>
      {preview !== null && <div className="canvas-preview" role="dialog" aria-modal="true" aria-label={t("Context sent to Tutor")}>
        <h3>{t("Context sent to Tutor")}</h3>
        <p className="board-hint">{t("Only these selected clips are shared. Nothing else on the board is sent.")}</p>
        <pre>{preview}</pre>
        <div className="canvas-preview-actions">
          <button type="button" onClick={() => setPreview(null)}>{t("Cancel")}</button>
          <button type="button" className="canvas-primary" autoFocus onClick={() => { const text = preview; setPreview(null); askTutor?.(text); }}>{t("Open in Tutor")}</button>
        </div>
      </div>}
    </section>
  </div>;
}

function Picker({ vault, close, open, problem }: { vault: string; close(): void; open(board: CanvasBoard): void; problem: string }) {
  const [files, setFiles] = useState<{ file: string; name: string }[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState(problem);
  useEffect(() => {
    void host.canvas!({ action: "list" }).then(result => setFiles(result.files)).catch(failure => setError(errorText(failure)));
  }, [vault]);
  const choose = (file: string) => void host.canvas!({ action: "read", file }).then(open).catch(failure => setError(errorText(failure)));
  const create = () => void host.canvas!({ action: "create", name: name.trim() || t("Untitled board") }).then(open).catch(failure => setError(errorText(failure)));
  return <div className="board-picker-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }} onKeyDown={event => { if (event.key === "Escape") close(); }}>
    <section className="board-picker canvas-picker" role="dialog" aria-modal="true" aria-label={t("Canvas boards")}>
      <header><h2>{t("Canvas boards")}</h2><button type="button" aria-label={t("Close")} onClick={close}>×</button></header>
      {error && <p className="board-warning" role="alert">{error}</p>}
      {!files && !error && <p className="board-hint"><Loader2 size={13} className="board-spin" /> {t("Loading boards…")}</p>}
      {files && !files.length && <p className="board-hint">{t("No .canvas boards in this folder yet.")}</p>}
      {!!files?.length && <ul>{files.map(file => <li key={file.file}><button type="button" onClick={() => choose(file.file)}>{file.name.replace(/\.canvas$/i, "")}<span>{file.file}</span></button></li>)}</ul>}
      <form onSubmit={event => { event.preventDefault(); create(); }}>
        <input value={name} onChange={event => setName(event.target.value)} placeholder={t("Untitled board")} aria-label={t("New board name")} autoFocus />
        <button type="submit" className="board-picker-new">{t("New board")}</button>
      </form>
    </section>
  </div>;
}

export default function CanvasView({ vault, request, close, openNote, askTutor }: CanvasViewProps) {
  const [board, setBoard] = useState<CanvasBoard | null>(null);
  const [error, setError] = useState("");
  const wanted = request.file ?? (request.last ? localStorage.getItem(lastBoardKey(vault)) ?? undefined : undefined);
  const [file, setFile] = useState(wanted);
  useEffect(() => {
    document.documentElement.classList.add("board-open");
    return () => { document.documentElement.classList.remove("board-open"); };
  }, []);
  useEffect(() => {
    setFile(wanted);
    if (!wanted) setBoard(null);
  }, [request.at, wanted]);
  useEffect(() => {
    if (!file || board?.file === file) return;
    let live = true;
    void host.canvas!({ action: "read", file }).then((value: CanvasBoard) => { if (live) setBoard(value); })
      .catch(failure => { if (!live) return; localStorage.removeItem(lastBoardKey(vault)); setError(errorText(failure)); setFile(undefined); });
    return () => { live = false; };
  }, [file, board?.file, vault]);
  const open = (value: CanvasBoard) => { localStorage.setItem(lastBoardKey(vault), value.file); setError(""); setBoard(value); setFile(value.file); };
  if (!file) return <Picker vault={vault} close={close} open={open} problem={error} />;
  if (!board) return <div className="board-picker-backdrop" role="status"><Loader2 size={22} className="board-spin" /></div>;
  return <ReactFlowProvider>
    <Board key={`${board.file}:${board.hash}`} board={board} vault={vault} clips={request.clips} close={close} openNote={openNote} askTutor={askTutor} />
  </ReactFlowProvider>;
}
