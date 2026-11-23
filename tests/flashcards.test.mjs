import test from "node:test";
import assert from "node:assert/strict";
import { scheduleReview } from "../src/flashcard-schedule.ts";
import { dueCards, sourceDraft, suggestCards } from "../src/flashcards.ts";

const start = "2026-02-20T10:30:00.000Z";
const anchor = (quote, block = `The answer is ${quote}.`) => ({ quote, block, headings: ["Facts"], line: 3, hash: `hash-${quote}` });
const card = (id, quote = id) => ({ id, type: "card", front: "Question", back: quote, anchor: anchor(quote), document: "facts.md", at: start });
const answer = (cardId, at, rating) => ({ id: `${cardId}-${at}`, type: "answer", cardId, at, rating, document: "facts.md" });

const fallback = () => "What was highlighted?";

test("card prompts mask all answer occurrences and fall back for an isolated quote", () => {
  const target = anchor("helium", "helium is lighter than air. helium is inert.");
  assert.deepEqual(sourceDraft(target, "[…]", fallback()), { anchor: target, front: "[…] is lighter than air. […] is inert.", back: "helium" });
  assert.equal(sourceDraft(anchor("helium", "==helium=="), "[…]", fallback()).front, "What was highlighted?");
});

test("suggestions keep source order, skip duplicate anchors, include notes and stop at ten cards", () => {
  const existing = Array.from({ length: 7 }, (_, i) => card(`existing-${i}`));
  const note = { type: "note", body: "Additional detail", anchor: anchor("other") };
  const highlights = [anchor("existing-0"), anchor("first"), anchor("first"), anchor("second")];
  const suggestions = suggestCards(existing, highlights, [note, { ...note, anchor: anchor("extra") }], "[…]", fallback);
  assert.deepEqual(suggestions.map(({ back }) => back), ["first", "second", "Additional detail"]);
  assert.equal(suggestions[2].front, "other");
});

test("SM-2 schedules 1 and 6 days, rounds mature intervals up and restarts after a miss", () => {
  const first = scheduleReview(undefined, 5, start);
  assert.deepEqual(first, { repetitions: 1, intervalDays: 1, easeFactor: 2.6, dueAt: "2026-02-21T10:30:00.000Z" });
  const second = scheduleReview(first, 5, first.dueAt);
  assert.deepEqual(second, { repetitions: 2, intervalDays: 6, easeFactor: 2.7, dueAt: "2026-02-27T10:30:00.000Z" });
  const mature = scheduleReview(second, 4, second.dueAt);
  assert.equal(mature.intervalDays, 17);
  assert.deepEqual(scheduleReview(mature, 0, mature.dueAt), {
    repetitions: 0, intervalDays: 1, easeFactor: 1.9, dueAt: "2026-03-17T10:30:00.000Z",
  });
  assert.equal(scheduleReview({ ...second, easeFactor: 1.4 }, 0, second.dueAt).easeFactor, 1.3);
});

test("replay restores due cards across files and does not advance same-session recall drills", () => {
  const again = "2026-02-20T10:31:00.000Z";
  const due = "2026-02-21T10:30:00.000Z";
  const entries = [card("new"), { ...answer("new", again, 5), document: "another.md" }, answer("review", again, 5), card("review"), answer("review", start, 3), card("future"), answer("future", again, 4)];
  assert.deepEqual(dueCards(entries, Date.parse(again)).map(item => item.id), ["new"]);
  assert.deepEqual(dueCards(entries, Date.parse(due)).map(item => item.id), ["new", "review"]);
  assert.deepEqual(dueCards(entries, Date.parse("2026-02-22T10:30:00.000Z")).map(item => item.id), ["review", "future", "new"]);
});
