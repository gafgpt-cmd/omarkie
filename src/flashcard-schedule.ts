export type RecallRating = 0 | 1 | 2 | 3 | 4 | 5;
export interface ReviewSchedule {
  repetitions: number;
  intervalDays: number;
  easeFactor: number;
  dueAt: string;
}

const day = 86_400_000;

export function scheduleReview(previous: ReviewSchedule | undefined, rating: RecallRating, reviewedAt: string): ReviewSchedule {
  const ease = previous?.easeFactor ?? 2.5;
  const miss = 5 - rating;
  const easeFactor = Math.max(1.3, Math.round((ease + 0.1 - miss * (0.08 + miss * 0.02)) * 100) / 100);
  const reviewed = Date.parse(reviewedAt);
  // Same-session recall drills must not advance an already successful repetition.
  if (rating >= 3 && previous?.repetitions && reviewed < Date.parse(previous.dueAt)) return { ...previous, easeFactor };
  const repetitions = rating < 3 ? 0 : (previous?.repetitions ?? 0) + 1;
  const intervalDays = repetitions <= 1 ? 1 : repetitions === 2 ? 6 : Math.ceil(previous!.intervalDays * Math.round(ease * 100) / 100);
  const dueAt = new Date(reviewed + intervalDays * day).toISOString();
  return { repetitions, intervalDays, easeFactor, dueAt };
}
