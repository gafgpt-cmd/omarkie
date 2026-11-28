import type { Fold, FoldMeta, FoldUnit, Slot, WrittenSection, WrittenUnit } from "./fold-format.mjs";

export declare const CHUNK_LIMIT: 12;
export declare const CHUNK_KEY_VERSION: 1;

/** Fields of a chunk key besides unit hashes and pins. */
export interface ChunkSettings {
  schemaVersion: number;
  promptVersion: number;
  slot: Slot;
  route: string;
  agent?: string;
  model: string;
  outLang: string;
}

export interface ChunkUnit {
  elementId: string;
  kind: string;
  hash: string;
}

export interface Chunk {
  index: number;
  unitIds: string[];
  /** Heading units inside the chunk, in document order. */
  sectionIds: string[];
  hashes: string[];
}

/** `[position in chunk, NFC quote]`. */
export type ChunkPin = [number, string];

export interface PlannedChunk extends Chunk {
  pins: ChunkPin[];
  key: string;
}

export interface PinRef {
  elementId: string;
  quote: string;
}

export declare function chunkUnits(units: readonly ChunkUnit[], limit?: number): Chunk[];
export declare function chunkPins(chunk: Chunk, pins?: readonly PinRef[]): ChunkPin[];
export declare function chunkKey(settings: ChunkSettings, hashes: readonly string[], pins?: readonly ChunkPin[]): string;
export declare function planChunks(units: readonly ChunkUnit[], settings: ChunkSettings, pins?: readonly PinRef[], limit?: number): PlannedChunk[];
export declare function queueOrder<T extends Chunk>(chunks: readonly T[], visibleId?: string | null): T[];
export declare function sameWriter(a: Partial<FoldMeta> | null | undefined, b: Partial<FoldMeta> | null | undefined): boolean;
export declare function foldRecord(meta: FoldMeta, units: readonly FoldUnit[], written: WrittenUnit[], sections: WrittenSection[]): Fold;
export declare function assembleFold(
  meta: FoldMeta,
  units: readonly (FoldUnit & { text: string })[],
  chunks: readonly PlannedChunk[],
  records: ReadonlyMap<string, Fold>,
  previous?: Fold | null,
): Fold;
