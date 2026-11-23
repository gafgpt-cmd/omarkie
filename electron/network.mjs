export function blocksRequest(url, devOrigin, allowRemote) {
  if (allowRemote) return false;
  let address;
  try { address = new URL(url); } catch { return true; }
  if (address.protocol === "ws:" || address.protocol === "wss:") address.protocol = address.protocol === "ws:" ? "http:" : "https:";
  if (address.protocol !== "http:" && address.protocol !== "https:") return false;
  return address.origin !== devOrigin;
}
