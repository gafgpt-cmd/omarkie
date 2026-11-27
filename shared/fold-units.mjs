// Fold units from the shared element model, raw-block preservation (D5), and monotonic guard (D4).
// Pure ESM (Node + browser): no disk, network, or Node-only built-ins.

import { normalizeText } from "./anchor-core.mjs";
import { elementId, markdownElements, tableCells } from "./element-model.mjs";
import { isFoldLine, levelOf } from "./fold-format.mjs";
import { LOCAL_LEVELS, firstSentence, sentences, words } from "./fold-text.mjs";

const LOCAL_STOP_IDS = Object.freeze(LOCAL_LEVELS.map(entry => entry.id));
const SUB_ELEMENT_KINDS = new Set(["list-item", "table-cell"]);
const SKIP_UNIT_KINDS = new Set(["divider"]);
const PROSE_KINDS = new Set(["paragraph", "list", "quote", "callout", "html"]);
const FENCE_OPEN = /^\s*(?:(`{3,})[^`]*$|(~{3,}))/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+/;
const HEADING_LINE = /^\s{0,3}#{1,6}\s/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const ART_ROW = /^(`+).*\1 {2}$/;
const QUOTE_MARKER = /^\s*>\s?/;
const QUOTE_PREFIXES = /^(?:\s*>\s?)+/;
const INLINE_MD_IMAGE = /!\[[^\]\r\n]*\]\([^)\s]*(?:(?:[ \t]|\r?\n)[^)\r\n]*)?\)/y;
const INLINE_WIKI_EMBED = /!\[\[[^\]\r\n]+\]\]/y;
const INLINE_HTML_IMG = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/iy;
const MORE = " …";

// FIPS 180-4 SHA-256 constants (first 32 bits of fractional parts of cube roots of first 64 primes).
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const UTF8 = new TextEncoder();

/** Pure synchronous SHA-256 hex digest (64 lowercase hex chars), works in Node and browsers. */
export function sha256(text) {
  const bytes = UTF8.encode(typeof text === "string" ? text : String(text ?? ""));
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map(n => n.toString(16).padStart(8, "0")).join("");
}

/** Content hash for incremental re-fold: normalizes EOL and NFC while keeping case, accents, and punctuation exact. */
export function unitHash(kind, markdown) {
  const normalized = String(markdown ?? "").replace(/\r\n?/g, "\n").normalize("NFC");
  return sha256(`${kind}\u0001${normalized}`);
}

/** Maps an element kind (or element object) to its D5 raw-block class, or null for prose/headings. */
export function rawClassOf(kindOrElement) {
  const kind = typeof kindOrElement === "string" ? kindOrElement : kindOrElement?.kind;
  switch (kind) {
    case "table": return "table";
    case "code": return "code";
    case "formula": return "math";
    case "image":
    case "embed": return "image";
    default: return null;
  }
}

/** Exact six-field `FoldUnit` record accepted by `foldProblems()` in `shared/fold-format.mjs`. */
export function toFoldUnit(unit) {
  return {
    elementId: unit.elementId,
    kind: unit.kind,
    line: unit.line,
    endLine: unit.endLine,
    hash: unit.hash,
    raw: unit.raw,
  };
}

function splitLines(markdown) {
  return markdown.replace(/\r\n?/g, "\n").split("\n");
}

function fenceMark(line) {
  const match = FENCE_OPEN.exec(line);
  return match ? (match[1] ?? match[2]) : null;
}

function fenceClose(line, mark) {
  const trimmed = line.trim();
  if (trimmed.length < mark.length || !trimmed.startsWith(mark)) return false;
  const ch = mark[0];
  for (let i = mark.length; i < trimmed.length; i++) if (trimmed[i] !== ch) return false;
  return true;
}

function codeBodyLines(lines) {
  const mark = fenceMark(lines[0] ?? "");
  if (!mark) return lines.length;
  const closed = lines.length > 1 && fenceClose(lines[lines.length - 1] ?? "", mark);
  return Math.max(0, lines.length - (closed ? 2 : 1));
}

function imageAlt(kind, markdown) {
  if (kind === "embed") {
    const match = /^!\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]*))?\]\]/.exec(markdown.trim());
    if (!match) return "";
    const alias = match[2]?.trim() ?? "";
    const isSize = /^\d+(?:\s*x\s*\d+)?$/i.test(alias);
    return (!isSize && alias) || match[1].trim();
  }
  const match = /^!\[([^\]\n]*)\]/.exec(markdown.trim());
  return match ? match[1].trim() : "";
}

