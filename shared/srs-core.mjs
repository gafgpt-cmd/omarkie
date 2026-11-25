// Study scheduling: FSRS-6 through ts-fsrs, one review queue per vault.
// Pure functions over journal lines; electron/glass-service.mjs owns the disk.
import { FSRS, Rating, createEmptyCard, generatorParameters } from "ts-fsrs";

export const srsGrades = ["again", "hard", "good", "easy"];
export const srsGradeLabels = { again: "Again", hard: "Hard", good: "Good", easy: "Easy" };
export const srsDefaults = {
  idLimit: 96, frontLimit: 4_000, backLimit: 20_000, sourceLimit: 64, noteLimit: 2_048,
  retention: 0.9, maximumInterval: 36_500, minimumInterval: 1, maxCards: 200_000, maxReviews: 2_000_000,
};
const ratings = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };
const states = ["new", "learning", "review", "relearning"];
const stateNames = { 0: "new", 1: "learning", 2: "review", 3: "relearning" };

export function normalizeGrade(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4) return srsGrades[value - 1];
  const key = String(value ?? "").trim().toLowerCase();
  return srsGrades.includes(key) ? key : null;
}

export function srsParameters(overrides = {}) {
  return generatorParameters({
    request_retention: srsDefaults.retention,
    maximum_interval: srsDefaults.maximumInterval,
    enable_fuzz: false,
    ...overrides,
  });
}

const scheduler = () => new FSRS(srsParameters());

export function emptySchedule(at) {
  return createEmptyCard(new Date(at));
}

// One card is one label, menu card or marked bubble; the id is stable per source.
export function cardId(noteId, magnet) {
  return `s-${noteId}-${magnet}`.slice(0, srsDefaults.idLimit);
}

const text = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";
const finite = value => typeof value === "number" && Number.isFinite(value);

export function validStudyCard(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (record.op !== "card") return false;
  if (typeof record.id !== "string" || !record.id || record.id.length > srsDefaults.idLimit) return false;
  if (typeof record.noteId !== "string" || !record.noteId || record.noteId.length > srsDefaults.sourceLimit) return false;
  if (typeof record.magnet !== "string" || !record.magnet || record.magnet.length > srsDefaults.sourceLimit) return false;
  if (typeof record.front !== "string" || !record.front.trim() || record.front.length > srsDefaults.frontLimit) return false;
  if (typeof record.back !== "string" || record.back.length > srsDefaults.backLimit) return false;
  return typeof record.created === "string" && Number.isFinite(Date.parse(record.created));
}

export function parseStudyText(value) {
  const cards = new Map(), reviews = [], exams = new Map(), labels = new Map(), unknown = [];
  let invalid = 0;
  const seen = new Set();
  for (const raw of String(value ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    let record;
    try { record = JSON.parse(line); } catch { invalid += 1; continue; }
    if (!record || typeof record !== "object" || Array.isArray(record)) { invalid += 1; continue; }
    if (record.op === "card") {
      if (!validStudyCard(record)) { invalid += 1; continue; }
      cards.set(record.id, {
        id: record.id, noteId: record.noteId, note: text(record.note, srsDefaults.noteLimit),
        magnet: record.magnet, front: record.front, back: record.back,
        source: text(record.source, srsDefaults.sourceLimit), created: record.created,
      });
    } else if (record.op === "review") {
      const rating = normalizeGrade(record.rating);
      if (!cards.size || typeof record.id !== "string" || !rating) { invalid += 1; continue; }
      if (typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))) { invalid += 1; continue; }
      reviews.push({ id: record.id, rating, at: record.at, preview: record.preview === true });
      if (reviews.length > srsDefaults.maxReviews) { invalid += 1; break; }
    } else if (record.op === "exam") {
      if (typeof record.noteId !== "string" || typeof record.on !== "boolean") { invalid += 1; continue; }
      exams.set(record.noteId, record.on);
    } else if (record.op === "labels") {
      if (typeof record.noteId !== "string" || typeof record.hidden !== "boolean") { invalid += 1; continue; }
      labels.set(record.noteId, record.hidden);
    } else unknown.push(record);
  }
  return { cards, reviews, exams, labels, unknown, invalid };
}

function reviewsFor(reviews, id) {
  return reviews.filter(review => review.id === id && !review.preview).sort((left, right) => left.at.localeCompare(right.at));
}

export function scheduleOf(card, reviews) {
  let state = emptySchedule(card.created);
  const fsrs = scheduler();
  for (const review of reviewsFor(reviews, card.id)) {
    const log = fsrs.repeat(state, new Date(review.at));
    const next = log[ratings[review.rating]]?.card;
    if (next) state = next;
  }
  return state;
}

export function previewGrade(card, reviews, grade, at) {
  const rating = normalizeGrade(grade);
  if (!rating) return null;
  const before = scheduleOf(card, reviews);
  const log = scheduler().repeat(before, new Date(at));
  const next = log[ratings[rating]]?.card;
  if (!next) return null;
  return {
    rating, due: next.due.toISOString(), interval: next.scheduled_days,
    state: stateNames[next.state] ?? "new", reps: next.reps, lapses: next.lapses,
    stability: next.stability, difficulty: next.difficulty,
  };
}

export function cardView(card, reviews, now = Date.now()) {
  const schedule = scheduleOf(card, reviews);
  const due = schedule.due.toISOString();
  return {
    id: card.id, noteId: card.noteId, note: card.note, magnet: card.magnet,
    front: card.front, back: card.back, source: card.source, created: card.created,
    due, dueIn: Date.parse(due) - now, interval: schedule.scheduled_days,
    state: stateNames[schedule.state] ?? "new", reps: schedule.reps, lapses: schedule.lapses,
    stability: schedule.stability, difficulty: schedule.difficulty,
    next: Object.fromEntries(srsGrades.map(grade => [grade, previewGrade(card, reviews, grade, now)])),
  };
}

export function dueStudyCards(study, now = Date.now()) {
  const due = [];
  for (const card of study.cards.values()) {
    const view = cardView(card, study.reviews, now);
    if (Date.parse(view.due) <= now) due.push(view);
  }
  return due.sort((left, right) => Date.parse(left.due) - Date.parse(right.due) || left.id.localeCompare(right.id));
}

export function studySummary(study, now = Date.now()) {
  const due = dueStudyCards(study, now);
  const cards = [...study.cards.values()];
  return { due: due.length, total: cards.length,
    learning: cards.filter(card => { const view = cardView(card, study.reviews, now); return view.state === "new" || view.state === "learning" || view.state === "relearning"; }).length };
}

// Exam previews fold the same items to a cue and never schedule; the filter is pure on purpose.
export function filterExamItems(items, { markedOnly = false } = {}) {
  const list = Array.isArray(items) ? items.filter(item => item && typeof item.id === "string") : [];
  return markedOnly ? list.filter(item => item.marked === true) : list;
}

export function examStatus(study, noteId) {
  return { exam: study.exams.get(noteId) === true, labelsHidden: study.labels.get(noteId) === true };
}
