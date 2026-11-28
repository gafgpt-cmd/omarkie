import type { DocumentRecord, FileEntry, FolderResult, Host, Recovery, SearchResult, SessionSnapshot } from "./types";
import { browserBackground, chooseBrowserBackground } from "./browserBackground";
import { t } from "./i18n";
import { bundledImageUrls } from "./editor/htmlResources";
import { localImageSources } from "./editor/markdown";
import * as companion from "./companion";
const browserRecords = new Map<string, DocumentRecord>();
const showcaseImages = new Map(Object.entries(import.meta.glob<string>("../docs/showcase/images/*", { query: "?url", import: "default", eager: true }))
  .map(([file, url]) => [file.replace("../docs/showcase/", ""), url]));
const showcase = Object.entries(import.meta.glob<string>("../docs/showcase/*.md", { query: "?raw", import: "default", eager: true }))
  .map(([file, content]) => ({ name: file.split("/").pop()!, content }))
  .sort((a, b) => Number(b.name === "travel-journal.md") - Number(a.name === "travel-journal.md"));
function registerShowcaseImages(record: DocumentRecord) {
  for (const [source, url] of showcaseImages)
    bundledImageUrls.set(`omarkie-asset://local/${encodeURIComponent(record.id)}/${encodeURIComponent(source)}`, url);
}
const key = "omarkie-session-v1";
function draft(name: string, content: string): DocumentRecord {
  return {
    id: crypto.randomUUID(),
    path: null,
    name,
    content,
    savedContent: content,
    diskHash: null,
    lineEnding: content.includes("\r\n") ? "\r\n" : "\n",
  };
}
function download(name: string, text: string, type = "text/markdown;charset=utf-8") {
  const url = URL.createObjectURL(
    new Blob([text], { type }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Companion notes live at "/<vault>/<relative path>"; drafts have no path.
const companionPath = (record: DocumentRecord) => record.path?.split("/").slice(2).join("/") || null;
let imageUrls: Map<string, string> | null = null;
async function companionFolder(): Promise<FolderResult | null> {
  const vault = await companion.status();
  if (!vault) return null;
  const root = `/${vault.name}`, rows = await companion.notes(), folders = new Set<string>();
  for (const row of rows) { const parts = row.path.split("/"); for (let depth = 1; depth < parts.length; depth++) folders.add(parts.slice(0, depth).join("/")); }
  const entry = (relative: string, directory: boolean): FileEntry => ({ token: directory ? `folder:${relative}` : relative, name: relative.split("/").pop()!, relative, path: `${root}/${relative}`, ...(directory ? { isDirectory: "true" } : {}) });
  return { folder: root, files: [...[...folders].map(relative => entry(relative, true)), ...rows.map(row => entry(row.path, false))], truncated: false };
}
// Relative images in a companion note resolve to the photos imported with it, as blob URLs.
async function registerCompanionImages(record: DocumentRecord) {
  const relative = companionPath(record);
  if (!relative) return;
  if (!imageUrls) imageUrls = new Map((await companion.images()).map(image => [image.path, URL.createObjectURL(image.blob)]));
  const folder = relative.split("/").slice(0, -1);
  for (const source of localImageSources(record.content)) {
    let decoded = source;
    try { decoded = decodeURI(source); } catch {}
    const parts = [...(decoded.startsWith("/") ? [] : folder), ...decoded.split(/[?#]/)[0].split("/")].reduce<string[]>((path, part) => part === ".." ? path.slice(0, -1) : part && part !== "." ? [...path, part] : path, []);
    const name = parts.at(-1), candidates = [...imageUrls.keys()].filter(path => path.split("/").pop() === name);
    const url = imageUrls.get(parts.join("/")) ?? (candidates.length === 1 ? imageUrls.get(candidates[0]) : undefined);
    if (url) for (const key of new Set([source, encodeURI(decoded)])) bundledImageUrls.set(`omarkie-asset://local/${encodeURIComponent(record.id)}/${encodeURIComponent(key)}`, url);
  }
}
export async function resetCompanionImages() {
  for (const url of imageUrls?.values() ?? []) URL.revokeObjectURL(url);
  imageUrls = null;
}
const browser: Host = {
  native: false,
  async vaultSnapshot() { throw new Error(t("请在桌面应用中打开文件夹以使用知识库工具")); },
  async exportBundle() { throw new Error(t("导出压缩包需要桌面应用")); },
  async exportGlass() { throw new Error(t("导出玻璃需要桌面应用")); },
  async importGlass() { throw new Error(t("导入玻璃导出包需要桌面应用")); },
  async sharedGlass() { throw new Error(t("共享玻璃需要桌面应用")); },
  async sharedGlassState() { return { shared: false }; },
  async spellcheckLanguages() { return []; },
  async cancelClose() {},
  async windowAction() { return false; },
  async imageAction() { throw new Error(t("图片文件操作请使用桌面应用。")); },
  async imageSizes() { return {}; },
  async themes() { return []; }, async omarchyTheme() { return null; }, async setRemoteImages() {}, async installTheme() { throw new Error(t("安装主题请使用桌面应用。")); },
  background: () => browserBackground(), chooseBackground: chooseBrowserBackground,
  clearBackground: () => browserBackground(null),
  async plugins() { return []; }, async installPlugin() { throw new Error(t("安装本地插件请使用桌面应用。")); },
  async removePlugin() { throw new Error(t("移除本地插件请使用桌面应用。")); },
  async sync() { throw new Error(t("同步需要桌面应用。")); },
  async conversionSettings() { return { pandoc: "", word: false }; },
  async importDocument() { throw new Error(t("导入文档请使用桌面应用。")); }, async exportConverted() { throw new Error(t("此格式导出请使用桌面应用。")); },
  async restore() {
    let session: Recovery | null = null;
    const raw = localStorage.getItem(key);
    try {
      session = JSON.parse(raw || "null");
    } catch {}
    // Keep a damaged session for recovery and restore only well-formed drafts.
    if (raw && !Array.isArray(session?.documents)) { localStorage.setItem(key + "-backup", raw); session = null; }
    if (session) session.documents = session.documents.filter(record => record && typeof record.id === "string" && typeof record.name === "string" && typeof record.content === "string" && typeof record.savedContent === "string");
    session ??= {
      documents: showcase.map(sample => draft(sample.name, sample.content)),
    };
    // Companion notes reopen from this device's copy. A note no longer there comes back as an unsaved draft,
    // never as a file that seems to exist.
    const folder = await companionFolder().catch(() => null);
    session.folder = folder?.folder ?? null;
    session.documents = await Promise.all(session.documents.map(async record => {
      const relative = companionPath(record);
      if (!relative) return record;
      const row = folder && record.path!.startsWith(folder.folder + "/") ? await companion.note(relative).catch(() => undefined) : undefined;
      if (!row) return { ...record, path: null, diskHash: null, savedContent: "" };
      return record.content === record.savedContent ? { ...record, content: row.text, savedContent: row.text } : { ...record, savedContent: row.text };
    }));
    for (const record of session.documents) {
      browserRecords.set(record.id, record);
      if (showcase.some(sample => sample.name === record.name)) registerShowcaseImages(record);
      await registerCompanionImages(record).catch(() => {});
    }
    return session;
  },
  async showcase() {
    const record = draft(showcase[0].name, showcase[0].content);
    browserRecords.set(record.id, record);
    registerShowcaseImages(record);
    return { folder: null, files: [], truncated: false, document: record };
  },
  async registerDraft(record) {
    browserRecords.set(record.id, record);
  },
  open: () =>
    new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".md,.markdown,.mdown";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        const record = draft(file.name, await file.text());
        browserRecords.set(record.id, record);
        resolve(record);
      };
      input.addEventListener("cancel", () => resolve(null));
      input.click();
    }),
  async openFolder() {
    const existing = await companionFolder();
    if (existing) return existing;
    const files = await new Promise<FileList | null>(resolve => {
      const input = document.createElement("input");
      input.type = "file"; input.webkitdirectory = true; input.multiple = true;
      input.onchange = () => resolve(input.files);
      input.addEventListener("cancel", () => resolve(null));
      input.click();
    });
    if (!files?.length) return null;
    await companion.importFolder(files);
    await resetCompanionImages();
    return companionFolder();
  },
  async fileOperation() { throw new Error(t("文件操作请使用桌面应用。")); },
  onFileOperation() { return () => {}; },
  async recent() { return []; },
  async recentAction() { return null; },
  async searchFiles(query, options) {
    if (!query || query.length > 1000) return { matches: [], truncated: false, skipped: 0 };
    const vault = await companion.status();
    if (!vault) return { matches: [], truncated: false, skipped: 0 };
    const notes = await companion.notes(), worker = new Worker(new URL("./companionSearch.worker.ts", import.meta.url), { type: "module" });
    try {
      const reply = await new Promise<Partial<SearchResult> & { error?: string; timedOut?: boolean }>(resolve => {
        const timer = setTimeout(() => resolve({ matches: [], truncated: true, timedOut: true }), 5000);
        worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
        worker.postMessage({ notes, query, regex: options.regex, caseSensitive: options.caseSensitive });
      });
      if (reply.error) throw new Error(reply.error);
      return { matches: (reply.matches ?? []).map(match => ({ ...match, path: `/${vault.name}/${match.token}` })), truncated: !!reply.truncated, skipped: 0 };
    } finally { worker.terminate(); }
  },
  async reveal() {},
  async scan() {
    return await companionFolder() ?? { folder: null, files: [], truncated: false };
  },
  async openToken(token) {
    const [vault, row] = await Promise.all([companion.status(), companion.note(token)]);
    if (!vault || !row) throw new Error(t("目录已更新，请刷新后重试。"));
    const path = `/${vault.name}/${token}`, existing = [...browserRecords.values()].find(record => record.path === path);
    if (existing) return existing;
    const record = { ...draft(token.split("/").pop()!, row.text), path };
    browserRecords.set(record.id, record);
    await registerCompanionImages(record);
    return record;
  },
  async reopen(id) { const record = browserRecords.get(id); if (!record) throw new Error(t("文档已不可用。")); return record; },
  chooseImage: (id) => new Promise(resolve => {
    const input = document.createElement("input"); input.type = "file"; input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.onchange = async () => { const file = input.files?.[0]; resolve(file ? { path: await browser.importImage(id, new Uint8Array(await file.arrayBuffer()), file.name), alt: file.name } : null); };
    input.addEventListener("cancel", () => resolve(null)); input.click();
  }),
  async save(id, text) {
    const record = browserRecords.get(id)!, relative = companionPath(record);
    if (relative) await companion.saveNote(relative, text);
    else download(record.name, text);
    const next = { ...record, content: text, savedContent: text };
    browserRecords.set(id, next);
    return next;
  },
  async persist(session: SessionSnapshot) {
    localStorage.setItem(key, JSON.stringify(session));
  },
  async check() {
    return null;
  },
  async reload(id) {
    return browserRecords.get(id)!;
  },
  async acceptDisk(id) {
    return browserRecords.get(id)!;
  },
  async importImage(_id, bytes) {
    const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
  },
  async exportPdf() {
    window.print();
    return null;
  },
  async exportHtml(name, html) { download(name.replace(/\.(?:md|markdown|mdown)$/i, "") + ".html", html, "text/html;charset=utf-8"); return null; },
  writeClipboard: text => navigator.clipboard.writeText(text),
  readClipboard: () => navigator.clipboard.readText(),
  async openLink(url) {
    if (/^https?:\/\//.test(url))
      window.open(url, "_blank", "noopener,noreferrer");
  },
  async openDocumentLink() { throw new Error(t("打开本地 Markdown 链接请使用桌面应用。")); },
  async confirmDiscard(name) {
    return window.confirm(t("关闭「{{name}}」并移除未保存的修改？", { name }));
  },
  async confirmClose(name) {
    return window.confirm(t("不保存「{{name}}」的修改并关闭？", { name }))
      ? "discard"
      : "cancel";
  },
  async setDirty() {},
  async closeWindow() {
    window.close();
  },
  onCommand() {
    return () => {};
  },
};
export const host: Host = window.desktop
  ? new Proxy({ native: true } as Host, {
      get(target, name: keyof Host) {
        if (name === "native") return true;
        if ((name === "checkGrammar" || name === "glass" || name === "onGlassStorage") && !window.desktop![name]) return undefined;
        if ((name === "exportGlass" || name === "importGlass" || name === "sharedGlass" || name === "sharedGlassState") && !window.desktop![name]) return undefined;
        if ((name === "checkGrammar" || name === "glass" || name === "onGlassStorage" || name === "sync") && !window.desktop![name]) return undefined;
        if ((name === "bibliography" || name === "tutorBridge" || name === "learningSearch" || name === "peek" || name === "resolveConflict") && !window.desktop?.[name]) return undefined;
        if (name === "onCommand" || name === "onFileOperation" || name === "onTutor" || name === "onGlassStorage" || name === "closeWindow")
          return window.desktop![name];
        return async (...args: unknown[]) => {
          if (name === "spellcheckLanguages" && !window.desktop![name]) return [];
          const response = await window.desktop![name](...args);
          if (!response.ok) {
            const error = new Error(response.code === "LEARNING_ERROR" ? t(response.error) : response.error);
            Object.assign(error, { code: response.code });
            throw error;
          }
          return response.value;
        };
      },
    })
  : browser;
