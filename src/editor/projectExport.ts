import { projectChapters } from "../../shared/project-export.mjs";
import { host } from "../host";
import { t } from "../i18n";
import type { ConversionOptions, DocumentRecord } from "../types";
import { renderDiagrams } from "./diagrams";
import { renderMarkdown } from "./markdown";
import { conversionMarkdown } from "./print";

export async function exportProject(format: "docx" | "pdf", folder: string, drafts: DocumentRecord[], options: ConversionOptions) {
  const snapshot = await host.vaultSnapshot(true);
  if (snapshot.folder !== folder) throw new Error(t("目录已更新，请刷新后重试。"));
  const chapters = projectChapters(snapshot, drafts, t);
  const prepared: string[] = [];
  const template = document.createElement("template"), diagrams = document.createElement("article");
  diagrams.hidden = true;
  document.body.append(diagrams);
  try {
    for (const chapter of chapters) {
      try {
        template.innerHTML = renderMarkdown(chapter.body);
        diagrams.replaceChildren(...template.content.querySelectorAll(".mermaid-block"));
        await renderDiagrams(diagrams);
        prepared.push(await conversionMarkdown(chapter.body, diagrams, chapter.token));
      } catch (error) {
        throw new Error(t("无法导出章节 {{chapter}}：{{detail}}", { chapter: chapter.relative, detail: t((error as Error).message) }));
      }
    }
  } finally { diagrams.remove(); }
  return host.exportConverted({ folder }, format, prepared, "", options);
}
