const key = /[\w.:+/-]/;
const start = /\[@([\w.:+/-]{0,256})$/;
const complete = /\[@([\w.:+/-]{1,256})\](?![[(])/g;
export interface CitationDraft { from: number; to: number; at: number; query: string }

function escaped(text: string, at: number) {
  let from = at;
  while (from > 0 && text[from - 1] === "\\") from--;
  return (at - from) % 2 !== 0;
}

export function citationDraft(text: string, at: number): CitationDraft | undefined {
  if (at < 2 || text[at - 1] !== "@" && !key.test(text[at - 1])) return;
  const match = start.exec(text.slice(Math.max(0, at - 258), at));
  if (!match) return;
  const from = at - match[0].length;
  if (escaped(text, from) || text[from - 1] === "[") return;
  const suffix = /^[\w.:+/-]{0,256}\](?![[(])/.exec(text.slice(at, at + 258));
  if (text[at] && !suffix && (text[at] === "]" || key.test(text[at]))) return;
  return { from, to: at + (suffix?.[0].length || 0), at, query: match[1] };
}

export function citationAt(text: string, at: number) {
  const first = Math.max(0, at - 259), last = Math.min(text.length, at + 260);
  const nearby = text.slice(first, last);
  for (const match of nearby.matchAll(complete)) {
    const from = first + match.index, to = from + match[0].length;
    if (from <= at && to >= at && !escaped(text, from) && text[from - 1] !== "[" && text[to] !== "]") return { from, to, id: match[1] };
  }
}
