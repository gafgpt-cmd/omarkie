// Deterministic Markdown fold: local stops from the author's own sentences, no model call.
// Adapted from TextFold (Apache-2.0, Xia Chen) `plugins/pi-textfold/extension/fold.ts` at 7dedb2d.
// Changed: Omarkie local stop ids from `fold-format.mjs`, ES/EN sentence cutting (abbreviations,
// inverted punctuation, decimals, units), Unicode word accounting, synthetic marker exclusion,
// frontmatter skipping, and dropped-block ellipsis accounting. See third-party/textfold/PORTED.md.

import { LEVELS as FORMAT_LEVELS, levelOf } from "./fold-format.mjs";

export const LOCAL_LEVELS = Object.freeze(FORMAT_LEVELS.filter(entry => entry.local));

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const ART_ROW = /^(`+).*\1 {2}$/;
const FM_OPEN = /^\uFEFF?---[ \t]*$/;
const FM_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
const FM_LINE = /^(?:[ \t]*|[ \t]*#.*|[ \t]+.*|[ \t]*-[ \t]*.*|[A-Za-z0-9_.-]+[ \t]*:.*)$/;

// A GFM table starts at a row with a pipe followed by its delimiter row, with or without leading pipes, and
// may come straight after a paragraph. The delimiter needs a pipe, or `Title` over `---` would be one.
const tableAt = (lines, i) =>
  (lines[i] ?? "").includes("|") && (lines[i + 1] ?? "").includes("|") && DELIM.test(lines[i + 1] ?? "");

function fenceClose(line, mark) {
  const trimmed = line.trim();
  if (trimmed.length < mark.length || !trimmed.startsWith(mark)) return false;
  const ch = mark[0];
  for (let i = mark.length; i < trimmed.length; i++) if (trimmed[i] !== ch) return false;
  return true;
}

function frontmatterEnd(lines) {
  if (!FM_OPEN.test(lines[0] ?? "")) return -1;
  for (let j = 1; j < lines.length; j++) {
    const line = lines[j] ?? "";
    if (FM_CLOSE.test(line)) return j;
    if (!FM_LINE.test(line)) return -1;
  }
  return -1;
}

/** A markdown text as blocks: frontmatter, headings, code, lists, tables, quotes, paragraphs, rules, art. */
export function blocks(md) {
  const out = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  const fmEnd = frontmatterEnd(lines);
  if (fmEnd > 0) {
    out.push({ kind: "frontmatter", lines: lines.slice(0, fmEnd + 1) });
    i = fmEnd + 1;
  }
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1] ?? "```";
      const buf = [line];
      i++;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        buf.push(l);
        i++;
        if (fenceClose(l, mark)) break;
      }
      out.push({ kind: "code", lines: buf });
      continue;
    }
    if (HEADING.test(line)) {
      out.push({ kind: "heading", lines: [line] });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ kind: "rule", lines: [line] });
      i++;
      continue;
    }
    const kind = /^\s*\|/.test(line) || tableAt(lines, i) ? "table" : /^\s*>/.test(line) ? "quote" : ITEM.test(line) ? "list" : "para";
    const buf = [line];
    i++;
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (!l.trim() || FENCE.test(l) || HEADING.test(l)) break;
      if (kind === "para" && (ITEM.test(l) || tableAt(lines, i))) break;
      buf.push(l);
      i++;
    }
    const art = kind === "para" && buf.length > 1 && buf.slice(0, -1).every(l => ART_ROW.test(l));
    out.push({ kind: art ? "art" : kind, lines: buf });
  }
  return out;
}

