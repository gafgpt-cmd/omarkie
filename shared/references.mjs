import { createMarkdown, setSyntaxOptions } from "./markdown.mjs";
import { inlineDestination } from "./link-destination.mjs";
import { sourceLines } from "./source-lines.mjs";
import { frontmatter, properties, makeReady } from "./frontmatter.mjs";
import { decodeHTMLAttribute } from "entities";
import { headingSlug as slug } from "./wiki-syntax.mjs";
export { headingSlug as slug } from "./wiki-syntax.mjs";
const md = createMarkdown();
md.core.ruler.disable("strip_references");
const key = value => value.normalize("NFC").toLowerCase();
function upperBound(offsets, at) {
  let low = 0, high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle] <= at) low = middle + 1; else high = middle;
  }
  return low;
}
function rangeCursor(ranges) {
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
export function normalizePath(value) {
  if (/[\0]|^[a-z][a-z\d+.-]*:|^[/\\]{2}/i.test(value)) return null;
  const parts = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}
export function referenceParts(value, wiki = false) {
  const [target, ...fragment] = value.split("#");
  if (wiki) return { target, fragment: fragment.join("#") };
  try { return { target: decodeURIComponent(target), fragment: decodeURIComponent(fragment.join("#")) }; }
  catch { return null; }
}
export function references(source, options = {}) {
  setSyntaxOptions(md, options);
  const { lines, offsets: sourceOffsets } = sourceLines(source), text = lines.join("\n"), offsets = [0], excluded = [], htmlRanges = [];
  for (const line of lines) offsets.push(offsets.at(-1) + line.length + 1);
  const sourceOffset = at => { const line = upperBound(offsets, at) - 1; return sourceOffsets[line] + at - offsets[line]; };
  try { const fm = frontmatter(text); if (fm.start > fm.bom.length) excluded.push([0, text.length - fm.body.length]); } catch { excluded.push([0, text.indexOf("\n\n") < 0 ? text.length : text.indexOf("\n\n")]); }
  const environment = {}, tokens = md.parse(text, environment);
  for (const token of tokens) {
    if (["fence", "code_block", "math_block", "reference_definition"].includes(token.type) && token.map) excluded.push([offsets[token.map[0]], offsets[token.map[1]]]);
    if (token.type === "html_block" && token.map) {
      const range = [offsets[token.map[0]], Math.min(text.length, offsets[token.map[1]])];
      excluded.push([...range, true]); htmlRanges.push(range);
    }
    if (!["inline", "footnote_definition"].includes(token.type) || !token.map) continue;
    const content = token.meta?.source ?? token.content, inlineLines = content.split("\n");
    const children = token.children || md.parseInline(content, { ...environment, fragment: true })[0].children || [];
    const inlineOffsets = [0], sourceStarts = inlineLines.map((line, index) => {
      inlineOffsets.push(inlineOffsets.at(-1) + line.length + 1);
      const sourceLine = token.map[0] + index;
      return offsets[sourceLine] + Math.max(0, lines[sourceLine].indexOf(line));
    });
    const offset = at => {
      const line = upperBound(inlineOffsets, at) - 1;
      return sourceStarts[line] + at - inlineOffsets[line];
    };
    for (const child of children) if (["math_inline", "html_embed"].includes(child.type)) {
      const range = [offset(child.meta.from), offset(child.meta.to)];
      excluded.push([...range, child.type === "html_embed"]);
      if (child.type === "html_embed") htmlRanges.push(range);
    }
  }
  for (const match of text.matchAll(/<!--[^]*?(?:-->|$)|(`+)(?!`)([^]*?[^`])\1(?!`)/g)) excluded.push([match.index, match.index + match[0].length]);
  const commonHTML = rangeCursor(excluded.filter(range => !range[2]));
  let opaqueEnd = 0;
  for (const [from, to] of htmlRanges.sort((a, b) => a[0] - b[0])) {
    for (const match of text.slice(from, to).matchAll(/<!--[\s\S]*?(?:-->|$)|<([a-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
      const at = from + match.index;
      if (!match[1] || at < opaqueEnd || commonHTML(at) || !/^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/i.test(match[1])) continue;
      const close = new RegExp(`</${match[1]}\\s*>`, "gi"); close.lastIndex = at + match[0].length;
      const ending = match[1].toLowerCase() === "plaintext" ? null : close.exec(text);
      opaqueEnd = ending ? ending.index + ending[0].length : text.length;
      excluded.push([at, opaqueEnd]);
    }
  }
  const blockCursor = () => {
    const common = rangeCursor(excluded.filter(range => !range[2])), markdown = rangeCursor(excluded.filter(range => range[2]));
    return (at, html = false) => {
      if (common(at) || !html && markdown(at)) return true;
      let before = at;
      while (text[before - 1] === "\\") before--;
      return (at - before) % 2 !== 0;
    };
  };
  let blocked = blockCursor();
  const lineNumber = at => upperBound(offsets, at);
  const result = [];
  const add = ({ target, image, wiki = false, alias, destinationRange, referenceStyle = false, title, from, to, html = false }) => {
    const size = image && wiki ? /^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/i.exec(alias || "") : null;
    let width = size?.[1] || "", height = size?.[2] || "";
    const attributes = image && !html ? /^\{([^{}\n]*\b(?:width|height)\s*=[^{}\n]*)\}/.exec(text.slice(to)) : null;
    const dimensions = html ? text.slice(from, to) : attributes?.[1] || "";
    for (const [, name, value] of dimensions.matchAll(/\b(width|height)\s*=\s*["']?(\d+(?:\.\d+)?(?:px|%)?)["']?/g)) { if (name === "width") width = value.replace(/px$/, ""); else height = value.replace(/px$/, ""); }
    if (attributes) to += attributes[0].length;
    result.push({ target, image, wiki, alias, destinationRange, referenceStyle, title, dimensionAlias: !!size, width, height, from, to, line: lineNumber(from), source: text.slice(from, to) });
  };
  const expression = /(!?)\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]*))?\]\]|<(?:a|img|video|audio|source)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  for (const match of text.matchAll(expression)) {
    const wiki = match[2] !== undefined, html = !wiki, anchor = html && /^<a\b/i.test(match[0]);
    if (blocked(match.index, html)) continue;
    const attribute = html ? (anchor ? /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/id : /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/id).exec(match[0]) : null;
    const destinationRange = attribute?.indices[1] || attribute?.indices[2] || attribute?.indices[3];
    const target = html ? destinationRange && decodeHTMLAttribute(match[0].slice(...destinationRange)) : match[2].trim();
    if (!target) continue;
    const image = html ? !anchor : !!match[1], alias = html ? /\balt\s*=\s*["']([^"']*)["']/i.exec(match[0])?.[1] : match[3]?.trim() || undefined;
    add({ target, image, wiki, alias, destinationRange, from: match.index, to: match.index + match[0].length, html });
  }
  const literal = rangeCursor(result.map(ref => [ref.from, ref.to])), suffixRanges = [], markdownSuffixes = [], state = new md.inline.State(text, md, environment, []);
  blocked = blockCursor();
  for (const match of text.matchAll(/!?\[/g)) {
    const from = match.index, image = match[0] === "![", open = from + (image ? 1 : 0);
    while (suffixRanges.length && from >= suffixRanges.at(-1)[1]) suffixRanges.pop();
    if (blocked(from) || literal(from) || suffixRanges.length && from >= suffixRanges.at(-1)[0]) continue;
    const end = md.helpers.parseLinkLabel(state, open, !image);
    if (end < 0) continue;
    const alias = text.slice(open + 1, end), tail = text.slice(end + 1);
    const inline = inlineDestination(md, text, end + 1);
    if (inline) {
      if (inline.target) {
        const destinationRange = [inline.from - from, inline.to - from];
        add({ target: inline.target, image, alias, destinationRange, from, to: inline.end });
        const range = [end + 1, inline.end]; suffixRanges.push(range); markdownSuffixes.push(range);
      }
    } else if (!tail.startsWith("(")) {
      const labelEnd = text[end + 1] === "[" ? md.helpers.parseLinkLabel(state, end + 1) : -1;
      const label = labelEnd >= 0 ? text.slice(end + 2, labelEnd) : "", id = md.utils.normalizeReference(label || alias), definition = environment.references?.[id];
      if (definition) {
        const to = labelEnd >= 0 ? labelEnd + 1 : end + 1;
        add({ target: definition.href, image, alias, destinationRange: [end + 1 - from, to - from], referenceStyle: true, title: definition.title, from, to });
        const range = [end + 1, to]; suffixRanges.push(range); markdownSuffixes.push(range);
      }
    }
  }
  result.sort((a, b) => a.from - b.from);
  const inSuffix = rangeCursor(markdownSuffixes);
  const visible = result.filter(ref => !inSuffix(ref.from));
  const tags = [], referenced = rangeCursor(visible.map(ref => [ref.from, ref.to]));
  blocked = blockCursor();
  for (const match of text.matchAll(/(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) {
    const at = match.index + match[1].length;
    if (!blocked(at) && !referenced(at)) tags.push({ tag: match[2], line: lineNumber(at) });
  }
  blocked = blockCursor();
  const headings = (environment.headings || []).filter(heading => !blocked(offsets[heading.line - 1])).map(({ text, id, line }) => ({ title: text, id, line }));
  const mapped = visible.map(ref => {
    const from = sourceOffset(ref.from), to = sourceOffset(ref.to);
    const destinationRange = ref.destinationRange?.map(at => sourceOffset(ref.from + at) - from);
    return { ...ref, from, to, destinationRange, source: source.slice(from, to) };
  });
  return { references: mapped, tags, headings };
}
export function referenceIndex(snapshot, options = {}) {
  const notes = snapshot.notes.map(note => {
    let metadata = {}; try { metadata = properties(note.content); } catch {}
    const parsed = references(note.content, options);
    const tags = new Set([...parsed.tags.map(item => item.tag), ...(Array.isArray(metadata.tags) ? metadata.tags.filter(tag => typeof tag === "string") : [])]);
    return { ...note, ...parsed, tags: [...tags], aliases: [metadata.aliases, metadata.alias].flat().filter(alias => typeof alias === "string") };
  });
  const files = [...notes, ...snapshot.assets], byPath = new Map(), byName = new Map();
  for (const file of files) {
    const relative = file.relative.replaceAll("\\", "/");
    const pathKey = key(relative);
    if (!byPath.has(pathKey)) byPath.set(pathKey, []);
    byPath.get(pathKey).push(file);
    for (const name of new Set([relative.split("/").at(-1), relative.split("/").at(-1).replace(/\.(md|markdown|mdown)$/i, ""), ...(file.aliases || [])])) {
      const nameKey = key(name);
      if (!byName.has(nameKey)) byName.set(nameKey, []);
      byName.get(nameKey).push(file);
    }
  }
  function resolve(from, raw, wiki = true) {
    if (/^(?:https?:|mailto:|data:)/i.test(raw)) return { state: "external", candidates: [] };
    const parts = referenceParts(raw, wiki);
    if (!parts) return { state: "invalid", candidates: [] };
    if (!parts.target) {
      const heading = parts.fragment ? from.headings?.find(heading => heading.id === parts.fragment || key(heading.title) === key(parts.fragment) || heading.id === slug(parts.fragment)) : undefined;
      return { state: parts.fragment && !heading ? "missing-heading" : "resolved", candidates: [from], fragment: heading?.id || parts.fragment, line: heading?.line };
    }
    if (/^[a-z][a-z\d+.-]*:|^[/\\]{2}/i.test(parts.target)) return { state: "escape", candidates: [] };
    const parent = from.relative.replaceAll("\\", "/").split("/").slice(0, -1).join("/");
    const rooted = parts.target.startsWith("/"), local = normalizePath((rooted ? "" : parent ? parent + "/" : "") + parts.target), root = normalizePath(parts.target);
    if (local === null || root === null && rooted) return { state: "escape", candidates: [] };
    const find = path => byPath.get(key(path)) || (wiki || !/\.[^/]+$/.test(path) ? [".md", ".markdown", ".mdown"].flatMap(ext => byPath.get(key(path + ext)) || []) : []);
    let candidates = find(local);
    if (!candidates.length && wiki && root !== null) candidates = find(root);
    if (!candidates.length && wiki && !parts.target.includes("/") && !parts.target.includes("\\")) candidates = byName.get(key(parts.target)) || [];
    candidates = [...new Set(candidates)];
    const state = candidates.length > 1 ? "ambiguous" : candidates.length ? "resolved" : "missing";
    const heading = candidates.length === 1 && parts.fragment ? candidates[0].headings?.find(heading => heading.id === parts.fragment || key(heading.title) === key(parts.fragment) || heading.id === slug(parts.fragment)) : undefined;
    return { state: state === "resolved" && parts.fragment && !heading ? "missing-heading" : state, candidates, fragment: heading?.id || parts.fragment, line: heading?.line };
  }
  const edges = notes.flatMap(note => note.references.map(ref => ({ source: note, ref, ...resolve(note, ref.target, ref.wiki) })));
  const referencedPaths = new Set();
  for (const edge of edges) for (const file of edge.candidates) referencedPaths.add(file.relative);
  return { notes, assets: snapshot.assets, truncated: snapshot.truncated, resolve, edges, referencedPaths,
    backlinks: target => edges.filter(edge => !edge.ref.image && edge.candidates.length === 1 && edge.candidates[0].relative === target.relative),
    tags: query => notes.filter(note => note.tags.some(tag => key(tag) === key(query))),
    broken: edges.filter(edge => !["resolved", "external"].includes(edge.state)),
    unused: snapshot.assets.filter(asset => !referencedPaths.has(asset.relative)),
  };
}
export function bundlePlan(snapshot, date = new Date().toISOString().slice(0, 10), options = {}) {
  const index = referenceIndex(snapshot, options);
  if (snapshot.truncated) throw new Error("清点不完整，已拒绝导出。");
  const portable = relative => "notes/" + relative.replaceAll("\\", "/").replace(/\.(md|markdown|mdown)$/i, ".md").replace(/(^|\/)(index|log)\.md$/i, "$1_$2.md");
  const destinations = index.notes.map(note => portable(note.relative));
  if (new Set(destinations.map(key)).size !== destinations.length) throw new Error("压缩包目标路径重复。");
  const encodePart = value => encodeURIComponent(value).replace(/[!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
  const encode = value => value.split("/").map(encodePart).join("/");
  const notes = index.notes.map(note => {
    let content = note.content;
    const edits = [];
    for (const ref of note.references) {
      const resolved = index.resolve(note, ref.target, ref.wiki);
      if (resolved.state === "external") continue;
      if (resolved.state !== "resolved") throw new Error(`${note.relative}:${ref.line}: ${resolved.state}: ${ref.target}`);
      const target = resolved.candidates[0], destination = target.content !== undefined ? portable(target.relative) : "assets/" + target.relative.replaceAll("\\", "/");
      const depth = portable(note.relative).split("/").length - 1, fragment = resolved.fragment ? "#" + encodePart(resolved.fragment) : "", url = referenceParts(ref.target, ref.wiki)?.target === "" ? fragment : encode("../".repeat(depth) + destination) + fragment;
      if (ref.destinationRange) {
        const [from, to] = ref.destinationRange;
        edits.push({ from: ref.from + from, to: ref.from + to, replacement: ref.referenceStyle ? `(${url}${ref.title ? ` "${ref.title.replace(/["\\]/g, "\\$&").replace(/&/g, "&amp;")}"` : ""})` : md.utils.escapeHtml(url) });
        continue;
      }
      let label = ref.dimensionAlias ? target.relative.split("/").at(-1) : ref.alias || ref.target;
      label = !ref.image ? label.replace(/[!-/:-@[-`{-~]/g, "\\$&") : label.replace(/[\[\]\\]/g, "\\$&");
      const dimensions = ref.image && (ref.width || ref.height) ? `{${[ref.width && `width=${ref.width}`, ref.height && `height=${ref.height}`].filter(Boolean).join(" ")}}` : "";
      const media = ref.image ? /\.(?:mp3|wav|m4a|ogg)$/i.test(target.relative) ? "audio" : /\.(?:mp4|webm)$/i.test(target.relative) ? "video" : "" : "";
      const replacement = media ? `<${media} controls preload="metadata" src="${md.utils.escapeHtml(url)}"${ref.width ? ` width="${md.utils.escapeHtml(ref.width)}"` : ""}></${media}>` : `${ref.image ? "!" : ""}[${label}](${url})${dimensions}`;
      edits.push({ from: ref.from, to: ref.to, replacement });
    }
    for (const edit of edits.sort((a, b) => b.from - a.from)) content = content.slice(0, edit.from) + edit.replacement + content.slice(edit.to);
    content = makeReady(content, note.relative);
    return { token: note.token, relative: portable(note.relative), content };
  });
  const assets = index.assets.filter(asset => index.referencedPaths.has(asset.relative)).map(asset => ({ source: asset.relative, relative: "assets/" + asset.relative.replaceAll("\\", "/") }));
  return { notes, assets, index: `---\nokf_version: "0.2"\n---\n\n# Knowledge bundle\n\n${notes.map(note => `* [${note.relative.replace(/[\[\]\\]/g, "\\$&")}](${encode(note.relative)})`).join("\n")}\n`, log: `# Directory Update Log\n\n## ${date}\n* **Creation**: Copied ${notes.length} concepts and ${assets.length} referenced assets.\n` };
}
