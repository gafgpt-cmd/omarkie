declare module "markdown-it-task-lists" {
  const plugin: any;
  export default plugin;
}
declare module "*.css";
declare module "*shared/wiki-syntax.mjs" {
  export const wikiSyntax: import("markdown-it").PluginSimple;
  export function headingText(tokens: import("markdown-it").Token[]): string;
  export function headingSlug(text: string): string;
}
declare module "*shared/new-note.mjs" { export function newNote(name: string, now?: string): string; }
declare module "*shared/frontmatter.mjs" {
  export function properties(text: string): Record<string, unknown>;
  export function setProperties(text: string, updates: Record<string, unknown>): string;
  export function makeReady(text: string, name: string): string;
  export function validateOKF(text: string, name?: string, root?: boolean): string[];
}
declare module "*shared/markdown.mjs" {
  export function createMarkdown(options?: import("markdown-it").MarkdownItOptions): import("markdown-it").MarkdownIt;
  export function setSyntaxOptions(md: import("markdown-it").MarkdownIt, options?: Partial<import("./preferences").Preferences>): void;
}
declare module "*shared/parser-context.mjs" {
  export function parserContext(md: import("markdown-it").MarkdownIt, source: string, environment?: Record<string, unknown>): { tokens: import("markdown-it").Token[]; environment: Record<string, unknown> };
}
declare module "*shared/image-references.mjs" {
  export function collectImages(md: import("markdown-it").MarkdownIt, source: string): import("./editor/images").ImageReference[];
}
declare module "*shared/source-lines.mjs" {
  export function sourceLines(source: string): { lines: string[]; offsets: number[] };
}
declare module "*shared/link-destination.mjs" {
  export function inlineDestination(md: import("markdown-it").MarkdownIt, text: string, open: number, max?: number): { target: string; from: number; to: number; end: number; title?: string; spaced: boolean } | null;
}
declare module "*shared/references.mjs" {
  export function referenceIndex(snapshot: import("./types").VaultSnapshot, options?: Partial<import("./preferences").Preferences>): any;
  export function bundlePlan(snapshot: import("./types").VaultSnapshot, date?: string, options?: Partial<import("./preferences").Preferences>): import("./types").BundlePayload;
}
declare module "markdown-it-mark" { const plugin: import("markdown-it").PluginSimple; export default plugin; }
declare module "markdown-it-sub" { const plugin: import("markdown-it").PluginSimple; export default plugin; }
declare module "markdown-it-sup" { const plugin: import("markdown-it").PluginSimple; export default plugin; }
declare module "markdown-it-emoji" { export const full: import("markdown-it").PluginWithOptions<{ shortcuts?: Record<string, string[]> }>; }
declare module "turndown" {
  export default class TurndownService {
    constructor(options?: Record<string, string>);
    use(plugin: (service: TurndownService) => void): this;
    addRule(name: string, rule: { filter: string; replacement: (content: string) => string }): this;
    turndown(html: string): string;
  }
}
declare module "turndown-plugin-gfm" { export const gfm: (service: import("turndown").default) => void; }

declare module "markdown-it-emoji/lib/data/full.mjs" { const names: Record<string, string>; export default names; }
declare module "*?typora-plugin" { const factory: (context: any) => any; export default factory; }
declare module "*shared/i18n.mjs" {
  export const languages: [string, string][];
  export function resolveLanguage(choice: string, locales?: readonly string[]): string;
  export function createTranslator(language: string): (key: string, options?: Record<string, unknown>) => string;
}
declare module "*shared/background.mjs" {
  export const maxBackgroundBytes: number;
  export function backgroundMime(bytes: Uint8Array): string;
  export function checkedBackground(value: unknown): { name: string; dataUrl: string } | null;
}

declare module "*shared/languages.mjs" {
  export const languages: [string, string][];
  export function resolveLanguage(choice: string, locales?: readonly string[]): string;
}
