import { sourceLines } from "./source-lines.mjs";
import { inlineDestination } from "./link-destination.mjs";
import { decodeHTMLAttribute } from "entities";

export function upperBound(offsets, at) {
  let low = 0, high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle] <= at) low = middle + 1; else high = middle;
  }
  return low;
}
export function rangeCursor(ranges) {
  const merged = [];
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (to <= from) continue;
    const last = merged.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to); else merged.push([from, to]);
  }
  let cursor = 0;
  return at => {
    while (cursor < merged.length && merged[cursor][1] <= at) cursor++;
    return cursor < merged.length && merged[cursor][0] <= at;
  };
}
const configured = new WeakSet();
function configure(md) {
  if (configured.has(md)) return;
  configured.add(md);
  const table = { ...md.block.ruler.__rules__.find(rule => rule.name === "table") };
  md.block.ruler.at("table", (state, start, end, silent) => {
    const before = state.tokens.length, accepted = table.fn(state, start, end, silent);
    if (!accepted || silent || !state.env.sourceContext) return accepted;
    state.env.sourceTables.push([state.bMarks[start], state.bMarks[state.line] ?? state.src.length]);
    let cells = [], cell = 0, rowEnd = 0;
    for (let index = before; index < state.tokens.length; index++) {
      const token = state.tokens[index];
      if (token.type === "tr_open") {
        const line = token.map[0]; rowEnd = state.eMarks[line];
        let from = state.bMarks[line] + state.tShift[line], to = state.eMarks[line];
        while (from < to && /\s/.test(state.src[from])) from++;
        while (to > from && /\s/.test(state.src[to - 1])) to--;
        const ranges = []; let part = from;
        for (let at = from; at < to; at++) if (state.src[at] === "|" && state.src[at - 1] !== "\\") { ranges.push([part, at]); part = at + 1; }
        ranges.push([part, to]);
        if (ranges[0]?.[0] === ranges[0]?.[1]) ranges.shift();
        if (ranges.at(-1)?.[0] === ranges.at(-1)?.[1]) ranges.pop();
        cells = ranges.map(([from, to]) => {
          const start = from, end = to;
          while (from < to && /\s/.test(state.src[from])) from++;
          while (to > from && /\s/.test(state.src[to - 1])) to--;
          const positions = [];
          for (let at = from; at < to; at++) {
            positions.push(at);
            if (state.src[at] === "\\" && state.src[at + 1] === "|") { state.env.sourceRemoved.push(at); at++; }
          }
          positions.push(to);
          return { from, to, positions, cellFrom: from === to ? start + Math.min(1, end - start) : from };
        });
        cell = 0;
      } else if (token.type === "inline") {
        const current = cells[cell++];
        token.meta = { ...token.meta, sourcePositions: current?.positions || [], sourceCell: current ? [current.cellFrom, current.from === current.to ? current.cellFrom : current.to] : [rowEnd, rowEnd] };
      } else if (token.type === "tr_close") {
        for (; cell < cells.length; cell++) state.env.sourceHidden.push([cells[cell].from, cells[cell].to]);
      }
    }
    return accepted;
  }, { alt: table.alt });
  for (const name of ["backticks", "comment", "link", "image", "image_spaced"]) {
    const rule = { ...md.inline.ruler.__rules__.find(rule => rule.name === name) };
    md.inline.ruler.at(name, (state, silent) => {
      const from = state.pos, before = state.tokens.length, accepted = rule.fn(state, silent);
      if (accepted && !silent && state.env.sourceContext) {
        for (let index = before; index < state.tokens.length; index++) {
          const token = state.tokens[index];
          if (["backticks", "comment"].includes(name) && ["code_inline", "comment"].includes(token.type)) token.meta = { ...token.meta, sourceFrom: from, sourceTo: state.pos };
          if (name === "link" && token.type === "link_open" || name !== "link" && token.type === "image") {
            const image = token.type === "image", labelTo = md.helpers.parseLinkLabel(state, from + (image ? 1 : 0), !image);
            token.meta = { ...token.meta, sourceFrom: from, sourceTo: state.pos, labelFrom: from + 2, labelTo };
          }
        }
      }
      return accepted;
    }, { alt: rule.alt });
  }
  md.core.ruler.before("strip_references", "source_definitions", state => {
    if (state.env.sourceContext) state.env.sourceDefinitions = state.tokens.filter(token => token.type === "reference_definition").map(token => token.map);
  });
}
export function parserContext(md, source, initial = {}) {
  configure(md);
  const { lines, offsets: sourceOffsets } = sourceLines(source), normalized = lines.join("\n"), offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1) + line.length + 1);
  const environment = { ...initial, sourceContext: true, sourceRemoved: [], sourceHidden: [], sourceTables: [] }, tokens = md.parse(normalized, environment);
  const removed = [...new Set(environment.sourceRemoved)].sort((a, b) => a - b), removedView = removed.map((at, index) => at - index);
  const view = at => at - upperBound(removed, at - 1), chunks = []; let from = 0;
  for (const at of removed) { chunks.push(normalized.slice(from, at)); from = at + 1; }
  chunks.push(normalized.slice(from));
  const text = chunks.join(""), excluded = environment.sourceHidden.map(([from, to]) => [view(from), view(to)]), htmlRanges = [], imageUses = [], linkUses = [], htmlTags = [];
  for (const [from, to] of environment.sourceDefinitions || []) excluded.push([view(offsets[from]), view(Math.min(normalized.length, offsets[to]))]);
  for (const token of tokens) {
    if (["fence", "code_block", "frontmatter", "math_block"].includes(token.type) && token.map) excluded.push([view(offsets[token.map[0]]), view(Math.min(normalized.length, offsets[token.map[1]]))]);
    if (token.type === "html_block" && token.map) {
      const range = [view(offsets[token.map[0]]), view(Math.min(normalized.length, offsets[token.map[1]]))];
      excluded.push([...range, true]); htmlRanges.push(range);
    }
    if (!["inline", "footnote_definition"].includes(token.type)) continue;
    const content = token.meta?.source ?? token.content;
    let position;
    if (token.meta?.sourcePositions) position = at => view(token.meta.sourcePositions[at]);
    else if (token.map) {
      const inlineOffsets = [0], starts = content.split("\n").map((line, index) => {
        inlineOffsets.push(inlineOffsets.at(-1) + line.length + 1);
        const sourceLine = token.map[0] + index;
        return offsets[sourceLine] + Math.max(0, lines[sourceLine].indexOf(line));
      });
      position = at => { const line = upperBound(inlineOffsets, at) - 1; return view(starts[line] + at - inlineOffsets[line]); };
    } else continue;
    const children = token.children || md.parseInline(content, { ...environment, fragment: true })[0].children || [];
    for (const child of children) {
      if (["image", "link_open"].includes(child.type) && child.meta?.labelTo >= 0) {
        excluded.push([position(child.meta.labelTo + 1), position(child.meta.sourceTo)]);
        const image = child.type === "image", from = position(child.meta.sourceFrom), to = position(child.meta.sourceTo), labelTo = child.meta.labelTo;
        const destination = inlineDestination(md, content, labelTo + 1, child.meta.sourceTo);
        const range = destination ? [destination.from, destination.to] : [labelTo + 1, child.meta.sourceTo];
        const use = { from, to, image, alias: content.slice(child.meta.sourceFrom + (image ? 2 : 1), labelTo), url: destination?.target ?? child.attrGet(image ? "src" : "href"), destinationRange: range.map(at => position(at) - from), referenceStyle: !destination, title: child.attrGet("title") };
        linkUses.push(use);
        if (image) {
          excluded.push([position(child.meta.labelFrom), position(labelTo)]);
          imageUses.push(use);
        }
      }
      if (!["math_inline", "html_embed", "code_inline", "comment"].includes(child.type)) continue;
      const from = child.meta?.sourceFrom ?? child.meta?.from, to = child.meta?.sourceTo ?? child.meta?.to;
      const range = [position(from), position(to)];
      excluded.push([...range, child.type === "html_embed"]);
      if (child.type === "html_embed") htmlRanges.push(range);
    }
  }
  const commonHTML = rangeCursor(excluded.filter(range => !range[2])); let opaqueEnd = 0;
  for (const [from, to] of htmlRanges.sort((a, b) => a[0] - b[0])) for (const match of text.slice(from, to).matchAll(/<!--[\s\S]*?(?:-->|$)|<\/?([a-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const at = from + match.index;
    if (!match[1]) { excluded.push([at, at + match[0].length]); continue; }
    if (at < opaqueEnd || commonHTML(at)) continue;
    if (!/^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/i.test(match[1])) {
      const attributes = new Map();
      for (const attribute of match[0].matchAll(/\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gd)) {
        const name = attribute[1].toLowerCase(), range = attribute.indices[2] || attribute.indices[3] || attribute.indices[4];
        if (!attributes.has(name)) attributes.set(name, { value: range ? decodeHTMLAttribute(match[0].slice(...range)) : "", range });
      }
      htmlTags.push({ from: at, to: at + match[0].length, source: match[0], attributes }); continue;
    }
    const close = new RegExp(`</${match[1]}\\s*>`, "gi"); close.lastIndex = at + match[0].length;
    const ending = match[1].toLowerCase() === "plaintext" ? null : close.exec(text);
    opaqueEnd = ending ? ending.index + ending[0].length : text.length; excluded.push([at, opaqueEnd]);
  }
  const originalOffset = at => { const line = upperBound(offsets, at) - 1; return sourceOffsets[line] + at - offsets[line]; };
  const sourceOffset = at => originalOffset(at + upperBound(removedView, at - 1));
  const blockCursor = () => {
    const common = rangeCursor(excluded.filter(range => !range[2])), markdown = rangeCursor(excluded.filter(range => range[2]));
    return (at, html = false) => {
      if (common(at) || !html && markdown(at)) return true;
      let before = at; while (text[before - 1] === "\\") before--;
      return (at - before) % 2 !== 0;
    };
  };
  const lineNumber = at => upperBound(offsets, at + upperBound(removedView, at - 1));
  for (const token of tokens) if (token.meta?.sourceCell) token.meta.sourceCell = token.meta.sourceCell.map(originalOffset);
  return { text, environment, tokens, excluded, imageUses, linkUses, htmlTags, sourceOffset, lineNumber, blockCursor, viewOffset: at => view(offsets[at]), tableCursor: () => rangeCursor(environment.sourceTables.map(([from, to]) => [view(from), view(to)])) };
}
