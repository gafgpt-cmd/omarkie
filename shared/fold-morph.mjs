// Fold morph plan: which author words of a fuller stop survive into a sparser one, as pure data.
// The view keeps one node per author word and only toggles it, so a surviving word keeps identity.

// Above this many units the view morphs whole units instead of single words.
export const WORD_MORPH_LIMIT = 300;
const TABLE_LIMIT = 4_000_000;

function lowerBound(list, value) {
  let low = 0, high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (list[middle] < value) low = middle + 1; else high = middle;
  }
  return low;
}

// Longest common subsequence of two token lists as [sourceIndex, targetIndex] pairs, in order.
// Past TABLE_LIMIT cells it falls back to a greedy in-order match, which fold stops (sentence
// prefixes of the same text) satisfy exactly.
export function commonPairs(source, target) {
  const head = [], tail = [];
  let start = 0, endSource = source.length, endTarget = target.length;
  while (start < endSource && start < endTarget && source[start] === target[start]) { head.push([start, start]); start++; }
  while (endSource > start && endTarget > start && source[endSource - 1] === target[endTarget - 1]) {
    endSource--; endTarget--; tail.push([endSource, endTarget]);
  }
  const rows = endSource - start, columns = endTarget - start;
  if (rows && columns && rows * columns <= TABLE_LIMIT) {
    const width = columns + 1, table = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) for (let j = columns - 1; j >= 0; j--)
      table[i * width + j] = source[start + i] === target[start + j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    for (let i = 0, j = 0; i < rows && j < columns;) {
      if (source[start + i] === target[start + j]) { head.push([start + i, start + j]); i++; j++; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
      else j++;
    }
  } else if (rows && columns) {
    const positions = new Map();
    for (let i = start; i < endSource; i++) {
      const list = positions.get(source[i]);
      if (list) list.push(i); else positions.set(source[i], [i]);
    }
    let cursor = start;
    for (let j = start; j < endTarget; j++) {
      const list = positions.get(target[j]);
      if (!list) continue;
      const at = lowerBound(list, cursor);
      if (at < list.length) { head.push([list[at], j]); cursor = list[at] + 1; }
    }
  }
  return head.concat(tail.reverse());
}

// kept[i] = 1 when source token i survives; added = target tokens with no source node, each placed
// after the last kept source token before it (-1 = unit start).
export function morphPlan(source, target) {
  const pairs = commonPairs(source, target), kept = new Uint8Array(source.length), added = [];
  let next = 0, anchor = -1;
  for (let j = 0; j < target.length; j++) {
    if (next < pairs.length && pairs[next][1] === j) { anchor = pairs[next][0]; kept[anchor] = 1; next++; }
    else added.push({ after: anchor, token: target[j] });
  }
  return { kept, added };
}

const clamp = (value, count) => Math.max(0, Math.min(count - 1, Number.isFinite(value) ? value : 0));

// A continuous slider value between stop indexes: the segment it sits in and how far along it is.
export function scrubSegment(value, count) {
  const position = clamp(value, count), from = Math.min(Math.floor(position), Math.max(0, count - 2));
  return { from, to: Math.min(from + 1, count - 1), fraction: count > 1 ? position - from : 0 };
}

export function nearestStop(value, count) {
  return Math.round(clamp(value, count));
}

export function stepStop(index, delta, count) {
  return Math.round(clamp(index + delta, count));
}
