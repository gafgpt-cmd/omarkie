import { readFile, readdir, stat } from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import path from "node:path";

const ignored = [".omarkie", ".git", ".obsidian", ".trash", "node_modules", ".sync"];
const networkFileSystems = new Set(["fuse", "fuseblk", "fuse.sshfs", "fuse.rclone", "nfs", "nfs4", "cifs", "smb3", "9p", "vboxsf", "davfs", "afs"]);

const quietFor = 300;
const maxWait = 2_000;
const pollEveryDefault = 5_000;

export function ignoredPath(relative) {
  return relative.split("/").some(part => ignored.includes(part));
}

function relativeOf(root, file) {
  const value = path.relative(root, file);
  return value.startsWith("..") || path.isAbsolute(value) ? null : value.split(path.sep).join("/");
}

// The filesystem under a path, from the longest mount prefix. No root needed.
export async function mountInfo(root) {
  if (process.platform !== "linux") return null;
  try {
    const mounts = (await readFile("/proc/mounts", "utf8")).split("\n").filter(Boolean).map(line => {
      const [device, mount, type] = line.split(" ");
      return { device, mount: mount?.replace(/\\040/g, " "), type };
    });
    let best = null;
    for (const mount of mounts) {
      if (!mount.mount || !root.startsWith(mount.mount === "/" ? "/" : `${mount.mount}/`) && root !== mount.mount) continue;
      if (!best || mount.mount.length > best.mount.length) best = mount;
    }
    return best;
  } catch { return null; }
}

export async function pollingRequired(root, env = process.env) {
  if (["1", "true", "yes"].includes(String(env.OMARKIE_GLASS_POLL ?? "").toLowerCase())) return true;
  if (process.platform !== "linux") return false;
  const best = await mountInfo(root);
  return !!best && networkFileSystems.has(best.type) || !!best?.device?.startsWith("//");
}

async function snapshot(root) {
  const seen = new Map();
  async function walk(folder) {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      const relative = relativeOf(root, file);
      if (!relative || ignoredPath(relative)) continue;
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) continue;
      try {
        const metadata = await stat(file);
        seen.set(relative, `${metadata.size}:${metadata.mtimeMs}:${metadata.ino}`);
      } catch {}
    }
  }
  await walk(root);
  return seen;
}

// Native inotify when present, Node's recursive watch otherwise, polling for network and FUSE mounts.
export async function createWatcher({ root, onBatch, env = process.env, onMode, pollEvery = pollEveryDefault } = {}) {
  let closed = false, mode = "none", subscription = null, nodeWatcher = null, pollTimer = null, previous = null;
  let pending = new Map(), quietTimer = null, maxTimer = null;

  const emit = events => {
    if (!events.size || closed) return;
    const batch = [...events.values()];
    events.clear();
    try { onBatch(batch); } catch { /* the sync loop reports its own failure */ }
  };
  const flush = () => {
    clearTimeout(quietTimer); clearTimeout(maxTimer);
    quietTimer = maxTimer = null;
    emit(pending);
  };
  const queue = event => {
    if (closed) return;
    const relative = relativeOf(root, event.path);
    if (!relative || !relative || ignoredPath(relative)) return;
    pending.set(relative, { type: event.type, path: relative });
    clearTimeout(quietTimer);
    quietTimer = setTimeout(flush, quietFor);
    maxTimer ??= setTimeout(flush, maxWait);
  };

  const startPolling = async () => {
    mode = "polling";
    previous = await snapshot(root);
    pollTimer = setInterval(async () => {
      if (closed) return;
      const current = await snapshot(root);
      if (previous) {
        const events = new Map();
        for (const [file, signature] of current) if (previous.get(file) !== signature) events.set(file, { type: "update", path: file });
        for (const file of previous.keys()) if (!current.has(file)) events.set(file, { type: "delete", path: file });
        for (const event of events.values()) pending.set(event.path, event);
        if (pending.size) flush();
      }
      previous = current;
    }, pollEvery);
    pollTimer.unref?.();
    onMode?.(mode);
  };

  const startNodeWatch = () => {
    try {
      nodeWatcher = fsWatch(root, { recursive: true, encoding: "utf8" }, (_event, name) => {
        if (name) queue({ type: "update", path: path.join(root, name) });
      });
      nodeWatcher.on("error", () => { void startPolling(); });
      mode = "fs.watch";
      onMode?.(mode);
      return true;
    } catch { return false; }
  };

  const polling = await pollingRequired(root, env);
  if (!polling) {
    try {
      const watcher = await import("@parcel/watcher");
      subscription = await watcher.subscribe(root, (error, events) => {
        if (error) { void startPolling(); return; }
        for (const event of events) queue(event);
      }, { ignore: ignored.map(name => path.join(root, name)), backend: process.platform === "linux" ? "inotify" : undefined });
      mode = "parcel";
      onMode?.(mode);
    } catch {
      if (!startNodeWatch()) await startPolling();
    }
  } else await startPolling();

  return {
    get mode() { return mode; },
    async close() {
      closed = true;
      clearTimeout(quietTimer); clearTimeout(maxTimer);
      clearInterval(pollTimer);
      await Promise.resolve(subscription?.unsubscribe()).catch(() => {});
      nodeWatcher?.close();
    },
    flush,
    // Tests drive batches without waiting for a real event stream.
    push(events) { for (const event of events) queue(event); flush(); },
  };
}
