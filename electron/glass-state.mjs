import { lstat, mkdir, readFile } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./store.mjs";

export const glassDirectory = root => path.join(root, ".omarkie", "glass");
export const glassFile = root => path.join(glassDirectory(root), "vault.json");

const missing = error => { if (error.code !== "ENOENT") throw error; return null; };
const directory = file => lstat(file).then(stat => stat.isDirectory(), () => false);

async function readState(root) {
  const file = glassFile(root), stat = await lstat(file).catch(missing);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return value?.version === 1 ? value : null;
  } catch { return null; }
}

async function writeState(root, value) {
  await mkdir(glassDirectory(root), { recursive: true, mode: 0o700 });
  await atomicWrite(glassFile(root), `${JSON.stringify({ version: 1, ...value })}\n`);
}

export async function readGlass(root) {
  return (await readState(root))?.visible === true;
}

export async function writeGlass(root, visible) {
  if (typeof visible !== "boolean") throw new Error("Glass state must be a boolean.");
  await writeState(root, { ...(await readState(root)) ?? {}, visible });
  return visible;
}

// G18: a second person's glass journal is a separate read-only layer, toggled per vault.
export async function readShared(root) {
  return (await readState(root))?.shared === true;
}

export async function writeShared(root, shared) {
  if (typeof shared !== "boolean") throw new Error("Shared glass state must be a boolean.");
  await writeState(root, { ...(await readState(root)) ?? {}, shared });
  return shared;
}

// Agents change the vault file directly, so the running app follows it instead of caching.
export function watchGlass(root, notify) {
  let watcher, timer, closed = false;
  const glass = glassDirectory(root);
  async function arm() {
    for (const target of [glass, path.join(root, ".omarkie"), root]) {
      if (closed || !(await directory(target))) continue;
      try { watcher = watch(target, { persistent: false }, () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          if (closed) return;
          notify(await readGlass(root));
          if (watcher && target !== glass && await directory(glass)) {
            watcher.close();
            watcher = undefined;
            await arm();
          }
        }, 80);
      }); } catch { watcher = undefined; return; }
      return;
    }
  }
  const ready = arm();
  return async () => {
    closed = true;
    clearTimeout(timer);
    watcher?.close();
    await ready;
  };
}