function rawMetadata(element, raw) {
  if (!raw) return null;
  if (raw === "table") {
    const lines = splitLines(element.markdown);
    const columns = tableCells(lines[0] ?? "").length;
    const rows = Math.max(0, lines.slice(2).filter(line => line.trim().length > 0).length);
    return { class: "table", rows, columns };
  }
  if (raw === "code") {
    const lines = splitLines(element.markdown);
    return { class: "code", lines: codeBodyLines(lines), language: element.language ?? null };
  }
  if (raw === "math") return { class: "math" };
  return { class: "image", kind: element.kind === "embed" ? "embed" : "image", alt: imageAlt(element.kind, element.markdown) };
}

function containerPriority(kind) {
  // Blockquotes can wrap lists at the exact same source range; outer container must win.
  return kind === "quote" || kind === "callout" ? 0 : kind === "list" ? 1 : 2;
}

function stripQuotePrefix(line) {
  return line.replace(QUOTE_PREFIXES, "");
}

function prefixQuote(markdown) {
  return splitLines(markdown).map(line => (line ? `> ${line}` : ">")).join("\n");
}

function commonIndent(lines) {
  let min = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const len = line.length - line.trimStart().length;
    if (len < min) min = len;
  }
  return Number.isFinite(min) ? min : 0;
}

function dedentLines(lines) {
  const indent = commonIndent(lines);
  return {
    indent,
    lines: indent > 0 ? lines.map(line => (line.trim() ? line.slice(indent) : "")) : lines,
  };
}

function indentBlock(markdown, spaces) {
  if (spaces <= 0) return markdown;
  const pad = " ".repeat(spaces);
  return splitLines(markdown).map(line => (line ? pad + line : "")).join("\n");
}

function stripQuoteDepth(line, maxDepth = Infinity) {
  let s = line;
  let depth = 0;
  while (depth < maxDepth) {
    const match = QUOTE_MARKER.exec(s);
    if (!match) break;
    s = s.slice(match[0].length);
    depth++;
  }
  return { depth, rest: s };
}

function quotedLineAt(lines, j, quoteDepth) {
  if (j >= lines.length) return null;
  const raw = lines[j] ?? "";
  if (quoteDepth <= 0) return raw;
  const inner = stripQuoteDepth(raw, quoteDepth);
  return inner.depth < quoteDepth ? null : inner.rest;
}

function matchRawBlockCore(lines, i, firstLine, quoteDepth = 0) {
  const mark = fenceMark(firstLine);
  if (mark) {
    const out = [firstLine];
    let j = i + 1;
    while (j < lines.length) {
      const l = quotedLineAt(lines, j, quoteDepth);
      if (l === null) break;
      out.push(l);
      j++;
      if (fenceClose(l, mark)) break;
    }
    return { raw: "code", lines: out, nextIndex: j };
  }

  const trimmed = firstLine.trim();
  if (trimmed.startsWith("$$")) {
    if (trimmed.length >= 4 && trimmed.endsWith("$$")) {
      return { raw: "math", lines: [firstLine], nextIndex: i + 1 };
    }
    if (trimmed === "$$" || !trimmed.slice(2).includes("$$")) {
      const out = [firstLine];
      let close = -1;
      let limit = i + 1;
      for (let j = i + 1; j < lines.length; j++) {
        const l = quotedLineAt(lines, j, quoteDepth);
        if (l === null) break;
        out.push(l);
        limit = j + 1;
        if (l.trim().endsWith("$$")) {
          close = j;
          break;
        }
      }
      if (close !== -1 || trimmed === "$$") {
        return { raw: "math", lines: out, nextIndex: close !== -1 ? close + 1 : limit };
      }
    }
  }

  const nextLine = quotedLineAt(lines, i + 1, quoteDepth);
  if (firstLine.includes("|") && nextLine !== null && nextLine.includes("|") && TABLE_DELIM.test(nextLine)) {
    const out = [firstLine, nextLine];
    let j = i + 2;
    while (j < lines.length) {
      const l = quotedLineAt(lines, j, quoteDepth);
      if (l === null || !l.trim() || !l.includes("|") || fenceMark(l) || LIST_ITEM.test(l) || HEADING_LINE.test(l) || QUOTE_MARKER.test(l) || l.trim().startsWith("$$")) break;
      out.push(l);
      j++;
    }
    return { raw: "table", lines: out, nextIndex: j };
  }

  return null;
}

function stripBlockContainers(line) {
  let s = line;
  let quoteDepth = 0;
  let indent = null;
  let pos = 0;
  let innerPrefixLen = 0;
  while (true) {
    const q = QUOTE_MARKER.exec(s);
    if (q) {
      if (indent === null) indent = pos + (q[0].length - q[0].trimStart().length);
      quoteDepth++;
      pos += q[0].length;
      s = s.slice(q[0].length);
      innerPrefixLen = 0;
      continue;
    }
    const m = LIST_ITEM.exec(s);
    if (m) {
      if (quoteDepth > 0) innerPrefixLen += m[0].length;
      pos += m[0].length;
      s = s.slice(m[0].length);
      continue;
    }
    break;
  }
  if (indent === null) indent = pos;
  return { quoteDepth, indent, virtualLine: " ".repeat(quoteDepth > 0 ? innerPrefixLen : pos) + s };
}

