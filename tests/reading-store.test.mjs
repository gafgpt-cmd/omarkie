import assert from "node:assert/strict";
import { appendFile, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import readingCore from "../shared/reading-core.cjs";
import { moveReadingEntries, readingMarkdown, readingStore } from "../electron/reading-store.mjs";
import { digest, DocumentStore } from "../electron/store.mjs";
import { Workspace } from "../electron/workspace.mjs";
import { dueCards } from "../src/flashcards.ts";

const { readingAnchor, resolveReadingAnchors } = readingCore(digest);

const body = "This long paragraph has enough distinct words to keep its identity after a minor spelling edit.";
const block = (text = body, line = 4, headings = ["Title", "Topic"]) => ({ block: text, headings, line });
const note = (id, target = block()) => ({ id, type: "note", body: `Text from ${id}`, anchor: { ...target, quote: "distinct words" } });

async function fixture(t) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "omarkie-reading-store-"))), vault = path.join(home, "vault");
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

test("rename, folder move and undo transfer reading history without sharing it with replacements", async t => {
  const { source, store } = await fixture(t);
  const workspace = new Workspace(store.folder);
  const change = async operation => {
    const root = operation.action === "undo" ? workspace.undo?.folder : store.folder;
    const result = await moveReadingEntries(root, move => workspace.execute(operation, store, undefined, move));
    workspace.apply(result, store);
    return result;
  };
  const list = (id, scope) => readingStore(store, id, { action: "list", scope });
  const original = source.path;
  await readingStore(store, source.id, { action: "put", item: note("margin") });
  await readingStore(store, source.id, { action: "put", item: { id: "card", type: "card", front: "Q", back: "A" } });
  await change({ action: "rename", path: original, name: "renamed.md" });
  assert.deepEqual((await list(source.id)).map(item => item.document), ["renamed.md", "renamed.md"]);
  const firstVault = store.folder;
  store.folder = path.join(path.dirname(firstVault), "second-vault");
  await mkdir(store.folder);
  await change({ action: "undo" });
  store.folder = firstVault;
  assert.deepEqual((await list(source.id)).map(item => item.document), ["source.md", "source.md"]);
  const folder = path.join(store.folder, "chapter"), destination = path.join(store.folder, "parts");
  await mkdir(folder); await mkdir(destination);
  await change({ action: "move", path: original, target: folder });
  await change({ action: "move", path: folder, target: destination });
  await writeFile(original, "Unrelated replacement");
  const replacement = await store.open(original);
  assert.deepEqual(await list(replacement.id), []);
  assert.deepEqual((await list(replacement.id, "vault")).map(item => item.document), ["parts/chapter/source.md", "parts/chapter/source.md"]);
  await change({ action: "undo" });
  assert.deepEqual((await list(source.id)).map(item => item.document), ["chapter/source.md", "chapter/source.md"]);
});

