export interface FoldReply { written: unknown[]; sections: unknown[] }

export declare const FOLD_PROMPT_VERSION: 2;
export declare const FOLD_SCHEMA_VERSION: 1;
export declare const FOLD_REPLY_BYTES: number;
/** JSON Schema (2020-12) of one ladder reply. */
export declare const FOLD_LADDER_SCHEMA: Readonly<Record<string, unknown>>;

export declare function foldInstruction(request: { outLang: string }): string;
export declare function foldJob(request: Record<string, any>): Record<string, unknown>;
export declare function foldMessages(request: Record<string, any>): { role: "system" | "user"; content: string }[];
export declare function parseFoldReply(text: string): FoldReply;
export declare function foldReplyObject(value: unknown): FoldReply;
export declare function anchorReply(reply: FoldReply, units: { elementId: string; text: string }[]): FoldReply;
export declare function ladderReplyProblems(reply: unknown, units: readonly { elementId: string; kind: string; raw: string | null; sectionId?: string | null; text: string }[]): string[];
