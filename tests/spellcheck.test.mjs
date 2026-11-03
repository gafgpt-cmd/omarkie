import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { dictionaryDownloadURL, dictionarySource, seedDictionaries } from "../electron/spellcheck.mjs";
import { dictionaryArchive, dictionaryFiles, unzipEntries } from "../scripts/spellcheck-dictionaries.mjs";
import { applicationFolders } from "../scripts/prepare-electron.mjs";
import pkg from "../package.json" with { type: "json" };

test("bundled dictionaries are seeded into the profile, keeping files already there", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omarkie-spell-")), source = path.join(directory, "dictionaries"), profile = path.join(directory, "profile");
  await mkdir(path.join(profile, "Dictionaries"), { recursive: true });
  await mkdir(source);
  await writeFile(path.join(source, "en-US-10-1.bdic"), "english");
  await writeFile(path.join(source, "es-ES-3-0.bdic"), "spanish");
  await writeFile(path.join(profile, "Dictionaries", "es-ES-3-0.bdic"), "spanisH");
  assert.deepEqual(seedDictionaries(source, profile).sort(), ["en-US-10-1.bdic", "es-ES-3-0.bdic"]);
  assert.deepEqual((await readdir(path.join(profile, "Dictionaries"))).sort(), ["en-US-10-1.bdic", "es-ES-3-0.bdic"]);
  assert.equal(await readFile(path.join(profile, "Dictionaries", "en-US-10-1.bdic"), "utf8"), "english");
  assert.equal(await readFile(path.join(profile, "Dictionaries", "es-ES-3-0.bdic"), "utf8"), "spanisH");
  assert.deepEqual(seedDictionaries(path.join(directory, "missing"), profile), []);
});

test("a dictionary the app lacks is requested from the app's own folder, never a remote host", () => {
  const url = new URL(dictionaryDownloadURL(dictionarySource(path.join(os.tmpdir(), "app"))));
  assert.equal(url.protocol, "file:");
  assert.ok(url.pathname.endsWith("/dictionaries/"));
});

test("dictionaries for every UI language that has one are pinned to the Electron in use and packaged", () => {
  assert.equal(dictionaryArchive.electron, pkg.devDependencies.electron);
  assert.match(dictionaryArchive.sha256, /^[a-f0-9]{64}$/);
  assert.ok(dictionaryArchive.url.startsWith(`https://github.com/electron/electron/releases/download/v${pkg.devDependencies.electron}/`));
  for (const language of ["en-US", "es-ES", "ca-ES", "ro-RO"])
    assert.ok(Object.keys(dictionaryFiles).some(name => name.startsWith(language + "-")), language);
  for (const hash of Object.values(dictionaryFiles)) assert.match(hash, /^[a-f0-9]{64}$/);
  assert.ok(!applicationFolders.includes("dictionaries"), "dictionaries are fetched at build time, not copied from the checkout");
});

test("the archive reader extracts stored and deflated entries", () => {
  const entries = [["a.txt", Buffer.from("stored"), 0], ["b.bdic", Buffer.from("deflated ".repeat(20)), 8]];
  const locals = [], central = [];
  let offset = 0;
  for (const [name, content, method] of entries) {
    const data = method ? deflateRawSync(content) : content, nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(method, 10); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(content.length, 24); record.writeUInt16LE(nameBytes.length, 28); record.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); central.push(record, nameBytes); offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const result = unzipEntries(Buffer.concat([...locals, directory, end]), ["a.txt", "b.bdic"]);
  assert.equal(result["a.txt"].toString(), "stored");
  assert.equal(result["b.bdic"].toString(), "deflated ".repeat(20));
});
