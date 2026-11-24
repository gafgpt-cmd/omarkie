export interface ReadingBlock {
  block: string;
  headings: readonly string[];
  line: number;
}

export interface ReadingTarget extends ReadingBlock {
  quote: string;
}

export interface ReadingAnchor extends ReadingTarget {
  hash: string;
}

export type SheetColour = "amber" | "blue" | "rose" | "green";
export type ScrapKind = "note" | "doubt" | "answer" | "clip" | "card" | "exam" | "evidence" | "gloss";
export type StudyItem<A = ReadingTarget> = { id: string } & (
  | { type: "sheet"; name: string; colour: SheetColour; order: number; visible: boolean }
  | { type: "scrap"; sheet: string; kind: ScrapKind; anchor: A | null; body: string; stackOf: string | null; folded: boolean; deleted?: boolean }
  | { type: "mark"; sheet: string; anchor: A; start: number; end: number; colour: SheetColour; deleted?: boolean }
  | { type: "ink"; sheet: string; anchor: A; from: string; to: string }
);

export type ReadingItem<A = ReadingTarget> = { id: string } & (
  | { type: "note"; body: string; anchor: A }
  | { type: "card"; front: string; back: string; anchor?: A }
  | { type: "answer"; cardId: string; rating: number }
) | StudyItem<A>;

export type ReadingEntry = ReadingItem<ReadingAnchor> & { document: string; at: string };

export interface ReadingLocation {
  id: string;
  line: number | null;
}

export interface ReadingRequests {
  list: { scope?: "document" | "vault"; types?: readonly ReadingItem["type"][]; studyNotes?: boolean };
  put: { item: ReadingItem; owner?: string };
  resolve: { blocks: readonly ReadingBlock[] };
  study: { blocks: readonly ReadingBlock[] };
  export: { action: "export" };
}

export interface ReadingResults {
  list: ReadingEntry[];
  put: ReadingEntry;
  resolve: ReadingLocation[];
  study: { entries: (StudyItem<ReadingAnchor> & { document: string; at: string })[]; locations: ReadingLocation[] };
  export: boolean;
}

export interface ReadingStore {
  <K extends keyof ReadingRequests>(id: string, request: { action: K } & ReadingRequests[K]): Promise<ReadingResults[K]>;
}
