export const grammarDefault = "http://127.0.0.1:8081/v2/check";
export const grammarTextLimit = 20_000;

export function grammarEndpoint(value) {
  if (typeof value !== "string" || value.length > 500) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!local || url.protocol !== "http:") && url.protocol !== "https:" ||
      url.username || url.password || url.href.includes("?") || url.href.includes("#") ||
      !url.pathname.endsWith("/v2/check")) return null;
  return { url: url.href, origin: url.origin, local };
}

export function grammarMatches(payload, text) {
  if (!Array.isArray(payload?.matches)) throw new Error("Invalid LanguageTool response");
  const splitsPair = offset => /[\uD800-\uDBFF]/.test(text[offset - 1] || "") && /[\uDC00-\uDFFF]/.test(text[offset] || "");
  return payload.matches.slice(0, 200).flatMap(match => {
    const { offset, length, message, replacements } = match || {};
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || typeof message !== "string") return [];
    const end = offset + length;
    if (end > text.length || splitsPair(offset) || splitsPair(end)) return [];
    const previous = text.slice(offset, end);
    const fixes = Array.isArray(replacements) ? replacements.slice(0, 8).flatMap(item => {
      const value = item?.value;
      return typeof value === "string" && value.length <= 500 && !/[\r\n\u0000]/.test(value) && value !== previous ? [value] : [];
    }) : [];
    return [{ from: offset, to: end, message: message.slice(0, 500), fixes: [...new Set(fixes)] }];
  });
}
