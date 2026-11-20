import { digest } from "./store.mjs";

const normalize = text => text.normalize("NFC").replace(/\s+/gu, " ").trim();
const identity = (block, section) => digest(JSON.stringify([block, section]));
const sectionKey = headings => JSON.stringify(headings.map(normalize));

export function readingAnchor({ block, headings, line, quote }) {
  block = normalize(block);
  headings = headings.map(normalize);
  return { block, headings, line, quote, hash: identity(block, JSON.stringify(headings)) };
}

function grams(text) {
  const counts = new Map();
  for (let i = 0, n = Math.max(text.length - 2, 1); i < n; i++) {
    const gram = text.slice(i, i + 3);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  return counts;
}

function similarity(text, candidate, counts) {
  const length = Math.max(text.length - 2, 1), other = Math.max(candidate.length - 2, 1);
  if (2 * Math.min(length, other) < 0.8 * (length + other)) return 0;
  let shared = 0;
  for (const [gram, count] of grams(candidate)) shared += Math.min(count, counts.get(gram) || 0);
  return 2 * shared / (length + other);
}

export function resolveReadingAnchors(notes, blocks) {
  if (!notes.length) return [];
  const hashes = new Map(), sections = new Map(), byText = new Map();
  for (const note of notes) sections.set(sectionKey(note.anchor.headings), []);
  for (const { block, headings, line } of blocks) {
    const text = normalize(block);
    if (!text) continue;
    const section = sectionKey(headings), candidates = sections.get(section);
    if (candidates) {
      const hash = identity(text, section), sameBlock = hashes.get(hash);
      if (sameBlock) sameBlock.push(line); else hashes.set(hash, [line]);
      candidates.push({ text, line });
    }
    // An unchanged block can survive a renamed heading, but never guess between copies.
    const found = byText.get(text);
    byText.set(text, found === undefined ? line : null);
  }
  return notes.map(({ id, anchor }) => {
    const exact = hashes.get(anchor.hash);
    let line = null;
    if (exact) line = exact.length === 1 ? exact[0] : exact.includes(anchor.line) ? anchor.line : null;
    else if (byText.has(anchor.block)) line = byText.get(anchor.block);
    else {
      const counts = grams(anchor.block);
      let best = 0;
      for (const candidate of sections.get(sectionKey(anchor.headings))) {
        const score = similarity(anchor.block, candidate.text, counts);
        if (score >= 0.8 && score > best) {
          line = candidate.line; best = score;
        } else if (score === best) line = null;
      }
    }
    return { id, line };
  });
}
