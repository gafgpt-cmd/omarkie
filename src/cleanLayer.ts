import { cleanWithEngine } from "./clean-converted";
import type { EditorHandle } from "./editor/MarkdownEditor";
import { host } from "./host";
import { t } from "./i18n";
import type { DocumentRecord } from "./types";

export interface CleanPreview {
  readonly id: string;
  readonly path: string | null;
  readonly diskHash: string | null;
  readonly name: string;
  readonly source: string;
  readonly markdown: string;
}

export async function previewClean(record: DocumentRecord): Promise<CleanPreview> {
  const { id, path, diskHash, name, content: source } = record;
  const markdown = await cleanWithEngine(source, name, window.desktop?.cleanConverted ? host.cleanConverted : undefined);
  return { id, path, diskHash, name, source, markdown };
}

export async function bakeClean(preview: CleanPreview, current: () => DocumentRecord | undefined, editor: () => EditorHandle | undefined) {
  const assertCurrent = () => {
    const record = current(), target = editor();
    if (!record || record.conflict || record.id !== preview.id || record.name !== preview.name || record.path !== preview.path ||
        record.diskHash !== preview.diskHash || record.content !== preview.source || target?.markdown() !== preview.source) {
      throw new Error(t("源文档已改变，请重新预览。"));
    }
    return target;
  };
  assertCurrent();
  if (preview.path && host.native && await host.check(preview.id)) throw new Error(t("源文档已改变，请重新预览。"));
  const target = assertCurrent();
  if (preview.markdown !== preview.source && !target.replaceRange(0, preview.source.length, preview.markdown, preview.source, true)) {
    throw new Error(t("当前不可编辑"));
  }
}
