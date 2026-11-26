import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";

const uid = process.getuid?.(), win = uid === undefined;
const missing = error => { if (error.code !== "ENOENT") throw error; return null; };
const info = file => lstat(file).catch(missing);
const ownerOnly = (stat, mask) => win || stat.uid === uid && (stat.mode & 0o777) === mask;
const frameLimit = 2 * 1024 * 1024, pollTimeout = 90_000;
const unavailable = () => new Error("Local Tutor bridge is unavailable in this vault.");
let flock;

export function endpoint(root, kind = "bridge") {
  const key = createHash("sha256").update(root).digest("hex");
  const under = base => path.join(base, `omarkie-${uid ?? "user"}`, key.slice(0, 32));
  // A long TMPDIR overflows the Unix socket path limit; /tmp is the same short place for the app and every CLI.
  let directory = under(os.tmpdir());
  if (!win && Buffer.byteLength(path.join(directory, `${kind}.sock`)) >= 104) directory = under("/tmp");
  return { directory, discovery: path.join(directory, `${kind}.json`), lock: path.join(directory, `${kind}.lock`),
    socket: win ? `\\\\.\\pipe\\omarkie-${key}${kind === "bridge" ? "" : `-${kind}`}` : path.join(directory, `${kind}.sock`) };
}

async function privateDirectory(directory, create) {
  for (const target of [path.dirname(directory), directory]) {
    if (create) await mkdir(target, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const stat = await info(target);
    if (!stat) return false;
    if (!stat.isDirectory() || !ownerOnly(stat, 0o700)) throw unavailable();
  }
  return true;
}

async function configuration(root, place) {
  if (!await privateDirectory(place.directory, false)) return null;
  const handle = await open(place.discovery, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)).catch(missing);
  if (!handle) return null;
  try {
    const meta = await handle.stat();
    if (!meta.isFile() || meta.nlink !== 1 || !ownerOnly(meta, 0o600) || meta.size > 16_384) throw unavailable();
    const value = JSON.parse(await handle.readFile("utf8"));
    if (value.version !== 1 || value.vault !== root || !/^[a-f0-9]{64}$/.test(value.token)) throw unavailable();
    return value;
  } finally { await handle.close(); }
}

export async function endpointExists(root, kind = "bridge") {
  const place = endpoint(root, kind);
  return await privateDirectory(place.directory, false) && !!(await info(place.discovery));
}

function frame(socket, accept, invalid) {
  let buffer = [], size = 0;
  function receive(chunk) {
    const end = chunk.indexOf(10);
    size += end < 0 ? chunk.length : end;
    if (size > frameLimit || end >= 0 && end !== chunk.length - 1) { socket.off("data", receive); return invalid(); }
    buffer.push(end < 0 ? chunk : chunk.subarray(0, end));
    if (end < 0) return;
    socket.off("data", receive);
    let data;
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(buffer, size))); }
    catch { return invalid(); }
    buffer = [];
    accept(data);
  }
  socket.on("data", receive);
}

export async function requestBridge(root, input, timeout, kind = "bridge") {
  const place = endpoint(root, kind), config = await configuration(root, place);
  if (!config) return null;
  if (!win) {
    const stat = await info(place.socket);
    if (!stat) return null;
    if (!stat.isSocket() || !ownerOnly(stat, 0o600)) throw unavailable();
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(place.socket);
    let connected = false;
    function finish(error, result) { socket.destroy(); error ? reject(error) : resolve(result); }
    socket.once("connect", () => { connected = true; socket.write(`${JSON.stringify({ ...input, token: config.token })}\n`); });
    socket.once("error", error => finish(!connected && ["ENOENT", "ECONNREFUSED"].includes(error.code) ? null : unavailable(), null));
    socket.once("close", () => resolve(null));
    socket.setTimeout(timeout, () => finish(new Error("Local Tutor bridge did not respond.")));
    frame(socket, response => finish(typeof response?.error === "string" ? new Error(response.error) : null, response), () => finish(unavailable()));
  });
}

export async function listenBridge(root, broker, kind = "bridge") {
  const place = endpoint(root, kind), label = kind === "bridge" ? "Tutor" : "Glass";
  if (!win && Buffer.byteLength(place.socket) >= 104) throw new Error(`The temporary directory path is too long for the ${label} socket.`);
  await privateDirectory(place.directory, true);
  let lock, owned = false, discovery = false;
  const sockets = new Set(), code = randomBytes(32), encoded = code.toString("hex");
  const server = createServer(socket => {
    if (sockets.size >= 24) { socket.destroy(); return; }
    sockets.add(socket);
    const waitId = randomBytes(16).toString("hex");
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { sockets.delete(socket); broker.stopWait(waitId, false); });
    socket.setTimeout(3_000, () => socket.destroy());
    // A frame past the limit would read as "bridge unavailable" on the client; name the real cause.
    const result = packet => {
      if (socket.destroyed) return;
      const frame = `${JSON.stringify(packet)}\n`;
      socket.end(Buffer.byteLength(frame) > frameLimit
        ? `${JSON.stringify({ error: `That Glass answer is larger than ${Math.round(frameLimit / 1024)} KB and cannot cross the local bridge.` })}\n`
        : frame);
    };
    frame(socket, request => {
      if (!request || typeof request.token !== "string" || !/^[a-f0-9]{64}$/.test(request.token) || !timingSafeEqual(code, Buffer.from(request.token, "hex"))) {
        result({ error: "Unauthorized Tutor bridge request." }); return;
      }
      socket.setTimeout(pollTimeout, () => broker.stopWait(waitId, true));
      broker.client(request, result, waitId);
    }, () => result({ error: "Invalid Tutor bridge frame." }));
  });
  async function close() {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (discovery) await unlink(place.discovery).catch(missing);
    if (owned && !win) await unlink(place.socket).catch(missing);
    await lock?.close();
  }
  try {
    if (!win) {
      lock = await open(place.lock, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      const meta = await lock.stat();
      if (!meta.isFile() || meta.nlink !== 1 || !ownerOnly(meta, 0o600)) throw unavailable();
      flock ??= import("koffi").then(({ default: koffi }) => koffi.load(null).func("int flock(int fd, int operation)"));
      if ((await flock)(lock.fd, 2 | 4) !== 0) throw new Error(`Another Omarkie process owns the ${label} bridge for this vault.`);
      owned = true;
      const previous = await info(place.socket);
      if (previous && (!previous.isSocket() || previous.uid !== uid)) throw unavailable();
      if (previous) await unlink(place.socket);
    }
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(place.socket, () => { server.off("error", reject); resolve(); });
    });
    server.on("error", () => void close().catch(() => {}));
    if (!win) {
      const { chmod } = await import("node:fs/promises");
      await chmod(place.socket, 0o600);
    }
    const stale = await info(place.discovery);
    if (stale && (!stale.isFile() || stale.nlink !== 1 || !ownerOnly(stale, 0o600))) throw unavailable();
    if (stale) await unlink(place.discovery);
    const handle = await open(place.discovery, "wx", 0o600);
    discovery = true;
    try { await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, vault: root, token: encoded })); }
    finally { await handle.close(); }
    return close;
  } catch (error) { await close(); throw error; }
}
