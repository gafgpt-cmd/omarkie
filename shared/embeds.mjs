// Note and heading embeds (`![[Note]]`, `![[Note#Heading]]`, `![[#Heading]]`): resolution, section text and
// freshness. Pure apart from the `read` callback, so both hosts and the unit tests share it.
import { frontmatter } from "./frontmatter.mjs";
import { normalizePath, referenceIndex, referenceParts, references } from "./references.mjs";
import { sectionRange } from "./glass-cards.mjs";

export const embedLimits = { depth: 4, bytes: 512 * 1024, read: 64 };
const media = /\.(?:png|jpe?g|gif|webp|avif|svg|mp3|wav|m4a|ogg|mp4|webm)$/i;
const otherFile = /\.(?:pdf|base|canvas)$/i;
export const noteEmbed = target => {
  const path = String(target ?? "").split("#")[0].trim();
  return !media.test(path) && !otherFile.test(path);
};
export const baseEmbed = target => /\.base$/i.test(String(target ?? "").split("#")[0].trim());
export const audioEmbed = target => /\.(?:mp3|wav|m4a|ogg)$/i.test(String(target ?? "").split("#")[0].trim());
const folderOf = relative => relative.split("/").slice(0, -1).join("/");
const scheme = /^[a-z][a-z\d+.-]*:|^[/\\]{2}/i;

