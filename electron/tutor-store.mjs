import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createMarkdown } from "../shared/markdown.mjs";
import { markdownBlocks, plainProposal } from "../shared/markdown-blocks.mjs";
import readingCore from "../shared/reading-core.cjs";
import { readingStore } from "./reading-store.mjs";
import { decodeText, digest } from "./store.mjs";

const { readingAnchor, validPath } = readingCore(digest);
const markdown = createMarkdown();
const kinds = new Set(["note", "doubt", "answer", "evidence", "gloss"]);
const proposalSheet = "proposals";

export async function vaultRoot(folder) {
  const root = await realpath(folder);
  if (!(await stat(root)).isDirectory()) throw new Error("Choose a vault directory with --vault.");
  return root;
}

export function documentPath(name) {
  if (!validPath(name) || /[:\\]/.test(name) || name.split("/").some(part => part.startsWith(".")) || !/\.(?:md|markdown|mdown)$/i.test(name))
    throw new Error("Use a vault-relative Markdown path, without symlinks or hidden directories.");
  return name;
}

export async function readText(file, limit) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error(`Expected a regular file up to ${limit} bytes.`);
    const buffer = Buffer.allocUnsafe(info.size + 1);
    const result = await handle.read({ buffer, length: buffer.length, position: 0 });
    if (result.bytesRead !== info.size || (await handle.stat()).mtimeMs !== info.mtimeMs) throw new Error("File changed while reading it.");
    return buffer.subarray(0, result.bytesRead);
  } finally { await handle.close(); }
}

function targets(source) {
  const env = {}, blocks = markdownBlocks(markdown, source.replace(/\r\n?/g, "\n"), env), headings = [];
  let cursor = 0;
  return blocks.filter(node => node.kind !== "frontmatter" && node.source.trim()).map(({ fromLine: line, source: block, kind }) => {
    while (env.headings[cursor]?.line <= line) {
      const next = env.headings[cursor++];
      while (headings.at(-1)?.level >= next.level) headings.pop();
      headings.push(next);
    }
    const target = { block, line, headings: headings.map(heading => heading.text), quote: block.trim().slice(0, 240) };
    return { ...target, kind, hash: readingAnchor(target).hash };
  });
}

function select(blocks, prefix, quote) {
  if (prefix && !/^[a-f0-9]{6,64}$/.test(prefix)) throw new Error("Use at least six characters of a paragraph hash from doc view --blocks.");
  if (quote && !quote.trim()) throw new Error("Use a non-empty --quote.");
  const matches = blocks.filter(block => (!prefix || block.hash.startsWith(prefix)) && (!quote || block.block.includes(quote)));
  if (matches.length !== 1) throw new Error(matches.length ? "Block is ambiguous. Use a more specific quote or hash." : "Block not found. Run doc view --blocks again.");
  const { hash: _, kind: __, ...target } = matches[0];
  return quote ? { ...target, quote } : target;
}

export async function openStudy(root, name, parse = true) {
  const file = path.join(root, documentPath(name));
  if (await realpath(file) !== file) throw new Error("Markdown symlinks are not allowed.");
  const content = parse ? decodeText(await readText(file, 8 * 1024 * 1024)).content : undefined;
  const store = { folder: root, require: () => ({ path: file }) };
  return { content, blocks: parse ? targets(content) : [], request: value => readingStore(store, name, value) };
}

export async function putScrap(study, { block, quote, sheet = "notes", kind = "note", text }) {
  if (!kinds.has(kind)) throw new Error("Scrap kind must be note, doubt, answer, evidence, or gloss.");
  if (!["notes", "tutor-answers"].includes(sheet)) {
    const { entries } = await study.request({ action: "study", blocks: [] });
    if (!entries.some(entry => entry.type === "sheet" && entry.id === sheet && entry.id !== proposalSheet)) throw new Error("Choose an existing notes sheet ID.");
  }
  const anchor = select(study.blocks, block, quote);
  return study.request({ action: "put", item: { id: randomUUID(), type: "scrap", kind, sheet, body: text, anchor, folded: true, stackOf: null } });
}

export async function putProposal(study, { block, after, reason }) {
  const anchor = select(study.blocks.filter(block => block.kind === "paragraph_open"), block);
  if (anchor.block === after || !plainProposal(markdown, after)) throw new Error("Use one changed paragraph without HTML, links, or images.");
  return study.request({ action: "put", item: { id: randomUUID(), type: "scrap", kind: "proposal", sheet: proposalSheet,
    before: anchor.block, body: after, ...(reason ? { question: reason } : {}), anchor, folded: true, stackOf: null } });
}
