import test from "node:test";
import assert from "node:assert/strict";

// Messages are asserted in English; the runner pins another language unless one is set.
process.env.OMARKIE_LANGUAGE = "en";
const { buildIndex, executeQuery } = await import("../src/plugins/ports/dataview-engine.ts");
const { parseQuery, QueryError } = await import("../src/plugins/ports/dataview-query.ts");
const { valueText } = await import("../src/plugins/ports/dataview-values.ts");
const { cardDrafts, defaultSyntax, BOLD_CLOZE } = await import("../src/plugins/ports/srs-cards.ts");
const { CapabilityError, portHost } = await import("../src/plugins/ports/capabilities.ts");
const { syntaxFrom } = await import("../src/plugins/ports/spaced_repetition.ts");

const note = (relative, frontmatter, body = "") => ({ relative, content: `---\n${frontmatter}\n---\n${body}` });
const snapshot = {
  truncated: false, assets: [],
  notes: [
    note("projects/alpha.md", "status: active\ndue: 2026-03-01\ntags: [work]", "See [[beta]]."),
    note("projects/beta.md", "status: done\ndue: 2026-02-01\ntags: [work, archive]", "Back to [[alpha]]."),
    note("projects/gamma.md", "status: active\ndue: 2026-01-15"),
    note("journal/2026-02-20.md", "mood: calm", "Worked on [[alpha]]."),
  ],
};
const index = buildIndex(snapshot);
const run = (query, origin = "journal/2026-02-20.md") => executeQuery(parseQuery(query), index, origin, "en");

test("Dataview TABLE filters by folder and frontmatter, sorts and renames columns", () => {
  const result = run('TABLE status AS "State", due FROM "projects" WHERE status = "active" SORT due ASC');
  assert.equal(result.type, "table");
  assert.deepEqual(result.names, ["File", "State", "due"]);
  assert.deepEqual(result.rows.map(row => row[0].path), ["projects/gamma.md", "projects/alpha.md"]);
  assert.deepEqual(result.rows.map(row => row[1]), ["active", "active"]);
  assert.equal(valueText(result.rows[0][2], "en"), "January 15, 2026");
  assert.equal(result.scanned, 4);
});

test("Dataview LIST resolves tags, links, file fields, GROUP BY and expressions", () => {
  assert.deepEqual(run("LIST FROM #archive").items.map(item => item.value.path), ["projects/beta.md"]);
  assert.deepEqual(run("LIST FROM [[alpha]]").items.map(item => item.value.path).sort(), ["journal/2026-02-20.md", "projects/beta.md"]);
  assert.deepEqual(run('LIST FROM outgoing([[alpha]])').items.map(item => item.value.path), ["projects/beta.md"]);
  const grouped = run('TABLE length(rows) AS "Count" FROM "projects" GROUP BY status SORT key');
  assert.deepEqual(grouped.rows.map(row => [row[0], row[1]]), [["active", 2], ["done", 1]]);
  const day = run('LIST dateformat(file.day, "yyyy-MM-dd") FROM "journal"');
  assert.equal(day.items[0].value, "2026-02-20");
  const mapped = run('TABLE map(file.tags, (tag) => upper(tag)) AS "Tags" FROM "projects" WHERE file.name = "beta"');
  assert.deepEqual(mapped.rows[0][1], ["#WORK", "#ARCHIVE"]);
  assert.ok(run("LIST WHERE this.mood = \"calm\" AND file.name = this.file.name").items.length === 1, "`this` is the note holding the query");
});

test("Dataview refuses out-of-scope views, sources and functions with a clear message", () => {
  assert.throws(() => parseQuery("TASK FROM \"projects\""), /TASK queries are not supported\. Use TABLE or LIST\./);
  assert.throws(() => run('LIST FROM csv("data.csv")'), /csv\(\) sources are not available/);
  assert.throws(() => run('LIST WHERE regextest("a", file.name)'), /regextest\(\) is not available in Omarkie: queries cannot run regular expressions\./);
  assert.throws(() => run("LIST WHERE nonsense(1)"), /Unknown function nonsense\(\)\./);
  const error = (() => { try { parseQuery("TABLE status\nWHERE (status ="); } catch (caught) { return caught; } })();
  assert.ok(error instanceof QueryError);
  assert.equal(error.line, 2);
  assert.match(error.message, /at line 2, column \d+/);
  assert.match(run('TABLE file.mtime FROM "projects"').warnings.join(" "), /file\.mtime is not available in Omarkie and reads as empty\./);
});

