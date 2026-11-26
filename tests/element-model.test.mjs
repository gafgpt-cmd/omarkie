import assert from "node:assert/strict";
import test from "node:test";
import { elementById, markdownElements, tableCells } from "../shared/element-model.mjs";

const source = `# Area 6

## Dosimetría

Kerma is the kinetic energy released per unit mass.

- first item
- second item
  - nested item

| Dose | Unit |
| --- | --- |
| 1 Gy | J/kg |

![Film badge](badge.png)

A photo of a badge ![inline](inline.png) inside a sentence.

$$ K = \\frac{dE}{dm} $$

\`\`\`ts
const kerma = 1;
\`\`\`

> [!warning] Careful
> Shielding matters.

> A plain quotation.

![[Shared note]]

---

Closing paragraph.
`;

const elements = markdownElements(source);
const kind = name => elements.filter(element => element.kind === name);

test("every element carries an exact source range and heading path", () => {
  assert.ok(elements.length >= 20);
  for (const element of elements) assert.equal(source.slice(element.from, element.to), element.markdown, `${element.id} range`);
  assert.deepEqual(elements[0].headings, ["Area 6"]);
  assert.deepEqual(elements[1].headings, ["Area 6", "Dosimetría"]);
  assert.deepEqual(elementById(elements, kind("paragraph")[0].id).headings, ["Area 6", "Dosimetría"]);
});

test("paragraphs, headings and sections keep their kind", () => {
  assert.equal(kind("heading").length, 2);
  assert.equal(kind("heading")[1].level, 2);
  assert.ok(kind("paragraph").some(element => element.markdown.startsWith("Kerma is")));
  assert.ok(kind("paragraph").some(element => element.markdown === "Closing paragraph."));
});

test("nested list items point at their list and keep their own lines", () => {
  const items = kind("list-item"), lists = kind("list");
  assert.equal(items.length, 3);
  assert.equal(lists.length, 2);
  assert.deepEqual(items.map(item => item.markdown.split("\n")[0]), ["- first item", "- second item", "  - nested item"]);
  assert.ok(items.every(item => item.parent && lists.some(list => list.id === item.parent)));
  assert.equal(items[2].parent, lists[1].id);
  assert.equal(items[2].line, 9);
  assert.equal(items[2].blockLine, 7);
});

test("table cells are elements with row, column and trimmed text", () => {
  const cells = kind("table-cell");
  assert.equal(cells.length, 4);
  assert.deepEqual(cells.map(cell => [cell.row, cell.column, cell.text]), [[11, 1, "Dose"], [11, 2, "Unit"], [13, 1, "1 Gy"], [13, 2, "J/kg"]]);
  assert.ok(cells.every(cell => cell.parent === kind("table")[0].id));
  assert.equal(kind("table").length, 1);
  assert.deepEqual(tableCells("| a | b |"), [{ markdown: "a", start: 2, end: 3 }, { markdown: "b", start: 6, end: 7 }]);
});

test("images, formulas and code blocks are their own boxes", () => {
  const images = kind("image");
  assert.equal(images.length, 2);
  assert.equal(images[0].markdown, "![Film badge](badge.png)");
  assert.equal(images[0].parent, undefined);
  assert.equal(images[1].markdown, "![inline](inline.png)");
  assert.ok(images[1].parent, "an inline image points at its paragraph");
  assert.equal(kind("formula")[0].markdown.trim(), "$$ K = \\frac{dE}{dm} $$");
  assert.equal(kind("code")[0].language, "ts");
  assert.match(kind("code")[0].markdown, /const kerma = 1;/);
});

test("callouts, quotes, embeds and dividers are told apart", () => {
  assert.equal(kind("callout")[0].markdown.split("\n")[0], "> [!warning] Careful");
  assert.equal(kind("quote")[0].markdown, "> A plain quotation.");
  assert.equal(kind("embed")[0].markdown, "![[Shared note]]");
  assert.equal(kind("divider")[0].markdown, "---");
});

test("ids are stable, unique, and survive edits elsewhere", () => {
  const ids = elements.map(element => element.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(markdownElements(source).map(element => element.id), ids);
  const edited = source.replace("Closing paragraph.", "Closing paragraph, revised.");
  const after = markdownElements(edited);
  for (const element of elements) if (!element.markdown.includes("Closing paragraph.")) assert.ok(elementById(after, element.id), `${element.id} kept`);
});

test("identical text gets an ordinal instead of a collision", () => {
  const copy = markdownElements("Same words.\n\nSame words.\n");
  assert.equal(copy.length, 2);
  assert.notEqual(copy[0].id, copy[1].id);
  assert.ok(copy[1].id.endsWith("-2"));
});

test("landmarks match the G2b stack for every element", () => {
  const paragraph = kind("paragraph")[0], landmarks = paragraph.landmarks.landmarks;
  assert.deepEqual(landmarks.map(landmark => landmark.kind), ["fingerprint", "quote", "heading", "neighbours", "position", "spot"]);
  assert.equal(landmarks[0].value.tag, "paragraph");
  assert.equal(landmarks[1].value.exact, paragraph.text);
  assert.deepEqual(landmarks[2].value.path, ["Area 6", "Dosimetría"]);
  assert.equal(landmarks[4].value.line, paragraph.line);
  assert.equal(landmarks[4].value.char, paragraph.from);
});