function matchRawBlock(lines, i) {
  const line = lines[i] ?? "";
  const { quoteDepth, indent, virtualLine } = stripBlockContainers(line);
  const matched = matchRawBlockCore(lines, i, virtualLine, quoteDepth);
  return matched ? { ...matched, quoted: quoteDepth > 0, quoteIndent: indent } : null;
}

function skipBacktickRun(text, i) {
  let run = 1;
  while (text[i + run] === "`") run++;
  let pos = i + run;
  while (pos < text.length) {
    if (text[pos] !== "`") {
      pos++;
      continue;
    }
    let len = 1;
    while (text[pos + len] === "`") len++;
    if (len === run) return pos + len;
    pos += len;
  }
  return i + run;
}

function lineSpans(text) {
  const spans = [];
  let offset = 0;
  while (offset <= text.length) {
    const nl = text.indexOf("\n", offset);
    const end = nl === -1 ? text.length : nl + 1;
    const line = (nl === -1 ? text.slice(offset) : text.slice(offset, nl)).replace(/\r$/, "");
    spans.push({ start: offset, end, text: line });
    if (nl === -1) break;
    offset = end;
  }
  return spans;
}

function nonMediaBlockRanges(markdown, targetText = markdown) {
  const ranges = [];
  const sourceLines = lineSpans(markdown);
  const targetLines = targetText === markdown ? sourceLines : lineSpans(targetText);
  const lineTexts = sourceLines.map(entry => entry.text);
  let i = 0;
  while (i < lineTexts.length) {
    const raw = matchRawBlock(lineTexts, i);
    if (raw) {
      if (raw.raw === "code" || raw.raw === "math") {
        ranges.push([targetLines[i].start, targetLines[raw.nextIndex - 1].end]);
      }
      i = raw.nextIndex;
      continue;
    }
    i++;
  }
  return ranges;
}

function nextMediaId(kind, markdown, ordinals) {
  const key = `${kind}\u0001${normalizeText(markdown)}`;
  const ordinal = (ordinals.get(key) ?? 0) + 1;
  ordinals.set(key, ordinal);
  return elementId(kind, markdown, ordinal);
}

function normalizeInlineMediaMarkdown(text) {
  return text.replace(/\r?\n(?:\s*>\s?)*[ \t]*/g, " ").trim();
}

function stripQuotedSource(markdown) {
  let text = "";
  const rawIndex = [];
  let offset = 0;
  while (offset <= markdown.length) {
    const nl = markdown.indexOf("\n", offset);
    const lineEnd = nl === -1 ? markdown.length : nl;
    const line = markdown.slice(offset, lineEnd);
    const prefix = QUOTE_PREFIXES.exec(line);
    const skip = prefix ? prefix[0].length : 0;
    for (let k = offset + skip; k < lineEnd; k++) {
      text += markdown[k];
      rawIndex.push(k);
    }
    if (nl === -1) break;
    text += "\n";
    rawIndex.push(nl);
    offset = nl + 1;
  }
  rawIndex.push(markdown.length);
  return { text, rawIndex };
}

