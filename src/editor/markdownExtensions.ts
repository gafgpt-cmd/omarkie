import { safeDocumentHtml } from "./htmlResources.ts";
export { headingSlug } from "../../shared/wiki-syntax.mjs";
import type { MarkdownIt } from "markdown-it";
import { t } from "../i18n.ts";
import { smartPunctuationRule } from "./smartPunctuation.ts";
export interface DocumentHeading { line: number; level: number; text: string; id: string }
export interface FootnoteDefinition { id: string; text: string; line: number }
interface SyntaxEnvironment {
  fragment?: boolean; lineOffset?: number; headings?: DocumentHeading[];
  footnoteDefinitions?: Record<string, FootnoteDefinition>; footnoteNumbers?: Record<string, number>;
}
export function alertTitle(kind: string, custom = false) {
  const label = custom ? "" : kind[0].toUpperCase() + kind.slice(1).toLowerCase();
  return `<span class="markdown-alert-title"><svg class="alert-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 4.3v1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>${label}</span>`;
}
export function configureDocumentRendering(md: MarkdownIt) {
  md.core.ruler.before("text_join", "smart_punctuation", smartPunctuationRule);
  md.renderer.rules.html_break = () => "<br>";
  md.renderer.rules.html_block = (tokens, index, _options, env) => safeDocumentHtml(tokens[index].content, typeof env?.documentId === "string" ? env.documentId : undefined);
  md.renderer.rules.alert_marker = (tokens, index) => alertTitle(tokens[index].content);
  md.renderer.rules.text = (tokens, index) => {
    const token = tokens[index], callout = token.meta?.callout as { type: string; custom: boolean; length: number } | undefined;
    return callout ? alertTitle(callout.type, callout.custom) + md.utils.escapeHtml(token.content.slice(callout.length)) : md.utils.escapeHtml(token.content);
  };
  md.renderer.rules.frontmatter = () => "";
  md.renderer.rules.comment = () => "";
  md.renderer.rules.html_embed = (tokens, index, _options, env) => safeDocumentHtml(tokens[index].content, typeof env?.documentId === "string" ? env.documentId : undefined, false);
  md.renderer.rules.footnote_ref = (tokens, index) => {
    const token = tokens[index], id = md.utils.escapeHtml(token.content), definition = token.meta?.definition as FootnoteDefinition;
    return `<sup class="footnote-reference"><a href="#fn-${encodeURIComponent(token.content)}" data-footnote="${id}" title="${md.utils.escapeHtml(definition.text)}">${md.utils.escapeHtml(String(token.meta?.number))}</a></sup>`;
  };
  md.renderer.rules.footnote_definition = (tokens, index, _options, env) => {
    const token = tokens[index], id = String(token.meta?.id), number = (env as SyntaxEnvironment)?.footnoteNumbers?.[id] || id;
    return `<aside class="footnote-definition" id="fn-${encodeURIComponent(id)}"><span class="footnote-label">${md.utils.escapeHtml(String(number))}.</span> ${md.renderInline(token.content, { ...env, fragment: true })}</aside>\n`;
  };
  md.renderer.rules.toc = (_tokens, _index, _options, env) => {
    const headings = (env as SyntaxEnvironment)?.headings || [];
    return `<nav class="markdown-toc md-toc-content" aria-label="${t("正文目录")}">${headings.map(heading => `<span class="md-toc-item md-toc-h${heading.level}"><a href="#${md.utils.escapeHtml(heading.id)}" data-heading-line="${heading.line}" style="padding-left:${(heading.level - 1) * 18}px">${md.utils.escapeHtml(heading.text)}</a></span>`).join("") || `<span class="toc-empty">${t("添加标题后自动生成目录")}</span>`}</nav>\n`;
  };
}
