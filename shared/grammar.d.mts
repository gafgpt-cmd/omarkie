export const grammarDefault: string;
export const grammarTextLimit: number;
export function grammarEndpoint(value: unknown): { url: string; origin: string; local: boolean } | null;
export interface GrammarMatch { from: number; to: number; message: string; fixes: string[] }
export function grammarMatches(payload: unknown, text: string): GrammarMatch[];
