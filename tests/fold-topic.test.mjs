import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { checkLine } from "../shared/fold-check.mjs";
import { foldLecture, foldTopic, headingMarkdown, OPENING, topicCardAt, topicCards } from "../shared/fold-topic.mjs";
import { foldDocumentLadder } from "../shared/fold-units.mjs";
import { lectureNote } from "../shared/voice.mjs";

const fixtures = new URL("./fixtures/fold/", import.meta.url);
const fixtureNames = readdirSync(fixtures).filter(name => !name.endsWith(".json"));
const topicOf = markdown => foldTopic(foldDocumentLadder(markdown));
// List markers, line breaks and the fold's own "…" are layout, not author words.
const words = markdown => markdown.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "").split(/\s+/).filter(word => word && word !== "…");
const inOrder = (shown, source) => { let at = 0; for (const word of source) if (word === shown[at]) at++; return at === shown.length; };

const NOTE = `# Ward guide

Read this before rounds. It is short.

## Assessment

Check perfusion first. Then congestion.

### Numbers

| a | b |
|---|---|
| 1 | 2 |
| 3 | 4 |

\`\`\`js
one
two
three
\`\`\`

$$
x^2
$$

![chest film](film.png)

## Treatment $x$

Give furosemide. Watch the urine.

<!-- hidden -->
`;

test("a single leading H1 is the title; sections nest by heading level; text under the title is the opening", () => {
  const topic = topicOf(NOTE);
  assert.equal(topic.title.markdown, "Ward guide");
  assert.deepEqual(topic.sections.map(section => [section.heading, section.level, section.parent === null]), [
    [null, 0, true], ["Assessment", 2, true], ["Numbers", 3, false], ["Treatment $x$", 2, true],
  ]);
  const [opening, assessment, numbers] = topic.sections;
  assert.equal(opening.id, OPENING);
  assert.equal(opening.anchor, opening.items[0].unitId);
  assert.deepEqual(assessment.children, [numbers.id]);
  assert.equal(numbers.parent, assessment.id);
  assert.equal(numbers.anchor, numbers.id);
});

test("raw blocks become chips with their counts; hidden HTML gives nothing", () => {
  const topic = topicOf(NOTE);
  const numbers = topic.sections.find(section => section.heading === "Numbers");
  assert.deepEqual(numbers.items.map(item => item.raw), [
    { class: "table", rows: 2, columns: 2 },
    { class: "code", lines: 3, language: "js" },
    { class: "math" },
    { class: "image", kind: "image", alt: "chest film" },
  ]);
  const treatment = topic.sections.at(-1);
  assert.deepEqual(treatment.items.map(item => item.markdown), ["Give furosemide. …"]);
});

test("several H1s are sections and the note name stays the title", () => {
  const topic = topicOf("# One\n\nAlpha text here.\n\n# Two\n\nBeta text here.\n");
  assert.equal(topic.title, null);
  assert.deepEqual(topic.sections.map(section => section.heading), ["One", "Two"]);
});

test("cards skip branch-only headings and name the parent; the reading line picks its card", () => {
  const topic = topicOf("# T\n\n## Parent\n\n### Child A\n\nA text here.\n\n### Child B\n\nB text here.\n\n## Empty\n");
  const cards = topicCards(topic);
  assert.deepEqual(cards.map(card => [card.eyebrow, card.section.heading]), [["Parent", "Child A"], ["Parent", "Child B"], [null, "Empty"]]);
  assert.equal(topicCardAt(topic, 1).heading, "Child A");
  assert.equal(topicCardAt(topic, 11).heading, "Child B");
  assert.equal(topicCardAt(topic, 99).heading, "Empty");
});

