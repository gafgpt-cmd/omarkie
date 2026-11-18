import { readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export async function linuxArtifacts(directory) {
  const manifest = await readFile(path.join(directory, "SHA256SUMS-linux-x64.txt"), "utf8"), entries = [];
  for (const line of manifest.trimEnd().split(/\r?\n/)) {
    const entry = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(line);
    if (!entry) throw new Error("Invalid Linux checksum manifest");
    const artifact = /^Omarkie-(\d[\w.+-]*)-linux-x64\.(deb|AppImage)$/.exec(entry[2]);
    if (artifact) entries.push({ hash: entry[1], name: entry[2], version: artifact[1], kind: artifact[2] });
  }
  const result = {};
  for (const kind of ["deb", "AppImage"]) {
    const candidates = entries.filter(entry => entry.kind === kind);
    if (candidates.length !== 1) throw new Error(`Expected one Linux ${kind} artifact in checksum manifest`);
    const entry = candidates[0];
    if (result.version && result.version !== entry.version) throw new Error("Linux artifacts have different build versions");
    const file = path.resolve(directory, entry.name), bytes = await readFile(file);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.hash) throw new Error(`Linux artifact checksum mismatch: ${entry.name}`);
    result.version = entry.version; result[kind] = file;
  }
  return result;
}

export async function pruneLinuxArtifacts(directory, current) {
  for (const name of await readdir(directory)) {
    if (/^(?:Omarkie-\d[\w.+-]*\.(?:deb|AppImage)|omarkie-\d[\w.+-]*\.x86_64\.rpm)$/.test(name) && !current.includes(name)) await rm(path.join(directory, name));
  }
}
