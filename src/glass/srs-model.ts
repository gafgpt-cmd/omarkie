export type SrsGrade = "again" | "hard" | "good" | "easy";

export interface SrsNext {
  rating: SrsGrade;
  due: string;
  interval: number;
  state: string;
  reps: number;
  lapses: number;
  stability: number;
  difficulty: number;
}

export interface SrsCard {
  id: string;
  noteId: string;
  note: string;
  magnet: string;
  front: string;
  back: string;
  source: string;
  created: string;
  due: string;
  dueIn: number;
  interval: number;
  state: string;
  reps: number;
  lapses: number;
  stability: number;
  difficulty: number;
  next: Record<SrsGrade, SrsNext>;
}

export interface SrsDue {
  due: SrsCard[];
  count: number;
  total: number;
  learning: number;
}

export interface StudyState {
  exam: boolean;
  labelsHidden: boolean;
}
