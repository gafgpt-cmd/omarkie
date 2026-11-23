import { projectChapters } from "../../shared/project-export.mjs";
import { host } from "../host";
import { t } from "../i18n";
import type { ConversionOptions, DocumentRecord } from "../types";
import { conversionMarkdown } from "./print";
import { exportDiagramBlocks } from "./markdown";

export async function exportProject(format: "docx" | "pdf", folder: string, drafts: DocumentRecord[], options: ConversionOptions) {
  const snapshot = await host.vaultSnapshot(true);
  if (snapshot.folder !== folder) throw new Error(t("目录已更新，请刷新后重试。"));
  const chapters = projectChapters(snapshot, drafts, t);
  const prepared: string[] = [];
  let sandbox: HTMLIFrameElement | undefined;
  try {
    for (const chapter of chapters) {
      try {
        const blocks = exportDiagramBlocks(chapter.body);
        if (blocks.length && !sandbox) {
          sandbox = document.createElement("iframe");
          sandbox.style.cssText = "position:fixed;left:-10000px;width:960px;height:600px;visibility:hidden";
          const loaded = new Promise<void>(resolve => sandbox!.addEventListener("load", () => resolve(), { once: true }));
          sandbox.src = new URL("project-diagrams.html", location.href).href;
          document.body.append(sandbox);
          await loaded;
        }
        const owner = blocks.length ? sandbox?.contentDocument : document.implementation.createHTMLDocument();
        if (!owner) throw new Error(t("无法生成图表图片。"));
        const diagrams = owner.createElement("article");
        owner.body.replaceChildren(diagrams);
        for (const block of blocks) {
          const placeholder = owner.createElement("div");
          placeholder.className = "mermaid-block";
          placeholder.dataset.diagramLanguage = block.language;
          placeholder.textContent = block.body;
          diagrams.append(placeholder);
        }
        if (blocks.length) {
          const render = (sandbox?.contentWindow as (Window & { renderProjectDiagrams?: (container: HTMLElement) => Promise<void> }) | null)?.renderProjectDiagrams;
          if (!render) throw new Error(t("无法生成图表图片。"));
          await render(diagrams);
        }
        prepared.push(await conversionMarkdown(chapter.body, diagrams, chapter.token));
      } catch (error) {
        throw new Error(t("无法导出章节 {{chapter}}：{{detail}}", { chapter: chapter.relative, detail: t((error as Error).message) }));
      }
    }
  } finally { sandbox?.remove(); }
  return host.exportConverted({ folder }, format, prepared, "", options);
}
