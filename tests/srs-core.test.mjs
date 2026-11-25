import assert from "node:assert/strict";
import test from "node:test";
import {
  cardId, cardView, dueStudyCards, emptySchedule, filterExamItems, normalizeGrade, parseStudyText, previewGrade, studySummary,
} from "../shared/srs-core.mjs";

const at = Date.parse("2026-11-25T09:00:00.000Z");
const card = {
  id: cardId("note1", "l-1"), noteId: "note1", note: "anatomy.md", magnet: "l-1",
  front: "Name the pinned structure", back: "Median nerve", source: "label",
  created: "2026-11-20T09:00:00.000Z",
};

function study(records) {
  return parseStudyText(records.map(record => JSON.stringify(record)).join("\n"));
}

test("grades accept names and 1-4 keys, reject anything else", () => {
  assert.equal(normalizeGrade("again"), "again");
  assert.equal(normalizeGrade(2), "hard");
  assert.equal(normalizeGrade(4), "easy");
  assert.equal(normalizeGrade(0), null);
  assert.equal(normalizeGrade("soon"), null);
});

test("FSRS-6 scheduling: first Good leaves the new state and pushes the due date forward", () => {
  const fresh = emptySchedule(at);
  assert.equal(fresh.state, 0);
  const preview = previewGrade(card, [], "good", at);
  assert.equal(preview.rating, "good");
  assert.equal(preview.reps, 1);
  assert.ok(Date.parse(preview.due) > at);
  assert.ok(preview.stability > 0);
  assert.ok(preview.difficulty >= 1 && preview.difficulty <= 10);
});

test("review history is replayed, so the same grade gets a longer interval on a mature card", () => {
  const first = previewGrade(card, [], "good", at);
  const reviews = [{ id: card.id, rating: "good", at: new Date(at).toISOString(), preview: false }];
  const second = previewGrade(card, reviews, "good", Date.parse(first.due));
  assert.ok(second.interval >= first.interval);
  assert.ok(second.reps > first.reps);
});

test("a preview never appends a review and never moves a due date", () => {
  const reviews = [];
  const before = cardView(card, reviews, at);
  const preview = previewGrade(card, reviews, "easy", at);
  assert.deepEqual(reviews, []);
  assert.equal(cardView(card, reviews, at).due, before.due);
  assert.equal(preview.rating, "easy");
});

test("due queue and summary count only cards whose due time passed", () => {
  const first = study([{ op: "card", ...card }]);
  assert.equal(studySummary(first, at).due, 1);
  const later = at + 10 * 24 * 60 * 60 * 1000;
  assert.equal(dueStudyCards(first, later).length, 1);
});

test("exam state and hidden labels round-trip through the journal", () => {
  const parsed = study([
    { op: "exam", noteId: "note1", on: true },
    { op: "labels", noteId: "note1", hidden: true },
  ]);
  assert.equal(parsed.exams.get("note1"), true);
  assert.equal(parsed.labels.get("note1"), true);
  assert.equal(parsed.invalid, 0);
});

test("exam filter keeps every item or only marked ones, without touching scheduling", () => {
  const items = [
    { id: "l-1", kind: "label", cue: "Name 1", answer: "Median nerve", marked: true },
    { id: "b-1", kind: "bubble", cue: "Brachial plexus", answer: "Cords", marked: false },
  ];
  assert.equal(filterExamItems(items).length, 2);
  assert.deepEqual(filterExamItems(items, { markedOnly: true }).map(item => item.id), ["l-1"]);
  const state = study([{ op: "card", ...card }]);
  const dueBefore = studySummary(state, at).due;
  filterExamItems(items, { markedOnly: true });
  assert.equal(studySummary(state, at).due, dueBefore);
  assert.deepEqual(state.reviews, []);
});
