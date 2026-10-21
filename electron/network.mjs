// With remote images off, the app window may reach only its own dev server and loopback services (e.g. PicGo).
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
export function blocksRequest(url, devOrigin, allowRemote) {
  if (allowRemote) return false;
  let address;
  try { address = new URL(url); } catch { return true; }
  if (address.protocol !== "http:" && address.protocol !== "https:") return false;
  return address.origin !== devOrigin && !loopback.has(address.hostname);
}
