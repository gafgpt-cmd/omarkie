export type EmbedState = "ok" | "missing" | "ambiguous" | "missing-heading" | "ambiguous-heading" | "cycle" | "too-deep" | "too-large" | "unsupported-block";
export interface EmbedSection {
  state: EmbedState;
  relative?: string;
  title?: string;
  line?: number;
  markdown?: string;
  content?: string;
  chain?: string[];
  candidates?: string[];
  matches?: number;
}
export interface EmbedSource {
  files(): { relative: string; modified: string; created: string; draft: boolean }[];
  notes(relatives: string[]): Promise<{ relative: string; content: string }[]>;
  setFiles(list: { relative: string; modified?: string; created?: string; isDirectory?: string }[]): { changed: string[]; paths: boolean };
  setDrafts(list: { relative: string; content: string }[]): { changed: string[]; paths: boolean };
  section(from: { relative: string; content: string; base?: string }, raw: string, chain?: string[], budget?: { bytes: number }): Promise<EmbedSection>;
}
export const embedLimits: { depth: number; bytes: number; read: number };
export function noteEmbed(target: string): boolean;
export function rebaseLinks(markdown: string, targetRelative: string, fromRelative: string, exists?: (path: string) => boolean): string;
export function createEmbedSource(options: { read(relatives: string[]): Promise<{ relative: string; content: string }[]> | { relative: string; content: string }[] }): EmbedSource;