test("Spaced Repetition cards parse every syntax with anchors into the source note", () => {
  const source = [
    "---", "title: Cells", "---", "# Biology", "## Cells",
    "Mitochondria::Powerhouse of the cell", "Ribosome:::Protein factory",
    "What is ATP?", "?", "Energy currency", "costs $5 and $& to make", "",
    "The ==nucleus== holds ==DNA==.", "",
    "Done::Yes <!--SR:!2026-03-01,3,250-->", "<!--", "Hidden::Card", "-->", "After::Comment",
  ].join("\n");
  const drafts = cardDrafts(source, defaultSyntax);
  assert.deepEqual(drafts.map(({ front, back }) => [front, back]), [
    ["Mitochondria", "Powerhouse of the cell"],
    ["Ribosome", "Protein factory"], ["Protein factory", "Ribosome"],
    ["What is ATP?", "Energy currency\ncosts $5 and $& to make"],
    ["The […] holds DNA.", "The nucleus holds DNA."], ["The nucleus holds […].", "The nucleus holds DNA."],
    ["Done", "Yes"],
    ["After", "Comment"],
  ]);
  assert.deepEqual(drafts[0].anchor.headings, ["Biology", "Cells"]);
  assert.equal(drafts[0].anchor.line, 6);
  assert.equal(drafts[0].anchor.quote, "Powerhouse of the cell");
  assert.ok(drafts.every(draft => draft.anchor.block.length > 0 && !draft.back.includes("<!--SR")));
  assert.deepEqual(drafts.slice(4, 6).map(draft => draft.anchor.quote), ["nucleus", "DNA"]);
  assert.deepEqual(cardDrafts("A **bold** word", syntaxFrom({ HIGHLIGHT_CLOZE: false, BOLD_CLOZE: true })).map(draft => draft.front), ["A […] word"]);
  assert.deepEqual(syntaxFrom({}).clozePatterns, defaultSyntax.clozePatterns);
  assert.ok(syntaxFrom({ BOLD_CLOZE: true }).clozePatterns.includes(BOLD_CLOZE));
  assert.deepEqual(cardDrafts("Plain prose without cards."), []);
});

const provider = () => {
  const calls = [];
  return {
    calls,
    snapshot: async () => { calls.push("snapshot"); return snapshot; },
    activeNote: () => ({ relative: "projects/alpha.md", content: "x" }),
    open: async relative => { calls.push(`open ${relative}`); return true; },
    draftCards: (drafts, found) => calls.push(`draft ${drafts.length}/${found}`),
  };
};

test("port capabilities grant only declared access and refuse network, writes and internals by name", async () => {
  const host = provider(), port = portHost({ name: "Dataview", capabilities: ["vault:read", "note:read", "note:open"] }, host);
  assert.equal((await port.api.vault.snapshot()).notes.length, 4);
  assert.equal(await port.api.note.open("projects/beta.md"), true);
  assert.throws(() => port.api.cards.draft([], 0), new CapabilityError("Dataview has no permission to: Propose study cards for review."));
  assert.throws(() => port.api.requestUrl, /^CapabilityError: requestUrl is not available: Obsidian ports have no network access\.$/);
  assert.throws(() => port.api.fetch, /no network access/);
  assert.throws(() => port.api.vault.adapter, /vault\.adapter is not available: Obsidian ports cannot change files/);
  assert.throws(() => port.api.vault.modify, /vault\.modify is not available: Obsidian ports cannot change files/);
  assert.throws(() => { port.api.vault.snapshot = () => null; }, /vault\.snapshot is not available|not part of the Omarkie port API/);
  assert.throws(() => port.api.app, /app is not available: Obsidian app and workspace internals/);
  assert.throws(() => port.api.workspace, /workspace is not available/);
  assert.throws(() => port.api.require, /Node\.js and shell access are not available/);
  assert.throws(() => port.api.registerEditorExtension, /Direct DOM, CSS and editor extensions are not available/);
  assert.throws(() => port.api.addStyle, /Direct DOM, CSS/);
  assert.throws(() => port.api.vault.getFiles, /vault\.getFiles is not part of the Omarkie port API\./);
  for (const path of ["../secret.md", "/etc/passwd", "C:/x.md", "https://example.com/a.md", "a/./b.md", ""])
    await assert.rejects(port.api.note.open(path), /is outside the open folder/);
  assert.deepEqual(host.calls, ["snapshot", "open projects/beta.md"]);
});

test("port access ends on dispose, including calls already in flight", async () => {
  let release;
  const host = { ...provider(), snapshot: () => new Promise(resolve => { release = () => resolve(snapshot); }) };
  const port = portHost({ name: "Dataview", capabilities: ["vault:read", "note:read"] }, host);
  const pending = port.api.vault.snapshot();
  port.dispose();
  release();
  await assert.rejects(pending, /Dataview is turned off; its access has ended\./);
  assert.throws(() => port.api.note.active(), /turned off/);
  await assert.rejects(port.api.vault.snapshot(), /turned off/);
});

test("ports without a desktop folder explain why, and Spaced Repetition can only propose cards", async () => {
  const offline = portHost({ name: "Spaced Repetition", capabilities: ["note:read", "cards:draft"] });
  assert.throws(() => offline.api.note.active(), /Open a folder in the desktop app to use Spaced Repetition\./);
  const host = provider(), port = portHost({ name: "Spaced Repetition", capabilities: ["note:read", "cards:draft"] }, host);
  await assert.rejects(port.api.vault.snapshot(), /no permission to: Read notes in the open folder/);
  assert.throws(() => port.api.cards.save, /cards\.save is not available: Ports only propose cards/);
  assert.throws(() => port.api.cards.draft([{ front: "Q" }], 1), /Card drafts need a question, an answer and a source\./);
  const drafts = cardDrafts("Q::A");
  port.api.cards.draft(drafts, drafts.length);
  assert.deepEqual(host.calls, ["draft 1/1"]);
});
