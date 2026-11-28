export declare const WORD_MORPH_LIMIT: 300;

export interface AddedToken {
  after: number;
  token: string;
}

export interface MorphPlan {
  kept: Uint8Array;
  added: AddedToken[];
}

export interface ScrubSegment {
  from: number;
  to: number;
  fraction: number;
}

export declare function commonPairs(source: readonly string[], target: readonly string[]): [number, number][];
export declare function morphPlan(source: readonly string[], target: readonly string[]): MorphPlan;
export declare function scrubSegment(value: number, count: number): ScrubSegment;
export declare function nearestStop(value: number, count: number): number;
export declare function stepStop(index: number, delta: number, count: number): number;
