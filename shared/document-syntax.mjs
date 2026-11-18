import { wikiSyntax, headingText, headingSlug } from "./wiki-syntax.mjs";
import { inlineDestination } from "./link-destination.mjs";
export function configureDocumentSyntax(md) {
  md.use(wikiSyntax);
  md.inline.ruler.before("image", "wiki_embed", (state, silent) => {
    if (!state.src.startsWith("![[", state.pos)) return false;
    const match = /^!\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]*))?\]\]/.exec(state.src.slice(state.pos, state.posMax));
    if (!match || !match[1].trim()) return false;
    if (!silent) {
      const token = state.push("wiki_embed", "img", 0), size = /^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/i.exec(match[2] || "");
      token.markup = match[0]; token.content = !size && match[2]?.trim() ? match[2].trim() : match[1].trim();
      token.meta = { target: match[1].trim(), width: size?.[1], height: size?.[2] };
    }
    state.pos += match[0].length; return true;
  });
  md.inline.ruler.after("image", "image_spaced", (state, silent) => {
    if (!state.src.startsWith("![", state.pos)) return false;
    const labelEnd = state.md.helpers.parseLinkLabel(state, state.pos + 1, false);
    if (labelEnd < 0 || state.src[labelEnd + 1] !== "(") return false;
    const destination = inlineDestination(state.md, state.src, labelEnd + 1, state.posMax);
    if (!destination?.spaced) return false;
    const href = state.md.normalizeLink(destination.target);
    if (!state.md.validateLink(href)) return false;
    if (!silent) {
      const content = state.src.slice(state.pos + 2, labelEnd), children = [];
      state.md.inline.parse(content, state.md, state.env, children);
      const token = state.push("image", "img", 0);
      token.attrs = [["src", href], ["alt", ""], ...(destination.title !== undefined ? [["title", destination.title]] : [])];
      token.children = children; token.content = content;
    }
    state.pos = destination.end; return true;
  });
  md.core.ruler.after("inline", "image_attributes", state => {
    for (const block of state.tokens) for (const [index, image] of (block.children || []).entries()) {
      const next = block.children[index + 1];
      if (!["image", "wiki_embed"].includes(image.type) || next?.type !== "text") continue;
      const match = /^\{([^{}\n]*\b(?:width|height)\s*=[^{}\n]*)\}/.exec(next.content);
      if (!match) continue;
      for (const [, key, value] of match[1].matchAll(/\b(width|height)\s*=\s*["']?(\d+(?:\.\d+)?(?:px|%)?)["']?/g)) {
        if (image.type === "wiki_embed") image.meta = { ...image.meta, [key]: value.replace(/px$/, "") }; else image.attrSet(key, value.replace(/px$/, ""));
      }
      image.meta = { ...image.meta, attributes: match[0] }; next.content = next.content.slice(match[0].length);
    }
  });
  md.inline.ruler.before("emphasis", "html_break", (state, silent) => {
    const match = /^<br\s*\/?>/i.exec(state.src.slice(state.pos));
    if (!match) return false;
    if (!silent) { const token = state.push("html_break", "br", 0); token.markup = match[0]; }
    state.pos += match[0].length; return true;
  });
  md.core.ruler.after("inline", "alert_blocks", state => {
    for (let i = 0; i < state.tokens.length - 2; i++) {
      const token = state.tokens[i], inline = state.tokens[i + 2];
      if (token.type !== "blockquote_open" || inline.type !== "inline") continue;
      const match = /^\[!([\w-]+)\]([+-]?)/.exec(inline.content); if (!match) continue;
      token.attrJoin("class", `markdown-alert markdown-alert-${match[1].toLowerCase()}`);
      token.attrSet("data-alert", match[1]); token.attrSet("data-callout-fold", match[2]);
      const marker = inline.children?.[0];
      if (marker?.type === "text") marker.meta = { ...marker.meta, callout: { type: match[1], length: match[0].length, custom: !!inline.content.slice(match[0].length).split("\n")[0].trim() } };
    }
  });
  md.block.ruler.before("hr", "frontmatter", (state, startLine, endLine, silent) => {
    if (startLine !== 0 || !/^(?:\uFEFF)?---[ \t]*$/.test(state.src.slice(state.bMarks[0], state.eMarks[0]))) return false;
    let end = 1;
    for (; end < endLine; end++) if (/^(?:---|\.\.\.)[ \t]*$/.test(state.src.slice(state.bMarks[end], state.eMarks[end]))) break;
    if (end === endLine) return false;
    if (silent) return true;
    const token = state.push("frontmatter", "pre", 0); token.block = true; token.map = [0, end + 1]; token.content = state.src.slice(state.bMarks[1], state.bMarks[end]);
    state.line = end + 1; return true;
  });
  md.inline.ruler.before("emphasis", "comment", (state, silent) => {
    if (!state.src.startsWith("<!--", state.pos)) return false;
    const end = state.src.indexOf("-->", state.pos + 4); if (end < 0) return false;
    if (!silent) { const token = state.push("comment", "span", 0); token.markup = state.src.slice(state.pos, end + 3); token.content = state.src.slice(state.pos + 4, end); }
    state.pos = end + 3; return true;
  });
  md.block.ruler.before("reference", "footnote_definition", (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const match = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(state.src.slice(start, state.eMarks[startLine]));
    if (!match || state.sCount[startLine] >= 4) return false;
    if (silent) return true;
    let end = startLine + 1, body = match[2];
    while (end < endLine) {
      const next = state.src.slice(state.bMarks[end], state.eMarks[end]);
      if (/^(?: {4}|\t)/.test(next)) body += "\n" + next.replace(/^(?: {4}|\t)/, "");
      else if (!next.trim() && end + 1 < endLine && state.sCount[end + 1] >= 4) body += "\n";
      else break;
      end++;
    }
    const token = state.push("footnote_definition", "aside", 0);
    token.content = body; token.meta = { id: match[1] }; token.map = [startLine, end]; token.block = true;
    state.line = end; return true;
  }, { alt: ["paragraph", "reference"] });
  md.inline.ruler.before("link", "footnote_ref", (state, silent) => {
    const match = /^\[\^([^\]\s]+)\]/.exec(state.src.slice(state.pos)), definitions = state.env.footnoteDefinitions;
    if (!match || !definitions?.[match[1]]) return false;
    if (!silent) {
      const token = state.push("footnote_ref", "sup", 0);
      token.content = match[1]; token.markup = match[0];
      token.meta = { definition: definitions[match[1]], number: state.env.footnoteNumbers?.[match[1]] || match[1] };
    }
    state.pos += match[0].length; return true;
  });
  md.block.ruler.before("paragraph", "toc", (state, startLine, _endLine, silent) => {
    const raw = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
    if (!/^\[toc\]$/i.test(raw.trim())) return false;
    if (silent) return true;
    const token = state.push("toc", "nav", 0); token.block = true; token.map = [startLine, startLine + 1]; token.content = raw;
    state.line = startLine + 1; return true;
  }, { alt: ["paragraph"] });
  md.core.ruler.before("inline", "document_definitions", state => {
    const env = state.env, definitions = env.fragment ? { ...env.footnoteDefinitions } : {};
    for (const token of state.tokens) {
      if (token.type === "inline") token.meta = { ...token.meta, source: token.content };
      if (token.type === "footnote_definition") {
        const id = String(token.meta?.id); definitions[id] = { id, text: token.content, line: (token.map?.[0] || 0) + 1 + (env.lineOffset || 0) };
      }
    }
    state.env.footnoteDefinitions = definitions;
    if (!env.fragment) state.env.footnoteNumbers = {};
  });
  md.core.ruler.after("inline", "footnote_numbers", state => {
    const env = state.env, numbers = env.footnoteNumbers || {};
    for (const token of state.tokens) for (const ref of token.children || []) if (ref.type === "footnote_ref") {
      if (!numbers[ref.content]) numbers[ref.content] = Object.keys(numbers).length + 1;
      ref.meta = { ...ref.meta, number: numbers[ref.content] };
    }
    state.env.footnoteNumbers = numbers;
  });
  md.core.ruler.after("inline", "heading_targets", state => {
    const env = state.env, headings = [], used = new Map();
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type !== "heading_open" || !token.map) continue;
      const text = headingText(state.tokens[i + 1]?.children || []);
      const line = token.map[0] + 1 + (env.lineOffset || 0), base = headingSlug(text), count = used.get(base) || 0;
      used.set(base, count + 1);
      const existing = env.fragment ? env.headings?.find(item => item.line === line) : undefined;
      const id = existing?.id || base + (count ? `-${count}` : "");
      token.attrSet("id", id); headings.push({ line, text, id, level: Number(token.tag.slice(1)) });
    }
    if (!state.env.fragment) state.env.headings = headings;
  });
  md.inline.ruler.before("emphasis", "html_embed", (state, silent) => {
    const raw = state.src.slice(state.pos), match = /^(?:<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>|<(span|a|ruby|abbr|small|b|i|strong|em|code|samp|time|label|video|audio)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1>)/i.exec(raw);
    if (!match) return false;
    if (!silent) { const token = state.push("html_embed", "span", 0); token.content = match[0]; token.markup = match[0]; token.meta = { from: state.pos, to: state.pos + match[0].length }; }
    state.pos += match[0].length; return true;
  });
  md.inline.ruler.before("emphasis", "safe_inline_html", (state, silent) => {
    const raw = state.src.slice(state.pos), close = /^<\/(u|sub|sup|mark|kbd|span)>/i.exec(raw), open = /^<(u|sub|sup|mark|kbd)>/i.exec(raw), span = /^<span\s+style\s*=\s*(["'])\s*color\s*:\s*(#[0-9a-f]{3,8}|[a-z]+)\s*;?\s*\1\s*>/i.exec(raw);
    const match = close || open || span;
    if (!match || (!close && !raw.toLowerCase().includes(`</${span ? "span" : open[1].toLowerCase()}>`))) return false;
    if (!silent) {
      const tag = span ? "span" : match[1].toLowerCase(), token = state.push(close ? "safe_html_close" : "safe_html_open", tag, close ? -1 : 1);
      token.markup = match[0]; if (span) token.attrSet("style", `color:${span[2]}`);
    }
    state.pos += match[0].length; return true;
  });
}
