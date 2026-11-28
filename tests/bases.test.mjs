import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { baseLimits, createBaseIndex, evaluateBase, noteRecord, parseBase, parseExpression } from "../shared/bases.mjs";

const fixture = name => readFile(new URL(`./fixtures/bases/${name}`, import.meta.url), "utf8");
const note = (relative, content, modified = "1700000000") => ({ relative, content, modified, created: "1690000000" });
const records = notes => notes.map(noteRecord);
const fm = lines => `---\n${lines.join("\n")}\n---\n`;
const run = (base, view, rows) => evaluateBase(base, view, records(rows));
const codes = base => base.diagnostics.map(item => [item.code, item.view ?? item.where ?? "", item.detail ?? ""].join(":"));

const library = [
  note("Library/Dune.md", fm(["author: Herbert", "pages: 600", "status: reading", "published: 1965-08-01"])),
  note("Library/Emma.md", fm(["author: Austen", "pages: 400", "status: done", "published: 1815-12-23"])),
  note("Library/Old/Ulysses.md", fm(["pages: 700", "tags: [archive]"])),
  note("Library/Odyssey.md", fm(["author: Homer", "pages: '350'", "status: null"])),
  note("Library/Brief.md", fm(["pages: 120"]) + "```\n#archive in code\n```\n"),
  note("Library/sub/Tagged.md", fm(["pages: 800"]) + "Shelved #archive/old\n"),
  note("Library/Broken.md", "---\npages: 999\nno closing fence\n"),
  note("Elsewhere/Out.md", fm(["pages: 900"])),
];

test("reading.base: folder, tag and typed filters, labels, DESC sort with empties last, limit and an unsupported formula column", async () => {
  const source = await fixture("reading.base"), base = parseBase(source);
  assert.deepEqual(base.views.map(view => [view.name, view.type]), [["Unread", "table"], ["All books", "cards"]]);
  assert.deepEqual(codes(base), ["formula::pages_left"]);
  const unread = run(base, "Unread", library);
  assert.deepEqual(unread.columns, [{ id: "file.name", label: "Title" }, { id: "author", label: "Author" }, { id: "pages", label: undefined }]);
  assert.deepEqual(unread.rows.map(row => row.path), ["Library/Dune.md", "Library/Odyssey.md"]);
  assert.deepEqual(unread.rows[1].values.map(cell => cell.text), ["Odyssey.md", "Homer", "350"]);
  assert.equal(unread.total, 4); assert.equal(unread.limited, true); assert.equal(unread.incomplete, false);
  const all = run(base, "All books", library);
  assert.deepEqual(all.rows.map(row => row.path), ["Library/Emma.md", "Library/Dune.md", "Library/Brief.md", "Library/Broken.md", "Library/Odyssey.md", "Library/Old/Ulysses.md", "Library/sub/Tagged.md"]);
  assert.deepEqual(all.columns.map(column => column.label), ["Title", "Author", undefined]);
  assert.equal(await fixture("reading.base"), source, "evaluation never writes");
});

const projects = [
  note("Work/Alpha.md", fm(["tags: [project]", "due: 2026-05-01", "done: false", "priority: 2", "owner: null"])),
  note("Work/Beta.md", fm(["type: project", "due: 2027-02-01", "done: false", "priority: 3"])),
  note("Work/Gamma.md", fm(["due: '2026-03-01'", "done: true", "priority: 5"]) + "Tagged #project\n"),
  note("Work/Delta.md", fm(["type: project", "due: 2026-01-15", "done: false", "priority: '4'"])),
  note("Work/Note.md", fm(["priority: 9"])),
];

test("projects.base: or-global, dates against date(), booleans, numeric text, ungrouped warning and incomplete views", async () => {
  const base = parseBase(await fixture("projects.base"));
  assert.deepEqual(codes(base), ["group-by:Active:", "filter:Linked:file.backlinks.length > 0 || priority >= 3"]);
  const active = run(base, "Active", projects);
  assert.deepEqual(active.rows.map(row => row.path), ["Work/Delta.md", "Work/Alpha.md"]);
  assert.deepEqual(active.rows.map(row => row.values.map(cell => cell.value)), [["Delta.md", "2026-01-15", "4", false, null], ["Alpha.md", "2026-05-01", 2, false, null]]);
  assert.equal(active.incomplete, false);
  const linked = run(base, "Linked", projects);
  assert.equal(linked.incomplete, true, "an unsupported filter keeps rows and says the view is incomplete");
  assert.deepEqual(linked.rows.map(row => row.path), ["Work/Alpha.md", "Work/Beta.md", "Work/Delta.md", "Work/Gamma.md"]);
});