test("a lecture note's cards carry the second each line starts at, its audio is the player, and lines stay the speaker's words", () => {
  const segments = [
    { startMs: 400, endMs: 2_000, text: "Spaced practice fights forgetting across long courses." },
    { startMs: 2_400, endMs: 4_000, text: "It needs gaps of days, not minutes." },
    { startMs: 6_000, endMs: 7_000, text: "Retrieval beats rereading for 120 students." },
    { startMs: 9_300, endMs: 11_000, text: "Write the answer before you check it." },
    { startMs: 310_050, endMs: 312_000, text: "Sleep keeps what you learned." },
  ];
  const markdown = lectureNote({ title: "Lecture A", audio: "Lecture A.m4a", segments, marks: [{ atMs: 6_200 }], at: "2026-01-05T09:00:00.000Z" });
  const ladder = foldDocumentLadder(markdown), topic = foldTopic(ladder);
  assert.equal(topic.audio.target, "Lecture A.m4a");
  assert.deepEqual(topic.audio.times.map(item => item.time), [0.4, 6, 9.3, 310]);
  assert.equal(topic.title.markdown, "Lecture A");
  // The audio embed is the player, never a card chip, so the opening disappears with it.
  assert.deepEqual(topic.sections.map(section => [section.heading, section.time]), [["00:00", 0.4], ["00:06", 6], ["05:10", 310]]);
  const units = new Map(ladder.byUnit.map(({ unit }) => [unit.elementId, unit]));
  for (const section of topic.sections) for (const item of section.items) {
    assert.equal(item.kind, "line");
    assert.equal(item.time, topic.audio.times.find(time => time.unitId === item.unitId).time);
    assert.doesNotMatch(item.markdown, /^\s*\[?\d/, item.markdown);
    const invented = checkLine(item.markdown, units.get(item.unitId).markdown).findings.filter(finding => finding.code.startsWith("invented"));
    assert.deepEqual(invented, [], item.markdown);
  }
  // Without an audio embed, a clock at the start of a line is just words.
  const plain = topicOf("# Plan\n\n12:30 Round on bed four before the scan.\n");
  assert.equal(plain.audio, null);
  assert.equal(foldLecture(foldDocumentLadder("# Plan\n\n![[scan.png]]\n\n00:01 Text here.\n")), null);
  assert.equal(plain.sections[0].items[0].time, null);
  assert.match(plain.sections[0].items[0].markdown, /^12:30 Round/);
});

test("heading words lose ATX hashes and setext underlines only", () => {
  assert.equal(headingMarkdown("## A **bold** $x$ ##"), "A **bold** $x$");
  assert.equal(headingMarkdown("Title\n====="), "Title");
  assert.equal(headingMarkdown("###"), "");
});

test("every fixture: one tree, every topic line is the author's own leading words and passes the payload checker", () => {
  for (const name of fixtureNames) {
    const ladder = foldDocumentLadder(readFileSync(new URL(`${name}/input.md`, fixtures), "utf8"));
    const topic = foldTopic(ladder);
    const units = new Map(ladder.byUnit.map(({ unit }) => [unit.elementId, unit]));
    const ids = new Set(topic.sections.map(section => section.id));
    assert.ok(topic.sections.length, name);
    for (const section of topic.sections) {
      if (section.parent !== null) assert.ok(ids.has(section.parent), `${name}: parent of ${section.id}`);
      for (const child of section.children) assert.ok(ids.has(child), `${name}: child ${child}`);
      for (const item of section.items) {
        const unit = units.get(item.unitId);
        assert.ok(unit, `${name}: ${item.unitId}`);
        if (item.kind === "raw") { assert.deepEqual(item.raw, unit.rawMeta); continue; }
        const shown = words(item.markdown), source = words(unit.markdown);
        assert.ok(shown.length && inOrder(shown, source), `${name}: ${item.markdown}`);
        // A lead line drops later sentences by design (its "…" says so); it must never add payload the author lacks.
        const invented = checkLine(item.markdown, unit.markdown).findings.filter(finding => finding.code.startsWith("invented"));
        assert.deepEqual(invented, [], `${name}: ${item.markdown}`);
      }
    }
    // Cards and map share sections: every section with items is a card, and every card is a section.
    const cards = topicCards(topic).map(card => card.section);
    for (const section of topic.sections) if (section.items.length) assert.ok(cards.includes(section), `${name}: ${section.id}`);
  }
});
