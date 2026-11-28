import test from "node:test";
import assert from "node:assert/strict";
import { checkPins } from "../shared/fold-check.mjs";
import { projectMarks } from "../shared/fold-project.mjs";
import { foldDocumentLadder, isMonotonic } from "../shared/fold-units.mjs";

const note = `# Fluids

Start with a fluid challenge in the ward. Reassess after every bolus. Do not give fluids if the lungs are wet. Repeat the scan at six hours.

Second paragraph opens the follow-up. It adds the urine target.

## Drugs

- Loop diuretic first. Double the dose if output stays low.
- Check potassium daily. Never stop the beta blocker abruptly.
`;
const negation = "Do not give fluids if the lungs are wet.";
const STOPS = ["full", "brief", "key", "takeaway", "topic"];

test("a highlighted negation survives every stop up to Takeaway in the author's words, and the ladder stays monotonic", () => {
  const plain = foldDocumentLadder(note).byUnit[1];
  assert.equal(checkPins(plain.stops.takeaway, [negation]).ok, false, "without the pin Takeaway drops the negation");
  const pinned = foldDocumentLadder(note, { pins: [{ line: 3, quote: negation }, { line: 10, quote: "Never stop the beta blocker abruptly." }] });
  const paragraph = pinned.byUnit[1], list = pinned.byUnit.find(entry => entry.unit.kind === "list");
  for (const stop of ["full", "brief", "key", "takeaway"]) {
    assert.equal(checkPins(paragraph.stops[stop], [negation]).ok, true, `${stop} keeps the negation`);
    assert.match(list.stops[stop], /Never stop the beta blocker abruptly\./, `${stop} keeps the list item's negation`);
  }
  assert.deepEqual(paragraph.pinned, ["brief", "key", "takeaway"]);
  assert.match(paragraph.stops.takeaway, /^Start with a fluid challenge in the ward\. … Do not give fluids if the lungs are wet\. …$/);
  for (const entry of pinned.byUnit) assert.ok(isMonotonic(entry.stops), `${entry.unit.kind} at line ${entry.unit.line} stays monotonic`);
});

test("a block pin keeps its paragraph's opening sentence where the stop would drop the paragraph", () => {
  const plain = foldDocumentLadder(note).byUnit[2], pinned = foldDocumentLadder(note, { pins: [{ line: 5 }] }).byUnit[2];
  assert.equal(plain.stops.takeaway, "");
  assert.equal(pinned.stops.takeaway, "Second paragraph opens the follow-up. …");
  assert.equal(pinned.stops.topic, "", "Topic stays a topic");
});

test("every mark is somewhere at every stop: on its line, out of the fold at the absorbing line, in a deck, in your words, or in the tray", () => {
  const ladder = foldDocumentLadder(note);
  const units = ladder.byUnit.map(({ unit, stops }) => ({ line: unit.line, endLine: unit.endLine, sectionId: unit.sectionId, present: STOPS.map(stop => !!stops[stop]) }));
  const texts = ladder.byUnit.map(entry => STOPS.map(stop => entry.stops[stop]));
  const marks = [
    { id: "neg", kind: "highlight", line: 3, quote: negation },
    { id: "follow", kind: "highlight", line: 5, quote: "the urine target" },
    { id: "clip", kind: "magnet", line: 5 },
    { id: "card", kind: "magnet", line: 9 },
    { id: "sticky", kind: "sticky", line: 5 },
    { id: "ink", kind: "ink", line: 10 },
    { id: "gone", kind: "magnet", line: null },
  ];
  const projection = projectMarks(units, marks, (mark, unit, stop) => texts[unit][stop].includes(mark.quote));
  for (const [stop, at] of projection.entries()) {
    const placed = [at.own, at.out, at.decks, at.words].flatMap(map => [...map.values()].flat()).map(mark => mark.id);
    assert.deepEqual([...placed, ...at.orphans.map(mark => mark.id)].sort(), marks.map(mark => mark.id).sort(), `${STOPS[stop]} accounts for every mark once`);
    assert.deepEqual(at.orphans.map(mark => mark.id), ["gone"]);
  }
  const full = projection[0], takeaway = projection[3];
  assert.deepEqual(full.ticks, { shown: 6, total: 7 });
  assert.deepEqual(full.decks.get(0)?.map(mark => mark.id), ["clip"], "the section's magnets stack on its heading");
  assert.deepEqual(full.decks.get(3)?.map(mark => mark.id), ["card"]);
  // Takeaway drops the follow-up paragraph and, unpinned, the negation: all three go out of the fold at line 3.
  assert.deepEqual(takeaway.out.get(1)?.map(mark => mark.id), ["neg", "follow", "clip"]);
  assert.deepEqual(takeaway.words.get(1)?.map(mark => mark.id), ["sticky"], "stickies keep their own fold at the absorbing line");
  assert.deepEqual(takeaway.own.get(4)?.map(mark => mark.id), ["ink"]);
  assert.deepEqual(takeaway.ticks, { shown: 3, total: 7 });
});
