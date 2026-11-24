export function learningSearchTerms(input) {
  if (typeof input !== "string" || input.length > 160) return [];
  return [...new Set(words(input))].slice(0, 12);
}

function words(text) {
  return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function matchLearningScraps(entries, terms) {
  if (!terms.length) return [];
  const matches = [];
  for (const item of entries) {
    if (item.type !== "note" && (item.type !== "scrap" || item.image)) continue;
    const tokens = words([item.body, item.question, item.anchor?.quote].join("\n"));
    if (!terms.every(term => tokens.some(token => token.startsWith(term)))) continue;
    matches.push({ document: item.document, line: item.anchor?.line ?? null, kind: item.kind ?? "note", text: item.body.slice(0, 320) });
    if (matches.length === 60) break;
  }
  return matches;
}