function scanInlineMedia(markdown, baseOffset, existingList, ordinals, isQuoted = false) {
  const existing = existingList ?? [];
  if (!existing.length && !markdown.includes("![") && !/<img\b/i.test(markdown)) return [];

  const { text: scanText, rawIndex } = isQuoted ? stripQuotedSource(markdown) : { text: markdown, rawIndex: null };
  const existingBySpan = new Map(existing.map(item => [`${item.from}:${item.to}`, item]));
  const matchedKeys = new Set();
  const skipRanges = nonMediaBlockRanges(markdown, scanText);
  let skipIdx = 0;
  const found = [];

  for (let i = 0; i < scanText.length; ) {
    while (skipIdx < skipRanges.length && skipRanges[skipIdx][1] <= i) skipIdx++;
    if (skipIdx < skipRanges.length && i >= skipRanges[skipIdx][0] && i < skipRanges[skipIdx][1]) {
      i = skipRanges[skipIdx][1];
      continue;
    }
    if (scanText.startsWith("<!--", i)) {
      const close = scanText.indexOf("-->", i + 4);
      i = close === -1 ? scanText.length : close + 3;
      continue;
    }
    if (scanText[i] === "\\" && i + 1 < scanText.length) {
      i += 2;
      continue;
    }
    if (scanText[i] === "`") {
      i = skipBacktickRun(scanText, i);
      continue;
    }
    let kind = null;
    let match = null;
    if (scanText[i] === "!") {
      INLINE_WIKI_EMBED.lastIndex = i;
      match = INLINE_WIKI_EMBED.exec(scanText);
      if (match) {
        kind = "embed";
      } else {
        INLINE_MD_IMAGE.lastIndex = i;
        match = INLINE_MD_IMAGE.exec(scanText);
        if (match) kind = "image";
      }
    } else if (scanText[i] === "<") {
      INLINE_HTML_IMG.lastIndex = i;
      match = INLINE_HTML_IMG.exec(scanText);
      if (match) kind = "image";
    }
    if (match && kind) {
      const from = baseOffset + (rawIndex ? rawIndex[i] : i);
      const to = baseOffset + (rawIndex ? rawIndex[i + match[0].length - 1] + 1 : i + match[0].length);
      const cleanMarkdown = isQuoted ? normalizeInlineMediaMarkdown(match[0]) : match[0];
      const spanKey = `${from}:${to}`;
      const reused = existingBySpan.get(spanKey);
      if (reused) {
        found.push(reused);
        matchedKeys.add(spanKey);
      } else {
        found.push({
          elementId: nextMediaId(kind, cleanMarkdown, ordinals),
          kind,
          markdown: cleanMarkdown,
          from,
          to,
        });
      }
      i += match[0].length;
      continue;
    }
    i++;
  }

  for (const item of existing) {
    const spanKey = `${item.from}:${item.to}`;
    if (!matchedKeys.has(spanKey)) found.push(item);
  }
  found.sort((a, b) => a.from - b.from || a.to - b.to);
  return found;
}

function isHtmlComment(markdown) {
  return markdown.replace(/<!--[\s\S]*?(?:-->|$)/g, "").trim().length === 0;
}

/** Extracts ordered, non-overlapping top-level Fold units from `markdownElements()`. */
export function extractUnits(markdown, options = {}) {
  if (typeof markdown !== "string" || !markdown) return [];
  const elements = markdownElements(markdown, options);
  const inlineMediaByParent = new Map();
  const mediaOrdinals = new Map();
  const candidates = [];

  for (const element of elements) {
    if (element.kind === "image" || element.kind === "embed") {
      const key = `${element.kind}\u0001${normalizeText(element.markdown)}`;
      mediaOrdinals.set(key, (mediaOrdinals.get(key) ?? 0) + 1);
    }
    if (element.parent !== undefined) {
      if (element.kind === "image" || element.kind === "embed") {
        let list = inlineMediaByParent.get(element.parent);
        if (!list) {
          list = [];
          inlineMediaByParent.set(element.parent, list);
        }
        list.push({
          elementId: element.id,
          kind: element.kind,
          markdown: element.markdown,
          from: element.from,
          to: element.to,
        });
      }
      continue;
    }
    if (SUB_ELEMENT_KINDS.has(element.kind) || SKIP_UNIT_KINDS.has(element.kind)) continue;
    candidates.push(element);
  }

  candidates.sort((a, b) => a.from - b.from || b.to - a.to || containerPriority(a.kind) - containerPriority(b.kind));

  const topLevel = [];
  let maxTo = -1;
  for (const element of candidates) {
    if (element.to <= maxTo) continue;
    topLevel.push(element);
    maxTo = element.to;
  }

  let currentSectionId = null;
  return topLevel.map(element => {
    if (element.kind === "heading") currentSectionId = element.id;
    const raw = rawClassOf(element.kind);
    const inlineMedia = raw === null && PROSE_KINDS.has(element.kind)
      ? scanInlineMedia(
        element.markdown,
        element.from,
        inlineMediaByParent.get(element.id),
        mediaOrdinals,
        element.kind === "quote" || element.kind === "callout",
      )
      : [];
    const unit = {
      elementId: element.id,
      kind: element.kind,
      line: element.line,
      endLine: element.endLine,
      from: element.from,
      to: element.to,
      markdown: element.markdown,
      text: element.text,
      headings: [...element.headings],
      sectionId: currentSectionId,
      hash: unitHash(element.kind, element.markdown),
      raw,
      rawMeta: rawMetadata(element, raw),
      inlineMedia,
    };
    if (element.level !== undefined) unit.level = element.level;
    if (element.language !== undefined) unit.language = element.language;
    if (element.ordered !== undefined) unit.ordered = element.ordered;
    return unit;
  });
}

