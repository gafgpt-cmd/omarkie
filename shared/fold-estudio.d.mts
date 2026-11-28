import type { Evidence, EstudioSheet } from "./fold-format.mjs";
import type { PinRef } from "./fold-cache.mjs";

interface EstudioUnit { elementId: string; text: string; cells?: readonly { elementId: string; row: number; column: number; text: string }[] }
/** A unit or table cell an Estudio quote may sit in, with its reading order. */
export interface EstudioElement { text: string; unitId: string; order: number; row?: number; header?: boolean }
export interface EstudioRetry { block: string; text: string; lost?: string[]; words?: number }
/** A chunk's sheet before it is stored: no format or version yet. */
export type EstudioPart = Partial<Omit<EstudioSheet, "checks">> & { checks?: Partial<EstudioSheet["checks"]> };

export declare function estudioElements(units: readonly EstudioUnit[]): Map<string, EstudioElement>;
/** Dice coefficient of character 3-grams, accents and case folded: 1 is the same words. */
export declare function dice(a: string, b: string): number;
/** Two items say the same thing: overlapping quotes of one element and nearly the same words. */
export declare function sameItem(a: unknown, b: unknown): boolean;
export declare function checkEstudioChunk(
  ask: (retry: EstudioRetry[] | null) => Promise<unknown>,
  options: { units: readonly EstudioUnit[]; pins?: readonly PinRef[] },
): Promise<{ estudio: EstudioSheet; retried: number; outOfFold: PinRef[] }>;
/** Merges chunk sheets in reading order: duplicates fold together, caps keep the most starred. */
export declare function mergeEstudio(sheets: readonly (EstudioPart | null | undefined)[], options?: { elements?: Map<string, EstudioElement> }): EstudioSheet;
/** The sheet's items whose every quote `keep` accepts. */
export declare function filterEstudio(sheet: EstudioSheet, keep: (entry: Evidence) => boolean): EstudioPart;
/** Pins no sheet line holds. */
export declare function estudioOutOfFold(sheet: EstudioSheet, pins?: readonly PinRef[]): PinRef[];
