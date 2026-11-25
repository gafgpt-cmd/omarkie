import { lstat, mkdir, readFile } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./store.mjs";

export const glassDirectory = root => path.join(root, ".omarkie", "glass");
export const glassFile = root => path.join(glassDirectory(root), "vault.json");

const missing = error => { if (error.code !== "ENOENT") throw error; return null; };
const directory = file => lstat(file).then(stat => stat.isDirectory(), () => false);

// One vault file: the overlay switch and the "never online" switch for this vault.
export async function readGlassSettings(root) {
  const file = glassFile(root), stat = await lstat(file).catch(missing);
  const off = { version: 1, visible: false, neverOnline: false };
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return off;
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value?.version !== 1) return off;
    return { version: 1, visible: value.visible === true, neverOnline: value.neverOnline === true };
  } catch { return off; }
}

export async function writeGlassSettings(root, patch) {
  const current = await readGlassSettings(root);
  const next = {
    version: 1,
    visible: typeof patch?.visible === "boolean" ? patch.visible : current.visible,
    neverOnline: typeof patch?.neverOnline === "boolean" ? patch.neverOnline : current.neverOnline,
  };
  await mkdir(glassDirectory(root), { recursive: true, mode: 0o700 });
  await atomicWrite(glassFile(root), `${JSON.stringify(next)}\n`);
  return next;
}

export async function readGlass(root) {
  return (await readGlassSettings(root)).visible;
}

export async function writeGlass(root, visible) {
  if (typeof visible !== "boolean") throw new Error("Glass state must be a boolean.");
  return (await writeGlassSettings(root, { visible })).visible;
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
          const settings = await readGlassSettings(root);
          notify(settings.visible, settings);
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
