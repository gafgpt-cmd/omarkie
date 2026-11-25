export interface GlassMagnetView { id: string; fields: Record<string, unknown>; kind?: string | null; deleted?: boolean }
export declare const kindOf: (magnet: GlassMagnetView) => string;
export declare function magnetLabel(kind: string, fields?: Record<string, unknown>): string;
export declare function sourceQuote(fields?: Record<string, unknown>): { quote: string; line: number | null };
export declare function anchorLine(fields?: Record<string, unknown>): number;
export declare function readingOrder<T extends GlassMagnetView>(magnets: T[]): T[];
export declare function arrowConnections(magnets: GlassMagnetView[]): { magnet: GlassMagnetView; from: string; to: string; label: string }[];