function resolveLocalLevel(level) {
  if (typeof level === "string") {
    const entry = levelOf(level);
    if (!entry || !entry.local) throw new RangeError(`Unsupported local fold level: ${level}`);
    return entry;
  }
  if (typeof level === "number" && Number.isFinite(level)) {
    const digit = level <= 1 ? 1 : Math.trunc(level);
    const entry = LOCAL_LEVELS.find(item => item.digit === digit);
    if (entry) return entry;
  }
  throw new RangeError(`Unsupported local fold level: ${String(level)}`);
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function normalizeMediaKey(text) {
  return text.replace(/\r?\n(?:\s*>\s?)+/g, " ").replace(/\s+/g, " ").trim();
}

function preserveInlineMedia(text, inlineMedia, { quotePrefix = false } = {}) {
  if (!inlineMedia?.length) return text;
  const required = new Map();
  for (const media of inlineMedia) {
    const key = normalizeMediaKey(media.markdown);
    required.set(key, (required.get(key) ?? 0) + 1);
  }
  const normText = normalizeMediaKey(text);
  const present = new Map();
  const missing = [];
  for (const media of inlineMedia) {
    const key = normalizeMediaKey(media.markdown);
    let seen = present.get(key);
    if (seen === undefined) {
      seen = countOccurrences(normText, key);
      present.set(key, seen);
    }
    if (seen < required.get(key)) {
      const clean = normalizeInlineMediaMarkdown(media.markdown);
      missing.push(quotePrefix ? prefixQuote(clean) : clean);
      present.set(key, seen + 1);
    }
  }
  if (!missing.length) return text;
  const sep = quotePrefix ? "\n>\n" : "\n";
  return text ? `${text}${sep}${missing.join("\n")}` : missing.join("\n");
}

function makeListRawEntry(rawBlock) {
  const dedented = dedentLines(rawBlock.lines);
  return {
    raw: rawBlock.raw,
    indent: rawBlock.quoted ? rawBlock.quoteIndent : dedented.indent,
    quoted: rawBlock.quoted,
    markdown: dedented.lines.join("\n"),
  };
}

function parseListItems(markdown) {
  const lines = splitLines(markdown);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const match = LIST_ITEM.exec(line);
    if (match) {
      const indent = (match[1] ?? "").length;
      const marker = match[2] ?? "-";
      const rest = line.slice(match[0].length);
      const markerRaw = matchRawBlock(lines, i);
      if (markerRaw) {
        const entry = makeListRawEntry(markerRaw);
        out.push({ indent, marker, text: "", rawBlocks: [entry] });
        i = markerRaw.nextIndex;
        continue;
      }
      out.push({ indent, marker, text: rest, rawBlocks: [] });
      i++;
      continue;
    }
    const rawBlock = matchRawBlock(lines, i);
    if (rawBlock) {
      const entry = makeListRawEntry(rawBlock);
      if (out.length) out[out.length - 1].rawBlocks.push(entry);
      else out.push({ indent: entry.indent, marker: "-", text: "", rawBlocks: [entry] });
      i = rawBlock.nextIndex;
      continue;
    }
    if (out.length && line.trim()) {
      const prev = out[out.length - 1];
      prev.text = prev.text ? `${prev.text} ${line.trim()}` : line.trim();
    }
    i++;
  }
  return out;
}

function parseQuotedBody(lines) {
  const proseLines = [];
  const rawBlocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const stripped = stripQuotePrefix(line).trim();
    if (!stripped) {
      i++;
      continue;
    }
    const rawBlock = matchRawBlock(lines, i);
    if (rawBlock) {
      rawBlocks.push({ raw: rawBlock.raw, markdown: dedentLines(rawBlock.lines).lines.join("\n") });
      i = rawBlock.nextIndex;
      continue;
    }
    proseLines.push(stripped);
    i++;
  }
  return { proseLines, rawBlocks };
}

function foldRawBlock(raw, markdown, effectiveDepth, knownCodeLines) {
  if (effectiveDepth <= 1) return markdown;
  if (raw === "table") {
    if (effectiveDepth <= 3) return markdown;
    const lines = splitLines(markdown);
    if (effectiveDepth === 4) return lines.length > 3 ? lines.slice(0, 3).join("\n") : markdown;
    return lines.length >= 2 ? lines.slice(0, 2).join("\n") : (lines[0] ?? markdown);
  }
  if (raw === "code") {
    const lines = splitLines(markdown);
    const bodyLines = knownCodeLines ?? codeBodyLines(lines);
    if (effectiveDepth <= 3 && lines.length <= 8) return markdown;
    return `\`⋯ ${bodyLines} lines of code\``;
  }
  // Math and image/embed blocks stay verbatim at every stop (D5).
  return markdown;
}

function foldRawUnit(unit, effectiveDepth) {
  const codeLines = unit.raw === "code" && unit.rawMeta?.class === "code" ? unit.rawMeta.lines : undefined;
  return foldRawBlock(unit.raw, unit.markdown, effectiveDepth, codeLines);
}