function startWorker(t, root, file, code) {
  const worker = `
    import { once } from "node:events";
    import { open } from "node:fs/promises";
    import path from "node:path";
    import { moveReadingEntries, readingStore } from ${JSON.stringify(new URL("../electron/reading-store.mjs", import.meta.url).href)};
    import { DocumentStore } from ${JSON.stringify(new URL("../electron/store.mjs", import.meta.url).href)};
    const [root, file] = process.argv.slice(1);
    const store = new DocumentStore(root);
    store.folder = root;
    const note = await store.open(file);
    const list = () => readingStore(store, note.id, {action:"list"});
    ${code}
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", worker, root, file], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  return child;
}

function readWorkerEntries(child) {
  return new Promise(resolve => {
    const receive = message => { if (Array.isArray(message)) { child.off("message", receive); resolve(message); } };
    child.on("message", receive);
  });
}

test("two warmed processes contend, repair a torn tail and see both commits", { timeout: 10000 }, async t => {
  const { store, source, log, index } = await fixture(t);
  await readingStore(store, source.id, { action: "put", item: note("seed") });
  const workers = ["first", "second"].map(id => startWorker(t, store.folder, source.path, `
    const go = once(process, "message");
    process.send((await list()).map(item => item.id));
    await go;
    await readingStore(store, note.id, {action:"put", item:{type:"card", id:${JSON.stringify(id)}, front:"Q", back:"A"}});
    const read = once(process, "message");
    process.send("committed");
    await read;
    process.send((await list()).map(item => item.id).sort());
    process.disconnect();
  `));
  for (const ids of await Promise.all(workers.map(readWorkerEntries))) assert.deepEqual(ids, ["seed"]);
  const finished = [];
  const committedMessages = workers.map(child => new Promise(resolve => {
    child.on("message", message => { if (message === "committed") { finished.push(child); resolve(); } });
  }));
  await moveReadingEntries(store.folder, async () => {
    await appendFile(log, '{"torn":');
    const before = await readFile(log);
    const starting = Promise.all(workers.map(child => once(child, "message")));
    workers.forEach(child => child.send("go"));
    assert.deepEqual((await starting).map(([message]) => message), ["journal-lock-contended", "journal-lock-contended"]);
    assert.deepEqual(await readFile(log), before);
    assert.equal(finished.length, 0);
  });
  await Promise.all(committedMessages);
  const committed = (await readFile(log, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line).entry.id).sort();
  assert.deepEqual(committed, ["first", "second", "seed"].sort());
  const cached = JSON.parse(await readFile(index, "utf8"));
  assert.deepEqual(cached.entries.map(item => item.id).sort(), committed);
  assert.deepEqual((await readingStore(store, source.id, { action: "list" })).map(item => item.id).sort(), committed);
  const messages = Promise.all(workers.map(readWorkerEntries));
  const exits = Promise.all(workers.map(child => once(child, "exit")));
  workers.forEach(child => child.send("read"));
  assert.deepEqual(await messages, [committed, committed]);
  assert.deepEqual(await exits, [[0, null], [0, null]]);
});

test("reopening recovers both sides of an interrupted rename and releases the lock", { timeout: 10000 }, async t => {
  const { store, source, log } = await fixture(t);
  await readingStore(store, source.id, { action: "put", item: note("seed") });
  await readingStore(store, source.id, { action: "put", item: { id: "card", type: "card", front: "Q", back: "A" } });
  for (const moved of [false, true]) {
    const child = startWorker(t, store.folder, source.path, `
      const handle = await open(file, "r");
      const prototype = Object.getPrototypeOf(handle), write = prototype.writeFile;
      await handle.close();
      const pause = async () => { process.send("interrupted"); await once(process, "message"); };
      prototype.writeFile = async function(bytes, ...args) {
        const row = typeof bytes === "string" ? JSON.parse(bytes) : {};
        if (${moved} && row.move) await pause();
        await write.call(this, bytes, ...args);
        if (!${moved} && row.intent) { await this.sync(); await pause(); }
      };
      await moveReadingEntries(root, move => move(file, path.join(root, "renamed.md")));
    `);
    assert.equal((await once(child, "message"))[0], "interrupted");
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    assert.deepEqual(await exit, [null, "SIGKILL"]);
    if (moved) await writeFile(source.path, "Replacement original path");
    else await writeFile(path.join(store.folder, "renamed.md"), "Unrelated destination");
    const reopened = new DocumentStore(store.folder);
    const scan = await reopened.scan(store.folder);
    assert.equal(scan.readingRecoveryWarning, false);
    const resolution = JSON.parse((await readFile(log, "utf8")).trimEnd().split("\n").at(-1));
    assert.deepEqual(resolution, moved ? { v: 1, move: { from: "source.md", to: "renamed.md" } } : { v: 1, cancel: true });
    const name = moved ? "renamed.md" : "source.md";
    const record = await reopened.open(path.join(store.folder, name));
    await reopened.save(record.id, "Saved before opening Reading Layers");
    assert.deepEqual((await readingStore(reopened, record.id, { action: "list" })).map(item => [item.id, item.document]), [["seed", name], ["card", name]]);
    if (moved) {
      const replacement = await reopened.open(source.path);
      assert.deepEqual(await readingStore(reopened, replacement.id, { action: "list" }), []);
    } else await rm(path.join(store.folder, "renamed.md"));
  }
});

test("rating belongs to the reviewed card and survives unrelated path reuse", async t => {
  const { store, source, other } = await fixture(t);
  for (const record of [source, other]) await readingStore(store, record.id, { action: "put", item: { type: "card", id: "same", front: "Q", back: "A" } });
  const put = owner => readingStore(store, source.id, { action: "put", owner, item: { type: "answer", id: "rating", cardId: "same", rating: 5 } });
  await assert.rejects(put("missing.md"));
  assert.equal((await put("other.md")).document, "other.md");
  assert.deepEqual((await readingStore(store, source.id, { action: "list", types: ["answer"] })), []);
  const workspace = new Workspace(store.folder), reused = path.join(store.folder, "reused.md");
  await writeFile(reused, "Other content");
  await moveReadingEntries(store.folder, move => workspace.execute({ action: "rename", path: source.path, name: "moved.md" }, store, undefined, move));
  await moveReadingEntries(store.folder, move => workspace.execute({ action: "rename", path: reused, name: "source.md" }, store, undefined, move));
  assert.deepEqual((await readingStore(store, other.id, { action: "list", types: ["answer"] })).map(item => item.rating), [5]);
});

test("ambiguous fingerprints remain pending until one path matches", async t => {
  const { store, source, other, log } = await fixture(t);
  await readingStore(store, source.id, { action: "put", item: note("original") });
  const intent = { from: "source.md", to: "other.md", fingerprint: `${Buffer.byteLength(body)}:${digest(body)}` };
  const awaiting = JSON.stringify({ v: 1, intent }) + "\n";
  await appendFile(log, awaiting);
  for (const content of [body, "Neither file matches"]) {
    await writeFile(source.path, content);
    await writeFile(other.path, content);
    assert.equal((await new DocumentStore(store.folder).scan(store.folder)).readingRecoveryWarning, true);
    assert.ok((await readFile(log, "utf8")).endsWith(awaiting));
  }
  await writeFile(other.path, body);
  assert.equal((await new DocumentStore(store.folder).scan(store.folder)).readingRecoveryWarning, false);
  assert.deepEqual((await readingStore(store, other.id, { action: "list" })).map(item => item.id), ["original"]);
});

test("unused vault moves stay lazy and Trash hides history from path reuse", async t => {
  const { store, source, other, sidecar } = await fixture(t);
  const workspace = new Workspace(store.folder);
  const original = source.path;
  const relocate = operation => moveReadingEntries(store.folder, move => workspace.execute(operation, store, undefined, move));
  workspace.apply(await relocate({ action: "rename", path: original, name: "renamed.md" }), store);
  await assert.rejects(stat(sidecar), { code: "ENOENT" });
  await mkdir(sidecar);
  workspace.apply(await relocate({ action: "undo" }), store);
  await assert.rejects(stat(path.join(sidecar, "journal.lock")), { code: "ENOENT" });
  await readingStore(store, source.id, { action: "put", item: note("trashed") });
  const change = await moveReadingEntries(store.folder, () => workspace.execute({ action: "trash", path: original }, store, file => rm(file)), original);
  workspace.apply(change, store);
  await writeFile(original, "Replacement");
  const replacement = await store.open(original);
  assert.deepEqual(await readingStore(store, replacement.id, { action: "list" }), []);
  assert.deepEqual(await readingStore(store, other.id, { action: "list", scope: "vault" }), []);
});

test("an invalid rating timestamp cannot stop valid cards from being reviewed", async t => {
  const { store, source, log } = await fixture(t);
  await readingStore(store, source.id, { action: "put", item: { id: "valid-card", type: "card", front: "Q", back: "A" } });
  await appendFile(log, JSON.stringify({ v: 1, entry: { id: "bad-answer", type: "answer", cardId: "valid-card", rating: 5, document: "source.md", at: "not a date" } }) + "\n");
  const entries = await readingStore(store, source.id, { action: "list" });
  assert.deepEqual(dueCards(entries, Date.now()).map(item => item.id), ["valid-card"]);
});

test("bad journal rows are reported and do not hide committed history", async t => {
  const { store, source, log } = await fixture(t);
  await readingStore(store, source.id, { action: "put", item: note("original") });
  await appendFile(log, JSON.stringify({ v: 1, intent: { from: "source.md", to: "../other.md" } }) + "\n");
  await appendFile(log, Buffer.from([0xff, 10]));
  const reopened = new DocumentStore(store.folder);
  assert.equal((await reopened.scan(store.folder)).readingRecoveryWarning, true);
  const record = await reopened.open(source.path);
  await readingStore(reopened, record.id, { action: "put", item: note("next") });
  assert.deepEqual((await readingStore(reopened, record.id, { action: "list" })).map(item => item.id), ["original", "next"]);
  await appendFile(log, JSON.stringify({ v: 1, move: { from: "source.md", to: "other.md" } }) + "\n");
  assert.deepEqual((await readingStore(reopened, record.id, { action: "list" })).map(item => item.id), ["original", "next"]);
  if (process.platform !== "win32") {
    const literal = path.join(store.folder, "literal\\slash.md");
    await writeFile(literal, body);
    const original = await store.open(literal);
    await readingStore(store, original.id, { action: "put", item: { id: "literal-card", type: "card", front: "Q", back: "A" } });
    await readingStore(store, source.id, { action: "put", owner: "literal\\slash.md", item: { id: "literal-rating", type: "answer", cardId: "literal-card", rating: 5 } });
    const workspace = new Workspace(store.folder);
    const change = await moveReadingEntries(store.folder, move => workspace.execute({ action: "rename", path: literal, name: "clean.md" }, store, undefined, move));
    workspace.apply(change, store);
    assert.deepEqual((await readingStore(store, original.id, { action: "list" })).map(item => [item.id, item.document]), [["literal-card", "clean.md"], ["literal-rating", "clean.md"]]);
  }
});

test("the last card slot is exclusive and existing cards remain editable", async t => {
  const { store, source } = await fixture(t);
  const put = id => readingStore(store, source.id, { action: "put", item: { id, type: "card", front: "Q", back: "A" } });
  for (let i = 0; i < 9; i++) await put(`card-${i}`);
  assert.deepEqual((await Promise.allSettled([put("first"), put("second")])).map(result => result.status).sort(), ["fulfilled", "rejected"]);
  await put("card-0");
  assert.equal((await readingStore(store, source.id, { action: "list" })).length, 10);
});

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
  assert.deepEqual(await get(source.id, "vault"), items);
  assert.equal(await readFile(log, "utf8"), recovered + "damaged\n");
  await put(note("after-damage"));
  assert.deepEqual((await get(source.id, "vault")).map(item => item.id).sort(), [...items.map(item => item.id), "after-damage"].sort());
  assert.ok((await readFile(log, "utf8")).startsWith(recovered + "damaged\n"));
});

test("sidecar refuses external documents, unsafe links and malformed writes", async t => {
  const { store, source, external, sidecar, log, outside } = await fixture(t);
  const put = (item, id = source.id) => readingStore(store, id, { action: "put", item });
  await assert.rejects(put(note("external"), external.id), /unsafe|不安全/);
  await assert.rejects(put({ ...note("invalid"), body: " " }), /Invalid|无效/);
  for (const item of [
    { id: "old", type: "highlight", text: "Unsupported" },
    { id: "old", type: "schedule", cardId: "card", dueAt: "2026-11-22", intervalDays: 1, repetitions: 1, easeFactor: 2.5 },
    { id: "old", type: "payload", markdown: "Unsupported" },
  ]) {
    await assert.rejects(put(item), /Invalid|无效/);
    await assert.rejects(readingStore(store, source.id, { action: "list", types: [item.type] }), /Invalid|无效/);
  }
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
