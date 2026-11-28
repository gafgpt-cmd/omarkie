import test from "node:test";
import assert from "node:assert/strict";
import { baseEmbed, createEmbedSource, embedLimits, noteEmbed, rebaseLinks } from "../shared/embeds.mjs";
import { extractSection, sectionRange } from "../shared/glass-cards.mjs";

const source = [
  "---", "title: Synthetic", "# not a heading", "---",
  "# Anatomy", "Intro.", "## Overview", "Anatomy overview ![chart](img/chart.png).", "### Detail", "Deep.",
  "# Physiology", "## Overview", "Physiology overview.", "```", "# Fenced", "```",
  "## Señales nerviosas", "Texto ñ.", "",
].join("\n");

function vault(notes) {
  const reads = [];
  const files = Object.keys(notes).map(relative => ({ relative, modified: "1" }));
  const embeds = createEmbedSource({ read: relatives => { reads.push(...relatives); return relatives.map(relative => ({ relative, content: notes[relative] })); } });
  embeds.setFiles(files);
  return { embeds, reads };
}

test("section ranges take nested paths, slugs, numbered ids and skip fences and front matter", () => {
  assert.equal(sectionRange(source, ["not a heading"]), null);
  assert.equal(sectionRange(source, ["Fenced"]), null);
  assert.equal(sectionRange(source, ["Overview"]).matches, 2);
  const nested = sectionRange(source, ["Physiology", "Overview"]);
  assert.equal(nested.matches, 1);
  assert.deepEqual(nested.lines.slice(nested.start, nested.end), ["## Overview", "Physiology overview.", "```", "# Fenced", "```"]);
  assert.equal(sectionRange(source, ["señales-nerviosas"]).heading, "Señales nerviosas");
  assert.equal(sectionRange(source, ["overview-1"]).lines[sectionRange(source, ["overview-1"]).start + 1], "Physiology overview.");
  assert.equal(sectionRange(source, ["overview-2"]), null);
  const detail = sectionRange(source, ["Anatomy", "Overview"]);
  assert.deepEqual(detail.lines.slice(detail.start, detail.end), ["## Overview", "Anatomy overview ![chart](img/chart.png).", "### Detail", "Deep."]);
  assert.equal(extractSection(source, "Overview").markdown, "Anatomy overview ![chart](img/chart.png).\n### Detail\nDeep.");
});

test("note embeds keep media precedence and leave non-note files to their own viewers", () => {
  assert.equal(noteEmbed("Note"), true);
  assert.equal(noteEmbed("folder/v1.2 notes#Head"), true);
  assert.equal(noteEmbed("photo.PNG"), false);
  assert.equal(noteEmbed("clip.mp4"), false);
  assert.equal(noteEmbed("table.base#View"), false);
  assert.equal(baseEmbed("table.base#View"), true);
  assert.equal(baseEmbed("Lists/Table.BASE"), true);
  assert.equal(baseEmbed("table.base.md"), false);
});

test("base embeds resolve the vault file and keep the view name", () => {
  const { embeds, reads } = vault({ "home.md": "", "a/reading.base": "", "b/twin.base": "", "c/twin.base": "" });
  assert.deepEqual(embeds.resolveBase({ relative: "home.md" }, "reading.base#All books"), { state: "ok", view: "All books", relative: "a/reading.base" });
  assert.deepEqual(embeds.resolveBase({ relative: "home.md" }, "a/reading.base"), { state: "ok", view: "", relative: "a/reading.base" });
  assert.deepEqual(embeds.resolveBase({ relative: "home.md" }, "twin.base#V"), { state: "ambiguous", view: "V", candidates: ["b/twin.base", "c/twin.base"] });
  assert.equal(embeds.resolveBase({ relative: "home.md" }, "gone.base").state, "missing");
  assert.equal(embeds.resolveBase({ relative: "" }, "reading.base").state, "missing");
  assert.deepEqual(reads, [], "resolving reads nothing");
});

test("embedded sections resolve headings, keep the target folder for links, and report ambiguity", async () => {
  const { embeds } = vault({ "a/home.md": "![[Topic#Physiology#Overview]]", "b/Topic.md": source, "b/sub/Other.md": "# Other\n", "c/Same.md": "x", "d/Same.md": "y" });
  const from = { relative: "a/home.md", content: "" };
  const nested = await embeds.section(from, "Topic#Physiology#Overview");
  assert.equal(nested.state, "ok"); assert.equal(nested.relative, "b/Topic.md"); assert.equal(nested.title, "Overview"); assert.equal(nested.line, 12);
  assert.equal((await embeds.section(from, "Topic#Overview")).state, "ambiguous-heading");
  assert.equal((await embeds.section(from, "Topic#Señales nerviosas")).markdown, "## Señales nerviosas\nTexto ñ.");
  assert.match((await embeds.section(from, "Topic#Anatomy#Overview")).markdown, /!\[chart\]\(\.\.\/b\/img\/chart\.png\)/);
  assert.equal((await embeds.section(from, "Topic#Missing")).state, "missing-heading");
  assert.equal((await embeds.section(from, "Topic#^block-1")).state, "unsupported-block");
  assert.deepEqual(await embeds.section(from, "Same"), { state: "ambiguous", candidates: ["c/Same.md", "d/Same.md"] });
  assert.equal((await embeds.section(from, "c/Same")).markdown, "x");
  assert.equal((await embeds.section(from, "Nowhere")).state, "missing");
  const whole = await embeds.section(from, "Topic");
  assert.ok(!whole.markdown.includes("title: Synthetic")); assert.ok(whole.markdown.startsWith("# Anatomy"));
});

