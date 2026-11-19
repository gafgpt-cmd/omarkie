import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import mark from "markdown-it-mark";
import sub from "markdown-it-sub";
import sup from "markdown-it-sup";
import { full as emoji } from "markdown-it-emoji";
import { configureMath } from "./math-syntax.mjs";
import { configureDocumentSyntax } from "./document-syntax.mjs";
export function createMarkdown(options = {}) {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: true, ...options })
    .use(taskLists, { enabled: false }).use(configureMath)
    .use(mark).use(sub).use(sup).use(emoji, { shortcuts: {} })
    .use(configureDocumentSyntax).disable("html_inline");
  const validate = md.validateLink;
  md.validateLink = url => /^file:\/\//i.test(url.trim()) || validate(url);
  return md;
}
export function setSyntaxOptions(md, options = {}) {
  for (const [rule, key] of [["mark", "highlight"], ["sub", "subscript"], ["sup", "superscript"], ["emoji", "emoji"], ["math_inline", "inlineMath"]])
    options[key] === false ? md.disable(rule, true) : md.enable(rule, true);
}