test("expressions: precedence, null vs missing, durations, methods and precise errors", () => {
  const [alpha, delta] = records([projects[0], projects[3]]);
  const check = (expression, record) => evaluateBase(parseBase(`filters: ${JSON.stringify(expression)}`), "", [record]).rows.length === 1;
  assert.equal(check('file.hasProperty("owner")', alpha), true);
  assert.equal(check('file.hasProperty("owner")', delta), false);
  assert.equal(check("owner == null && missing == null", delta), true);
  assert.equal(check('owner.isEmpty() && !note["done"]', alpha), true);
  assert.equal(check('date("2024-12-01") + "1M" == date("2025-01-01")', alpha), true);
  assert.equal(check('due - "2 weeks" < date("2026-04-20")', alpha), true);
  assert.equal(check("1 + 2 * 3 == 7 && (1 + 2) * 3 == 9", alpha), true);
  assert.equal(check('file.name.lower().startsWith("alpha") && file.folder == "Work" && file.ext == "md"', alpha), true);
  assert.equal(check('tags.contains("project") && file.tags.length == 1 && file.inFolder("work/")', alpha), true);
  assert.equal(check('priority > "10"', alpha), false, "numeric text compares as a number");
  assert.equal(check("done > 1", alpha), false, "booleans and numbers are not ordered");
  assert.throws(() => parseExpression("a =="), /incomplete/);
  assert.throws(() => parseExpression("a = 1"), /unexpected "="/);
  assert.throws(() => parseExpression("(".repeat(80) + "1" + ")".repeat(80)), /nested too deep/);
  assert.throws(() => parseExpression("x".repeat(baseLimits.expression + 1)), /too long/);
  const unsupported = parseBase('filters: \'file.hasLink("x") && formula.y > 1\'\nviews:\n  - type: map\n    name: Map\nextra: 1\n');
  assert.deepEqual(codes(unsupported), ["key::extra", "filter:global:file.hasLink(\"x\") && formula.y > 1", "view-type:Map:map"]);
  assert.match(unsupported.diagnostics[1].reason, /file\.hasLink\(\) is not supported yet/);
});

test("bad files fail closed: YAML errors, wrong shape, size cap; empty file is one default table", () => {
  assert.equal(parseBase("views: [").error, "yaml");
  assert.equal(parseBase("- a\n- b\n").error, "shape");
  assert.equal(parseBase("#".repeat(baseLimits.bytes + 1)).error, "too-large");
  const blank = parseBase("");
  assert.equal(blank.views.length, 1); assert.deepEqual(blank.views[0].columns.map(column => column.id), ["file.name"]);
  assert.equal(evaluateBase(blank, "", records(library)).rows.length, library.length);
});

test("the index re-parses only changed, renamed or deleted notes", () => {
  const index = createBaseIndex(), notes = projects.map(item => ({ ...item }));
  assert.equal(index.update(notes).length, 5);
  const first = index.records();
  assert.deepEqual(index.update(notes), []);
  assert.equal(index.records(), first, "unchanged input keeps the same records");
  notes[1] = { ...notes[1], content: notes[1].content.replace("priority: 3", "priority: 1") };
  assert.deepEqual(index.update(notes), ["Work/Beta.md"]);
  assert.equal(index.records().find(record => record.path === "Work/Beta.md").properties.priority, 1);
  assert.equal(index.records().find(record => record.path === "Work/Alpha.md"), first[0]);
  notes[2] = { ...notes[2], relative: "Work/Renamed.md" };
  assert.deepEqual(index.update(notes), ["Work/Renamed.md", "Work/Gamma.md"]);
  assert.deepEqual(index.update(notes.slice(0, 2)).sort(), ["Work/Delta.md", "Work/Note.md", "Work/Renamed.md"]);
  assert.deepEqual(index.records().map(record => record.path), ["Work/Alpha.md", "Work/Beta.md"]);
});

test("warm filter and sort over 10k synthetic notes stays under 100 ms at p95", () => {
  const statuses = ["todo", "reading", "done", "paused", "dropped"], index = createBaseIndex();
  index.update(Array.from({ length: 10000 }, (_, at) => note(`Shelf/${at % 40}/Note ${at}.md`, fm([`status: ${statuses[at % 5]}`, `pages: ${(at * 7919) % 1500}`, `published: ${1900 + at % 120}-0${1 + at % 9}-1${at % 10}`, `tags: [${at % 3 ? "keep" : "archive/old"}]`]))));
  const base = parseBase([
    "filters:", "  and:", '    - file.inFolder("Shelf")', '    - \'file.ext == "md"\'',
    "views:", "  - type: table", "    name: Main", "    filters:", "      and:", "        - 'status != \"done\" && pages > 100'", "        - not:", '            - file.hasTag("archive")',
    "    order: [file.name, status, pages, published]", "    sort:", "      - property: pages", "        direction: DESC", "      - property: published", "        direction: ASC",
  ].join("\n"));
  const rows = index.records(), times = [];
  let result;
  for (let round = 0; round < 35; round++) {
    const start = performance.now();
    result = evaluateBase(base, "Main", rows);
    if (round >= 5) times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.ceil(times.length * 0.95) - 1];
  assert.ok(result.total > 4000 && result.total < 6000, `matched ${result.total}`);
  assert.ok(Number(result.rows[0].values[2].value) >= Number(result.rows[1].values[2].value));
  assert.ok(p95 <= 100, `p95 ${p95.toFixed(1)} ms`);
});
