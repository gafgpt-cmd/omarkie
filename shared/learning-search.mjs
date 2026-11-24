export function learningSearchTerms(input) {
  if (typeof input !== "string" || input.length > 160) return [];
  return [...new Set(input.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? [])].slice(0, 12);
}
