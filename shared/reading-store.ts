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

export type ReadingItem<A = ReadingTarget> = { id: string } & (
  | { type: "note"; body: string; anchor: A }
  | { type: "card"; front: string; back: string; anchor?: A }
  | { type: "answer"; cardId: string; rating: number }
);

export type ReadingEntry = ReadingItem<ReadingAnchor> & { document: string; at: string };

export interface ReadingLocation {
  id: string;
  line: number | null;
}

export interface ReadingRequests {
  list: { scope?: "document" | "vault"; types?: readonly ReadingItem["type"][] };
  put: { item: ReadingItem };
  resolve: { blocks: readonly ReadingBlock[] };
  export: { defaultName?: string };
}

export interface ReadingResults {
  list: ReadingEntry[];
  put: ReadingEntry;
  resolve: ReadingLocation[];
  export: boolean;
}

export interface ReadingStore {
  <K extends keyof ReadingRequests>(id: string, request: { action: K } & ReadingRequests[K]): Promise<ReadingResults[K]>;
}
