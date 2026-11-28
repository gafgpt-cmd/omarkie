export interface BaseDiagnostic { code: string; view?: string; where?: string; detail?: string; reason?: string }
export interface BaseRecord { path: string; name: string; basename: string; folder: string; ext: string; size: number; ctime: Date | null; mtime: Date | null; properties: Record<string, unknown>; tags: string[]; broken: boolean }
export interface BaseView { name: string; type: "table" | "cards"; declaredType: string; limit: number | null; image: string | null }
export interface ParsedBase { error?: "too-large" | "yaml" | "shape"; message?: string; views: BaseView[]; diagnostics: BaseDiagnostic[] }
export interface BaseCell { value: unknown; text: string }
export interface BaseResult {
  view: string | null;
  type?: "table" | "cards";
  columns: { id: string; label?: string }[];
  rows: { path: string; name: string; values: BaseCell[] }[];
  total: number;
  limited?: boolean;
  incomplete: boolean;
}
export interface BaseIndex { update(notes: { relative: string; content: string; modified?: string; created?: string }[]): string[]; records(): BaseRecord[] }
export const baseLimits: { bytes: number; expression: number; depth: number; filters: number; views: number; rows: number };
export function parseExpression(source: string): unknown;
export function propertyGetter(id: string): ((record: BaseRecord) => unknown) | null;
export function parseBase(source: string): ParsedBase;
export function noteRecord(note: { relative: string; content: string; modified?: string; created?: string }): BaseRecord;
export function createBaseIndex(): BaseIndex;
export function evaluateBase(base: ParsedBase, viewName: string, records: BaseRecord[]): BaseResult;
export function baseFile(relative: string): boolean;
