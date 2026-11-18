import { createMarkdown, setSyntaxOptions } from "./markdown.mjs";
import { frontmatter, properties, makeReady } from "./frontmatter.mjs";
import { decodeHTMLAttribute } from "entities";
import { headingSlug as slug } from "./wiki-syntax.mjs";
export { headingSlug as slug } from "./wiki-syntax.mjs";
const md = createMarkdown();
const key = value => value.normalize("NFC").toLowerCase();
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
export function references(text, options = {}) {
  setSyntaxOptions(md, options);
  const lines = text.split("\n"), offsets = [0], excluded = [];
  for (const line of lines) offsets.push(offsets.at(-1) + line.length + 1);
  try { const fm = frontmatter(text); if (fm.start > fm.bom.length) excluded.push([0, text.length - fm.body.length]); } catch { excluded.push([0, text.indexOf("\n\n") < 0 ? text.length : text.indexOf("\n\n")]); }
  const environment = {}, tokens = md.parse(text, environment);
  for (const token of tokens) {
    if (["fence", "code_block", "math_block"].includes(token.type) && token.map) excluded.push([offsets[token.map[0]], offsets[token.map[1]]]);
    if (!["inline", "footnote_definition"].includes(token.type) || !token.map) continue;
    const content = token.meta?.source ?? token.content, inlineLines = content.split("\n");
    const children = token.children || md.parseInline(content, { ...environment, fragment: true })[0].children || [];
    const offset = at => {
      const before = content.slice(0, at).split("\n"), line = token.map[0] + before.length - 1;
      return offsets[line] + Math.max(0, lines[line].indexOf(inlineLines[before.length - 1])) + before.at(-1).length;
    };
    for (const child of children) if (["math_inline", "html_embed"].includes(child.type)) excluded.push([offset(child.meta.from), offset(child.meta.to), child.type === "html_embed"]);
  }
  for (const match of text.matchAll(/^ {0,3}\[(?!\^)[^\]\n]+\]:[^\n]*/gm)) excluded.push([match.index, match.index + match[0].length]);
  for (const match of text.matchAll(/<!--[^]*?(?:-->|$)|(`+)(?!`)([^]*?[^`])\1(?!`)/g)) excluded.push([match.index, match.index + match[0].length]);
  const blocked = (at, html = false) => excluded.some(([from, to, onlyHTML]) => at >= from && at < to && (!onlyHTML || !html)) || /(?:^|[^\\])(?:\\\\)*\\$/.test(text.slice(0, at));
  const result = [];
  const add = ({ target, image, wiki = false, alias, destinationRange, referenceStyle = false, from, to, html = false }) => {
    const size = image && wiki ? /^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/i.exec(alias || "") : null;
    let width = size?.[1] || "", height = size?.[2] || "";
    const attributes = image && !html ? /^\{([^{}\n]*\b(?:width|height)\s*=[^{}\n]*)\}/.exec(text.slice(to)) : null;
    const dimensions = html ? text.slice(from, to) : attributes?.[1] || "";
    for (const [, name, value] of dimensions.matchAll(/\b(width|height)\s*=\s*["']?(\d+(?:\.\d+)?(?:px|%)?)["']?/g)) { if (name === "width") width = value.replace(/px$/, ""); else height = value.replace(/px$/, ""); }
    if (attributes) to += attributes[0].length;
    result.push({ target, image, wiki, alias, destinationRange, referenceStyle, dimensionAlias: !!size, width, height, from, to, line: text.slice(0, from).split("\n").length, source: text.slice(from, to) });
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
  const literalRanges = result.map(ref => [ref.from, ref.to]), suffixRanges = [], state = new md.inline.State(text, md, environment, []);
  for (const match of text.matchAll(/!?\[/g)) {
    const from = match.index, image = match[0] === "![", open = from + (image ? 1 : 0);
    if (blocked(from) || [...literalRanges, ...suffixRanges].some(([start, end]) => from >= start && from < end)) continue;
    const end = md.helpers.parseLinkLabel(state, open, !image);
    if (end < 0) continue;
    const alias = text.slice(open + 1, end), tail = text.slice(end + 1);
    const inline = /^\((<[^>\n]*>|(?:\\.|[^\s)])*(?:\([^)]*\)[^\s)]*)*|[^\n()<>"']*?\.[a-z0-9]{1,8})(?:\s+["'][^"']*["'])?\)/id.exec(tail);
    if (inline) {
      const angled = inline[1].startsWith("<"), range = inline.indices[1];
      const destinationRange = [end + 1 - from + range[0] + (angled ? 1 : 0), end + 1 - from + range[1] - (angled ? 1 : 0)];
      const target = md.utils.unescapeAll(text.slice(from + destinationRange[0], from + destinationRange[1]));
      if (target) {
        const to = end + 1 + inline[0].length;
        add({ target, image, alias, destinationRange, from, to });
        suffixRanges.push([end + 1, to]);
      }
    } else if (!tail.startsWith("(")) {
      const reference = /^[ \t]*\[([^\]\n]*)\]/.exec(tail), id = md.utils.normalizeReference(reference?.[1] || alias), definition = environment.references?.[id];
      if (definition) {
        const to = end + 1 + (reference?.[0].length || 0);
        add({ target: definition.href, image, alias, destinationRange: [end + 1 - from, to - from], referenceStyle: true, from, to });
        suffixRanges.push([end + 1, to]);
      }
    }
  }
  result.sort((a, b) => a.from - b.from);
  const tags = [];
  for (const match of text.matchAll(/(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) {
    const at = match.index + match[1].length;
    if (!blocked(at) && !result.some(ref => at >= ref.from && at < ref.to)) tags.push({ tag: match[2], line: text.slice(0, at).split("\n").length });
  }
  const headings = (environment.headings || []).filter(heading => !blocked(offsets[heading.line - 1])).map(({ text, id, line }) => ({ title: text, id, line }));
  return { references: result, tags, headings };
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
    byPath.set(key(relative), [...(byPath.get(key(relative)) || []), file]);
    for (const name of new Set([relative.split("/").at(-1), relative.split("/").at(-1).replace(/\.(md|markdown|mdown)$/i, ""), ...(file.aliases || [])])) byName.set(key(name), [...(byName.get(key(name)) || []), file]);
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
  const portable = relative => "notes/" + relative.replaceAll("\\", "/").replace(/(^|\/)(index|log)\.md$/i, "$1_$2.md").replace(/\.(markdown|mdown)$/i, ".md");
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
        edits.push({ from: ref.from + from, to: ref.from + to, replacement: ref.referenceStyle ? `(${url})` : md.utils.escapeHtml(url) });
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
