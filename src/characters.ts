// Non-whitespace code points, as Array.from(text.replace(/\s/g, "")).length, without building the copy.
const space = /\s/;
export function countCharacters(text: string) {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
      const lead = text.charCodeAt(i - 1);
      if (lead >= 0xd800 && lead <= 0xdbff) continue;
    }
    if (code > 32 && code < 127) count++;
    else if (!space.test(text[i])) count++;
  }
  return count;
}
