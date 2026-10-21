import { parseBlocks } from "./markdown.ts";
import type { Block } from "./markdown.ts";
import type { DocumentHeading, FootnoteDefinition } from "./markdownExtensions.ts";
export interface SelectionBookmark {
  anchor: number;
  head: number;
}
export interface DocumentNode {
  id: string;
  from: number;
  to: number;
  source: string;
  kind: string;
  line: number;
}
export interface DocumentRoot {
  children: DocumentNode[];
}
interface Snapshot {
  text: string;
  selection: SelectionBookmark;
}
// Undo stores the edit, not two copies of the document: large files keep a full history.
interface Command {
  from: number;
  removed: string;
  inserted: string;
  before: SelectionBookmark;
  after: SelectionBookmark;
  kind: string;
  time: number;
}
// Beyond these the rich view falls back to source mode: a single element would hold the block.
export const richTextLimit = 12_000_000;
export const richBlockLimit = 256_000;
let sequence = 0;
const newlines = (text: string) => {
  let count = 0;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count++;
  return count;
};
// Blocks keep their ids across parses: exact matches first, then same-kind blocks at the same position.
function assignIds(old: DocumentNode[], blocks: Block[]) {
  const used = new Set<string>(), reusable = new Map<string, DocumentNode[]>();
  for (const node of old) {
    const key = node.kind + "\u0001" + node.source, list = reusable.get(key);
    if (list) list.push(node); else reusable.set(key, [node]);
  }
  const ids: (string | undefined)[] = blocks.map(block => {
    const list = reusable.get(block.kind + "\u0001" + block.source);
    while (list?.length) { const node = list.shift()!; if (!used.has(node.id)) { used.add(node.id); return node.id; } }
    return undefined;
  });
  return ids.map((id, index) => {
    if (id) return id;
    const same = old[index];
    if (same && same.kind === blocks[index].kind && !used.has(same.id)) { used.add(same.id); return same.id; }
    return `node-${++sequence}`;
  });
}
export class MarkdownDocument {
  text: string;
  nodes: DocumentNode[] = [];
  environment: Record<string, unknown> = {};
  selection: SelectionBookmark;
  lines = 1;
  largestBlock = 0;
  private byId: Map<string, DocumentNode> | null = null;
  private children: DocumentNode[] | null = null;
  // Blocks plus the separators between them: built on demand, it covers the text exactly.
  get root(): DocumentRoot {
    if (!this.children) {
      const children: DocumentNode[] = [];
      let end = 0;
      for (const node of this.nodes) {
        if (node.from > end) children.push({ id: `source-gap-${end}`, from: end, to: node.from, source: this.text.slice(end, node.from), kind: "separator", line: 0 });
        children.push(node);
        end = node.to;
      }
      if (end < this.text.length) children.push({ id: `source-gap-${end}`, from: end, to: this.text.length, source: this.text.slice(end), kind: "separator", line: 0 });
      this.children = children;
    }
    return { children: this.children };
  }
  private original: string;
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private group = false;
  private compositionSession: { entry: Snapshot; undo: Command[]; redo: Command[] } | null = null;
  beginComposition() {
    if (this.compositionSession) return;
    this.closeGroup();
    this.compositionSession = { entry: { text:this.text,selection:{...this.selection} }, undo:this.undoStack, redo:this.redoStack };
    this.undoStack=[]; this.redoStack=[];
  }
  endComposition() {
    const session=this.compositionSession; if (!session) return false;
    const after={text:this.text,selection:{...this.selection}};
    this.undoStack=session.undo; this.redoStack=session.redo;
    this.text=session.entry.text; this.selection=session.entry.selection; this.compositionSession=null;
    this.closeGroup();
    const changed=this.replace(0,this.text.length,after.text,"composition",after.selection);
    this.closeGroup(); return changed;
  }
  private sourceSession: {
    entry: Snapshot;
    undo: Command[];
    redo: Command[];
  } | null = null;
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  beginSourceSession() {
    if (this.sourceSession) return;
    this.closeGroup();
    this.sourceSession = {
      entry: { text: this.text, selection: { ...this.selection } },
      undo: this.undoStack,
      redo: this.redoStack,
    };
    this.undoStack = [];
    this.redoStack = [];
  }
  endSourceSession() {
    const session = this.sourceSession;
    if (!session) return;
    const after = { text: this.text, selection: { ...this.selection } };
    this.undoStack = session.undo;
    this.redoStack = session.redo;
    this.text = session.entry.text;
    this.selection = session.entry.selection;
    this.sourceSession = null;
    this.closeGroup();
    this.replace(
      0,
      this.text.length,
      after.text,
      "source-session",
      after.selection,
    );
    this.closeGroup();
  }
  lineEnding: string;
  constructor(source: string, lineEnding = "\n") {
    this.lineEnding = lineEnding;
    this.original = source;
    this.text = source.replace(/\r\n?/g, "\n");
    this.selection = { anchor: this.text.length, head: this.text.length };
    this.parse();
  }
  // The block tree always covers the text exactly (tests/model-fastpath asserts it).
  serialize() {
    return this.text;
  }
  private normalizedOriginal: string | null = null;
  toMarkdown() {
    this.normalizedOriginal ??= this.original.replace(/\r\n?/g, "\n");
    if (this.text === this.normalizedOriginal) return this.original;
    return this.lineEnding === "\n" ? this.text : this.text.replace(/\n/g, this.lineEnding);
  }
  // Too large for one rich view: the caller shows the source instead.
  oversized() {
    return this.text.length > richTextLimit || this.largestBlock > richBlockLimit;
  }
  private parse() {
    const old = this.nodes;
    if (this.text.length > richTextLimit) {
      // Source mode only: no block tree is built for a text this large.
      this.nodes = [];
      this.lines = 1 + newlines(this.text);
      this.largestBlock = this.text.length;
      this.children = [{ id: "raw-source", from: 0, to: this.text.length, source: this.text, kind: "source", line: 1 }];
      this.byId = null;
      return;
    }
    const offsets = [0];
    for (let at = this.text.indexOf("\n"); at >= 0; at = this.text.indexOf("\n", at + 1)) offsets.push(at + 1);
    this.lines = offsets.length;
    this.environment = {};
    const blocks = parseBlocks(this.text, this.environment), ids = assignIds(old, blocks);
    this.nodes = blocks.map((block, index) => ({
      id: ids[index],
      from: offsets[block.fromLine - 1],
      to: (offsets[block.toLine] ?? this.text.length + 1) - 1,
      source: block.source,
      kind: block.kind,
      line: block.fromLine,
    }));
    this.finish(old.find(node => node.kind === "empty" && !node.id.startsWith("gap-"))?.id);
  }
  // Shared tail of every parse: caret block, trailing block, separators and lookup state.
  private finish(trailingId: string | undefined) {
    // A whitespace-only last line belongs to no block; the trailing block keeps it so the caret stays there.
    const tail = this.text.slice(this.text.lastIndexOf("\n") + 1);
    if (!this.nodes.length || this.text.endsWith("\n") || (!tail.trim() && !this.covering(this.text.length)))
      this.nodes.push({
        id: trailingId || `node-${++sequence}`,
        from: this.text.length - tail.length,
        to: this.text.length,
        source: tail,
        kind: "empty",
        line: this.lines,
      });
    const caret = this.selection.head;
    if (caret < this.text.length && !this.covering(caret)) {
      this.nodes.push({ id: `gap-${caret}`, from: caret, to: caret, source: "", kind: "empty", line: this.lineAt(caret) });
      this.nodes.sort((a, b) => a.from - b.from);
    }
    let largest = 0;
    for (const node of this.nodes) if (node.source.length > largest) largest = node.source.length;
    this.largestBlock = largest;
    this.children = null;
    this.byId = null;
  }
  closeGroup() {
    this.group = false;
  }
  // Only the synthetic caret block depends on the selection; skip the full parse when it is unchanged.
  refreshCaret() {
    const caret = this.selection.head, gaps = this.nodes.filter(node => node.id.startsWith("gap-"));
    const covered = caret >= this.text.length || this.nodes.some(node => !node.id.startsWith("gap-") && caret >= node.from && caret <= node.to);
    if (this.nodes.length && (covered ? !gaps.length : gaps.length === 1 && gaps[0].from === caret)) return;
    this.parse();
  }
  replace(
    from: number,
    to: number,
    insert: string,
    kind = "command",
    selection?: SelectionBookmark,
  ) {
    from = Math.max(0, Math.min(from, this.text.length));
    to = Math.max(from, Math.min(to, this.text.length));
    insert = insert.replace(/\r\n?/g, "\n");
    const before = { text: this.text, selection: { ...this.selection } };
    selection ??= { anchor: from + insert.length, head: from + insert.length };
    // Whole-range replacements (source mode, transforms) usually change a small middle part.
    const removed = this.text.slice(from, to), shortest = Math.min(removed.length, insert.length);
    let head = 0, tail = 0;
    while (head < shortest && removed.charCodeAt(head) === insert.charCodeAt(head)) head++;
    while (tail < shortest - head && removed.charCodeAt(removed.length - 1 - tail) === insert.charCodeAt(insert.length - 1 - tail)) tail++;
    from += head; to -= tail; insert = insert.slice(head, insert.length - tail);
    const deleted = removed.slice(head, removed.length - tail);
    this.text = this.text.slice(0, from) + insert + this.text.slice(to);
    this.selection = selection;
    if (from === to && !insert) return false;
    const now = Date.now(),
      previous = this.undoStack.at(-1),
      end = previous ? previous.from + previous.inserted.length : -1;
    const grouped =
      this.group &&
      ["typing", "composition"].includes(kind) &&
      previous?.kind === kind &&
      (kind === "composition" || now - previous.time < 800) &&
      previous.after.head === before.selection.head &&
      before.selection.anchor === before.selection.head;
    if (grouped && !deleted && from === end) previous.inserted += insert;
    else if (grouped && !insert && to === end && from >= previous.from) previous.inserted = previous.inserted.slice(0, from - previous.from);
    else if (grouped && !insert && to === end && from < previous.from) {
      previous.removed = deleted.slice(0, previous.from - from) + previous.removed;
      previous.inserted = "";
      previous.from = from;
    } else {
      this.undoStack.push({ from, removed: deleted, inserted: insert, before: before.selection, after: { ...this.selection }, kind, time: now });
      if (this.undoStack.length > 100) this.undoStack.shift();
    }
    if (this.undoStack.at(-1) === previous && previous) { previous.after = { ...this.selection }; previous.time = now; }
    while (
      this.undoStack.length > 1 &&
      this.undoStack.reduce((bytes, command) => bytes + 2 * (command.removed.length + command.inserted.length), 0) > 16 * 1024 * 1024
    )
      this.undoStack.shift();
    this.group = ["typing", "composition"].includes(kind);
    this.redoStack = [];
    if (!this.patch(from, to, insert, before.text) && !this.patchWindow(from, to, insert, before.text)) this.parse();
    return true;
  }
  // Fast path for typing inside one top-level paragraph: re-parse only that paragraph and shift
  // the blocks after it. Anything that could change block structure or footnote/reference state
  // falls back to the windowed parse.
  private patch(from: number, to: number, insert: string, previous: string) {
    if (/[\n|[\]^$]/.test(insert + previous.slice(from, to))) return false;
    const old = this.nodes.filter(node => !node.id.startsWith("gap-"));
    const trailing = old.at(-1)?.kind === "empty" && old.at(-1)!.to === previous.length ? old.pop() : undefined;
    let low = 0, high = old.length - 1, index = -1;
    while (low <= high) {
      const middle = (low + high) >> 1, node = old[middle];
      if (to < node.from) high = middle - 1;
      else if (from > node.to) low = middle + 1;
      else { index = from >= node.from && to <= node.to ? middle : -1; break; }
    }
    const node = old[index];
    if (!node || node.kind !== "paragraph_open") return false;
    const delta = insert.length - (to - from);
    const source = this.text.slice(node.from, node.to + delta);
    // An indented first line may continue the previous list item; the windowed parse decides.
    if (/^[ \t]/.test(source) || /^[ \t]/.test(node.source)) return false;
    const blocks = parseBlocks(source, {});
    if (blocks.length !== 1 || blocks[0].kind !== "paragraph_open" || blocks[0].source !== source) return false;
    node.to += delta;
    node.source = source;
    for (let at = index + 1; at < old.length; at++) { const item = old[at]; item.from += delta; item.to += delta; }
    this.nodes = old;
    this.finish(trailing?.id);
    return true;
  }
  // Windowed re-parse: parse the edited blocks plus one unchanged block of context on each side.
  // The window converged when both context blocks come back unchanged; the rest of the document
  // only shifts. Headings keep their ids when the window's heading list is unchanged; footnotes
  // and reference definitions are document-global and go through the full parse.
  private patchWindow(from: number, to: number, insert: string, previous: string) {
    if (this.text.length > richTextLimit) return false;
    const old = this.nodes.filter(node => !node.id.startsWith("gap-"));
    const trailing = old.at(-1)?.kind === "empty" && old.at(-1)!.to === previous.length ? old.pop() : undefined;
    if (!old.length) return false;
    const last = old.length - 1;
    let lo = 0, high = last;
    while (lo <= high) { const middle = (lo + high) >> 1; if (old[middle].to >= from) high = middle - 1; else lo = middle + 1; }
    let hi = -1; high = last;
    let low = 0;
    while (low <= high) { const middle = (low + high) >> 1; if (old[middle].from <= to) { hi = middle; low = middle + 1; } else high = middle - 1; }
    let start = Math.max(0, Math.min(lo, hi)), end = Math.min(last, Math.max(lo, hi));
    // An edit touching a separator can join or split the neighbouring block as well.
    if (from <= old[start].from && start > 0) start--;
    if (to >= old[end].to && end < last) end++;
    const s = Math.max(0, start - 1), e = Math.min(last, end + 1);
    // Lists own their trailing blank lines, so the window runs up to the next block's first line.
    const windowFrom = s === 0 ? 0 : old[s].from, windowTo = e === last ? previous.length : old[e + 1].from;
    const delta = insert.length - (to - from);
    const oldSlice = previous.slice(windowFrom, windowTo), newSlice = this.text.slice(windowFrom, windowTo + delta);
    // Document-global state, a front-matter marker that only the document start may own, or a
    // display-math line: an unclosed $$ is rejected rather than extended, so its closer may sit
    // beyond the window.
    const global = /\[\^|^ {0,3}\[[^\]]*\]:|^\s*(?:[>*+-]\s*|\d+[.)]\s*)*\$\$/m;
    if (global.test(oldSlice) || global.test(newSlice)) return false;
    if (oldSlice.startsWith("---") || newSlice.startsWith("---")) return false;
    const lineBase = s === 0 ? 1 : old[s].line, oldLastLine = lineBase + newlines(oldSlice) - (oldSlice.endsWith("\n") ? 1 : 0);
    const environment: { headings?: DocumentHeading[] } = {};
    const blocks = parseBlocks(newSlice, environment);
    const offsets = [0];
    for (let at = newSlice.indexOf("\n"); at >= 0; at = newSlice.indexOf("\n", at + 1)) offsets.push(at + 1);
    const mapped = blocks.map(block => ({
      from: windowFrom + offsets[block.fromLine - 1],
      to: windowFrom + (offsets[block.toLine] ?? newSlice.length + 1) - 1,
      source: block.source,
      kind: block.kind,
      line: lineBase - 1 + block.fromLine,
    }));
    const same = (a: DocumentNode, b: { kind: string; source: string } | undefined) => !!b && a.kind === b.kind && a.source === b.source;
    if (s < start && !(same(old[s], mapped[0]) && mapped[0].from === old[s].from)) return false;
    if (e > end && !(same(old[e], mapped.at(-1)) && mapped.at(-1)!.to === old[e].to + delta)) return false;
    const headings = (this.environment.headings as DocumentHeading[] | undefined) || [];
    const windowHeadings = headings.filter(heading => heading.line >= lineBase && heading.line <= oldLastLine);
    const parsedHeadings = environment.headings || [];
    if (windowHeadings.length !== parsedHeadings.length || windowHeadings.some((heading, index) => heading.text !== parsedHeadings[index].text)) return false;
    const lineDelta = newlines(insert) - newlines(previous.slice(from, to));
    const ids = assignIds(old.slice(s, e + 1), blocks);
    const rest = old.slice(e + 1);
    for (const node of rest) { node.from += delta; node.to += delta; node.line += lineDelta; }
    this.lines += lineDelta;
    this.nodes = [...old.slice(0, s), ...mapped.map((block, index) => ({ id: ids[index], ...block })), ...rest];
    this.finish(trailing?.id);
    if (this.environment.headings) {
      this.environment.headings = [
        ...headings.filter(heading => heading.line < lineBase),
        ...parsedHeadings.map((heading, index) => ({ ...heading, line: heading.line + lineBase - 1, id: windowHeadings[index].id })),
        ...headings.filter(heading => heading.line > oldLastLine).map(heading => ({ ...heading, line: heading.line + lineDelta })),
      ];
    }
    const definitions = this.environment.footnoteDefinitions as Record<string, FootnoteDefinition> | undefined;
    if (definitions && lineDelta) {
      const shifted: Record<string, FootnoteDefinition> = {};
      for (const [id, definition] of Object.entries(definitions)) shifted[id] = definition.line > oldLastLine ? { ...definition, line: definition.line + lineDelta } : definition;
      this.environment.footnoteDefinitions = shifted;
    }
    return true;
  }
  replaceExternal(
    source: string,
    lineEnding = source.includes("\r\n") ? "\r\n" : "\n",
  ) {
    this.sourceSession = null;
    this.compositionSession = null;
    this.lineEnding = lineEnding;
    this.original = source;
    this.normalizedOriginal = null;
    this.text = source.replace(/\r\n?/g, "\n");
    this.selection = {
      anchor: Math.min(this.selection.anchor, this.text.length),
      head: Math.min(this.selection.head, this.text.length),
    };
    this.undoStack = [];
    this.redoStack = [];
    this.group = false;
    this.parse();
  }
  undo() {
    const command = this.undoStack.pop();
    if (!command) return false;
    this.redoStack.push(command);
    this.apply(command.from, command.from + command.inserted.length, command.removed, command.before);
    return true;
  }
  redo() {
    const command = this.redoStack.pop();
    if (!command) return false;
    this.undoStack.push(command);
    this.apply(command.from, command.from + command.removed.length, command.inserted, command.after);
    return true;
  }
  private apply(from: number, to: number, insert: string, selection: SelectionBookmark) {
    const previous = this.text;
    this.text = previous.slice(0, from) + insert + previous.slice(to);
    this.selection = { ...selection };
    this.closeGroup();
    if (!this.patch(from, to, insert, previous) && !this.patchWindow(from, to, insert, previous)) this.parse();
  }
  // Index of the first block ending at or after the position; blocks are sorted and disjoint.
  private lowerIndex(position: number) {
    let low = 0, high = this.nodes.length - 1;
    while (low <= high) { const middle = (low + high) >> 1; if (this.nodes[middle].to >= position) high = middle - 1; else low = middle + 1; }
    return low;
  }
  private covering(position: number) {
    const node = this.nodes[this.lowerIndex(position)];
    return node && position >= node.from ? node : undefined;
  }
  nodeAt(position: number) {
    return this.covering(position) || this.nodes.at(-1);
  }
  // Index of the block holding the position, else the nearest block before it.
  nodeIndexNear(position: number) {
    const index = this.lowerIndex(position);
    if (index < this.nodes.length && position >= this.nodes[index].from) return index;
    return Math.max(0, index - 1);
  }
  node(id: string) {
    this.byId ??= new Map(this.nodes.map(node => [node.id, node]));
    return this.byId.get(id);
  }
  // 1-based line of a position, counted from the nearest block instead of the document start.
  lineAt(position: number) {
    const index = this.nodeIndexNear(position), node = this.nodes[index];
    if (!node || node.from > position) return 1 + newlines(this.text.slice(0, position));
    return node.line + newlines(this.text.slice(node.from, position));
  }
  cursorAt(position: number) {
    const lineStart = this.text.lastIndexOf("\n", position - 1) + 1;
    return { line: this.lineAt(position), column: position - lineStart + 1 };
  }
  // Offset of a 1-based line start.
  lineStart(line: number) {
    if (line <= 1) return 0;
    let low = 0, high = this.nodes.length - 1, index = -1;
    while (low <= high) { const middle = (low + high) >> 1; if (this.nodes[middle].line <= line) { index = middle; low = middle + 1; } else high = middle - 1; }
    let at = 0, current = 1;
    if (index >= 0) { at = this.nodes[index].from; current = this.nodes[index].line; }
    while (current < line) { const next = this.text.indexOf("\n", at); if (next < 0) return this.text.length; at = next + 1; current++; }
    return at;
  }
}
