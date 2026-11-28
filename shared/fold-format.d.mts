export declare const FOLD_FORMAT: "omarkie/fold";
export declare const FOLD_VERSION: 1;

export type LevelId = "full" | "brief" | "key" | "takeaway" | "topic" | "estudio";
export type Slot = "ladder" | "estudio";
export type Route = "agent" | "payload";
export type Agent = "claude" | "codex" | "opencode";
export type Role = "definition" | "mechanism" | "presentation" | "diagnosis" | "treatment" | "dose" | "monitoring" | "pitfall" | "red_flag" | "prognosis" | "context";
export type CheckClass = "negation" | "restriction" | "condition" | "uncertainty" | "number" | "scope" | "attribution" | "pins" | "monotonic" | "format";
export type RawClass = "table" | "code" | "math" | "image";

export interface Level {
  readonly id: LevelId;
  readonly digit: 1 | 2 | 3 | 4 | 5 | 6;
  readonly words: "author" | "model";
  readonly local: boolean;
  readonly nested: boolean;
  readonly slot: Slot | null;
}

export declare const LEVELS: readonly Level[];
export declare const LEVEL_IDS: readonly LevelId[];
export declare const ROLES: readonly Role[];
export declare const CHECK_CLASSES: readonly CheckClass[];
export declare const RAW_CLASSES: readonly RawClass[];
export declare const SLOTS: readonly Slot[];
export declare const ROUTES: readonly Route[];
export declare const AGENTS: readonly Agent[];

export interface Evidence {
  elementId: string;
  quote: string;
  sentence: number;
  start: number;
  end: number;
}

/** The author's words, verbatim. */
export interface AuthorText { by: "author"; text: string }
/** A model's words; every written line rests on at least one quoted source span. */
export interface WrittenText { by: "model"; text: string; evidence: [Evidence, ...Evidence[]] }
export type FoldLine = AuthorText | WrittenText;

export interface FoldUnit {
  elementId: string;
  kind: string;
  line: number;
  endLine: number;
  hash: string;
  raw: RawClass | null;
}

export interface WrittenUnit {
  elementId: string;
  role: Role;
  key: FoldLine;
  takeaway: FoldLine;
  topic: FoldLine;
  checks: Partial<Record<CheckClass, "pass" | "fail">>;
}

export interface WrittenSection {
  elementId: string;
  takeaway: FoldLine;
  topic: FoldLine;
}

export interface FoldMeta {
  slot: Slot;
  route: Route;
  agent?: Agent;
  model: string;
  promptVersion: number;
  schemaVersion: number;
  outLang: string;
  created: string;
}

export interface Fold {
  format: typeof FOLD_FORMAT;
  version: typeof FOLD_VERSION;
  meta: FoldMeta;
  units: FoldUnit[];
  written: WrittenUnit[];
  sections: WrittenSection[];
  /** Schema `omarkie/fold-estudio` v1; null in a ladder record. */
  estudio: EstudioSheet | null;
}

export declare const ESTUDIO_FORMAT: "omarkie/fold-estudio";
export declare const ESTUDIO_VERSION: 1;
export type EstudioBlock = "caso" | "vs" | "numeros" | "flujo" | "bloques" | "nunca" | "buzzwords" | "mnemonics" | "cards" | "gaps";
export type BloqueKind = "mechanism" | "dx" | "tx" | "monitoring" | "pitfall" | "prognosis";
export declare const ESTUDIO_BLOCKS: readonly EstudioBlock[];
export declare const BLOQUE_KINDS: readonly BloqueKind[];
export declare const ESTUDIO_LIMITS: Readonly<Record<
  "oneLinerWords" | "lineWords" | "vs" | "vsRows" | "vsColumns" | "numeros" | "flujo" | "flujoNodes" | "bloques" | "bullets"
  | "nunca" | "buzzwords" | "mnemonics" | "cards" | "caso" | "gaps", number>>;

type Stars = 0 | 1 | 2;
type Grounded<T> = T & { evidence: [Evidence, ...Evidence[]] };
export interface EstudioSheet {
  format: typeof ESTUDIO_FORMAT;
  version: typeof ESTUDIO_VERSION;
  oneLiner: Grounded<{ text: string; stars: Stars }> | null;
  caso: Grounded<{ entity: string; text: string; stars: Stars }>[];
  vs: { title: string; columns: string[]; rows: { label: string; stars: Stars; cells: Grounded<{ text: string }>[] }[] }[];
  numeros: Grounded<{ label: string; value: string; unit: string; consequence: string; decisive: boolean; stars: Stars }>[];
  flujo: { title: string; nodes: Grounded<{ id: string; text: string }>[]; edges: { from: string; to: string; label?: string }[] }[];
  bloques: { kind: BloqueKind; bullets: Grounded<{ text: string; stars: Stars }>[] }[];
  nunca: Grounded<{ text: string; why: string; stars: Stars }>[];
  buzzwords: Grounded<{ term: string; concept: string }>[];
  mnemonics: { label: string; word: string; items: Grounded<{ letter: string; text: string }>[] }[];
  cards: Grounded<{ q: string; a: string }>[];
  gaps: Grounded<{ text: string }>[];
  /** Checker tally: lines shown, lines with a number gap, lines over their word cap, items dropped with their source. */
  checks: { lines: number; gapped: number; long: number; dropped: { block: "oneLiner" | EstudioBlock; evidence: [Evidence, ...Evidence[]] }[] };
}

/** Problems of `value` against a JSON Schema subset (type, enum, const, required, properties, items, bounds), by path. */
export declare function jsonSchemaProblems(schema: Readonly<Record<string, unknown>>, value: unknown, path: string, problems?: string[]): string[];
export declare function estudioSchema(evidence: Readonly<Record<string, unknown>>, options: { stored: boolean }): Readonly<Record<string, unknown>>;
export declare const ESTUDIO_SHEET_SCHEMA: Readonly<Record<string, unknown>>;
export declare const ESTUDIO_REPLY_EVIDENCE: Readonly<Record<string, unknown>>;
export declare const ESTUDIO_REPLY_SCHEMA: Readonly<Record<string, unknown>>;
export declare function anchorQuote<T>(entry: T, text: string | undefined): T | Evidence;
export declare function estudioShapeProblems(sheet: Record<string, any>, path?: string): string[];
export declare function estudioEvidence(sheet: Record<string, any>, path?: string, out?: [string, Evidence[]][]): [string, Evidence[]][];
export declare function estudioProblems(value: unknown, path?: string): string[];
export declare function isEstudioSheet(value: unknown): value is EstudioSheet;

export declare function isLevelId(value: unknown): value is LevelId;
export declare function isRole(value: unknown): value is Role;
export declare function levelOf(id: unknown): Level | null;
export declare function foldProblems(value: unknown): string[];
export declare function isFold(value: unknown): value is Fold;
export declare function isFoldLine(value: unknown): value is FoldLine;
export declare function isAuthorText(value: unknown): value is AuthorText;
export declare function isWrittenText(value: unknown): value is WrittenText;
export declare function isEvidence(value: unknown): value is Evidence;
export declare function evidenceFits(text: string, evidence: unknown): evidence is Evidence;