// Always non-breaking introducers and titles (EN + ES); `etc.` still breaks before `¿`/`¡`.
const ABBREV_ALWAYS = /(?:^|[^\p{L}\p{N}_])(?:e\.\s*g|i\.\s*e|p\.\s*ej|ej|etc|vs|cf|et\s+al|approx|aprox|Dr|Dra|Dres|Dras|Mr|Mrs|Ms|Sr|Sra|Sres|Sras|Srta|Prof|Profa|Lic|Ing|Dña|Ud|Uds|Vd|Vds|St|Fig|Figs|Eq|Ec|Núm|Pág|Págs|Apdo|Av|Avda|Tel|Supl|Obs|Máx|Mín)\.$/iu;
// Multi-part spaced abbreviations where the first dot precedes the rest (`p. ej.`, `e. g.`, `i. e.`).
const MULTIPART_START = /(?:^|[^\p{L}\p{N}_])([pei])\.$/iu;
const MULTIPART_TAIL = { p: /^ej\./i, e: /^g\./i, i: /^e\./i };
// Reference/number introducers that stay mid-sentence only before a digit or `#` (avoids splitting `"No."` or `"art."`).
const ABBREV_BEFORE_NUM = /(?:^|[^\p{L}\p{N}_])(?:No|Art|Arts|Cap|Tab|Sec|Vol|Vols|Ref|Refs|p|pp|v|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|ene|abr|ago|dic)\.$/iu;
// Multi-char units, compound units (`mg/kg/h.`), or clinical route/time abbreviations mid-sentence before lowercase/digit/symbol.
const UNIT_MULTI = /(?:^|[^\p{L}\p{N}_])(?:(?:mg|mcg|µg|μg|ug|ng|pg|kg|mL|ml|dL|dl|µL|μL|uL|mmol|mol|µmol|μmol|mEq|meq|mOsm|mosm|UI|IU|mmHg|cmH2O|kPa|bpm|lpm|rpm|cc|kcal|cal|cm|mm|µm|μm|nm|km|hr|hrs|min|seg|sec|sem|mes|Hz|kHz|MHz|mV|kV|mA|mSv|Sv|Gy|Bq)(?:\/(?:mg|mcg|µg|μg|ug|kg|g|mL|ml|dL|dl|L|l|mmol|mEq|UI|IU|U|min|h|hr|s|d|m2|m²))*|(?:g|L|l|U|m|h|s|d)\/(?:kg|g|mL|ml|dL|dl|L|l|min|h|hr|s|d|m2|m²)(?:\/(?:min|h|hr|s|d|kg|m2|m²))*|i\.v|i\.m|s\.c|v\.o|p\.o|i\.n|s\.l|q\.d|b\.i\.d|t\.i\.d|q\.i\.d|p\.r\.n|c\.s\.p|a\.m|p\.m|d\.s|h\.s|stat|sol|comp|amp|cáps|caps|iny|adm|diag|tto)\.$/iu;
// Single-letter SI/clinical units (`1,2 g.`, `6 h.`, `10 s.`, `5 m.`) preceded by a number, mid-sentence before lowercase/digit/symbol.
const UNIT_SINGLE = /\p{N}\s*(?:g|L|l|U|m|h|s|d|a|V|A|W|J)\.$/u;

const AFTER_STOP = /([*_)"'”’\]»]*)(\s+|$|(?=[¿¡]))/y;
const AFTER_CJK_STOP = /[*_)"'”’\]»」』】）]*/y;
const CONTINUES_MID = /^[\p{Ll}\d(/±+\-<>≤≥=]/u;

function findClosingBackticks(text, start, runLen) {
  let i = start;
  while (i < text.length) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let len = 1;
    while (text[i + len] === "`") len++;
    if (len === runLen) return i + len;
    i += len;
  }
  return -1;
}

function hasClosingMarkAhead(text, from, target) {
  for (let j = from; j < text.length; j++) {
    const ch = text[j];
    if (ch === "`") {
      let run = 1;
      while (text[j + run] === "`") run++;
      const end = findClosingBackticks(text, j + run, run);
      if (end !== -1) {
        j = end - 1;
        continue;
      }
    }
    if (ch === target) return true;
  }
  return false;
}

function isNonBreakingDot(text, i, tail) {
  if (!tail) return false;
  // Ellipsis (`...`) mid-sentence before a lowercase continuation.
  if (i > 0 && text[i - 1] === "." && /^\p{Ll}/u.test(tail)) return true;
  const headSlice = text.slice(Math.max(0, i - 24), i + 1);
  // Multi-part spaced abbreviations like `p. ej.`, `e. g.`, `i. e.`.
  const multi = MULTIPART_START.exec(headSlice);
  if (multi && MULTIPART_TAIL[multi[1].toLowerCase()]?.test(tail)) return true;
  // `¿`/`¡` unambiguously opens a new Spanish sentence after `etc.`.
  if (ABBREV_ALWAYS.test(headSlice)) {
    if ((tail[0] === "¿" || tail[0] === "¡") && /(?:^|[^\p{L}\p{N}_])etc\.$/iu.test(headSlice)) return false;
    return true;
  }
  if (ABBREV_BEFORE_NUM.test(headSlice) && /^[#\d]/.test(tail)) return true;
  if (CONTINUES_MID.test(tail) && (UNIT_MULTI.test(headSlice) || UNIT_SINGLE.test(headSlice))) return true;
  return false;
}

/** The text's first sentence, and whether more follows it. Inline code is never cut; a CJK stop
 *  ends a sentence without a space; ES/EN abbreviations, `¿¡` spans, decimals, and mid-sentence units stay intact. */
export function firstSentence(text) {
  let openQ = 0;
  let openE = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      const end = findClosingBackticks(text, i + run, run);
      if (end !== -1) {
        i = end - 1;
        continue;
      }
      i += run - 1;
      continue;
    }
    if (c === "¿") { openQ++; continue; }
    if (c === "¡") { openE++; continue; }
    if ("。！？".includes(c)) {
      AFTER_CJK_STOP.lastIndex = i + 1;
      const wrap = AFTER_CJK_STOP.exec(text);
      return cut(text, i + 1 + (wrap ? wrap[0].length : 0));
    }
    if (c === "?" && openQ > 0) openQ--;
    if (c === "!" && openE > 0) openE--;
    if (!".!?".includes(c)) continue;
    AFTER_STOP.lastIndex = i + 1;
    const after = AFTER_STOP.exec(text);
    if (!after) continue;
    const cutAt = i + 1 + after[1].length;
    if (c === ".") {
      if (openQ > 0 && hasClosingMarkAhead(text, cutAt, "?")) continue;
      if (openE > 0 && hasClosingMarkAhead(text, cutAt, "!")) continue;
      const tail = text.slice(cutAt, cutAt + 16).trimStart();
      if (isNonBreakingDot(text, i, tail)) continue;
    }
    return cut(text, cutAt);
  }
  return { head: text.trim(), more: false, rest: "" };
}

function cut(text, at) {
  const rest = text.slice(at).trim();
  return { head: balance(text.slice(0, at).trim()), more: rest.length > 0, rest };
}

/** Closes an unclosed bold span left open by a cut, ignoring inline code spans. */
function balance(s) {
  let bold = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "`") {
      let run = 1;
      while (s[i + run] === "`") run++;
      const end = findClosingBackticks(s, i + run, run);
      i = end !== -1 ? end - 1 : i + run - 1;
      continue;
    }
    if (s[i] === "*" && s[i + 1] === "*") {
      bold++;
      i++;
    }
  }
  return bold % 2 ? s + "**" : s;
}

