import type { GlassMagnet } from "../src/glass/glass-model";

export declare function parseScrubTime(value: unknown): number | null;
export declare function linesOf(source: string | readonly string[]): string[];
export interface TimelinePoint { at: number; events: number; kinds: string[] }
export interface Timeline { points: TimelinePoint[]; from: number | null; to: number | null; events: number; invalid: number; count: number }
export declare function journalTimeline(source: string | readonly string[]): Timeline;
export declare function magnetsAt(source: string | readonly string[], at: number): { magnets: GlassMagnet[]; at: number; lines: number; invalid: number };
