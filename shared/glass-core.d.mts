export const glassVersion: number;
export const nameByteLimit: number;
export const stickyColors: readonly ["yellow", "rose", "blue", "green", "violet", "slate"];
export function truncateBytes(text: string, limit: number): string;
export function sanitizeTitle(value: unknown): string;
export function glassFileName(title: string, id: string): string;
export function newMagnetId(): string;
export function parseClock(value: unknown): { t: number; c: number } | null;
export function createClock(device: string, now?: () => number): {
  device: string;
  next(): string;
  observe(value: unknown): boolean;
  readonly top: { t: number; c: number; range: number };
};
export function isNewer(hlc: string, device: string, current: { hlc: string; device?: string } | null): boolean;
export function parseJournalText(text: string): { lines: string[]; incomplete: string[] };
export function replayJournalText(text: string): {
  magnets: Map<string, unknown>;
  lines: string[];
  unknown: unknown[];
  invalid: number;
  duplicates: number;
  incomplete: number;
  clocks: string[];
};
export function magnetView(magnet: unknown): { id: string; fields: Record<string, unknown>; kind: unknown; deleted: boolean };
export function visibleMagnets(magnets: Map<string, unknown>): { id: string; fields: Record<string, unknown>; kind: unknown; deleted: boolean }[];
export function replayNotesText(text: string): {
  notes: Map<string, { id: string; path: string; title?: string; fingerprint?: unknown; hlc?: string; device?: string }>;
  invalid: number;
  unknown: number;
  incomplete: number;
};
