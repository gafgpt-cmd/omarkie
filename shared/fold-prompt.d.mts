export interface FoldReply { written: unknown[]; sections: unknown[] }

export declare const FOLD_PROMPT_VERSION: 1;
export declare const FOLD_SCHEMA_VERSION: 1;
export declare const FOLD_REPLY_BYTES: number;

export declare function foldInstruction(request: { outLang: string }): string;
export declare function foldJob(request: Record<string, any>): Record<string, unknown>;
export declare function foldMessages(request: Record<string, any>): { role: "system" | "user"; content: string }[];
export declare function parseFoldReply(text: string): FoldReply;
export declare function foldReplyObject(value: unknown): FoldReply;
export declare function anchorReply(reply: FoldReply, units: { elementId: string; text: string }[]): FoldReply;