/** Joins the first `n` sentences of `text` and reports whether more text remains. */
export function sentences(text, n) {
  let rest = text.trim();
  const out = [];
  let more = false;
  for (let k = 0; k < n && rest; k++) {
    const s = firstSentence(rest);
    out.push(s.head);
    rest = s.rest;
    more = s.more;
  }
  return { text: out.join(" "), more };
}

/** A list's items: the marker, the indent and the item's text (its continuation lines joined). */
function items(b) {
  const out = [];
  for (const line of b.lines) {
    const m = ITEM.exec(line);
    if (m) out.push({ indent: (m[1] ?? "").length, marker: m[2] ?? "-", text: line.slice(m[0].length) });
    else if (out.length) out[out.length - 1].text += " " + line.trim();
  }
  return out;
}

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g;
const NON_CJK_WORD = /(?:\p{N}+(?:[.,]\p{N}+)*|\p{L})[\p{L}\p{N}'’_-]*(?:[/.][\p{L}\p{N}][\p{L}\p{N}'’_-]*)*/gu;
const FENCED_CODE = /(?:```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
const CODE_FOLD_PLACEHOLDER = /`⋯ \d+ lines of code`/g;

function stripForWordCount(md) {
  let body = md.includes("\r") ? md.replace(/\r\n?/g, "\n") : md;
  if (body.startsWith("---") || body.startsWith("\uFEFF---")) {
    const lines = body.split("\n");
    const fmEnd = frontmatterEnd(lines);
    if (fmEnd > 0) body = lines.slice(fmEnd + 1).join("\n");
  }
  return body.replace(FENCED_CODE, " ").replace(CODE_FOLD_PLACEHOLDER, " ");
}

function wordMetrics(md) {
  const plain = stripForWordCount(md);
  const cjk = (plain.match(CJK_CHAR) ?? []).length;
  const nonCjk = cjk ? plain.replace(CJK_CHAR, " ") : plain;
  const latin = (nonCjk.match(NON_CJK_WORD) ?? []).length;
  return { cjk, latin, total: cjk + latin };
}

export function words(md) {
  return wordMetrics(md).total;
}

/** Below this many words a text is read whole: there is nothing in "Done, the tests pass." to fold. */
export const MIN_WORDS = 80;
/** A fold must hide at least this share of a text, or the reader would not see that anything changed. */
export const MIN_HIDDEN = 0.25;

/** Words as reading effort: a Chinese or Japanese character reads as about 1/1.6 of an English word. */
function reading(md) {
  const { cjk, latin } = wordMetrics(md);
  return latin + cjk / 1.6;
}

/** Whether a text is worth showing folded: long enough to need it, and the fold hides enough of it. */
export function worthFolding(md, folded) {
  const all = reading(md);
  return all >= MIN_WORDS && 1 - reading(folded) / all >= MIN_HIDDEN;
}

const MORE = " …";

function resolveDepth(level) {
  if (typeof level === "string") {
    const entry = levelOf(level);
    if (!entry || !entry.local) throw new RangeError(`Unsupported local fold level: ${level}`);
    return entry.digit;
  }
  if (typeof level === "number" && Number.isFinite(level)) {
    if (level <= 1) return 1;
    if (level <= 5) return Math.trunc(level);
  }
  throw new RangeError(`Unsupported local fold level: ${String(level)}`);
}

const isContentBlock = b => b.kind !== "rule" && b.kind !== "frontmatter";

function hasMoreInSection(bs, index) {
  for (let j = index + 1; j < bs.length; j++) {
    if (bs[j].kind === "heading") return false;
    if (isContentBlock(bs[j])) return true;
  }
  return false;
}

function hasMoreAfter(bs, index) {
  for (let j = index + 1; j < bs.length; j++) {
    if (isContentBlock(bs[j])) return true;
  }
  return false;
}

function codeLineCount(lines) {
  const fence = FENCE.exec(lines[0] ?? "");
  const mark = fence?.[1] ?? "```";
  const closed = lines.length > 1 && fenceClose(lines[lines.length - 1] ?? "", mark);
  return Math.max(0, lines.length - (closed ? 2 : 1));
}