function isArtParagraph(lines) {
  return lines.length > 1 && lines.slice(0, -1).every(line => ART_ROW.test(line));
}

function isProseUnit(unit) {
  if (unit.kind === "heading" || unit.raw !== null || !PROSE_KINDS.has(unit.kind)) return false;
  if (unit.kind === "paragraph") return !isArtParagraph(splitLines(unit.markdown));
  if (unit.kind === "html") return !isHtmlComment(unit.markdown);
  if (unit.kind === "list") return parseListItems(unit.markdown).some(item => item.text.trim().length > 0);
  if (unit.kind === "quote") return parseQuotedBody(splitLines(unit.markdown)).proseLines.length > 0;
  return true;
}

function foldProseUnit(unit, effectiveDepth, ctx) {
  const keepAtHighStop = effectiveDepth <= 3 || (effectiveDepth === 4 ? ctx.isFirstInSection : ctx.isFirstInDocument);

  if (unit.kind === "html") {
    if (isHtmlComment(unit.markdown)) return effectiveDepth <= 3 ? unit.markdown : "";
    const text = keepAtHighStop ? unit.markdown : "";
    return preserveInlineMedia(text, unit.inlineMedia);
  }

  if (unit.kind === "list") {
    const all = parseListItems(unit.markdown);
    if (!all.length) return preserveInlineMedia(keepAtHighStop ? unit.markdown : "", unit.inlineMedia);
    const minIndent = Math.min(...all.map(item => item.indent));
    if (effectiveDepth <= 3) {
      const rendered = [];
      let activeContentIndent = null;
      let prevWasRaw = false;
      for (let k = 0; k < all.length; k++) {
        const item = all[k];
        const isChildDropped = effectiveDepth === 3 && item.indent > minIndent;
        if (!isChildDropped && item.text.trim()) {
          const droppedChildren = effectiveDepth === 3 && k + 1 < all.length && all[k + 1].indent > item.indent;
          const s = firstSentence(item.text);
          const emitIndent = activeContentIndent === null
            ? (item.indent <= 3 ? item.indent : 0)
            : Math.min(item.indent, activeContentIndent + 3);
          rendered.push(`${" ".repeat(emitIndent)}${item.marker} ${s.head}${s.more || droppedChildren ? MORE : ""}`);
          activeContentIndent = emitIndent + item.marker.length + 1;
          prevWasRaw = false;
        }
        for (const rb of item.rawBlocks) {
          const folded = foldRawBlock(rb.raw, rb.markdown, effectiveDepth);
          const renderedRaw = rb.quoted ? prefixQuote(folded) : folded;
          const maxIndent = activeContentIndent === null
            ? 0
            : isChildDropped
              ? activeContentIndent
              : activeContentIndent + 3;
          const targetIndent = Math.min(rb.indent, maxIndent);
          if (activeContentIndent !== null && targetIndent < activeContentIndent) activeContentIndent = null;
          if (prevWasRaw) rendered.push("");
          rendered.push(indentBlock(renderedRaw, targetIndent));
          prevWasRaw = true;
        }
      }
      return preserveInlineMedia(rendered.join("\n"), unit.inlineMedia);
    }
    const foldedRaws = [];
    for (const item of all) {
      for (const rb of item.rawBlocks) {
        const folded = foldRawBlock(rb.raw, rb.markdown, effectiveDepth);
        foldedRaws.push(rb.quoted ? prefixQuote(folded) : folded);
      }
    }
    let prose = "";
    if (keepAtHighStop) {
      const top = all.find(item => item.indent === minIndent && item.text.trim()) ?? all.find(item => item.text.trim());
      if (top) {
        const s = firstSentence(top.text);
        const more = s.more || all.length > 1 || (effectiveDepth === 4 ? ctx.hasMoreProseInSection : ctx.hasMoreProseAfter);
        prose = s.head + (more ? MORE : "");
      }
    }
    const combined = [prose, ...foldedRaws].filter(Boolean).join("\n\n");
    return preserveInlineMedia(combined, unit.inlineMedia);
  }

  if (unit.kind === "callout") {
    const lines = splitLines(unit.markdown);
    const header = lines[0] ?? "";
    const { proseLines, rawBlocks } = parseQuotedBody(lines.slice(1));
    const foldedRaws = rawBlocks.map(rb => prefixQuote(foldRawBlock(rb.raw, rb.markdown, effectiveDepth)));
    if (!keepAtHighStop) return preserveInlineMedia(foldedRaws.join("\n>\n"), unit.inlineMedia, { quotePrefix: true });
    const body = proseLines.join(" ");
    if (!body && !foldedRaws.length) return preserveInlineMedia(header, unit.inlineMedia, { quotePrefix: true });
    const parts = [];
    if (body) {
      const s = sentences(body, effectiveDepth === 2 ? 2 : 1);
      const more = s.more || (effectiveDepth === 4 && ctx.hasMoreProseInSection) || (effectiveDepth === 5 && ctx.hasMoreProseAfter);
      parts.push(`> ${s.text}${more ? MORE : ""}`);
    }
    parts.push(...foldedRaws);
    return preserveInlineMedia(`${header}\n${parts.join("\n>\n")}`, unit.inlineMedia, { quotePrefix: true });
  }

  if (unit.kind === "quote") {
    const { proseLines, rawBlocks } = parseQuotedBody(splitLines(unit.markdown));
    const foldedRaws = rawBlocks.map(rb => prefixQuote(foldRawBlock(rb.raw, rb.markdown, effectiveDepth)));
    if (!keepAtHighStop) return preserveInlineMedia(foldedRaws.join("\n>\n"), unit.inlineMedia, { quotePrefix: true });
    const raw = proseLines.join(" ");
    const parts = [];
    if (raw) {
      const s = sentences(raw, effectiveDepth === 2 ? 2 : 1);
      const more = s.more || (effectiveDepth === 4 && ctx.hasMoreProseInSection) || (effectiveDepth === 5 && ctx.hasMoreProseAfter);
      parts.push(`> ${s.text}${more ? MORE : ""}`);
    }
    parts.push(...foldedRaws);
    return preserveInlineMedia(parts.join("\n>\n"), unit.inlineMedia, { quotePrefix: true });
  }

  // Paragraph (default prose block).
  const lines = splitLines(unit.markdown);
  if (isArtParagraph(lines)) {
    return effectiveDepth <= 3 ? unit.markdown : preserveInlineMedia("", unit.inlineMedia);
  }
  if (!keepAtHighStop) return preserveInlineMedia("", unit.inlineMedia);
  const raw = lines.map(l => l.trim()).filter(Boolean).join(" ");
  const s = sentences(raw, effectiveDepth === 2 ? 2 : 1);
  const more = s.more || (effectiveDepth === 4 && ctx.hasMoreProseInSection) || (effectiveDepth === 5 && ctx.hasMoreProseAfter);
  const text = s.text + (more ? MORE : "");
  return preserveInlineMedia(text, unit.inlineMedia);
}

