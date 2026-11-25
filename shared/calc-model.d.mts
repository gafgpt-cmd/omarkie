export interface CalcInput { key: string; label: string; unit: string; min: number | null; max: number | null }
export interface CalcCardShape { formula: string; inputs: CalcInput[]; unit: string; precision?: number; citation?: string }
export interface CalcFlag { key: string; side: "below" | "above" | "precision"; message: string }
export interface CalcResult {
  ok: boolean;
  value?: number;
  display?: string;
  unit?: string;
  precision?: number;
  flags?: CalcFlag[];
  error?: string;
}

export const calcLimits: {
  inputs: number; keyLength: number; label: number; unit: number; formula: number; citation: number;
  precision: number; defaultPrecision: number;
};
export function normalizeCalcInputs(value: unknown): CalcInput[];
export function normalizePrecision(value: unknown): number;
export function unitError(unit: unknown): Promise<string | null>;
export function assertCalcDefinition(definition: { formula?: string; inputs?: CalcInput[]; unit?: string }): Promise<true>;
export function formatCalcValue(value: number, precision?: number): string;
export function calcRangeText(input: CalcInput): string;
export function evaluateCalc(card: CalcCardShape, values?: Record<string, unknown>): Promise<CalcResult>;
