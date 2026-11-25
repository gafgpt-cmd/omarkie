// Which desktop sync app owns the folder above a vault. Detection only; omarkie never manages these apps.
// Visible folder names and hidden metadata folders both count, so a renamed top folder still reads
// correctly while a plain `Sync` folder without a marker does not pretend to be one.

import { access } from "node:fs/promises";
import path from "node:path";

const providers = [
  { app: "Google Drive", markers: ["GoogleDrive", "Google Drive", "My Drive"], source: "drive" },
  { app: "OneDrive", markers: ["OneDrive"], source: "onedrive" },
  { app: "Dropbox", markers: ["Dropbox", ".dropbox"], source: "dropbox" },
  { app: "Syncthing", markers: [".stfolder", ".stversions", ".stignore"], source: "syncthing" },
  { app: "Nextcloud", markers: ["Nextcloud", ".nextcloudsync"], source: "nextcloud" },
  { app: "iCloud Drive", markers: ["iCloud Drive"], source: "icloud" },
];

const exists = async target => access(target).then(() => true, () => false);

function markerMatch(name, marker) {
  const lower = name.toLowerCase();
  const value = marker.toLowerCase();
  if (value.startsWith(".")) return lower === value;
  return lower === value || lower.startsWith(`${value} `) || lower.startsWith(`${value}-`) || lower.startsWith(`${value} - `);
}

// Walk ancestors from the vault upward. Tests pass `ancestors` and `exists` to stay off the host's folders.
export async function detectFolderSync(root, { ancestors = [], exists: has = exists } = {}) {
  if (typeof root !== "string" || !root) throw new Error("A vault folder is needed to detect sync apps.");
  const chain = ancestors.length ? ancestors : parentChain(root);
  for (const folder of chain) {
    const name = folder.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
    for (const provider of providers) {
      for (const marker of provider.markers) {
        if (markerMatch(name, marker) || await has(path.join(folder, marker))) {
          return { app: provider.app, source: provider.source, folder };
        }
      }
    }
  }
  return null;
}

function parentChain(root) {
  const chain = [];
  let current = root;
  for (let depth = 0; depth < 8; depth += 1) {
    chain.push(current);
    const parent = current.replace(/[\\/][^\\/]+$/, "");
    if (!parent || parent === current) break;
    current = parent;
  }
  return chain;
}
