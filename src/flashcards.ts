import type { ReadingEntry, ReadingItem, ReadingTarget } from "../shared/reading-store.ts";
import { scheduleReview, type RecallRating, type ReviewSchedule } from "./flashcard-schedule.ts";

export type StoredCard = Extract<ReadingEntry, { type: "card" }>;
export type CardDraft = Extract<ReadingItem, { type: "card" }>;
type StoredNote = Extract<ReadingEntry, { type: "note" }>;
export const cardsPerNote = 10;

const normalize = (text: string) => text.trim().replace(/\s+/g, " ");
const anchorKey = (anchor: ReadingTarget) => JSON.stringify([anchor.headings, normalize(anchor.quote)]);

export function sourceDraft(target: ReadingTarget, placeholder: string, fallback: string): Pick<CardDraft, "front" | "back" | "anchor"> {
  const back = target.quote.trim();
  const answer = normalize(back);
  const block = normalize(target.block);
  const context = answer && block.replaceAll(answer, placeholder).replaceAll(`==${placeholder}==`, placeholder);
  const front = context && context !== block && /[\p{L}\p{N}]/u.test(context.replaceAll(placeholder, "")) ? context : fallback;
  return { front, back, anchor: target };
}

export function suggestCards(cards: readonly StoredCard[], highlights: readonly ReadingTarget[], notes: readonly StoredNote[],
  placeholder: string, fallback: (target: ReadingTarget) => string): Omit<CardDraft, "id" | "type">[] {
  const seen = new Set(cards.flatMap(card => card.anchor ? [anchorKey(card.anchor)] : []));
  const drafts: Omit<CardDraft, "id" | "type">[] = [];
  const limit = cardsPerNote - cards.length;
  for (const target of highlights) {
    if (drafts.length >= limit) break;
    if (target.block.length > 262144 || target.quote.length > 65536 || target.headings.some(heading => heading.length > 262144)) continue;
    const key = anchorKey(target);
    if (seen.has(key)) continue;
    const draft = sourceDraft(target, placeholder, fallback(target));
    if (!draft.back) continue;
    drafts.push(draft);
    seen.add(key);
  }
  for (const note of notes) {
    if (drafts.length >= limit) break;
    const key = anchorKey(note.anchor);
    if (seen.has(key)) continue;
    const front = normalize(note.anchor.quote);
    drafts.push({ front: front.includes(normalize(note.body)) ? fallback(note.anchor) : front, back: note.body, anchor: note.anchor });
    seen.add(key);
  }
  return drafts;
}

export function dueCards(entries: readonly ReadingEntry[], now: number): StoredCard[] {
  // One durable answer event per rating. Replay avoids a second, partially committed schedule write.
  const answers = entries.filter(entry => entry.type === "answer").sort((a, b) => a.at.localeCompare(b.at));
  const schedules = new Map<string, ReviewSchedule>();
  for (const answer of answers) schedules.set(answer.cardId, scheduleReview(schedules.get(answer.cardId), answer.rating as RecallRating, answer.at));
  const due: { card: StoredCard; at: number }[] = [];
  for (const entry of entries) {
    if (entry.type !== "card") continue;
    const schedule = schedules.get(entry.id);
    const at = schedule ? Date.parse(schedule.dueAt) : now;
    if (at <= now) due.push({ card: entry, at });
  }
  return due.sort((a, b) => a.at - b.at).map(({ card }) => card);
}