function relativeTo(folder, vaultPath) {
  const from = folder ? folder.split("/") : [], to = vaultPath.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;
  return [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/");
}

// Relative links and images in an embedded section point from the target note's folder; rewrite them so they
// resolve the same way from the note that shows the embed. Basename wiki links resolve vault-wide and stay.
export function rebaseLinks(markdown, targetRelative, fromRelative, exists = () => true) {
  const targetFolder = folderOf(targetRelative), fromFolder = folderOf(fromRelative);
  if (targetFolder === fromFolder) return markdown;
  let output = markdown;
  for (const ref of references(markdown).references.sort((a, b) => b.from - a.from)) {
    if (ref.wiki) {
      const parsed = /^(!?\[\[\s*)([^\]|#]*)/.exec(ref.source), path = parsed?.[2].trim();
      if (!path || !path.includes("/") || scheme.test(path) || path.startsWith("/")) continue;
      const vault = normalizePath(`${targetFolder}/${path}`);
      if (vault === null || (!ref.image || noteEmbed(path)) && !exists(vault)) continue;
      const at = ref.from + parsed[1].length;
      output = output.slice(0, at) + relativeTo(fromFolder, vault) + output.slice(at + parsed[2].trimEnd().length);
      continue;
    }
    if (!ref.destinationRange) continue;
    const [start, end] = ref.destinationRange.map(offset => ref.from + offset), written = output.slice(start, end);
    const bracketed = written.startsWith("<") && written.endsWith(">"), inner = bracketed ? written.slice(1, -1) : written;
    const cut = inner.search(/[?#]/), path = cut < 0 ? inner : inner.slice(0, cut), rest = cut < 0 ? "" : inner.slice(cut);
    if (!path || scheme.test(path) || path.startsWith("/")) continue;
    let decoded;
    try { decoded = decodeURIComponent(path); } catch { continue; }
    const vault = normalizePath(`${targetFolder}/${decoded}`);
    if (vault === null) continue;
    const rebased = relativeTo(fromFolder, vault).split("/").map(encodeURIComponent).join("/") + rest;
    output = output.slice(0, start) + (bracketed ? `<${rebased}>` : rebased) + output.slice(end);
  }
  return output;
}

function body(content) {
  try { return frontmatter(content).body; } catch { return content; }
}

// `read(relatives)` returns `[{ relative, content }]` for vault notes; drafts of open notes win over disk text.
export function createEmbedSource({ read }) {
  let files = new Map(), index = null;
  const drafts = new Map(), cache = new Map(), loading = new Map();
  const known = path => ["", ".md", ".markdown", ".mdown"].some(extension => files.has(path + extension) || drafts.has(path + extension));

  function resolver() {
    index ??= referenceIndex({ notes: [...new Set([...files.keys(), ...drafts.keys()])].map(relative => ({ relative, content: "" })), assets: [] });
    return index;
  }
  async function text(relative) {
    if (drafts.has(relative)) return drafts.get(relative);
    const modified = files.get(relative)?.modified;
    const cached = cache.get(relative);
    if (cached && cached.modified === modified) return cached.content;
    const key = `${relative}\n${modified}`;
    if (!loading.has(key)) loading.set(key, Promise.resolve(read([relative])).then(notes => {
      const note = notes?.find(item => item.relative === relative);
      if (typeof note?.content === "string" && files.get(relative)?.modified === modified) cache.set(relative, { modified, content: note.content });
      return typeof note?.content === "string" ? note.content : null;
    }, () => null).finally(() => loading.delete(key)));
    return loading.get(key);
  }

  return {
    // Vault files and open drafts with their stamps; Bases list notes from here.
    files() {
      return [...new Set([...files.keys(), ...drafts.keys()])].map(relative => ({ relative, modified: files.get(relative)?.modified ?? "", created: files.get(relative)?.created ?? "", draft: drafts.has(relative) }));
    },
    // Text of many files at once: drafts, then unchanged cache entries, then host reads in batches. Unreadable files are left out.
    async notes(relatives) {
      const fresh = relative => drafts.has(relative) || cache.get(relative)?.modified === files.get(relative)?.modified && cache.has(relative);
      const missing = relatives.filter(relative => !fresh(relative));
      for (let at = 0; at < missing.length; at += embedLimits.read) {
        const batch = missing.slice(at, at + embedLimits.read), stamps = new Map(batch.map(relative => [relative, files.get(relative)?.modified]));
        let loaded = [];
        try { loaded = await read(batch) ?? []; } catch {}
        for (const note of loaded) if (stamps.has(note?.relative) && typeof note.content === "string" && files.get(note.relative)?.modified === stamps.get(note.relative)) cache.set(note.relative, { modified: stamps.get(note.relative), content: note.content });
      }
      return relatives.flatMap(relative => drafts.has(relative) ? [{ relative, content: drafts.get(relative) }] : fresh(relative) ? [{ relative, content: cache.get(relative).content }] : []);
    },
    // Returns the notes whose text may have changed and whether the set of paths changed.
    setFiles(list) {
      const next = new Map(list.filter(file => file.isDirectory !== "true").map(file => [file.relative.replaceAll("\\", "/"), { modified: file.modified ?? "", created: file.created ?? "" }]));
      const changed = [];
      for (const [relative, file] of next) if (files.get(relative)?.modified !== file.modified) changed.push(relative);
      for (const relative of files.keys()) if (!next.has(relative)) changed.push(relative);
      const paths = next.size !== files.size || [...next.keys()].some(relative => !files.has(relative));
      files = next;
      for (const relative of changed) cache.delete(relative);
      if (paths) index = null;
      return { changed, paths };
    },
    setDrafts(list) {
      const next = new Map(list.filter(draft => draft.relative).map(draft => [draft.relative, draft.content]));
      const changed = [];
      for (const [relative, content] of next) if (drafts.get(relative) !== content) changed.push(relative);
      for (const relative of drafts.keys()) if (!next.has(relative)) changed.push(relative);
      const paths = [...next.keys()].some(relative => !drafts.has(relative) && !files.has(relative)) || [...drafts.keys()].some(relative => !next.has(relative) && !files.has(relative));
      drafts.clear();
      for (const [relative, content] of next) drafts.set(relative, content);
      if (paths) index = null;
      return { changed, paths };
    },
    // A `![[file.base#View]]` target: the vault file it names and the view after `#`.
    resolveBase(from, raw) {
      const parts = referenceParts(String(raw ?? ""), true), base = from.base ?? from.relative ?? "", view = parts.fragment.trim();
      if (!base) return { state: "missing", view };
      const resolved = resolver().resolve({ relative: base }, parts.target.trim(), true);
      if (resolved.state === "ambiguous") return { state: "ambiguous", view, candidates: resolved.candidates.map(file => file.relative).sort() };
      return resolved.state === "resolved" ? { state: "ok", view, relative: resolved.candidates[0].relative } : { state: "missing", view };
    },
    // `from` is the note whose text holds the embed: `{ relative, content }`; relative is empty outside a vault. Nested embeds
    // pass `base`, the note on screen: shown sections have their links rebased to it, so paths resolve from there.
    // `chain` holds `note#heading` keys already on screen above this embed; `budget.bytes` sums every section shown.
    async section(from, raw, chain = [], budget = { bytes: 0 }) {
      const parts = referenceParts(String(raw ?? ""), true), fragment = parts.fragment.trim(), target = parts.target.trim();
      const base = from.base ?? from.relative ?? "";
      let relative = from.relative || "", content = from.content;
      if (target) {
        if (!base) return { state: "missing" };
        const resolved = resolver().resolve({ relative: base }, target, true);
        if (resolved.state === "ambiguous") return { state: "ambiguous", candidates: resolved.candidates.map(file => file.relative).sort() };
        if (resolved.state !== "resolved") return { state: "missing" };
        relative = resolved.candidates[0].relative;
        content = await text(relative);
        if (content === null) return { state: "missing", relative };
      }
      const key = `${relative}#${fragment.normalize("NFC").toLowerCase()}`, name = relative.split("/").at(-1)?.replace(/\.(?:md|markdown|mdown)$/i, "") || "";
      if (chain.includes(key)) return { state: "cycle", relative, title: name };
      if (chain.length > embedLimits.depth) return { state: "too-deep", relative, title: name };
      if (fragment.startsWith("^")) return { state: "unsupported-block", relative, title: name };
      let markdown, line = 1, title = name;
      if (fragment) {
        const range = sectionRange(content, fragment.split("#").map(part => part.trim()).filter(Boolean));
        if (!range) return { state: "missing-heading", relative, title: name };
        if (range.matches > 1) return { state: "ambiguous-heading", relative, title: range.heading, matches: range.matches };
        markdown = range.lines.slice(range.start, range.end).join("\n").trim();
        line = range.start + 1; title = range.heading;
      } else markdown = body(content).trim();
      budget.bytes += markdown.length;
      if (budget.bytes > embedLimits.bytes) return { state: "too-large", relative, title };
      if (relative && base) markdown = rebaseLinks(markdown, relative, base, known);
      return { state: "ok", relative, line, title, markdown, content, chain: [...chain, key] };
    },
  };
}
