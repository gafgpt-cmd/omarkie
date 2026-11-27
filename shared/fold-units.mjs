// Fold units from the shared element model, raw-block preservation (D5), and monotonic guard (D4).
// Pure ESM (Node + browser): no disk, network, or Node-only built-ins.

import { markdownElements, tableCells } from "./element-model.mjs";
import { levelOf } from "./fold-format.mjs";
import { LOCAL_LEVELS, firstSentence, sentences, words } from "./fold-text.mjs";

const LOCAL_STOP_IDS = Object.freeze(LOCAL_LEVELS.map(entry => entry.id));
const SUB_ELEMENT_KINDS = new Set(["list-item", "table-cell"]);
const SKIP_UNIT_KINDS = new Set(["divider"]);
const PROSE_KINDS = new Set(["paragraph", "list", "quote", "callout", "html"]);
const FENCE_OPEN = /^\s*(?:(`{3,})[^`]*$|(~{3,}))/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+/;
const ART_ROW = /^(`+).*\1 {2}$/;
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

/** Extracts ordered, non-overlapping top-level Fold units from `markdownElements()`. */
export function extractUnits(markdown, options = {}) {
  if (typeof markdown !== "string" || !markdown) return [];
  const elements = markdownElements(markdown, options);
  const inlineMediaByParent = new Map();
  const candidates = [];

  for (const element of elements) {
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
      inlineMedia: inlineMediaByParent.get(element.id) ?? [],
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

function preserveInlineMedia(text, inlineMedia) {
  if (!inlineMedia?.length) return text;
  const required = new Map();
  for (const media of inlineMedia) required.set(media.markdown, (required.get(media.markdown) ?? 0) + 1);
  const appended = new Map();
  const missing = [];
  for (const media of inlineMedia) {
    const seen = countOccurrences(text, media.markdown) + (appended.get(media.markdown) ?? 0);
    if (seen < required.get(media.markdown)) {
      missing.push(media.markdown);
      appended.set(media.markdown, (appended.get(media.markdown) ?? 0) + 1);
    }
  }
  if (!missing.length) return text;
  return text ? `${text}\n${missing.join("\n")}` : missing.join("\n");
}

function parseListItems(markdown) {
  const lines = splitLines(markdown);
  const out = [];
  let inFence = null;
  for (const line of lines) {
    if (inFence) {
      if (fenceClose(line, inFence)) inFence = null;
      continue;
    }
    const mark = fenceMark(line);
    if (mark) {
      inFence = mark;
      continue;
    }
    const match = LIST_ITEM.exec(line);
    if (match) out.push({ indent: (match[1] ?? "").length, marker: match[2] ?? "-", text: line.slice(match[0].length) });
    else if (out.length && line.trim()) out[out.length - 1].text += " " + line.trim();
  }
  return out;
}

function foldRawUnit(unit, depth) {
  if (depth <= 1) return unit.markdown;
  if (unit.raw === "table") {
    if (depth <= 3) return unit.markdown;
    const lines = splitLines(unit.markdown);
    if (depth === 4) return lines.length > 3 ? lines.slice(0, 3).join("\n") : unit.markdown;
    return lines.length >= 2 ? lines.slice(0, 2).join("\n") : (lines[0] ?? unit.markdown);
  }
  if (unit.raw === "code") {
    const lines = splitLines(unit.markdown);
    const bodyLines = unit.rawMeta?.class === "code" ? unit.rawMeta.lines : codeBodyLines(lines);
    if (depth <= 3 && lines.length <= 8) return unit.markdown;
    return `\`⋯ ${bodyLines} lines of code\``;
  }
  // Math and image/embed blocks stay verbatim at every stop (D5).
  return unit.markdown;
}

function isArtParagraph(lines) {
  return lines.length > 1 && lines.slice(0, -1).every(line => ART_ROW.test(line));
}

