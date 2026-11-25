// Pure move pairing: notes travel by fingerprint, folders by one prefix swap.
// No disk here; electron/glass-sync.mjs supplies fingerprints and applies the plan.

const markdown = /\.(?:md|markdown|mdown)$/i;

export function noteKey(value, caseInsensitive = false) {
  const name = String(value ?? "").normalize("NFC");
  return caseInsensitive ? name.toLowerCase() : name;
}

export function isNotePath(value) {
  return markdown.test(String(value ?? ""));
}

function words(value) {
  return new Set(String(value ?? "").normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

function overlap(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function sameName(left, right) {
  const a = String(left ?? "").normalize("NFC").toLowerCase();
  const b = String(right ?? "").normalize("NFC").toLowerCase();
  return !!a && a === b;
}

// Exact content wins; an edited note still pairs by name, headings, first lines and size.
export function shapeScore(missing, added) {
  const oldShape = missing?.shape ?? missing?.fingerprint?.shape ?? {};
  const newShape = added?.shape ?? {};
  let score = 0;
  if (sameName(oldShape.fileName, newShape.fileName)) score += 0.35;
  score += 0.25 * overlap(words((oldShape.headings ?? []).join(" ")), words((newShape.headings ?? []).join(" ")));
  score += 0.25 * overlap(words((oldShape.firstLines ?? []).join(" ")), words((newShape.firstLines ?? []).join(" ")));
  const oldSize = Number(missing?.size ?? missing?.fingerprint?.size ?? 0);
  const newSize = Number(added?.size ?? 0);
  if (oldSize > 0 && newSize > 0) score += 0.15 * (1 - Math.abs(oldSize - newSize) / Math.max(oldSize, newSize));
  return Math.min(1, score);
}

function sameContent(missing, added) {
  const hash = missing?.hash ?? missing?.fingerprint?.hash;
  return !!hash && hash === added?.hash;
}

function directoryOf(path) {
  const index = String(path).lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function suffixUnder(path, prefix) {
  if (!prefix) return path;
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : null;
}

function bestOf(candidates) {
  return candidates.sort((left, right) => right.score - left.score || left.to.localeCompare(right.to))[0] ?? null;
}

function folderCandidates(missing, added, caseInsensitive) {
  const missingByDirectory = new Map();
  for (const note of missing) {
    const directory = directoryOf(note.path);
    if (!directory || directory.startsWith(".")) continue;
    const list = missingByDirectory.get(directory) ?? [];
    list.push(note);
    missingByDirectory.set(directory, list);
  }
  const addedDirectories = new Set([...added].map(file => directoryOf(file.path)).filter(Boolean));
  const plans = [];
  for (const [oldDirectory, notes] of missingByDirectory) {
    if (notes.length < 2) continue;
    for (const newDirectory of addedDirectories) {
      if (noteKey(newDirectory, caseInsensitive) === noteKey(oldDirectory, caseInsensitive)) continue;
      const suffixOf = new Map(notes.map(note => [noteKey(suffixUnder(note.path, oldDirectory), caseInsensitive), note]));
      const bySuffix = new Map();
      for (const file of added) {
        const suffix = suffixUnder(file.path, newDirectory);
        if (suffix) bySuffix.set(noteKey(suffix, caseInsensitive), file);
      }
      if (bySuffix.size < suffixOf.size) continue;
      const pairs = [];
      let valid = true, exact = 0;
      for (const [suffix, note] of suffixOf) {
        const file = bySuffix.get(suffix);
        if (!file) { valid = false; break; }
        if (sameContent(note, file)) exact += 1;
        else if (shapeScore(note, file) < 0.8) { valid = false; break; }
        pairs.push({ note, file, score: sameContent(note, file) ? 1 : shapeScore(note, file) });
      }
      if (!valid || !pairs.length) continue;
      plans.push({ from: oldDirectory, to: newDirectory, count: pairs.length, exact, score: pairs.length + exact / pairs.length, pairs });
    }
  }
  return plans.sort((left, right) => right.count - left.count || right.exact - left.exact || left.from.localeCompare(right.from));
}

// missing: [{id, path, hash, size, shape}], added: [{path, hash, size, shape}]
export function planMoves({ missing = [], added = [], caseInsensitive = false } = {}) {
  const remainingNotes = [...missing];
  const remainingFiles = [...added];
  const folders = [], moves = [];

  for (;;) {
    const plan = folderCandidates(remainingNotes, remainingFiles, caseInsensitive)[0];
    if (!plan) break;
    folders.push({ from: plan.from, to: plan.to, count: plan.count, exact: plan.exact });
    const usedNotes = new Set(plan.pairs.map(pair => pair.note));
    const usedFiles = new Set(plan.pairs.map(pair => pair.file));
    for (let index = remainingNotes.length - 1; index >= 0; index -= 1) if (usedNotes.has(remainingNotes[index])) remainingNotes.splice(index, 1);
    for (let index = remainingFiles.length - 1; index >= 0; index -= 1) if (usedFiles.has(remainingFiles[index])) remainingFiles.splice(index, 1);
  }

  const byHash = new Map();
  for (const file of remainingFiles) {
    if (!file.hash) continue;
    const list = byHash.get(file.hash) ?? [];
    list.push(file);
    byHash.set(file.hash, list);
  }
  for (let index = remainingNotes.length - 1; index >= 0; index -= 1) {
    const note = remainingNotes[index];
    const hash = note.hash ?? note.fingerprint?.hash;
    const candidates = (byHash.get(hash) ?? []).filter(file => remainingFiles.includes(file));
    let match = candidates.length === 1 ? candidates[0] : null;
    if (!match && candidates.length > 1) {
      const best = bestOf(candidates.map(file => ({ file, to: file.path, score: shapeScore(note, file) })));
      if (best?.score >= 0.8) match = best.file;
    }
    if (!match) continue;
    moves.push({ id: note.id, from: note.path, to: match.path, confidence: 1 });
    remainingNotes.splice(index, 1);
    remainingFiles.splice(remainingFiles.indexOf(match), 1);
  }

  for (let index = remainingNotes.length - 1; index >= 0; index -= 1) {
    const note = remainingNotes[index];
    const candidates = remainingFiles.map(file => ({ file, to: file.path, score: shapeScore(note, file) })).filter(item => item.score >= 0.8);
    const best = bestOf(candidates);
    if (!best) continue;
    moves.push({ id: note.id, from: note.path, to: best.file.path, confidence: Number(best.score.toFixed(3)) });
    remainingNotes.splice(index, 1);
    remainingFiles.splice(remainingFiles.indexOf(best.file), 1);
  }

  return {
    folders,
    moves,
    lost: remainingNotes.map(note => ({ id: note.id, path: note.path })),
    unmatched: remainingFiles.map(file => file.path),
  };
}
