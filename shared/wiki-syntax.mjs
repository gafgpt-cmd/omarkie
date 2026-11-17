export function wikiSyntax(md) {
  md.inline.ruler.before("link", "wiki_link", (state, silent) => {
    if (state.linkLevel || state.src[state.pos - 1] === "!") return false;
    const match = /^\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]*))?\]\]/.exec(state.src.slice(state.pos, state.posMax));
    if (!match || !match[1].trim()) return false;
    if (!silent) {
      const token = state.push("wiki_link", "a", 0);
      token.markup = match[0]; token.content = match[2]?.trim() || match[1].trim(); token.meta = { target: match[1].trim() };
    }
    state.pos += match[0].length; return true;
  });
  // Split text tokens, not raw source: code, links and escaped hashes stay literal.
  md.core.ruler.after("inline", "vault_tags", state => {
    for (const block of state.tokens) {
      if (!block.children) continue;
      let inLink = 0;
      block.children = block.children.flatMap(token => {
        if (token.type === "link_open") inLink++;
        if (token.type === "link_close") inLink--;
        if (token.type !== "text" || inLink) return [token];
        const parts = []; let from = 0;
        for (const match of token.content.matchAll(/(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) {
          const at = match.index + match[1].length;
          if (at > from) { const text = new state.Token("text", "", 0); text.content = token.content.slice(from, at); parts.push(text); }
          const tag = new state.Token("vault_tag", "a", 0); tag.content = match[2]; tag.markup = "#" + match[2]; parts.push(tag); from = at + tag.markup.length;
        }
        if (!parts.length) return [token];
        if (from < token.content.length) { const text = new state.Token("text", "", 0); text.content = token.content.slice(from); parts.push(text); }
        return parts;
      });
    }
  });
  md.renderer.rules.wiki_link = (tokens, at) => `<a class="vault-link" href="omarkie-wiki:${encodeURIComponent(tokens[at].meta.target)}">${md.utils.escapeHtml(tokens[at].content)}</a>`;
  md.renderer.rules.vault_tag = (tokens, at) => `<a class="vault-tag" href="omarkie-tag:${encodeURIComponent(tokens[at].content)}">#${md.utils.escapeHtml(tokens[at].content)}</a>`;
}
