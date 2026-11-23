import { frontmatter } from "./frontmatter.mjs";

export function projectChapters(snapshot, drafts, t) {
  if (snapshot.truncated) throw new Error(t("清点不完整，已拒绝导出。"));
  if (!snapshot.notes.length) throw new Error(t("项目文件夹中没有 Markdown 章节。"));
  const byPath = new Map(drafts.filter(draft => draft.path).map(draft => [draft.path, draft.content]));
  return snapshot.notes.map(note => {
    let metadata;
    try { metadata = frontmatter(byPath.get(note.path) ?? note.content); }
    catch { throw new Error(t("无法读取章节的前置元数据：{{chapter}}", { chapter: note.relative })); }
    const order = metadata.document.get("order");
    return { token: note.token, relative: note.relative, order: Number.isFinite(order) ? order : Infinity, body: metadata.body.replace(/\r\n?/g, "\n") };
  }).sort((a, b) => (a.order - b.order) || (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}