/** Folds a single unit at a local stop while preserving raw blocks (D5). */
export function foldUnit(unit, level, context = {}) {
  const entry = resolveLocalLevel(level);
  const depth = entry.digit;
  if (depth <= 1) return unit.markdown;
  const hasHeadings = context.hasHeadings ?? true;
  const effectiveDepth = depth === 4 && !hasHeadings ? 3 : depth;
  if (unit.kind === "heading") return effectiveDepth <= 4 ? unit.markdown : "";
  if (unit.raw !== null) return foldRawUnit(unit, effectiveDepth);
  return foldProseUnit(unit, effectiveDepth, {
    isFirstInSection: context.isFirstInSection ?? true,
    isFirstInDocument: context.isFirstInDocument ?? true,
    hasMoreProseInSection: context.hasMoreProseInSection ?? false,
    hasMoreProseAfter: context.hasMoreProseAfter ?? false,
  });
}

function stopText(value) {
  if (typeof value === "string") return value;
  if (isFoldLine(value)) return value.text;
  throw new TypeError("Monotonic stop value must be a string or valid FoldLine");
}

function cloneStopValue(value) {
  if (typeof value === "string") return value;
  if (!isFoldLine(value)) throw new TypeError("Monotonic stop value must be a string or valid FoldLine");
  if (value.by === "model") {
    return {
      by: "model",
      text: value.text,
      evidence: value.evidence.map(entry => ({ ...entry })),
    };
  }
  return { by: "author", text: value.text };
}

/**
 * Enforces D4 monotonicity per unit: Full >= Brief >= Key >= Takeaway >= Topic by word count.
 * Whenever a stop exceeds the previous stop, it falls back to that previous stop's text/line.
 */
export function enforceMonotonic(stops) {
  const out = {};
  const violations = [];
  let prevId = null;
  let prevValue = null;
  let prevWords = Infinity;

  for (const stopId of LOCAL_STOP_IDS) {
    if (!Object.prototype.hasOwnProperty.call(stops, stopId) || stops[stopId] === undefined) continue;
    const rawValue = stops[stopId];
    const count = words(stopText(rawValue));
    if (prevId !== null && count > prevWords) {
      violations.push({ stop: stopId, previous: prevId, words: count, limit: prevWords });
      out[stopId] = cloneStopValue(prevValue);
    } else {
      const cloned = cloneStopValue(rawValue);
      out[stopId] = cloned;
      prevId = stopId;
      prevValue = cloned;
      prevWords = count;
    }
  }

  return { stops: out, ok: violations.length === 0, violations };
}

