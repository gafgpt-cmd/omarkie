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

export interface SlotDefault {
  readonly route: Route;
  readonly agent: Agent;
  readonly model: string;
  readonly fallback: "local" | "off";
}
export declare const SLOT_DEFAULTS: { readonly ladder: SlotDefault; readonly estudio: SlotDefault };

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
  estudio: Record<string, unknown> | null;
}

export declare function isLevelId(value: unknown): value is LevelId;
export declare function isRole(value: unknown): value is Role;
export declare function levelOf(id: unknown): Level | null;
export declare function outLangFor(slot: Slot, noteLang: string, estudioLang?: string | null): string;
export declare function foldProblems(value: unknown): string[];
export declare function isFold(value: unknown): value is Fold;
export declare function isFoldLine(value: unknown): value is FoldLine;
export declare function isAuthorText(value: unknown): value is AuthorText;
export declare function isWrittenText(value: unknown): value is WrittenText;
export declare function isEvidence(value: unknown): value is Evidence;
export declare function evidenceFits(text: string, evidence: unknown): evidence is Evidence;
