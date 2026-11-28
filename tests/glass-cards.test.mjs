import assert from "node:assert/strict";
import test from "node:test";
import { cardFields, cardPageMarkdown, cardTitle, extractSection, normalizeChoices, parseCardLink } from "../shared/glass-cards.mjs";

test("card links accept wiki, md and section forms and reject escapes", () => {
  assert.deepEqual(parseCardLink("[[Reference#Kerma]]"), { target: "Reference", section: "Kerma" });
  assert.deepEqual(parseCardLink("[[Reference|source]]"), { target: "Reference", section: "" });
  assert.deepEqual(parseCardLink("notes/reference.md#Kerma"), { target: "notes/reference.md", section: "Kerma" });
  assert.deepEqual(parseCardLink("#Kerma"), { target: "", section: "Kerma" });
  for (const bad of ["", "   ", "../secret.md", "/abs/path.md", "https://example.com/a", "note\\win.md", "[[a#b]] extra"]) assert.equal(parseCardLink(bad), null, bad);
});

test("a static section resolves by heading and reports a broken link", () => {
  const markdown = "# Review\n\n## Kerma\n\nEnergy per unit mass.\n\n### Detail\n\nJ/kg.\n\n## Next\n\nOther.\n";
  const section = extractSection(markdown, "kerma");
  assert.equal(section.status, "ok");
  assert.equal(section.heading, "Kerma");
  assert.match(section.markdown, /Energy per unit mass/);
  assert.match(section.markdown, /J\/kg/);
  assert.doesNotMatch(section.markdown, /Other/);
  assert.equal(extractSection(markdown, "Missing").status, "section-missing");
  assert.equal(extractSection("# Only\n", "Only").status, "empty");
  assert.equal(extractSection("no headings here", "").status, "ok");
  const fenced = "## Real\n\n```md\n## Fake\n```\n\ntext\n";
  assert.equal(extractSection(fenced, "Fake").status, "section-missing");
});

test("an AI card caches one answer and keeps its question", () => {
  const values = cardFields({ kind: "card", card: "ai", question: "Why does mass matter?", answer: "Energy per mass.", answerAt: "2026-11-25T10:00:00Z", folded: false });
  assert.equal(values.answer, "Energy per mass.");
  assert.equal(values.folded, false);
  assert.equal(cardTitle({ card: "ai", question: "Why does mass matter?", answer: "Energy per mass." }), "Why does mass matter?");
  assert.throws(() => cardFields({ card: "ai", answer: 3 }), /answer/);
  assert.throws(() => cardFields({ card: "quiz" }), /Card kind/);
});

test("a menu card reveals one choice at a time", () => {
  const choices = normalizeChoices([{ label: "What is kerma?", body: "Energy released per unit mass." }, { label: "Unit?", body: "Gray." }]);
  assert.deepEqual(choices.map(choice => choice.label), ["What is kerma?", "Unit?"]);
  assert.throws(() => normalizeChoices([{ label: "" }]), /label/);
  const page = cardPageMarkdown({ card: "menu", choices });
  assert.match(page, /^# What is kerma\?/);
  assert.match(page, /## What is kerma\?\n\nEnergy released per unit mass\./);
  assert.match(page, /## Unit\?\n\nGray\./);
});

test("open-as-page is its own note, never the source", () => {
  const page = cardPageMarkdown({ card: "static", title: "Kerma", link: "[[Reference#Kerma]]" }, { markdown: "Energy per unit mass." });
  assert.match(page, /^# Kerma\n/);
  assert.match(page, /Embedded from \[\[Reference#Kerma\]\]/);
  assert.match(page, /Energy per unit mass\./);
});

test("a fold card keeps its line, stop and evidence, and its page quotes the evidence", () => {
  const values = cardFields({ kind: "card", card: "fold", question: "GFR falls as afferent tone rises.", answer: "Filtration falls when the afferent arteriole constricts.",
    link: "[[Renal#Filtration]]", stop: "key", folded: false });
  assert.equal(values.stop, "key");
  assert.throws(() => cardFields({ card: "fold", stop: "summary" }), /fold level/);
  assert.equal(cardTitle({ card: "fold", question: values.question }), "GFR falls as afferent tone rises.");
  assert.equal(cardPageMarkdown({ card: "fold", ...values }),
    "# GFR falls as afferent tone rises.\n\nGFR falls as afferent tone rises.\n\n> Filtration falls when the afferent arteriole constricts.\n\nSource: [[Renal#Filtration]]\n");
});
