import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { linuxArtifacts, pruneLinuxArtifacts } from "../scripts/linux-artifacts.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const names = version => ["deb", "AppImage"].map(kind => `Omarkie-${version}-linux-x64.${kind}`);
async function fixture(version) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "linux-artifacts-"));
  const entries = names(version).map(name => ({ name, bytes: Buffer.from(`Current build: ${name}`) }));
  for (const entry of entries) await writeFile(path.join(directory, entry.name), entry.bytes);
  const manifest = entries.map(entry => `${digest(entry.bytes)}  ${entry.name}`).join("\n") + "\n";
  const manifestPath = path.join(directory, "SHA256SUMS-linux-x64.txt");
  await writeFile(manifestPath, manifest);
  return { directory, entries, manifest, manifestPath };
}

for (const version of ["0.2.0", "0.2.0+r17.gabc1234"]) test(`install selection uses the emitted checksum manifest: ${version}`, async () => {
  const f = await fixture(version);
  for (const name of names("0.1.0")) await writeFile(path.join(f.directory, name), "Stale package");
  if (version !== "0.2.0") for (const name of names("0.2.0")) await writeFile(path.join(f.directory, name), "Stale plain-version package");
  const selected = await linuxArtifacts(f.directory);
  assert.equal(selected.version, version);
  for (const [index, kind] of ["deb", "AppImage"].entries()) {
    assert.equal(selected[kind], path.join(f.directory, f.entries[index].name));
    assert.deepEqual(await readFile(selected[kind]), f.entries[index].bytes);
  }
});

test("install selection rejects missing and ambiguous manifest entries", async () => {
  const f = await fixture("0.2.0+r17.gabc1234");
  await writeFile(f.manifestPath, f.manifest.split("\n")[0] + "\n");
  await assert.rejects(linuxArtifacts(f.directory), /Expected one Linux AppImage/);
  for (const kind of ["deb", "AppImage"]) {
    const entry = f.entries.find(entry => entry.name.endsWith("." + kind));
    await writeFile(f.manifestPath, f.manifest + `${digest(entry.bytes)}  ${entry.name}\n`);
    await assert.rejects(linuxArtifacts(f.directory), new RegExp(`Expected one Linux ${kind}`));
  }
  const empty = await mkdtemp(path.join(os.tmpdir(), "linux-no-manifest-"));
  for (const name of names("0.2.0")) await writeFile(path.join(empty, name), "Unmanifested package");
  await assert.rejects(linuxArtifacts(empty), { code: "ENOENT" });
});

test("install selection verifies both payloads and refuses missing files", async () => {
  for (const kind of ["deb", "AppImage"]) {
    const f = await fixture("0.2.0+r17.gabc1234"), entry = f.entries.find(entry => entry.name.endsWith("." + kind));
    await writeFile(path.join(f.directory, entry.name), "Truncated or stale payload");
    await assert.rejects(linuxArtifacts(f.directory), /checksum mismatch/);
    await rename(path.join(f.directory, entry.name), path.join(f.directory, entry.name + ".saved"));
    await assert.rejects(linuxArtifacts(f.directory), { code: "ENOENT" });
  }
});

test("install selection rejects mixed builds and unsafe manifest paths", async () => {
  const f = await fixture("0.2.0+r17.gabc1234"), oldImage = "Omarkie-0.2.0-linux-x64.AppImage", oldBytes = "Old build";
  await writeFile(path.join(f.directory, oldImage), oldBytes);
  await writeFile(f.manifestPath, f.manifest.split("\n")[0] + `\n${digest(oldBytes)}  ${oldImage}\n`);
  await assert.rejects(linuxArtifacts(f.directory), /different build versions/);
  for (const name of ["../outside.deb", "folder\\outside.deb", "/outside.deb"]) {
    await writeFile(f.manifestPath, f.manifest + `${digest(oldBytes)}  ${name}\n`);
    await assert.rejects(linuxArtifacts(f.directory), /Invalid Linux checksum manifest/);
  }
});

test("packaging prunes obsolete revisioned DEB, RPM and AppImage artifacts only", async () => {
  const f = await fixture("0.2.0+r17.gabc1234"), current = [...names("0.2.0+r17.gabc1234"), "omarkie-0.2.0+r17.gabc1234-1.x86_64.rpm"];
  const stale = [...names("0.2.0"), ...names("0.2.0+r16.gabcdef0"), "omarkie-0.2.0+r16.gabcdef0-1.x86_64.rpm", "omarkie-0.2.0-1.x86_64.rpm"];
  const unrelated = ["retained.txt", "Other-0.2.0-linux-x64.deb", "linux-unpacked"];
  for (const name of [...current, ...stale, ...unrelated]) await writeFile(path.join(f.directory, name), name);
  await pruneLinuxArtifacts(f.directory, current);
  const expected = [...current, ...unrelated, "SHA256SUMS-linux-x64.txt"].sort();
  assert.deepEqual((await readdir(f.directory)).sort(), expected);
  for (const name of [...current, ...unrelated]) assert.equal(await readFile(path.join(f.directory, name), "utf8"), name);
  await pruneLinuxArtifacts(f.directory, current);
  assert.deepEqual((await readdir(f.directory)).sort(), expected);
});
