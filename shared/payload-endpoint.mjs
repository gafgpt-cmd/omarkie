export function payloadEndpoint(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.length > 2048) return null;
  const raw = baseUrl.trim();
  if (!/^https?:\/\//i.test(raw) || /[\s?#\\]/.test(raw)) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || (!local && url.protocol !== "https:")) return null;
  url.pathname = url.pathname.replace(/\/+$/, "") + "/chat/completions";
  return { url: url.href, origin: url.origin, local };
}

export const payloadInputBytes = 24_000;
export const payloadQuestionLength = 1000;
