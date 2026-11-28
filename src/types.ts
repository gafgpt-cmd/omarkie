import type { ReadingStore, ReadingTarget } from "../shared/reading-store.ts";
import type { TutorVerb } from "./components/tutor-verbs";
import type { FoldEgress, SlotRoute } from "../shared/fold-route.mjs";

export interface DocumentRecord {
  readingRecoveryWarning?: boolean;
  id: string;
  path: string | null;
  name: string;
  content: string;
  savedContent: string;
  diskHash: string | null;
  lineEnding: string;
  conflict?: boolean;
  missing?: boolean;
  bom?: boolean;
  encoding?: string;
  controlCharacters?: number;
}
export interface FileEntry {
  token: string;
  name: string;
  relative: string;
  path: string;
  isDirectory?: string;
  modified?: string;
  created?: string;
}
export type CanvasRequest = { action: "list" } | { action: "read"; file: string } | { action: "note"; file: string }
  | { action: "save"; file: string; text: string; base: string | null } | { action: "create"; folder?: string; name?: string };
export interface CanvasBoard { file: string; name: string; text: string; hash: string }
export interface CanvasNote { file: string; text?: string; hash?: string; missing?: boolean }
export interface RecentEntry { path: string; name: string; folder: boolean; pinned: boolean }
export interface FileOperation { action: "new-file" | "new-folder" | "duplicate" | "rename" | "move" | "trash" | "undo"; path?: string; name?: string; target?: string }
export interface PathChange { fromPath?: string; toPath?: string; removedPath?: string; newPath?: string }
export interface SearchMatch { token: string; path: string; name: string; line: number; column: number; length: number; preview: string }
export interface SearchResult { matches: SearchMatch[]; truncated: boolean; skipped: number }
export interface FolderResult {
  readingRecoveryWarning?: boolean;
  folder: string | null;
  files: FileEntry[];
  truncated: boolean;
  skipped?: number;
}
export interface Recovery {
  readingRecoveryWarning?: boolean;
  documents: DocumentRecord[];
  activeId?: string;
  folder?: string | null;
  restoreError?: string;
}
export interface DiskChange {
  content?: string;
  diskHash?: string;
  error?: string;
  missing?: boolean;
  moved?: boolean;
  path?: string;
  name?: string;
  encoding?: string;
  bom?: boolean;
}
export interface DiskVersion { content: string; diskHash: string; path: string; name: string; encoding: string; bom: boolean }
export type ConflictRequest =
  { action: "keep-draft" | "keep-disk"; text: string; diskHash: string } |
  { action: "restore"; text: string } |
  { action: "drop-copy" | "use-copy"; token: string };
