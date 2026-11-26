import { access, lstat, mkdir, readFile } from "node:fs/promises";
import { constants, watch } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./store.mjs";

export const glassDirectory = root => path.join(root, ".omarkie", "glass");
export const glassFile = root => path.join(glassDirectory(root), "vault.json");

const missing = error => { if (error.code !== "ENOENT") throw error; return null; };
const directory = file => lstat(file).then(stat => stat.isDirectory(), () => false);
const ownership = ["EACCES", "EPERM", "EROFS"];
const off = () => ({ version: 1, visible: false, neverOnline: false, shared: false });
const vaultIdOf = value => typeof value === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(value) ? value : null;

async function readState(file) {
  const stat = await lstat(file).catch(missing);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return value?.version === 1 ? value : null;
  } catch { return null; }
}

// The switches belong to the glass store. A read-only vault keeps that store in app data, so the
// file is resolved the same way the service resolves its store: the vault's settings, then the
// remembered vault id under app data.
async function storeLocation(root, appData) {
  const inside = await readState(path.join(root, ".omarkie", "settings.json"));
  const id = vaultIdOf(inside?.vaultId);
  if (id && inside.mode === "outside") return { mode: "outside", vaultId: id };
  if (id) return { mode: "inside", vaultId: id };
  if (!appData) return { mode: "inside", vaultId: null };
  let registry = null;
  try { registry = JSON.parse(await readFile(path.join(appData, "glass-vaults", "roots.json"), "utf8")); } catch { registry = null; }
  const vaultId = vaultIdOf(registry?.[root]?.vaultId);
  if (!vaultId) return { mode: "inside", vaultId: null };
  if (await readState(path.join(appData, "glass-vaults", vaultId, "settings.json"))) return { mode: "outside", vaultId };
  return { mode: "inside", vaultId };
}

async function stateFiles(root, appData) {
  const { mode, vaultId } = await storeLocation(root, appData);
  const inside = glassFile(root);
  const outside = vaultId && appData ? path.join(appData, "glass-vaults", vaultId, "glass", "vault.json") : null;
  if (!outside) return [inside];
  if (mode === "outside") return [outside, inside];
  // A read-only vault refuses the vault copy, so the app data store is the authoritative one.
  const writable = await access(root, constants.W_OK).then(() => true, () => false);
  return writable ? [inside, outside] : [outside, inside];
}

// One vault file: the overlay switch, the "never online" switch and the shared layer for this vault.
export async function readGlassSettings(root, { appData } = {}) {
  for (const file of await stateFiles(root, appData)) {
    const value = await readState(file);
    if (value) return { version: 1, visible: value.visible === true, neverOnline: value.neverOnline === true, shared: value.shared === true };
  }
  return off();
}

export async function writeGlassSettings(root, patch, { appData } = {}) {
  const current = await readGlassSettings(root, { appData });
  const next = {
    version: 1,
    visible: typeof patch?.visible === "boolean" ? patch.visible : current.visible,
    neverOnline: typeof patch?.neverOnline === "boolean" ? patch.neverOnline : current.neverOnline,
    shared: typeof patch?.shared === "boolean" ? patch.shared : current.shared,
  };
  // A read-only vault refuses the vault copy; the app data store is the writable one there.
  let refusal = null;
  for (const file of await stateFiles(root, appData)) {
    try {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await atomicWrite(file, `${JSON.stringify(next)}\n`);
      return next;
    } catch (error) {
      if (!ownership.includes(error.code) && error.code !== "ENOENT") throw error;
      refusal ??= error;
    }
  }
  throw Object.assign(new Error("Glass switches cannot be saved: this vault and the Omarkie app data folder are both read-only."),
    { code: "GLASS_STATE_READ_ONLY", cause: refusal });
}

export async function readGlass(root, options) {
  return (await readGlassSettings(root, options)).visible;
}

export async function writeGlass(root, visible, options) {
  if (typeof visible !== "boolean") throw new Error("Glass state must be a boolean.");
  return (await writeGlassSettings(root, { visible }, options)).visible;
}

// G18: a second person's glass journal is a separate read-only layer, toggled per vault.
export async function readShared(root, options) {
  return (await readGlassSettings(root, options)).shared;
}

export async function writeShared(root, shared, options) {
  if (typeof shared !== "boolean") throw new Error("Shared glass state must be a boolean.");
  return (await writeGlassSettings(root, { shared }, options)).shared;
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
