import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentStore } from "../electron/store.mjs";
import { copyShowcase, openShowcase, showcaseDocuments, showcaseFolderName, showcaseSource } from "../electron/showcase.mjs";
import { applicationFolders } from "../scripts/prepare-electron.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = showcaseSource(root);
const listing = async folder => (await readdir(folder, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => path.relative(folder, path.join(entry.parentPath, entry.name))).sort();
const target = async () => path.join(await mkdtemp(path.join(os.tmpdir(), "omarkie-showcase-")), showcaseFolderName);

test("the showcase copies every document and picture, then only what is missing, keeping the user's edits", async () => {
  const folder = await target(), files = await listing(source);
  assert.deepEqual((await copyShowcase(source, folder)).sort(), files);
  assert.deepEqual(await listing(folder), files);
  assert.ok(files.some(file => file.startsWith("images" + path.sep)));
  const edited = path.join(folder, "travel-journal.md");
  await writeFile(edited, "# My own trip\n");
  await unlink(path.join(folder, "recipe-card.md"));
  await unlink(path.join(folder, "images", "harbour.jpg"));
  assert.deepEqual((await copyShowcase(source, folder)).sort(), ["images/harbour.jpg", "recipe-card.md"].map(file => path.join(...file.split("/"))));
  assert.equal(await readFile(edited, "utf8"), "# My own trip\n");
  assert.deepEqual(await copyShowcase(source, folder), []);
});

test("opening the showcase opens the travel journal first and shows the folder", async () => {
  const folder = await target(), store = new DocumentStore(path.join(path.dirname(folder), "recovery"));
  const { documents, folder: scanned } = await openShowcase(store, source, folder);
  assert.deepEqual(documents.map(record => record.name), showcaseDocuments);
  assert.equal(documents[0].name, "travel-journal.md");
  assert.equal(documents[0].path, path.join(await realpath(folder), "travel-journal.md"));
  assert.equal(scanned.folder, await realpath(folder));
  const names = JSON.stringify(scanned.files);
  for (const name of showcaseDocuments) assert.ok(names.includes(name), name);
  const single = await openShowcase(store, source, folder, [showcaseDocuments[0]]);
  assert.deepEqual(single.documents.map(record => record.id), [documents[0].id]);
});

test("packages resolve the showcase at runtime with every picture its documents use", async () => {
  // Electron packages copy these folders into the app at the same relative paths; macOS copies it into Resources/showcase.
  const application = path.join(os.tmpdir(), "packaged-app");
  assert.ok(applicationFolders.includes(path.relative(application, showcaseSource(application)).split(path.sep).join("/")));
  for (const name of showcaseDocuments) {
    const text = await readFile(path.join(source, name), "utf8");
    for (const [, image] of text.matchAll(/(?:\]\(|src=")(images\/[^)"]+)/g))
      assert.ok((await listing(source)).includes(path.join(...image.split("/"))), `${name} uses ${image}`);
  }
});

test("Help offers the showcase in every host's menu", async () => {
  const groups = JSON.parse(await readFile(path.join(root, "shared/commands.json"), "utf8"));
  assert.deepEqual(groups.find(group => group.title === "帮助")?.items.map(item => item.action), ["showcase"]);
});
