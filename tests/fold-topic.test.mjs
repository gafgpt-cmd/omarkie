import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { checkLine } from "../shared/fold-check.mjs";
import { foldTopic, headingMarkdown, OPENING, topicCardAt, topicCards } from "../shared/fold-topic.mjs";
import { foldDocumentLadder } from "../shared/fold-units.mjs";

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
