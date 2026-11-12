import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import pkg from "../package.json" with { type: "json" };

// Hunspell dictionaries for the UI languages (Chinese has none), shipped inside the app so that
// Chromium never downloads them from Google. They come from Electron's hunspell_dictionaries.zip
// for the pinned Electron: Chromium's chromium/deps/hunspell_dictionaries files under the names
// this Chromium asks for. A different Electron needs new pins.
export const dictionaryArchive = {
  electron: "44.7.2",
  url: "https://github.com/electron/electron/releases/download/v44.7.2/hunspell_dictionaries.zip",
  sha256: "0e3693aad6494be74dbcc63f34d48ca30c05d9f5a0ccb408ebc89b17a8048907",
};
export const dictionaryFiles = {
  "en-US-10-1.bdic": "a075b01d9b015c616511a9e87da77da3d9881621db32f584e4606ddabf1c1100",
  "es-ES-3-0.bdic": "e6334dcf080aaeca679db70565762a2c296ff5780c1af263530ac7345736bfa9",
  "ca-ES-3-0.bdic": "e03b0f6b4f1926e43eef08d6984915fe2615afe81c0fedb5c6b30671c0580504",
  "ro-RO-3-0.bdic": "0db54e3f28291d0fd28f049a61a76ade5a98591b6ae16cb7113e2561b0760ec4",
};
const licenseNote = `Spellcheck dictionaries: ${Object.keys(dictionaryFiles).join(", ")}
Source: Chromium hunspell dictionaries (https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries),
as packaged in Electron ${dictionaryArchive.electron} (${dictionaryArchive.url}).
Chromium's README.chromium lists ca_ES, en_US, es_ES and ro_RO under the GPL 2.0 / LGPL 2.1 / MPL 1.1
tri-license; the license texts follow in COPYING.
`;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// Reads the named stored or deflated entries from a ZIP archive's central directory.
export function unzipEntries(zip, names) {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a ZIP archive.");
  const entries = {}, count = zip.readUInt16LE(end + 10);
  for (let i = 0, at = zip.readUInt32LE(end + 16); i < count; i++) {
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20), nameLength = zip.readUInt16LE(at + 28);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength), local = zip.readUInt32LE(at + 42);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (!names.includes(name)) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28), data = zip.subarray(start, start + size);
    if (method === 0) entries[name] = Buffer.from(data);
    else if (method === 8) entries[name] = inflateRawSync(data);
    else throw new Error(`Unsupported ZIP method ${method} for ${name}.`);
  }
  return entries;
}

// Writes the verified dictionaries into dictionaries/ and their license notes into licenses/.
// The download is cached in build/ and checked against its pinned hash.
export async function spellcheckDictionaries(dictionaries, licenses, cache = path.resolve("build/cache")) {
  if (pkg.devDependencies.electron !== dictionaryArchive.electron)
    throw new Error(`Spellcheck dictionaries are pinned to Electron ${dictionaryArchive.electron}; update scripts/spellcheck-dictionaries.mjs for Electron ${pkg.devDependencies.electron}.`);
  const archive = path.join(cache, `hunspell_dictionaries-${dictionaryArchive.electron}.zip`);
  let zip = await readFile(archive).catch(() => null);
  if (!zip || sha256(zip) !== dictionaryArchive.sha256) {
    const response = await fetch(dictionaryArchive.url);
    if (!response.ok) throw new Error(`Spellcheck dictionary download failed: ${response.status}`);
    zip = Buffer.from(await response.arrayBuffer());
    if (sha256(zip) !== dictionaryArchive.sha256) throw new Error("Spellcheck dictionary archive does not match its pinned SHA-256.");
    await mkdir(cache, { recursive: true });
    await writeFile(archive, zip);
  }
  const entries = unzipEntries(zip, [...Object.keys(dictionaryFiles), "COPYING"]);
  await mkdir(dictionaries, { recursive: true });
  for (const [name, hash] of Object.entries(dictionaryFiles)) {
    if (!entries[name] || sha256(entries[name]) !== hash) throw new Error(`Spellcheck dictionary ${name} does not match its pinned SHA-256.`);
    await writeFile(path.join(dictionaries, name), entries[name]);
  }
  if (licenses) {
    await mkdir(licenses, { recursive: true });
    await writeFile(path.join(licenses, "README.txt"), licenseNote);
    await writeFile(path.join(licenses, "COPYING"), entries.COPYING);
  }
}

// `npm run dictionaries` fills dictionaries/ for development runs of the Electron host.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await spellcheckDictionaries(path.resolve("dictionaries"));
