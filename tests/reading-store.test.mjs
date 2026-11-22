import assert from "node:assert/strict";
import { appendFile, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import readingCore from "../shared/reading-core.cjs";
import { readingMarkdown, readingStore } from "../electron/reading-store.mjs";
import { digest, DocumentStore } from "../electron/store.mjs";

const { readingAnchor, resolveReadingAnchors } = readingCore(digest);

const body = "This long paragraph has enough distinct words to keep its identity after a minor spelling edit.";
const block = (text = body, line = 4, headings = ["Title", "Topic"]) => ({ block: text, headings, line });
const note = (id, target = block()) => ({ id, type: "note", body: `Text from ${id}`, anchor: { ...target, quote: "distinct words" } });

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-reading-store-")), vault = path.join(home, "vault");
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(vault);
  const store = new DocumentStore(home);
  const file = path.join(vault, "source.md"), second = path.join(vault, "other.md"), outside = path.join(home, "outside.md");
  await Promise.all([file, second, outside].map(file => writeFile(file, body, "utf8")));
  store.folder = vault;
  const [source, other, external] = await Promise.all([file, second, outside].map(file => store.open(file)));
  const sidecar = path.join(vault, ".omarkie");
  return { store, source, other, external, sidecar, log: path.join(sidecar, "store.jsonl"), index: path.join(sidecar, "index.json"), outside };
}

test("anchors follow normalization, movement and minor edits without guessing unrelated text", () => {
  const anchor = readingAnchor(note("n").anchor), notes = [{ id: "n", anchor }];
  assert.equal(anchor.hash, readingAnchor({ ...anchor, block: `  ${body.replaceAll(" ", " \n \t")}  ` }).hash);
  assert.notEqual(anchor.hash, readingAnchor({ ...anchor, headings: ["Another title", "Topic"] }).hash);
  const resolve = blocks => resolveReadingAnchors(notes, blocks)[0].line;
  assert.equal(resolve([block("Other text", 2), block(body, 9)]), 9);
  assert.equal(resolve([block(body.replace("spelling", "speling"), 14)]), 14);
  assert.equal(resolve([block(body, 9, ["Moved"])]), 9);
  assert.equal(resolve([block("No original material here.", 4)]), null);
  assert.equal(resolve([block(body, 7), block(body, 9)]), null);
  assert.equal(resolve([block(body, 4), block(body, 5)]), null);
  assert.equal(resolve([block(body, 4, ["Renamed"]), block(body, 5, ["Renamed"])]), null);
  assert.equal(resolve([block(body, 4, ["Elsewhere"]), block(body, 5)]), 5);
  const almost = body.replace("spelling", "speling");
  assert.equal(resolve([block(almost, 8), block(almost, 9), block(almost, 10)]), null);
});

test("vault journal serializes writers, compacts updates and rebuilds after a torn append", async t => {
  const { store, source, other, sidecar, log, index } = await fixture(t);
  const get = (id = source.id, scope) => readingStore(store, id, { action: "list", scope });
  const put = (item, id = source.id) => readingStore(store, id, { action: "put", item });
  assert.deepEqual(await get(), []);
  await assert.rejects(stat(sidecar), { code: "ENOENT" });
  await Promise.all([put(note("first")), put(note("other"), other.id), put({ id: "card", type: "card", front: "Question?", back: "Answer" })]);
  const journal = await readFile(log, "utf8");
  assert.equal(journal.trimEnd().split("\n").length, 3);
  await appendFile(log, '{"v":1,"entry":{"body":"torn', "utf8");
  await writeFile(index, "torn index", "utf8");
  assert.deepEqual((await get()).map(item => item.id).sort(), ["card", "first"]);
  assert.equal(JSON.parse(await readFile(index, "utf8")).entries.length, 3);
  await put({ ...note("first"), body: "Updated" });
  const recovered = await readFile(log, "utf8");
  assert.ok(recovered.startsWith(journal));
  assert.equal(recovered.trimEnd().split("\n").map(JSON.parse).length, 4);
  const items = await get(source.id, "vault");
  assert.equal(items.length, 3);
  assert.equal(items.find(item => item.id === "first").body, "Updated");
  assert.match(readingMarkdown(items), /Updated/);
  assert.match(readingMarkdown(items), /Question\?[\s\S]*Answer/);
  assert.equal(await readFile(source.path, "utf8"), body);
  await appendFile(log, "damaged\n", "utf8");
  await assert.rejects(put(note("do-not-write")), /damaged|损坏/);
  assert.equal(await readFile(log, "utf8"), recovered + "damaged\n");
});

test("sidecar refuses external documents, unsafe links and malformed writes", async t => {
  const { store, source, external, sidecar, log, outside } = await fixture(t);
  const put = (item, id = source.id) => readingStore(store, id, { action: "put", item });
  await assert.rejects(put(note("external"), external.id), /unsafe|不安全/);
  await assert.rejects(put({ ...note("invalid"), body: " " }), /Invalid|无效/);
  await assert.rejects(stat(sidecar), { code: "ENOENT" });
  const otherDirectory = path.dirname(outside);
  await symlink(otherDirectory, sidecar, "junction");
  await assert.rejects(put(note("unsafe-parent")), /unsafe|不安全/);
  await assert.rejects(stat(path.join(otherDirectory, "store.jsonl")), { code: "ENOENT" });
  await rm(sidecar);
  await mkdir(sidecar);
  await link(outside, log);
  await assert.rejects(put(note("unsafe-file")), /unsafe|不安全/);
  assert.equal(await readFile(outside, "utf8"), body);
});
