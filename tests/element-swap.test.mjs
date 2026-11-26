import assert from "node:assert/strict";
import test from "node:test";
import {
  attributionText, candidateAllowed, capProposals, compareSet, latestSwaps, licenceVerdict, normalLicence,
  onlineAllowed, replaySwaps, replacementLines, swapActionsFor, swapDiff,
} from "../shared/element-swap.mjs";

const picture = {
  kind: "find", source: "commons", sourceLabel: "Wikimedia Commons", title: "Median nerve", creator: "Ada Lovelace",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Median_nerve.jpg", width: 1600, height: 1200, bytes: 90_000,
  licence: { code: "by", version: "3.0", url: "https://creativecommons.org/licenses/by/3.0/", attribution: "Ada Lovelace", required: true },
  online: true,
};

test("element kinds offer only their own chips", () => {
  assert.deepEqual(swapActionsFor({ kind: "image" }), ["enhance", "find", "generate"]);
  assert.deepEqual(swapActionsFor({ kind: "paragraph" }), ["rewrite"]);
  assert.deepEqual(swapActionsFor({ kind: "code", language: "mermaid" }), ["redraw"]);
  assert.deepEqual(swapActionsFor({ kind: "code", language: "ts" }), []);
  assert.deepEqual(swapActionsFor({ kind: "formula" }), []);
  assert.deepEqual(swapActionsFor({ kind: "table" }), []);
});

test("an online candidate without licence data can never be applied", () => {
  const anonymous = { ...picture, licence: null };
  assert.equal(candidateAllowed(anonymous).code, "ATTRIBUTION_MISSING");
  const noAuthor = { ...picture, licence: { ...picture.licence, attribution: "" } };
  assert.equal(candidateAllowed(noAuthor).code, "ATTRIBUTION_MISSING");
  const noUrl = { ...picture, sourceUrl: null };
  assert.equal(candidateAllowed(noUrl).code, "ATTRIBUTION_MISSING");
  assert.equal(candidateAllowed(picture).ok, true);
});

test("NC and ND licences are refused with the reason", () => {
  assert.equal(licenceVerdict(normalLicence({ code: "by-nd", version: "4.0" })).code, "LICENCE_NOT_ALLOWED");
  assert.equal(licenceVerdict(normalLicence({ code: "by-nc-sa", version: "4.0" })).reason, "NC: no commercial use");
  assert.equal(licenceVerdict(normalLicence({ code: "by-sa", version: "4.0" })).allowed, true);
  const nd = { ...picture, licence: { ...picture.licence, code: "by-nc" } };
  assert.equal(candidateAllowed(nd).code, "LICENCE_NOT_ALLOWED");
});

test("a picture under 200 px on either edge is too small", () => {
  assert.equal(candidateAllowed({ ...picture, height: 199 }).code, "CANDIDATE_TOO_SMALL");
  assert.equal(candidateAllowed({ ...picture, width: 200, height: 200 }).ok, true);
});

test("the attribution footnote carries title, author, licence, source, changes and date", () => {
  const line = attributionText(picture, { accessed: "2026-11-25T10:00:00Z", operations: ["resized 1600 px"] });
  assert.equal(line, '"Median nerve" by Ada Lovelace, BY 3.0, via Wikimedia Commons — https://commons.wikimedia.org/wiki/File:Median_nerve.jpg (resized 1600 px; accessed 2026-11-25)');
});

test("a replacement rewrites only the element's bytes and appends its footnote", () => {
  const text = "# Head\n\n![Old](old.png)\n\nAfter.\n";
  const from = text.indexOf("![Old]"), to = from + "![Old](old.png)".length;
  const lines = replacementLines(picture, { swapId: "sw-abcdef", accessed: "2026-11-25T10:00:00Z", imageMarkdown: "![Median nerve](median.png)" });
  const diff = swapDiff(text, { from, to }, lines);
  assert.equal(diff.next, `# Head\n\n![Median nerve](median.png)[^swap-abcdef]\n\n[^swap-abcdef]: "Median nerve" by Ada Lovelace, BY 3.0, via Wikimedia Commons — https://commons.wikimedia.org/wiki/File:Median_nerve.jpg (accessed 2026-11-25)\n\nAfter.\n`);
  assert.deepEqual(diff.removed, ["![Old](old.png)"]);
  assert.equal(diff.added[0], "![Median nerve](median.png)[^swap-abcdef]");
});

test("Rewrite keeps its own prose and may add a source footnote", () => {
  const lines = replacementLines({ kind: "rewrite", text: "Shorter cue.\nSecond line.", licence: { code: "tutor", attribution: "Tutor" },
    sourceLabel: "the Tutor", sourceUrl: null, title: "Rewrite" }, { swapId: "sw-abcdef", accessed: 0 });
  assert.equal(lines[0], "Shorter cue.");
  assert.equal(lines[1], "Second line.");
  assert.match(lines[3], /^\[\^swap-abcdef\]: /);
});

test("online search needs the click and a vault that allows it", () => {
  assert.deepEqual(onlineAllowed({ requested: false, neverOnline: false }).code, "CONSENT_REQUIRED");
  assert.equal(onlineAllowed({ requested: true, neverOnline: true }).allowed, false);
  assert.equal(onlineAllowed({ requested: true, neverOnline: false }).allowed, true);
});

test("the original comes first in the compare set and the row stops at four", () => {
  const rows = compareSet({ id: "current", title: "Current" }, [1, 2, 3, 4].map(index => ({ id: `c${index}` })));
  assert.equal(rows.length, 5);
  assert.equal(rows[0].current, true);
  assert.equal(rows[1].current, false);
});

test("proposals are capped per batch and the newest per element wins undo", () => {
  const now = Date.parse("2026-11-25T10:00:00Z");
  const many = Array.from({ length: 30 }, (_, index) => ({ element: `e${index}`, candidateId: `c${index}`, at: now }));
  assert.equal(capProposals(many, { now }).length, 12);
  const old = Array.from({ length: 30 }, (_, index) => ({ element: `o${index}`, candidateId: `o${index}`, at: now - 2 * 3_600_000 }));
  assert.equal(capProposals(old, { now }).length, 20);
  const records = [
    { op: "swap", swapId: "sw-aaaaaa", element: { id: "paragraph-1" }, at: Date.parse("2026-11-25T10:00:00Z"), mode: "replace" },
    { op: "swap", swapId: "sw-bbbbbb", element: { id: "paragraph-1" }, at: Date.parse("2026-11-25T10:05:00Z"), mode: "cover" },
  ];
  assert.equal(latestSwaps(replaySwaps(records.map(record => JSON.stringify(record)).join("\n")).applied)[0].swapId, "sw-bbbbbb");
  records.push({ op: "swap-undo", swapId: "sw-bbbbbb" });
  assert.equal(latestSwaps(replaySwaps(records.map(record => JSON.stringify(record)).join("\n")).applied)[0].swapId, "sw-aaaaaa");
});