/** The text at a local stop: 1/"full", 2/"brief", 3/"key", 4/"takeaway", 5/"topic". */
export function fold(md, level) {
  let depth = resolveDepth(level);
  const total = words(md);
  if (depth <= 1) return { text: md, total, shown: total };
  const bs = blocks(md);
  // Takeaway/Outline is a text's headings and the first sentence under each. A text without
  // headings has no sections to outline, so it reads as Key/Points: the first sentence of each
  // paragraph, nothing dropped. Without this it fell to the text's first sentence (Topic/Gist).
  if (depth === 4 && !bs.some(b => b.kind === "heading")) depth = 3;
  const out = [];
  let underHeading = true;
  let first = true;
  for (let idx = 0; idx < bs.length; idx++) {
    const b = bs[idx];
    if (depth === 5 && !first) break;
    switch (b.kind) {
      case "frontmatter":
      case "rule":
        break;
      case "art":
        if (depth <= 3) out.push(b.lines.join("\n"));
        break;
      case "heading":
        if (depth <= 4) out.push(b.lines[0] ?? "");
        underHeading = true;
        break;
      case "code":
      case "table":
        if (depth > 3) break;
        if (b.kind === "table" || b.lines.length <= 8) out.push(b.lines.join("\n"));
        else out.push(`\`⋯ ${codeLineCount(b.lines)} lines of code\``);
        break;
      case "list": {
        const all = items(b);
        const minIndent = all.length ? Math.min(...all.map(it => it.indent)) : 0;
        if (depth <= 3) {
          const rendered = [];
          for (let k = 0; k < all.length; k++) {
            const it = all[k];
            if (depth === 3 && it.indent > minIndent) continue;
            const droppedChildren = depth === 3 && k + 1 < all.length && all[k + 1].indent > it.indent;
            const s = firstSentence(it.text);
            rendered.push(`${" ".repeat(it.indent)}${it.marker} ${s.head}${s.more || droppedChildren ? MORE : ""}`);
          }
          if (rendered.length) out.push(rendered.join("\n"));
        } else if (underHeading || (depth === 5 && first)) {
          const top = all.filter(it => it.indent === minIndent);
          const it = top[0];
          if (it) {
            const s = firstSentence(it.text);
            const more = s.more || all.length > 1 || (depth === 4 ? hasMoreInSection(bs, idx) : hasMoreAfter(bs, idx));
            out.push(s.head + (more ? MORE : ""));
          }
          underHeading = false;
          first = false;
        }
        break;
      }
      case "quote":
      case "para": {
        const raw = b.lines.map(l => (b.kind === "quote" ? l.replace(/^\s*>\s?/, "") : l).trim()).join(" ");
        if (depth >= 4 && !underHeading) break;
        const s = sentences(raw, depth === 2 ? 2 : 1);
        const more = s.more || (depth === 4 && hasMoreInSection(bs, idx)) || (depth === 5 && hasMoreAfter(bs, idx));
        out.push((b.kind === "quote" ? "> " : "") + s.text + (more ? MORE : ""));
        underHeading = false;
        first = false;
        break;
      }
    }
  }
  const text = out.join("\n\n");
  return { text, total, shown: words(text) };
}
