import type { Slot } from "./fold-format.mjs";

export interface FoldReply { written: unknown[]; sections: unknown[] }
/** An Estudio reply as the model sent it: every block, missing ones empty. Quotes are not yet placed. */
export type EstudioReply = { oneLiner: Record<string, unknown> | null } & Record<"caso" | "vs" | "numeros" | "flujo" | "bloques" | "nunca" | "buzzwords" | "mnemonics" | "cards" | "gaps", unknown[]>;

export declare const FOLD_PROMPT_VERSION: 2;
export declare const FOLD_SCHEMA_VERSION: 1;
export declare const ESTUDIO_PROMPT_VERSION: 1;
export declare const ESTUDIO_SCHEMA_VERSION: 1;
export declare const FOLD_REPLY_BYTES: number;
/** Prompt and schema versions of a slot: both join its chunk keys. */
export declare function foldVersions(slot: Slot): { promptVersion: number; schemaVersion: number };
/** JSON Schema (2020-12) of one ladder reply. */
export declare const FOLD_LADDER_SCHEMA: Readonly<Record<string, unknown>>;
/** JSON Schema (2020-12) of one Estudio reply. */
export declare const FOLD_ESTUDIO_SCHEMA: Readonly<Record<string, unknown>>;

export declare function foldInstruction(request: { outLang: string }): string;
export declare function foldJob(request: Record<string, any>): Record<string, unknown>;
export declare function estudioInstruction(request: { outLang: string }): string;
export declare function estudioJob(request: Record<string, any>): Record<string, unknown>;
/** Chat messages of one chunk call, by `request.slot`. */
export declare function foldMessages(request: Record<string, any>): { role: "system" | "user"; content: string }[];
export declare function parseFoldReply(text: string, slot?: "ladder"): FoldReply;
export declare function parseFoldReply(text: string, slot: "estudio"): EstudioReply;
export declare function parseFoldReply(text: string, slot?: Slot): FoldReply | EstudioReply;
export declare function foldReplyObject(value: unknown, slot?: "ladder"): FoldReply;
export declare function foldReplyObject(value: unknown, slot: "estudio"): EstudioReply;
export declare function foldReplyObject(value: unknown, slot?: Slot): FoldReply | EstudioReply;
export declare function anchorReply(reply: FoldReply, units: { elementId: string; text: string }[]): FoldReply;
export declare function ladderReplyProblems(reply: unknown, units: readonly { elementId: string; kind: string; raw: string | null; sectionId?: string | null; text: string }[]): string[];
/** Contract problems of an Estudio reply: schema, shape, and every quote word for word in a unit or table cell of the job. */
export declare function estudioReplyProblems(reply: unknown, units: readonly { elementId: string; text: string; cells?: readonly { elementId: string; text: string }[] }[]): string[];
