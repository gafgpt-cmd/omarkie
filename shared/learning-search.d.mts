export function learningSearchTerms(input: string): string[];
export function matchLearningScraps(entries: readonly {
  type: string; document: string; body?: string; image?: unknown; kind?: string;
  question?: string; anchor?: { line: number; quote?: string } | null;
}[], terms: string[]): { document: string; line: number | null; kind: string; text: string }[];