function foldProseUnit(unit, depth, ctx) {
  if (depth <= 1) return unit.markdown;
  const effectiveDepth = depth === 4 && !ctx.hasHeadings ? 3 : depth;
  const keepAtHighStop = effectiveDepth <= 3 || (effectiveDepth === 4 ? ctx.isFirstInSection : ctx.isFirstInDocument);

  if (unit.kind === "html") {
    return keepAtHighStop ? unit.markdown : "";
  }

  if (unit.kind === "list") {
    const all = parseListItems(unit.markdown);
    if (!all.length) return keepAtHighStop ? unit.markdown : "";
    const minIndent = Math.min(...all.map(item => item.indent));
    if (effectiveDepth <= 3) {
      const rendered = [];
      for (let k = 0; k < all.length; k++) {
        const item = all[k];
        if (effectiveDepth === 3 && item.indent > minIndent) continue;
        const droppedChildren = effectiveDepth === 3 && k + 1 < all.length && all[k + 1].indent > item.indent;
        const s = firstSentence(item.text);
        rendered.push(`${" ".repeat(item.indent)}${item.marker} ${s.head}${s.more || droppedChildren ? MORE : ""}`);
      }
      return rendered.join("\n");
    }
    if (!keepAtHighStop) return "";
    const top = all.find(item => item.indent === minIndent) ?? all[0];
    const s = firstSentence(top.text);
    const more = s.more || all.length > 1 || (effectiveDepth === 4 ? ctx.hasMoreProseInSection : ctx.hasMoreProseAfter);
    return s.head + (more ? MORE : "");
  }

  if (unit.kind === "callout") {
    if (!keepAtHighStop) return "";
    const lines = splitLines(unit.markdown);
    const header = lines[0] ?? "";
    const body = lines.slice(1).map(l => l.replace(/^\s*>\s?/, "").trim()).filter(Boolean).join(" ");
    if (!body) return header;
    const s = sentences(body, effectiveDepth === 2 ? 2 : 1);
    const more = s.more || (effectiveDepth === 4 && ctx.hasMoreProseInSection) || (effectiveDepth === 5 && ctx.hasMoreProseAfter);
    return `${header}\n> ${s.text}${more ? MORE : ""}`;
  }

  if (unit.kind === "quote") {
    if (!keepAtHighStop) return "";
    const raw = splitLines(unit.markdown).map(l => l.replace(/^\s*>\s?/, "").trim()).filter(Boolean).join(" ");
    if (!raw) return unit.markdown;
    const s = sentences(raw, effectiveDepth === 2 ? 2 : 1);
    const more = s.more || (effectiveDepth === 4 && ctx.hasMoreProseInSection) || (effectiveDepth === 5 && ctx.hasMoreProseAfter);
    return `> ${s.text}${more ? MORE : ""}`;
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
  if (unit.kind === "heading") return depth <= 4 ? unit.markdown : "";
  if (unit.raw !== null) return foldRawUnit(unit, depth);
  return foldProseUnit(unit, depth, {
    hasHeadings: context.hasHeadings ?? false,
    isFirstInSection: context.isFirstInSection ?? true,
    isFirstInDocument: context.isFirstInDocument ?? true,
    hasMoreProseInSection: context.hasMoreProseInSection ?? false,
    hasMoreProseAfter: context.hasMoreProseAfter ?? false,
  });
}

function stopText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.text === "string") return value.text;
  throw new TypeError("Monotonic stop value must be a string or FoldLine");
}

function cloneStopValue(value) {
  if (typeof value === "string") return value;
  if (value.by === "model") {
    return {
      by: "model",
      text: value.text,
      evidence: Array.isArray(value.evidence) ? value.evidence.map(entry => ({ ...entry })) : [],
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
  for (const stopId of LOCAL_STOP_IDS) {
    if (!Object.prototype.hasOwnProperty.call(stops, stopId) || stops[stopId] === undefined) continue;
    const count = words(stopText(stops[stopId]));
    if (count > prevWords) return false;
    prevWords = count;
  }
  return true;
}

function buildContexts(units) {
  const hasHeadings = units.some(unit => unit.kind === "heading");
  const isProse = unit => unit.kind !== "heading" && unit.raw === null && PROSE_KINDS.has(unit.kind);
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
    if (!isProse(unit)) {
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
      if (isProse(units[j])) {
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
  const total = words(source);
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

  const stops = {};
  for (const stopId of LOCAL_STOP_IDS) {
    const entries = byUnit.map(item => {
      const text = item.stops[stopId];
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
        words: item.words[stopId],
      };
    });
    const text = stopId === "full"
      ? source
      : entries.filter(entry => entry.visible).map(entry => entry.text).join("\n\n");
    stops[stopId] = {
      level: stopId,
      text,
      total,
      shown: stopId === "full" ? total : words(text),
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
