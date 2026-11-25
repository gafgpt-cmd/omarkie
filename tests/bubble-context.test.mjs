import test from "node:test";
import assert from "node:assert/strict";
import { markdownElements } from "../shared/element-model.mjs";
import { bubbleBundle, bubblePayload, findIdentifiers, payloadText } from "../shared/bubble-context.mjs";

const source = `# Kerma

Kerma is the kinetic energy released per unit mass.

Patient: Juan Pérez, MRN 88213, born 12/03/1975.

![Film badge](assets/badge.png)

Shielding matters.
`;

const elements = markdownElements(source);
const paragraph = elements.find(element => element.kind === "paragraph" && element.markdown.startsWith("Kerma is"));

test("bubble bundle carries element markdown, heading path and neighbours", () => {
  const bundle = bubbleBundle(elements, paragraph, { note: "dosimetry.md" });
  assert.equal(bundle.note, "dosimetry.md");
  assert.equal(bundle.element.kind, "paragraph");
  assert.deepEqual(bundle.headings, ["Kerma"]);
  assert.equal(bundle.text, paragraph.markdown);
  assert.equal(bundle.quote, "Kerma is the kinetic energy released per unit mass.");
  assert.equal(bundle.neighbours.before, "# Kerma");
  assert.equal(bundle.neighbours.after.startsWith("Patient: Juan Pérez"), true);
  assert.deepEqual(bundle.images, []);
  assert.deepEqual(bundle.metadata, { note: "dosimetry.md", kind: "paragraph", line: paragraph.line });
});

test("a selected range replaces the quote but not the sent element", () => {
  const bundle = bubbleBundle(elements, paragraph, { note: "dosimetry.md", quote: "  kinetic energy  " });
  assert.equal(bundle.quote, "kinetic energy");
  assert.equal(bundle.text, paragraph.markdown);
});

test("images are named, never inlined", () => {
  const image = elements.find(element => element.kind === "image");
  const bundle = bubbleBundle(elements, image, { note: "dosimetry.md" });
  assert.deepEqual(bundle.images, ["badge.png"]);
});

test("the payload is exactly the fields the bridge receives", () => {
  const bundle = bubbleBundle(elements, paragraph, { note: "dosimetry.md" });
  const payload = bubblePayload(bundle, "  Why does mass matter?  ", "Kerma is energy per mass.");
  assert.deepEqual(payload, {
    document: "dosimetry.md",
    element: paragraph.id,
    kind: "paragraph",
    line: paragraph.line,
    headings: ["Kerma"],
    text: "Kerma is energy per mass.",
    quote: "Kerma is the kinetic energy released per unit mass.",
    neighbours: { before: "# Kerma", after: "Patient: Juan Pérez, MRN 88213, born 12/03/1975." },
    question: "Why does mass matter?",
  });
  assert.deepEqual(bubblePayload(bubbleBundle(elements, elements.find(element => element.kind === "image"), { note: "x.md" }), "q").images, ["badge.png"]);
});

test("the guard scans every field the bridge receives, not only the block", () => {
  const bundle = bubbleBundle(elements, paragraph, { note: "dosimetry.md", quote: "Patient: Juan Pérez" });
  const payload = bubblePayload(bundle, "MRN 88213?");
  const flags = findIdentifiers(payloadText(payload));
  assert.deepEqual(flags.map(flag => [flag.kind, flag.value]), [
    ["name", "Patient: Juan Pérez"],
    ["record", "MRN 88213"],
    ["dob", "born 12/03/1975"],
  ]);
  const cleanBlock = { document: "dosimetry.md", element: "paragraph-x", kind: "paragraph", line: 3, headings: [], text: "Clean block.",
    quote: "Clean block.", neighbours: { after: "Patient: Juan Pérez" }, question: "Why?" };
  assert.deepEqual(findIdentifiers(payloadText(cleanBlock)).map(flag => flag.kind), ["name"], "a neighbour identifier is flagged");
});

test("obvious identifiers are flagged: labelled name, record number, date of birth, full date, contact", () => {
  const flags = findIdentifiers("Patient: Juan Pérez, MRN 88213, born 12/03/1975. Call +34 600 123 456 or a.b@clinic.example.");
  assert.deepEqual(flags.map(flag => [flag.kind, flag.value]), [
    ["name", "Patient: Juan Pérez"],
    ["record", "MRN 88213"],
    ["dob", "born 12/03/1975"],
    ["contact", "+34 600 123 456"],
    ["contact", "a.b@clinic.example"],
  ]);
  for (const flag of flags) assert.equal(flag.signature, `${flag.kind}:${flag.value}`);
});

test("a bare full date is flagged, an age or dose is not", () => {
  assert.deepEqual(findIdentifiers("Surgery on 2019-04-02.").map(flag => flag.kind), ["date"]);
  assert.deepEqual(findIdentifiers("Give 1 Gy in 2020 fractions to a 45-year-old."), []);
  assert.deepEqual(findIdentifiers("Kerma is the kinetic energy released per unit mass."), []);
});

test("duplicates collapse and overlaps never double-report", () => {
  const flags = findIdentifiers("MRN 88213 and MRN 88213. Dr. Ana Ruiz. Dra. Ana Ruiz.");
  assert.deepEqual(flags.map(flag => flag.kind), ["record", "name"]);
  assert.equal(findIdentifiers("MRN 88213", { limit: 0 }).length, 0);
});