/** Returns true when every present stop in the unit ladder is no longer than the stop before it. */
export function isMonotonic(stops) {
  let prevWords = Infinity;
  let monotonic = true;
  for (const stopId of LOCAL_STOP_IDS) {
    if (!Object.prototype.hasOwnProperty.call(stops, stopId) || stops[stopId] === undefined) continue;
    const count = words(stopText(stops[stopId]));
    if (count > prevWords) monotonic = false;
    prevWords = count;
  }
  return monotonic;
}

function buildContexts(units) {
  const hasHeadings = units.some(unit => unit.kind === "heading");
  const proseFlags = units.map(isProseUnit);
  const contexts = new Array(units.length);
  let seenInDoc = false;
  let seenInSection = false;

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit.kind === "heading") {
      seenInSection = false;
      contexts[i] = { hasHeadings, isFirstInSection: false, isFirstInDocument: false, hasMoreProseInSection: false, hasMoreProseAfter: false };
      continue;
    }
    if (!proseFlags[i]) {
      contexts[i] = { hasHeadings, isFirstInSection: false, isFirstInDocument: false, hasMoreProseInSection: false, hasMoreProseAfter: false };
      continue;
    }
    const isFirstInSection = !seenInSection;
    const isFirstInDocument = !seenInDoc;
    seenInSection = true;
    seenInDoc = true;

    let hasMoreProseInSection = false;
    let hasMoreProseAfter = false;
    let passedHeading = false;
    for (let j = i + 1; j < units.length; j++) {
      if (units[j].kind === "heading") {
        passedHeading = true;
        continue;
      }
      if (proseFlags[j]) {
        hasMoreProseAfter = true;
        if (!passedHeading) hasMoreProseInSection = true;
        if (hasMoreProseInSection || passedHeading) break;
      }
    }
    contexts[i] = { hasHeadings, isFirstInSection, isFirstInDocument, hasMoreProseInSection, hasMoreProseAfter };
  }
  return contexts;
}

/** Computes all five local stops in one pass with D5 raw-block preservation and D4 per-unit monotonic guard. */
export function foldDocumentLadder(markdown, options = {}) {
  const source = typeof markdown === "string" ? markdown : "";
  const units = extractUnits(source, options);
  const contexts = buildContexts(units);

  const byUnit = units.map((unit, index) => {
    const ctx = contexts[index];
    const rawStops = {
      full: foldUnit(unit, "full", ctx),
      brief: foldUnit(unit, "brief", ctx),
      key: foldUnit(unit, "key", ctx),
      takeaway: foldUnit(unit, "takeaway", ctx),
      topic: foldUnit(unit, "topic", ctx),
    };
    const guarded = enforceMonotonic(rawStops);
    const wordCounts = {
      full: words(guarded.stops.full),
      brief: words(guarded.stops.brief),
      key: words(guarded.stops.key),
      takeaway: words(guarded.stops.takeaway),
      topic: words(guarded.stops.topic),
    };
    return { unit, stops: guarded.stops, words: wordCounts, violations: guarded.violations };
  });

  const total = byUnit.reduce((sum, item) => sum + item.words.full, 0);
  const stops = {};
  for (const stopId of LOCAL_STOP_IDS) {
    let shown = 0;
    const entries = byUnit.map(item => {
      const text = item.stops[stopId];
      const count = item.words[stopId];
      shown += count;
      return {
        elementId: item.unit.elementId,
        kind: item.unit.kind,
        raw: item.unit.raw,
        rawMeta: item.unit.rawMeta,
        line: item.unit.line,
        endLine: item.unit.endLine,
        hash: item.unit.hash,
        sectionId: item.unit.sectionId,
        text,
        visible: text.length > 0,
        words: count,
      };
    });
    const text = stopId === "full"
      ? source
      : entries.filter(entry => entry.visible).map(entry => entry.text).join("\n\n");
    stops[stopId] = {
      level: stopId,
      text,
      total,
      shown,
      entries,
    };
  }

  return { units, byUnit, stops, total };
}

/** Unit-based local fold at one stop: 1/"full", 2/"brief", 3/"key", 4/"takeaway", 5/"topic". */
export function foldDocument(markdown, level, options = {}) {
  const entry = resolveLocalLevel(level);
  const ladder = foldDocumentLadder(markdown, options);
  const result = ladder.stops[entry.id];
  return {
    level: entry.id,
    units: ladder.units,
    entries: result.entries,
    text: result.text,
    total: ladder.total,
    shown: result.shown,
  };
}