test("cycles, same-note sections, depth and byte caps stop instead of looping", async () => {
  const { embeds } = vault({ "A.md": "# A\n![[B]]", "B.md": "# B\n![[A]]" });
  const a = await embeds.section({ relative: "A.md", content: "" }, "B", ["A.md#"]);
  assert.equal(a.state, "ok");
  assert.equal((await embeds.section({ relative: "B.md", content: "" }, "A", a.chain)).state, "cycle");
  const self = { relative: "A.md", content: "# Top\n![[#Top]]\n# Next\n" };
  const top = await embeds.section(self, "#Top", ["A.md#"]);
  assert.equal(top.state, "ok"); assert.equal(top.markdown, "# Top\n![[#Top]]");
  assert.equal((await embeds.section(self, "#Top", top.chain)).state, "cycle");
  assert.equal((await embeds.section(self, "A", ["A.md#"])).state, "cycle");
  const deep = Array.from({ length: embedLimits.depth + 1 }, (_, index) => `x${index}`);
  assert.equal((await embeds.section(self, "#Next", deep)).state, "too-deep");
  assert.equal((await embeds.section(self, "#Next", [], { bytes: embedLimits.bytes })).state, "too-large");
});

test("drafts win over disk, edits and deletes invalidate only the changed note", async () => {
  const notes = { "home.md": "", "Source.md": "# Part\nDisk text\n", "Other.md": "# Other\nStill\n" };
  const { embeds, reads } = vault(notes);
  const from = { relative: "home.md", content: "" };
  assert.equal((await embeds.section(from, "Source#Part")).markdown, "# Part\nDisk text");
  await embeds.section(from, "Other#Other");
  assert.deepEqual(reads, ["Source.md", "Other.md"]);
  await embeds.section(from, "Source#Part");
  assert.deepEqual(reads, ["Source.md", "Other.md"], "unchanged notes come from the cache");
  assert.deepEqual(embeds.setDrafts([{ relative: "Source.md", content: "# Part\nDraft text\n" }]), { changed: ["Source.md"], paths: false });
  assert.equal((await embeds.section(from, "Source#Part")).markdown, "# Part\nDraft text");
  embeds.setDrafts([]);
  notes["Source.md"] = "# Part\nSaved elsewhere\n";
  const update = embeds.setFiles([{ relative: "home.md", modified: "1" }, { relative: "Source.md", modified: "2" }, { relative: "Other.md", modified: "1" }]);
  assert.deepEqual(update, { changed: ["Source.md"], paths: false });
  assert.equal((await embeds.section(from, "Source#Part")).markdown, "# Part\nSaved elsewhere");
  assert.equal((await embeds.section(from, "Other#Other")).markdown, "# Other\nStill");
  assert.deepEqual(reads, ["Source.md", "Other.md", "Source.md"]);
  assert.deepEqual(embeds.setFiles([{ relative: "home.md", modified: "1" }, { relative: "Other.md", modified: "1" }]), { changed: ["Source.md"], paths: true });
  assert.equal((await embeds.section(from, "Source#Part")).state, "missing");
});

test("rebasing keeps external, anchor, rooted and basename links and encodes rewritten paths", () => {
  const markdown = "[web](https://example.test/x) [here](#part) [root](/abs.md) ![[pic.png]] ![[img/a b.png|200]] [note](sub/My Note.md#h) [[sub/Other]] [[gone/Note]]";
  const rebased = rebaseLinks(markdown, "b/Topic.md", "a/home.md", path => path === "b/sub/Other");
  assert.equal(rebased, "[web](https://example.test/x) [here](#part) [root](/abs.md) ![[pic.png]] ![[../b/img/a b.png|200]] [note](sub/My Note.md#h) [[../b/sub/Other]] [[gone/Note]]");
  assert.equal(rebaseLinks("[n](sub/My%20Note.md#h)", "b/T.md", "a/h.md"), "[n](../b/sub/My%20Note.md#h)");
  assert.equal(rebaseLinks("[n](<sub/My Note.md>)", "b/T.md", "h.md"), "[n](<b/sub/My%20Note.md>)");
});

test("portable bundles turn note embeds into note links and refuse unresolved embeds", async () => {
  const { bundlePlan } = await import("../shared/references.mjs");
  const note = (relative, content) => ({ token: relative, relative, content });
  const plan = bundlePlan({ notes: [note("home.md", "![[b/Topic#Señales]] ![[b/pic.png|120]]\n"), note("b/Topic.md", "# Señales\n")], assets: [{ relative: "b/pic.png" }], truncated: false });
  const home = plan.notes.find(item => item.relative === "home.md")?.content ?? plan.notes[0].content;
  assert.match(home, /^\[b\\\/Topic\\#Señales\]\(\.\.\/notes\/b\/Topic\.md#se%C3%B1ales\) !\[pic\.png\]\(\.\.\/assets\/b\/pic\.png\)\{width=120\}/m);
  assert.throws(() => bundlePlan({ notes: [note("home.md", "![[Nope#Heading]]\n")], assets: [], truncated: false }), /home\.md:1: missing: Nope#Heading/);
});