export interface ConflictResult { record: DocumentRecord; copy?: string; removedPath?: string }
export interface SessionSnapshot {
  documents: DocumentRecord[];
  activeId: string;
  closedId?: string;
}
export interface Command {
  action: string;
  message?: string;
  document?: DocumentRecord;
  anchor?: string;
  line?: number;
  note?: string;
  magnet?: string;
}
export interface VaultNote { token: string; relative: string; content: string; path?: string }
export interface VaultSnapshot { notes: VaultNote[]; assets: { relative: string }[]; truncated: boolean; folder?: string }
export interface BundlePayload { notes: VaultNote[]; assets: { source: string; relative: string }[]; index: string; log: string }
export interface ConversionOptions { bibliography?: string; style?: "vancouver"; letterhead?: { name: string; detail: string } }
export interface PayloadRequest {
  baseUrl: string;
  confirmedOrigin: string;
  allowedOrigin?: string;
  model: string;
  source: string;
  question?: string;
  proposal?: true;
  tutorVerb?: Exclude<TutorVerb, "answer" | "propose">;
  modernLimit: boolean;
}
export interface CitationMatch { id: string; title: string; authors: string }
export interface BibliographyInfo { csl: string; source: string | null; stale: boolean }
interface BibliographyOperations {
  info: BibliographyInfo;
  save: void;
  clear: void;
  link: boolean;
  disconnect: void;
  suggest: CitationMatch[];
  open: void;
}
export type TutorBridgeRequest = { lease: string } & ({ action: "attach" | "detach" } | {
  action: "submit"; target: ReadingTarget; question: string; verb: TutorVerb;
});
export interface FoldRouteView { slot: "ladder" | "estudio"; route: SlotRoute; agent?: string; model?: string; egress: FoldEgress; ready: boolean; code: string | null; message: string | null }
export interface FoldState { noteId: string | null; fold: Record<string, unknown> | null; chunks: { key: string | null; state: string; [field: string]: unknown }[]; stale: number; running: boolean; route: FoldRouteView }
export type FoldProgress = { runId: string; noteId: string; phase: "start" | "chunk" | "done" | "cancelled" | "error"; [field: string]: unknown };
export interface FoldRunRequest { note: string; slot?: "ladder" | "estudio"; sections?: string[]; visible?: string; outLang?: string }
export type TutorReceipt = "queued" | "seen" | "working" | "done";
export type TutorEvent = { lease: string } & (
  { type: "receipt"; id: string; owner: string | null; status: TutorReceipt } |
  { type: "reply"; id: string; owner: string | null; text: string } |
  { type: "agent"; owner: string | null } | { type: "expired"; id: string } | { type: "refresh" }
);
export interface StudySearchMatch { document: string; line: number | null; kind: string; text: string }
export interface Host {
  readingStore?: ReadingStore;
  tutorBridge?(id: string, request: TutorBridgeRequest): Promise<{ id?: string } | undefined>;
  onTutor?(callback: (event: TutorEvent) => void): () => void;
  learningSearch?(id: string, query: string): Promise<StudySearchMatch[]>;
  vaultSnapshot(chaptersOnly?: boolean): Promise<VaultSnapshot>;
  readNotes?(relatives: string[]): Promise<{ relative: string; content: string }[]>;
  bibliography?<T extends keyof BibliographyOperations>(folder: string, action: T, value?: string): Promise<BibliographyOperations[T]>;
  exportBundle(payload: BundlePayload): Promise<string | null>;
  cleanConverted?(body: string): Promise<string | null>;
  native: boolean;
  peek?(token: string): Promise<DiskVersion>;
  resolveConflict?(id: string, request: ConflictRequest): Promise<ConflictResult>;
  cancelClose(): Promise<unknown>;
  windowAction(action: string): Promise<unknown>;
  imageAction(id: string, sources: string[], action: string, options?: Record<string, unknown>): Promise<Record<string, string> | null>;
  imageSizes(id: string, sources: string[]): Promise<Record<string, [number, number]>>;
  themes(): Promise<{ id: string; name: string; css: string }[]>;
  installTheme(): Promise<string | null>;
  omarchyTheme(): Promise<import("./themes").OmarchyPalette | null>;
  spellcheckLanguages(languages?: string[]): Promise<string[]>;
  checkGrammar?(url: string, approvedOrigin: string, text: string): Promise<unknown>;
  setRemoteImages(allow: boolean): Promise<unknown>;
  background(): Promise<import("./background").BackgroundAsset | null>;
  chooseBackground(): Promise<import("./background").BackgroundAsset | null>;
  clearBackground(): Promise<unknown>;
  foldGet?(request: { note: string; slot?: "ladder" | "estudio" }): Promise<FoldState>;
  foldRun?(request: FoldRunRequest): Promise<{ runId: string; noteId: string; outLang: string; route: FoldRouteView }>;
  foldCancel?(request: { noteId: string }): Promise<{ cancelled: boolean }>;
  onFoldProgress?(callback: (event: FoldProgress) => void): () => void;
  plugins(): Promise<{ id: string; name: string; url: string }[]>;
  installPlugin(folder?: boolean): Promise<{ id: string; name: string; url: string } | null>;
  removePlugin(id: string): Promise<unknown>;
  conversionSettings(choose?: boolean): Promise<{ pandoc: string; word: boolean; libreOffice?: string }>;
  importDocument(): Promise<{ html?: string; markdown?: string; name: string } | null>;
  exportConverted(id: string, format: string, source: string, html: string, options?: ConversionOptions): Promise<string | null>;
  exportConverted(project: { folder: string }, format: "docx" | "pdf", chapters: string[], html: "", options?: ConversionOptions): Promise<string | null>;
  restore(): Promise<Recovery | null>;
  showcase(): Promise<FolderResult & { document: DocumentRecord }>;
  registerDraft(record: DocumentRecord): Promise<unknown>;
  open(): Promise<DocumentRecord | null>;
  openFolder(): Promise<FolderResult | null>;
  scan(): Promise<FolderResult>;
  fileOperation(operation: FileOperation): Promise<PathChange | null>;
  onFileOperation(callback: (phase: string, change: PathChange) => Promise<boolean>): () => void;
  recent(): Promise<RecentEntry[]>;
  recentAction(action: string, path?: string): Promise<FolderResult | DocumentRecord | RecentEntry[] | null>;
  searchFiles(query: string, options: { regex: boolean; caseSensitive: boolean }): Promise<SearchResult>;
  reveal(path: string): Promise<unknown>;
  openToken(token: string): Promise<DocumentRecord>;
  reopen(id: string): Promise<DocumentRecord>;
  chooseImage(id: string, options?: Record<string, unknown>): Promise<{ path: string; alt: string } | null>;
  save(
    id: string,
    text: string,
    saveAs?: boolean,
    force?: boolean,
    options?: { encoding: string; bom: boolean },
  ): Promise<DocumentRecord | null>;
  persist(session: SessionSnapshot): Promise<unknown>;
  check(id: string): Promise<DiskChange | null>;
  reload(id: string, encoding?: string): Promise<DocumentRecord>;
  acceptDisk(
    id: string,
    content: string,
    hash: string,
  ): Promise<DocumentRecord>;
  importImage(id: string, bytes: Uint8Array, name: string, options?: Record<string, unknown>): Promise<string>;
  exportPdf(html?: string, options?: Record<string, unknown>): Promise<string | null>;
  exportHtml(name: string, html: string): Promise<string | null>;
  exportImage?(name: string, html: string, options: { scale: 1 | 2 }): Promise<string | null>;
  writeClipboard(text: string): Promise<unknown>;
  readClipboard(): Promise<string>;
  readAloud?(text: string | null): Promise<void>;
  openLink(url: string): Promise<unknown>;
  openDocumentLink(id: string, url: string): Promise<unknown>;
  confirmDiscard(name: string): Promise<boolean>;
  confirmClose(name: string): Promise<"save" | "discard" | "cancel">;
  setDirty(dirty: boolean): Promise<unknown>;
  closeWindow(): Promise<unknown>;
  glass?(request: Record<string, unknown>): Promise<any>;
  canvas?(request: CanvasRequest): Promise<any>;
  ocrAvailable?(): Promise<{ ok?: boolean; value?: { available: boolean } } | { available: boolean } | null>;
  glassOcr?(request: { png: string }): Promise<{ ok?: boolean; value?: { text: string }; error?: string } | null>;
  exportGlass?(request: { note: string; mode: string; target?: string; order?: string[] }): Promise<{ out: string; files: string[]; note: string } | null>;
  importGlass?(): Promise<{ note: string; file: string } | null>;
  sharedGlass?(note: string): Promise<{ note: string; magnets: { id: string; fields: Record<string, unknown>; kind?: string | null }[]; readOnly: boolean }>;
  sharedGlassState?(request: { action: "read" | "write"; shared?: boolean }): Promise<{ shared: boolean }>;
  sync?(request?: Record<string, unknown>): Promise<any>;
  onGlassStorage?(callback: (status: { bring?: { count: number; notes?: { path: string; title?: string }[] } | null } | null) => void): () => void;
  onCommand(callback: (command: Command) => void): () => void;
  payloadRequest?(request: PayloadRequest): Promise<string>;
  payloadKey?(baseUrl: string, value: string): Promise<void>;
}
declare global {
  interface Window {
    desktop?: Record<string, (...args: any[]) => any>;
  }
}
