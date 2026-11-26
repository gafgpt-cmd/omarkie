import type { ReadingTarget } from "../../shared/reading-store.ts";
export type TutorVerb = "answer" | "propose" | "simplify" | "check" | "explain" | "quiz" | "grade" | "exam" | "glossary";
export type TutorDraft = { anchor: ReadingTarget; verb: TutorVerb; text?: string; parent?: string; context?: { before?: string; after?: string } };
export type TutorReply = TutorDraft & { question: string; body: string; id: string; replacement?: string; confidence?: 1 | 2 | 3 };
export const tutorLabels = {
  answer: "Answer", propose: "Propose edit", simplify: "Simplify", check: "Check correction", explain: "Explain back",
  quiz: "Quiz me", grade: "Check my answer", exam: "Exam points", glossary: "Glossary",
} as const;
export function tutorReply(draft: TutorDraft, question: string, body: string): TutorReply {
  const result = { ...draft, question, body, id: crypto.randomUUID() };
  if (draft.verb !== "check" && draft.verb !== "grade") return result;
  let data;
  try { data = JSON.parse(body.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1")); } catch { throw new Error("Tutor did not return a valid verdict. Try again."); }
  if (typeof data?.feedback !== "string" || !data.feedback.trim() || data.feedback.length > 48_000 ||
      (draft.verb === "check" && data.replacement != null && typeof data.replacement !== "string") ||
      (draft.verb === "grade" && ![1, 2, 3].includes(data.confidence))) throw new Error("Tutor did not return a valid verdict. Try again.");
  return { ...result, body: data.feedback, replacement: data.replacement ?? undefined, confidence: draft.verb === "grade" ? data.confidence : undefined };
}
