import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import mark from "markdown-it-mark";
import sub from "markdown-it-sub";
import sup from "markdown-it-sup";
import emojiDefs from "markdown-it-emoji/lib/data/full.mjs";
import emojiHtml from "markdown-it-emoji/lib/render.mjs";
import emojiReplace from "markdown-it-emoji/lib/replace.mjs";
import { configureMath } from "./math-syntax.mjs";
import { configureDocumentSyntax } from "./document-syntax.mjs";
export function createMarkdown(options = {}) {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: true, ...options })
    .use(taskLists, { enabled: false }).use(configureMath)
    .use(mark).use(sub).use(sup).use(emoji)
    .use(configureDocumentSyntax).disable("html_inline");
  const validate = md.validateLink;
  md.validateLink = url => /^file:\/\//i.test(url.trim()) || validate(url);
  return md;
}
export function setSyntaxOptions(md, options = {}) {
  for (const [rule, key] of [["mark", "highlight"], ["sub", "subscript"], ["sup", "superscript"], ["emoji", "emoji"], ["math_inline", "inlineMath"]])
    options[key] === false ? md.disable(rule, true) : md.enable(rule, true);
}
// markdown-it-emoji `full`, no shortcuts, with a linear scanner instead of its ~1900-name alternation
// regex (compiling that cost ~50 ms on each launch's first parse). Names are [\w+-]+, so at each colon
// the only candidate runs to the next colon; same leftmost, non-overlapping matches as the plugin.
function* emojiCodes(text) {
  const code = /:([\w+-]+):/g;
  for (let match; (match = code.exec(text));) {
    if (Object.hasOwn(emojiDefs, match[1])) yield match;
    else code.lastIndex--; // the closing colon may open the next code
  }
}
function emoji(md) {
  const scan = { test: text => !emojiCodes(text).next().done };
  const replace = { [Symbol.replace](text, found) { for (const match of emojiCodes(text)) found(match[0], match.index, text); return text; } };
  md.renderer.rules.emoji = emojiHtml;
  md.core.ruler.after("linkify", "emoji", emojiReplace(md, emojiDefs, {}, scan, replace));
}
