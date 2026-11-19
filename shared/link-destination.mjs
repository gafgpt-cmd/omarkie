export function inlineDestination(md, text, open, max = text.length) {
  if (text[open] !== "(") return null;
  let start = open + 1;
  while (start < max && /[ \t\r\n]/.test(text[start])) start++;
  const complete = (target, from, to, spaced = false) => {
    let pos = to, title;
    while (pos < max && /[ \t\r\n]/.test(text[pos])) pos++;
    if (pos > to) {
      const parsed = md.helpers.parseLinkTitle(text, pos, max);
      if (parsed.ok) {
        title = parsed.str; pos = parsed.pos;
        while (pos < max && /[ \t\r\n]/.test(text[pos])) pos++;
      }
    }
    return pos < max && text[pos] === ")" ? { target, from, to, end: pos + 1, title, spaced } : null;
  };
  const parsed = md.helpers.parseLinkDestination(text, start, max), angled = text[start] === "<";
  if (parsed.ok) {
    const destination = complete(parsed.str, start, parsed.pos);
    if (destination) return { ...destination, from: start + (angled ? 1 : 0), to: parsed.pos - (angled ? 1 : 0) };
  }
  let depth = 0;
  for (let pos = start; pos < max; pos++) {
    const character = text[pos];
    if (character === "\r" || character === "\n" || character === "<" || character === ">") return null;
    if (!depth && (/[ \t]/.test(character) || character === ")")) {
      const target = md.utils.unescapeAll(text.slice(start, pos));
      if (/\s/.test(target) && /\.[a-z0-9]{1,8}$/i.test(target)) {
        const result = complete(target, start, pos, true);
        if (result) return result;
      }
    }
    if (character === "\\") pos++;
    else if (character === "(" && ++depth > 32) return null;
    else if (character === ")" && !depth--) return null;
  }
  return null;
}
