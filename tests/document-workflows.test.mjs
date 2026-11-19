import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { frontmatter, properties, setProperties, makeReady, validateOKF } from "../shared/frontmatter.mjs";
import { newNote } from "../shared/new-note.mjs";
import { references, referenceIndex, bundlePlan } from "../shared/references.mjs";
import { DocumentStore, digest } from "../electron/store.mjs";
import { vaultSnapshot, exportBundle } from "../electron/document-workflows.mjs";
import { conversionOptions, convertExport, pandocPath } from "../electron/interchange.mjs";
const exec = promisify(execFile);
async function fixture(t) { const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "document-workflows-"))); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const note = (relative, content) => ({ relative, content, token: relative });

test("property patches preserve BOM, CRLF, YAML comments, unknown fields and exact body", () => {
  const body = "\r\n# Heading  \r\n\r\nUnchanged `bytes`\nlast line";
  const source = '\uFEFF---\r\n# Keep this\r\ntype: Old # inline\r\ncustom:\r\n  nested: "untouched"\r\n...\r\n' + body;
  const changed = setProperties(source, { type: "Reference", tags: ["one", "two"] });
  assert.equal(frontmatter(changed).body, body);
  assert.ok(changed.startsWith('\uFEFF---\r\n# Keep this\r\ntype: "Reference" # inline\r\ncustom:\r\n  nested: "untouched"\r\n'));
  assert.ok(changed.includes('"tags": ["one","two"]\r\n...\r\n'));
  assert.deepEqual(properties(changed).custom, { nested: "untouched" });
  assert.equal(setProperties(changed, { type: "Reference", tags: ["one", "two"] }), changed);
});
test("flow mappings, block scalar replacement and invalid YAML are handled without flattening unknown data", () => {
  const flow = '---\n{type: Old, custom: [1, 2]} # keep\n---\nbody';
  const result = setProperties(flow, { title: "New" });
  assert.ok(result.includes('custom: [1, 2]')); assert.ok(result.includes('# keep'));
  assert.equal(properties(result).title, "New");
  const block = '---\ntype: Reference\ndescription: |\n  old words\ncustom: value # keep\n---\nbody';
  const edited = setProperties(block, { description: "New words" });
  assert.equal(properties(edited).description, "New words"); assert.ok(edited.includes('custom: value # keep'));
  assert.throws(() => setProperties('---\ntype: One\ntype: Two\n---\nbody', { title: "New" }));
  assert.throws(() => setProperties('---\ntype: [\n---\nbody', { title: "New" }));
});
test("new-note metadata and permissive OKF v0.2 validation do not invent domain types", () => {
  const source = newNote('A "title".md', "2026-01-01T00:00:00Z");
  assert.deepEqual(validateOKF(source), []); assert.equal(properties(source).type, "Reference");
  assert.equal(properties(source).title, 'A "title"');
  assert.equal(properties(source).generated.by, "process:editor");
  assert.deepEqual(validateOKF('---\ntype: Unregistered Kind\ncustom: arbitrary\nverified: { by: "human:reviewer" }\n---\n'), []);
  assert.deepEqual(validateOKF('---\ntype: Reference\n---\n[broken](missing.md)'), []);
  assert.ok(validateOKF('# Plain').includes("missing-type"));
  assert.ok(validateOKF('---\ntype: Reference\n...\nbody').includes("okf-delimiter"));
  assert.deepEqual(validateOKF('---\nokf_version: "0.2"\n---\n# Bundle\n', "index.md", true), []);
  assert.ok(validateOKF('---\ntype: Reference\n---\n', "log.md").includes("log-frontmatter"));
  const ready = makeReady('---\ncustom: retained # keep\n---\nExact body', "note.md");
  assert.deepEqual(validateOKF(makeReady('---\ntype: null\n---\nBody', 'note.md')), []);
  assert.equal(makeReady(ready, "note.md"), ready); assert.ok(ready.endsWith('---\nExact body')); assert.ok(ready.includes('custom: retained # keep'));
});
test("explicit make-ready normalizes only YAML closing delimiters, including in bundle copies", () => {
  for (const eol of ["\n", "\r\n"]) for (const closing of ["...", "... \t"]) for (const body of ["", eol + "Body  " + eol + "last\nline"]) {
    const source = '\uFEFF---' + eol + '# Keep comment' + eol + 'type: Reference' + eol + 'title: Example' + eol + 'tags: []' + eol + 'custom: {nested: retained} # keep' + eol + closing + body;
    const expected = source.replace(eol + closing, eol + closing.replace("...", "---"));
    assert.equal(setProperties(source, { type: "Reference" }), source);
    assert.equal(makeReady(source, "note.md"), expected);
    assert.equal(makeReady(expected, "note.md"), expected);
    assert.deepEqual(validateOKF(expected), []);
    assert.equal(frontmatter(expected).body, frontmatter(source).body);
    const plan = bundlePlan({ notes: [note("note.md", source)], assets: [], truncated: false });
    assert.equal(plan.notes[0].content, expected);
  }
  const incomplete = '---\ncustom: value # keep\n...\nBody';
  const ready = makeReady(incomplete, "note.md");
  assert.deepEqual(validateOKF(ready), []);
  assert.equal(properties(ready).custom, "value");
  assert.equal(frontmatter(ready).body, "Body");
});
test("encoded hashes resolve as filenames across navigation, reports and copied links", () => {
  const original = '[Open](other%23draft.md#Heading%20name)\n![photo](photo%231.png)\n![ref][image]\n\n[image]: photo%231.png\n';
  const snapshot = { notes: [note("start.md", original), note("other#draft.md", "# Heading name\n")], assets: [{ relative: "photo#1.png" }, { relative: "unused.png" }], truncated: false };
  const index = referenceIndex(snapshot), from = index.notes[0];
  assert.equal(index.resolve(from, "other%23draft.md", false).candidates[0].relative, "other#draft.md");
  assert.equal(index.resolve(from, "other%23draft.md#Heading%20name", false).line, 1);
  assert.equal(index.resolve(from, "photo%231.png", false).candidates[0].relative, "photo#1.png");
  assert.equal(index.resolve(from, "other%23draft.md#Absent", false).state, "missing-heading");
  assert.equal(index.resolve(from, "photo%ZZ.png", false).state, "invalid");
  assert.equal(index.resolve(from, "other%23draft.md#%ZZ", false).state, "invalid");
  assert.deepEqual(index.broken, []);
  assert.deepEqual(index.unused.map(asset => asset.relative), ["unused.png"]);
  const plan = bundlePlan(snapshot);
  assert.ok(plan.notes[0].content.includes('[Open](../notes/other%23draft.md#heading-name)'));
  assert.ok(plan.notes[0].content.includes('![photo](../assets/photo%231.png)'));
  assert.ok(plan.notes[0].content.includes('![ref](../assets/photo%231.png)'));
  assert.equal(snapshot.notes[0].content, original);
});
test("reference inventory shares wiki, Markdown and reference-style images; excludes code/frontmatter/comments", () => {
  const source = '---\ntype: Reference\ncover: "![[ignored.png]]"\n---\n[[Target#Heading|Visible]] #nested/tag\n![[photo space.png|300x200]]\n![raw](folder/my photo.png)\n![ref][image]\n\n[image]: other.png\n\n`[[inline]] #ignored`\n<!-- ![[comment.png]] -->\n\n```md\n[[fenced]]\n```\n';
  const parsed = references(source);
  assert.deepEqual(parsed.references.map(ref => ref.target), ["Target#Heading", "photo space.png", "folder/my photo.png", "other.png"]);
  assert.deepEqual(parsed.tags.map(item => item.tag), ["nested/tag"]);
  for (const ref of parsed.references) assert.equal(source.slice(ref.from, ref.to), ref.source);
});
test("resolution is relative, alias-aware, fragment-aware and visibly ambiguous without vault escapes", () => {
  const snapshot = { notes: [note("folder/start.md", "[[Shared]] [[../Target#**Heading**]] #focus"), note("one/Shared.md", ""), note("two/Shared.md", ""), note("Target.md", '---\ntype: Reference\naliases: [Nickname]\ntags: [focus]\n---\n# **Heading**\n')], assets: [], truncated: false };
  const index = referenceIndex(snapshot), from = index.notes[0];
  assert.equal(index.resolve(from, "Shared").state, "ambiguous");
  assert.equal(index.resolve(from, "Nickname").candidates[0].relative, "Target.md");
  assert.equal(index.resolve(from, "../Target#Heading").line, 6);
  assert.equal(index.resolve(index.notes[3], "#Heading").line, 6);
  assert.equal(index.resolve(index.notes[3], "#Absent").state, "missing-heading");
  assert.equal(index.resolve(from, "../../outside").state, "escape");
  assert.equal(index.resolve(from, "%2e%2e/%2e%2e/outside", false).state, "escape");
  assert.equal(index.resolve(from, "file:///outside").state, "escape");
  assert.equal(index.resolve(from, "../Target#Absent").state, "missing-heading");
  assert.equal(index.tags("focus").length, 2);
  assert.equal(index.backlinks(index.notes[3]).length, 1);
  assert.equal(snapshot.notes[0].content, "[[Shared]] [[../Target#**Heading**]] #focus");
});
test("copied bundles rewrite note/image aliases, raw spaces, dimensions and reserved names in export copies only", () => {
  const original = '![[images/photo space.png|300x200]]\n![raw](images/photo space.png)\n[[other#Heading|Alias]]\n';
  const snapshot = { notes: [note("start.md", original), note("other.md", "# Heading\n"), note("index.md", "# Existing index\n")], assets: [{ relative: "images/photo space.png" }, { relative: "unused.png" }], truncated: false };
  const plan = bundlePlan(snapshot, "2026-01-01");
  assert.ok(plan.notes[0].content.includes('![photo space.png](../assets/images/photo%20space.png){width=300 height=200}'));
  assert.ok(plan.notes[0].content.includes('[Alias](../notes/other.md#heading)'));
  assert.equal(plan.assets.length, 1); assert.equal(snapshot.notes[0].content, original);
  assert.ok(plan.notes.some(note => note.relative === "notes/_index.md"));
  for (const item of plan.notes) assert.deepEqual(validateOKF(item.content, item.relative), []);
  assert.deepEqual(validateOKF(plan.index, "index.md", true), []); assert.deepEqual(validateOKF(plan.log, "log.md"), []);
  assert.throws(() => bundlePlan({ ...snapshot, truncated: true }));
  assert.throws(() => bundlePlan({ ...snapshot, notes: [note("start.md", "[[missing]]")] }));
});
test("explicit image size attributes override wiki dimensions once in copied bundles", () => {
  const source = "![[picture space.png|100 x 60]]{width=400 height=240}";
  const plan = bundlePlan({ notes: [note("start.md", source)], assets: [{ relative: "picture space.png" }], truncated: false });
  assert.ok(plan.notes[0].content.includes("![picture space.png](../assets/picture%20space.png){width=400 height=240}"));
  assert.equal((plan.notes[0].content.match(/\{width=/g) || []).length, 1);
  assert.equal(source, "![[picture space.png|100 x 60]]{width=400 height=240}");
});
test("duplicate images remain referenced in upkeep, but ambiguous bundle export is refused", () => {
  const snapshot = { notes: [note("start.md", "![[photo.png|wide]]")], assets: [{ relative: "a/photo.png" }, { relative: "b/photo.png" }, { relative: "unused.png" }], truncated: false };
  const index = referenceIndex(snapshot);
  assert.equal(index.edges[0].state, "ambiguous"); assert.deepEqual(index.unused.map(item => item.relative), ["unused.png"]);
  assert.throws(() => bundlePlan(snapshot));
});
test("restored aliased notes retain canonical identity, duplicate choices and recovery bytes", async t => {
  const root = await fixture(t), vault = path.join(root, "vault"), alias = path.join(root, "alias");
  await mkdir(vault); await mkdir(path.join(vault, "one")); await mkdir(path.join(vault, "two"));
  await symlink(vault, alias, process.platform === "win32" ? "junction" : "dir");
  for (const folder of ["one", "two"]) await writeFile(path.join(vault, folder, "Same.md"), "# Same\n");
  const saved = '---\r\ncustom: retained # keep\r\n---\r\n[[Same]] #focus\n';
  for (const state of ["clean", "dirty", "conflict", "missing"]) {
    const file = path.join(vault, state + ".md"), requested = path.join(alias, state + ".md");
    const disk = '\uFEFF' + saved + (state === "conflict" ? "External change\r\n" : "");
    if (state !== "missing") await writeFile(file, disk);
    const profile = path.join(root, state); await mkdir(profile);
    const content = state === "clean" ? saved : saved + "Unsaved draft\n";
    const record = { id: state, path: requested, name: state + ".md", content, savedContent: saved, diskHash: digest('\uFEFF' + saved), encoding: "utf-8", bom: true, lineEnding: "\r\n" };
    const sessionBytes = JSON.stringify({ version: 1, folder: alias, activeId: state, documents: [record] });
    await writeFile(path.join(profile, "session.json"), sessionBytes);
    const store = new DocumentStore(profile), session = await store.restore(), restored = session.documents[0];
    assert.equal(restored.id, state); assert.equal(session.activeId, state);
    assert.equal(restored.content, content); assert.equal(restored.savedContent, saved);
    assert.equal(restored.bom, true); assert.equal(restored.encoding, "utf-8"); assert.equal(restored.lineEnding, "\r\n");
    assert.equal(Boolean(restored.conflict), state === "conflict" || state === "missing");
    assert.equal(await readFile(path.join(profile, "session.json"), "utf8"), sessionBytes);
    if (state === "missing") { assert.equal(restored.path, requested); continue; }
    assert.equal(restored.path, await realpath(file));
    const index = referenceIndex(await vaultSnapshot(store)), current = index.notes.find(note => note.path === restored.path);
    assert.ok(current);
    const resolution = index.resolve(current, "Same", true);
    assert.equal(resolution.state, "ambiguous");
    assert.deepEqual(resolution.candidates.map(note => note.relative).sort(), ["one/Same.md", "two/Same.md"]);
    assert.equal((await store.open(file)).id, state);
    assert.equal(store.records.get(state).content, content);
    assert.equal(await readFile(file, "utf8"), disk);
  }
});
test("host snapshot/export uses selected-folder scope, bounded copied output and no source mutation", async t => {
  const root = await fixture(t), vault = path.join(root, "vault"), output = path.join(root, "output");
  await mkdir(vault); await mkdir(output); await mkdir(path.join(vault, "images"));
  const source = '![[images/picture space.png|100]]\n';
  await writeFile(path.join(vault, "note.md"), source); await writeFile(path.join(vault, "images/picture space.png"), "synthetic image");
  await writeFile(path.join(root, "outside.md"), "outside");
  if (process.platform !== "win32") await symlink(path.join(root, "outside.md"), path.join(vault, "escape.md"));
  const store = new DocumentStore(path.join(root, "session")); await store.scan(vault);
  const snapshot = await vaultSnapshot(store); assert.equal(snapshot.notes.length, 1);
  assert.equal(snapshot.notes[0].path, path.join(vault, "note.md"));
  const plan = bundlePlan(snapshot, "2026-01-01"), destination = await exportBundle(store, plan, output);
  assert.equal(await readFile(path.join(vault, "note.md"), "utf8"), source);
  assert.equal(await readFile(path.join(destination, "assets/images/picture space.png"), "utf8"), "synthetic image");
  assert.ok((await readdir(destination)).includes("index.md"));
  await assert.rejects(exportBundle(store, plan, vault));
  await assert.rejects(exportBundle(store, { ...plan, assets: [{ source: "../outside.md", relative: "assets/escape.md" }] }, output));
  await assert.rejects(exportBundle(store, { ...plan, notes: [{ ...plan.notes[0], relative: "../escape.md" }] }, output));
  await assert.rejects(exportBundle(store, { ...plan, notes: [{ ...plan.notes[0], token: "unowned" }] }, output));
});
test("default pasted attachments are inventoried and copied without admitting hidden files or symlinks", async t => {
  const root = await fixture(t), vault = path.join(root, "vault"), output = path.join(root, "output");
  await mkdir(vault); await mkdir(output); await mkdir(path.join(vault, "nested"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNNsAAAAASUVORK5CYII=", "base64");
  const store = new DocumentStore(path.join(root, "session"));
  for (const relative of ["note.md", "nested/note.md"]) {
    const file = path.join(vault, relative); await writeFile(file, "# Note\n");
    const record = await store.open(file), image = await store.importImage(record.id, png, "photo.png");
    assert.ok(image.startsWith(".assets/"));
    await writeFile(file, `![photo](${image})\n`);
  }
  await mkdir(path.join(vault, ".private")); await writeFile(path.join(vault, ".private/secret.png"), png);
  await writeFile(path.join(vault, ".assets/.hidden.png"), png);
  await writeFile(path.join(root, "outside.png"), png);
  if (process.platform !== "win32") {
    await symlink(path.join(root, "outside.png"), path.join(vault, ".assets/escape.png"));
    await symlink(path.join(vault, "nested/.assets"), path.join(vault, "linked"));
  }
  await store.scan(vault);
  const snapshot = await vaultSnapshot(store), index = referenceIndex(snapshot);
  assert.equal(snapshot.assets.length, 2);
  assert.deepEqual(index.broken, []); assert.deepEqual(index.unused, []);
  const plan = bundlePlan(snapshot), destination = await exportBundle(store, plan, output);
  for (const item of plan.assets) assert.deepEqual(await readFile(path.join(destination, item.relative)), png);
  for (const item of snapshot.notes) assert.equal(await readFile(path.join(vault, item.relative), "utf8"), item.content);
  for (const source of [".private/secret.png", ".assets/../outside.png", ...(process.platform !== "win32" ? [".assets/escape.png", "linked/" + path.basename(plan.assets.find(item => item.source.startsWith("nested/")).source)] : [])]) {
    await assert.rejects(exportBundle(store, { ...plan, assets: [{ source, relative: "assets/copy.png" }] }, output));
  }
  for (const relative of ["assets/.private/copy.png", "assets/.assets/../escape.png"]) {
    await assert.rejects(exportBundle(store, { ...plan, assets: [{ ...plan.assets[0], relative }] }, output));
  }
});
test("converter options reject arbitrary CLI arguments, CSL paths and malformed bibliography before execution", () => {
  assert.throws(() => conversionOptions({ args: ["--lua-filter=unsafe.lua"] }));
  assert.throws(() => conversionOptions({ style: "/tmp/unsafe.csl" }));
  assert.throws(() => conversionOptions({ bibliography: '[]', style: "vancouver" }));
  assert.throws(() => conversionOptions({ bibliography: '[{"id":"duplicate","type":"book"},{"id":"duplicate","type":"book"}]', style: "vancouver" }));
});
test("actual Pandoc citeproc creates Vancouver references and neutral letterhead in a real DOCX", { skip: !(await pandocPath()) }, async t => {
  const root = await fixture(t), destination = path.join(root, "output.docx"), pandoc = await pandocPath();
  const bibliography = JSON.stringify([{ id: "reference", type: "article-journal", title: "Synthetic evidence", author: [{ family: "Example", given: "A" }], "container-title": "Sample Journal", issued: { "date-parts": [[2026]] }, volume: "2", page: "1-5" }]);
  await convertExport(root, "docx", "# Report\n\nSupported statement [@reference].\n", "", destination, { bibliography, style: "vancouver", letterhead: { name: "Example Organization", detail: "Document service" } });
  const bytes = await readFile(destination); assert.equal(bytes.subarray(0, 2).toString(), "PK");
  const { stdout } = await exec(pandoc, [destination, "--to=plain"]);
  assert.match(stdout, /Example Organization/); assert.match(stdout, /Document service/); assert.match(stdout, /Synthetic evidence/); assert.match(stdout, /Supported statement\s*\(1\)/); assert.doesNotMatch(stdout, /@reference/);
});
