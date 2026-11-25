import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  protocol,
  net,
  shell,
  session,
  clipboard,
} from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PhotoPreviews, chromiumPreview, previewWidths } from "./photo-previews.mjs";
import { imageAction, imageName } from "./image-actions.mjs";
import { libreOfficePath, pandocPath, convertExport, convertImport, themes, installTheme } from "./interchange.mjs";
import { Workspace } from "./workspace.mjs";
import { vaultSnapshot, exportBundle, projectDestination } from "./document-workflows.mjs";
import { randomUUID } from "node:crypto";
import { atomicWrite, DocumentStore } from "./store.mjs";
import { readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { launchFiles } from "./launch-files.mjs";
import { plugins, installPlugin } from "./plugins.mjs";
import { pluginResource, exportResource, imageSizes } from "./resources.mjs";
import { readBackground, saveBackground, clearBackground } from "./background.mjs";
import { readOmarchyTheme, watchOmarchyTheme } from "./omarchy.mjs";
import { languages, resolveLanguage } from "../shared/i18n.mjs";
import { t, useLanguage } from "./i18n.mjs";
import { blocksRequest } from "./network.mjs";
import { openShowcase, showcaseDocuments, showcaseFolderName, showcaseSource } from "./showcase.mjs";
import { dictionaryDownloadURL, dictionarySource, seedDictionaries } from "./spellcheck.mjs";
import { convertPdf, isPdf, pdfConverter } from "./pdf.mjs";
import { ttsTextLimit } from "../shared/tts.mjs";
import { listenBridge } from "./tutor-transport.mjs";
import { GlassService } from "./glass-service.mjs";
import { GlassSync } from "./glass-sync.mjs";
const traceStartup = process.env.OMARKIE_TRACE_STARTUP === "1";
function startupMark(name) {
  if (!traceStartup) return;
  performance.mark(`omarkie:${name}`);
  console.log(`[startup] ${name} ${performance.now().toFixed(1)}ms`);
}
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const development = process.env.OMARKIE_DEV_URL;
let tutorSessions, tutorLoading;
function detachTutor(contents) { if (tutorLoading) void tutorLoading.then(() => tutorSessions?.detach(contents)).catch(() => {}); }
if (process.env.OMARKIE_DATA_DIR)
  app.setPath("userData", process.env.OMARKIE_DATA_DIR);
app.setName("Omarkie");
seedDictionaries(dictionarySource(root), app.getPath("userData"));
protocol.registerSchemesAsPrivileged([
  { scheme: "omarkie", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  {
    scheme: "omarkie-asset",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
let languageChoice = "auto", language = "zh", buildMenu = () => {}, remoteImages = false;
let viewChecked = {};
const checkedActions = ["source", "focus", "typewriter", "sidebar", "outline", "files", "file-tree", "reading-layers", "glass"];
let menuDefinitions = [], viewDisabled = true, viewContext = "";
const commandEnabled = item => !item.context || !viewDisabled && (!["rich", "table"].includes(item.context) || !viewChecked.source) && (item.context !== "table" || viewContext === "table_open");
function applyLanguage(choice) {
  languageChoice = choice;
  language = resolveLanguage(choice, app.getPreferredSystemLanguages());
  useLanguage(language);
}
let window,
  store, workspace,
  dirty = false,
  closing = false;
const pending = [], pendingPdfs = [];
let rendererReady = false;
let revealWindow = () => {};
let speech;
function stopSpeech() { speech?.abort(); speech = undefined; }

const pluginToken = randomUUID();
const authorizedPlugin = item => item && ({ ...item, url: item.url + "?token=" + pluginToken });
function openFiles(files) {
  for (const file of files) {
    if (window && rendererReady) (isPdf(file) ? openPdf(file) : store.open(file))
      .then(document => document && send({ action: "opened", document })).catch(showError);
    else pending.push(file);
  }
}
if (process.platform !== "darwin") {
  if (process.platform === "win32") app.setAppUserModelId("org.omarkie.desktop");
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    pending.push(...launchFiles(process.argv, app.isPackaged));
    app.on("second-instance", (_, argv, cwd) => {
      openFiles(launchFiles(argv, app.isPackaged, cwd));
      if (window?.isMinimized()) window.restore();
      window?.show();
      window?.focus();
    });
  }
}
app.on("open-file", (event, file) => {
  event.preventDefault();
  openFiles([file]);
});
const send = (command) =>
  window?.webContents.send(
    "app:command",
    typeof command === "string" ? { action: command } : command,
  );
// Open errors go to the window's message bar; a native error box blocks the app (and aborts headless runs).
const showError = (error) => window && rendererReady ? send({ action: "notice", message: error.message }) : console.error(error);
// A PDF opens as its Markdown copy; without a converter, or when conversion fails, it can open in the PDF viewer.
async function openPdf(file) {
  let reason;
  try {
    const converter = await pdfConverter(store.dataDir);
    if (converter) {
      send({ action: "notice", message: t("正在把“{{name}}”转换为 Markdown…", { name: path.basename(file) }) });
      return await store.open(await convertPdf(file, store.dataDir, converter));
    }
    reason = t("未找到 PDF 转换器：请在 PATH 中提供 pdf-md，或设置 OMARKIE_PDF_CONVERTER。");
  } catch (error) { reason = String(error.stderr || "").trim().split("\n").at(-1) || error.message; }
  const answer = await dialog.showMessageBox(window, { type: "info", message: t("无法把“{{name}}”转换为 Markdown。", { name: path.basename(file) }), detail: reason, buttons: [t("取消"), t("在 PDF 阅读器中打开")], defaultId: 1, cancelId: 0 });
  if (answer.response === 1) { const failure = await shell.openPath(file); if (failure) throw new Error(failure); }
  return null;
}
const handshakes = new Map();
ipcMain.on("workspace:prepared", (event, id, value) => { if (event.sender !== window?.webContents) return; handshakes.get(id)?.(value); });
function prepareOperation(phase, change) { return new Promise((resolve, reject) => { const id = randomUUID(), timeout = setTimeout(() => { handshakes.delete(id); reject(new Error(t("文件操作等待超时。"))); }, 30000); handshakes.set(id, value => { clearTimeout(timeout); handshakes.delete(id); resolve(value); }); window.webContents.send("workspace:operation", id, phase, change); }); }
let operationRunning = false;
let bibliography;
let glassRuntime = { folder: null, root: null, service: null, sync: null, close: null, error: null };
function announceGlass(request) {
  if (["add", "set", "delete", "restore", "bring", "clip-save", "layer", "merge-accept", "merge-undo", "lift-up",
    "swap-apply", "swap-restore", "swap-propose", "swap-dismiss",
    "srs-card", "srs-answer", "srs-review", "study-set"].includes(request?.action)) window?.webContents.send("glass:changed", { note: request.note, action: request.action });
}

let glassQueue = Promise.resolve();
function syncGlass(folder = store?.folder ?? null) {
  const run = glassQueue.then(() => syncGlassNow(folder));
  glassQueue = run.catch(() => {});
  return run;
}
let glassRetry = null, glassRetries = 0;
// A bridge that failed to bind must heal itself: agents call the CLI as soon as the folder is open.
function scheduleGlassRetry(folder) {
  if (glassRetry || glassRetries >= 3 || !folder) return;
  glassRetries += 1;
  glassRetry = setTimeout(() => {
    glassRetry = null;
    if (glassRuntime.service && glassRuntime.close) return;
    if (glassRuntime.folder && glassRuntime.folder !== folder) return;
    glassRuntime.folder = null;
    glassRuntime.error = null;
    void syncGlass(folder).catch(() => {});
  }, 1_000);
  glassRetry.unref?.();
}
async function closeGlassRuntime() {
  if (glassRetry) { clearTimeout(glassRetry); glassRetry = null; }
  glassRetries = 0;
  const current = glassRuntime;
  glassRuntime = { folder: null, root: null, service: null, sync: null, close: null, error: null };
  await current.close?.().catch(() => {});
  await current.sync?.close().catch(() => {});
  await current.service?.close().catch(() => {});
}
async function syncGlassNow(folder) {
  if (glassRuntime.folder === folder) {
    if (glassRuntime.error) throw glassRuntime.error;
    return;
  }
  await closeGlassRuntime();
  if (!folder) return;
  glassRuntime.folder = folder;
  try {
    const root = await realpath(folder);
    const service = await new GlassService({ root, appData: app.getPath("userData") }).open({ passive: true });
    if (glassRuntime.folder !== folder) { await service.close(); return; }
    glassRuntime.root = root;
    glassRuntime.service = service;
    service.subscribe(status => window?.webContents.send("glass:storage", status));
    let sync = null;
    try {
      sync = new GlassSync({ service, cacheDir: path.join(app.getPath("cache"), "omarkie"), appData: app.getPath("userData") });
      service.sync = sync;
      glassRuntime.sync = sync;
      await sync.start();
    } catch (error) {
      await sync?.close().catch(() => {});
      service.sync = null;
      glassRuntime.sync = null;
      console.warn("Glass index:", error.message);
    }
    try {
      glassRuntime.close = await listenBridge(root, {
        client(request, send) {
          if (!request || request.op !== "glass") return send({ error: "Unknown Glass bridge request." });
          if (!glassRuntime.service) return send({ error: "Glass storage is not open." });
          const { op: _, token: __, ...payload } = request;
          Promise.resolve(glassRuntime.service.request(payload)).then(result => { announceGlass(payload); send(result); }, error => send({ error: error.message }));
        },
        stopWait() {}, bind() { return {}; }, unbind() { return 0; },
      }, "glass");
      service.bridgeState = "listening";
    } catch (error) {
      service.bridgeState = "unavailable";
      console.warn("Glass bridge:", error.message);
      scheduleGlassRetry(folder);
      return;
    }
    glassRetries = 0;
  } catch (error) {
    glassRuntime.error = error;
    scheduleGlassRetry(folder);
    throw error;
  }
}
let glassWatch = { folder: null, root: null, close: null };
async function syncGlassWatch() {
  const folder = store.folder;
  if (glassWatch.folder === folder) return;
  const close = glassWatch.close;
  glassWatch = { folder, root: null, close: null };
  await close?.();
  if (!folder) return;
  const root = await realpath(folder).catch(() => null);
  if (!root) return;
  const { watchGlass } = await import("./glass-state.mjs");
  if (glassWatch.folder !== folder) return;
  glassWatch.root = root;
  glassWatch.close = await watchGlass(root, visible => { if (glassWatch.folder === folder) window?.webContents.send("glass:event", { visible }); });
}
function releaseBibliography() { bibliography?.close(); bibliography = undefined; }
async function vaultBibliography(folder) {
  if (!folder || folder !== store.folder) throw new Error(t("请先打开笔记文件夹"));
  if (bibliography?.root === folder) return bibliography;
  const { VaultBibliography } = await import("./bibliography.mjs");
  if (folder !== store.folder) throw new Error(t("请先打开笔记文件夹"));
  if (bibliography && bibliography.root !== folder) releaseBibliography();
  return bibliography ??= new VaultBibliography(store.dataDir, folder, () => send("bibliography-changed"));
}
function prioritizeGlass(file) {
  const sync = glassRuntime.sync;
  if (!file || !sync) return;
  void sync.prioritize(file).catch(() => {});
}
const handlers = {
  payloadRequest: async (_, request) => (await import("./payload.mjs")).requestPayload(request),
  payloadKey: async (_, baseUrl, value) => (await import("./payload.mjs")).setPayloadKey(baseUrl, value),
  viewState: (_, _focus, _typewriter, _sidebar, checked, disabled, context) => {
    viewChecked = checked || {};
    viewDisabled = disabled === true;
    viewContext = context;
    for (const action of checkedActions) {
      const item = Menu.getApplicationMenu()?.getMenuItemById(action);
      if (item) item.checked = checked?.[action] === true;
    }
    for (const definition of menuDefinitions) {
      const item = Menu.getApplicationMenu()?.getMenuItemById(definition.action);
      if (item) item.enabled = commandEnabled(definition);
    }
  },
  readAloud: async (_, text) => {
    if (text === null) { stopSpeech(); return; }
    if (typeof text === "string" && text.length > ttsTextLimit) throw new Error(t("朗读文字过长，请选择较短的段落。"));
    if (typeof text !== "string" || !text.trim()) throw new Error(t("没有可朗读的文字。"));
    const configured = process.env.OMARKIE_TTS?.trim();
    if (!configured) throw new Error(t("未配置朗读：请设置 OMARKIE_TTS。"));
    stopSpeech();
    const current = speech = new AbortController();
    try {
      const { speak } = await import("./tts.mjs");
      await speak(configured, text, current.signal);
    } finally {
      if (speech === current) speech = undefined;
    }
  },
  background: () => readBackground(store.dataDir),
  clearBackground: () => clearBackground(store.dataDir),
  chooseBackground: async () => {
    const result = await dialog.showOpenDialog(window,{title:t("选择背景图片"),filters:[{name:t("背景图片"),extensions:["png","jpg","jpeg","webp"]}],properties:["openFile"]});
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error(t("背景图片须小于 8 MB。"));
    return saveBackground(store.dataDir,await readFile(file),path.basename(file),async (_bytes,dataUrl) => {
      // Chromium supports WebP consistently; nativeImage's supported codecs differ by host.
      const size = await window.webContents.executeJavaScript(`(async () => {
        const image = new Image(); image.src = ${JSON.stringify(dataUrl)};
        let timer;
        try { await Promise.race([image.decode(),new Promise((_,reject) => {timer = setTimeout(() => reject(new Error('decode timeout')),10000);})]); return {width:image.naturalWidth,height:image.naturalHeight}; }
        catch { return {width:0,height:0}; }
        finally {clearTimeout(timer);image.src='';}
      })()`);
      if (!size.width || !size.height || size.width * size.height > 40_000_000) throw new Error(t("图片无效或分辨率超过 4000 万像素，请选择较小的图片。"));
    });
  },
  plugins: async () => (await plugins(store.dataDir)).map(authorizedPlugin),
  removePlugin: async (_, id) => { if (!/^local-[a-f0-9]{64}$/.test(id)) throw new Error(t("插件标识无效。")); const root = await realpath(path.join(store.dataDir, "plugins")); if (path.dirname(root) !== await realpath(store.dataDir)) throw new Error(t("插件目录无效。")); for (const suffix of [".json", ".mjs"]) { const file = path.join(root, id + suffix); try { if (path.dirname(await realpath(file)) !== root) throw new Error(t("插件资源路径无效。")); await shell.trashItem(file); } catch (error) { if (error.code !== "ENOENT") throw error; } } return true; },
  installPlugin: async (_, folder = false) => { const result = await dialog.showOpenDialog(window, folder ? { title: t("安装插件文件夹"), properties: ["openDirectory"] } : { filters: [{ name: "JavaScript", extensions: ["js", "cjs"] }], properties: ["openFile"] }); return result.canceled ? null : authorizedPlugin(await installPlugin(result.filePaths[0], store.dataDir)); },
  themes: () => themes(store.dataDir),
  omarchyTheme: () => readOmarchyTheme(),
  editRole: async (event, role) => { if (["cut", "copy", "paste", "selectAll"].includes(role)) event.sender[role](); },
  spellcheckLanguages: (_, languages) => {
    const available = session.defaultSession.availableSpellCheckerLanguages;
    if (Array.isArray(languages) && process.platform !== "darwin") session.defaultSession.setSpellCheckerLanguages([...new Set(languages.filter(code => typeof code === "string" && available.includes(code)))]);
    return available;
  },
  checkGrammar: async (_, url, approvedOrigin, text) => (await import("./grammar.mjs")).checkGrammar(url, approvedOrigin, text),
  setRemoteImages: async (_, value) => { remoteImages = value === true; return true; },
  setLanguage: async (_, choice) => {
    if (choice !== "auto" && !languages.some(([code]) => code === choice)) throw new Error(t("语言无效。"));
    await atomicWrite(path.join(store.dataDir, "language"), choice);
    // will-navigate blocks a renderer location.reload(), so the main process reloads after replying.
    applyLanguage(choice); buildMenu(); setTimeout(() => window?.webContents.reload()); return true;
  },
  installTheme: async () => { const result = await dialog.showOpenDialog(window, { filters: [{ name: "CSS", extensions: ["css"] }], properties: ["openFile"] }); return result.canceled ? null : installTheme(result.filePaths[0], store.dataDir); },
  readResource: (_, address, project) => exportResource(address, store, path.join(root, "dist"), project === true),
  imageSizes: (_, id, sources) => imageSizes(store, id, sources),
  cleanConverted: async (_, body) => (await import("./clean-script.mjs")).runCleanScript(body),
  glass: async (_, request) => {
    if (request?.image?.path !== undefined) throw new Error("Desktop image magnets require image bytes.");
    if (glassRuntime.error) { glassRuntime.folder = null; glassRuntime.error = null; }
    await syncGlass(store?.folder ?? null);
    if (!glassRuntime.service) throw glassRuntime.error ?? new Error(t("请先打开文件夹并保存文档。"));
    const result = await glassRuntime.service.request(request);
    if (request.action === "bring" || request.action === "add" && request.anchor !== undefined && request.fields?.kind !== "comment") announceGlass(request);
    return result;
  },
  captureRegion: async (_, rect) => {
    if (!window) throw new Error(t("No window to capture."));
    if (!rect || typeof rect !== "object") throw new Error("Invalid capture region.");
    const box = ["x", "y", "width", "height"].map(key => Math.round(Number(rect[key])));
    if (box.some(value => !Number.isFinite(value)) || box[2] < 1 || box[3] < 1 || box[2] > 4096 || box[3] > 4096)
      throw new Error("Invalid capture region.");
    const image = await window.webContents.capturePage({ x: box[0], y: box[1], width: box[2], height: box[3] });
    const bytes = image.toPNG();
    if (!bytes.length) throw new Error(t("The capture came back empty."));
    return { base64: bytes.toString("base64"), mime: "image/png", width: image.getSize().width, height: image.getSize().height };
  },
  tutorBridge: async ({ sender }, id, request) => {
    // Offline QA and demo machines: a fixed reply keeps the Tutor bridge testable with no agent.
    const stub = process.env.OMARKIE_TUTOR_STUB?.trim();
    if (stub && request?.action === "submit") {
      let text = stub;
      try {
        const shaped = JSON.parse(stub);
        text = shaped?.redraw && /mermaid/i.test(String(request.question ?? "")) ? shaped.redraw : shaped?.rewrite ?? stub;
      } catch { /* plain text stays the reply */ }
      const reply = { type: "reply", lease: request.lease, id: "local-stub", text };
      setTimeout(() => { if (!sender.isDestroyed()) sender.send("tutor:event", reply); }, 0);
      return { id: "local-stub" };
    }
    if (request?.action === "detach" && !tutorLoading) return;
    tutorLoading ??= import("./tutor-session.mjs").then(module => { tutorSessions = module.tutorSessions(store); });
    await tutorLoading;
    return tutorSessions.request(sender, id, request);
  },
  glassState: async (_, request) => {
    if (!request || !["read", "write"].includes(request.action)) throw new Error("Invalid Glass request.");
    const { readGlass, writeGlass } = await import("./glass-state.mjs");
    await syncGlassWatch();
    if (!glassWatch.root) throw new Error(t("请先打开文件夹并保存文档。"));
    if (request.action === "write" && typeof request.visible !== "boolean") throw new Error("Invalid Glass request.");
    return { visible: request.action === "read" ? await readGlass(glassWatch.root) : await writeGlass(glassWatch.root, request.visible) };
  },
  readingStore: async (_, id, request) => {
    const { readingStore, readingMarkdown } = await import("./reading-store.mjs");
    if (request?.action !== "export") return readingStore(store, id, request);
    const entries = await readingStore(store, id, { action: "list", scope: "vault", types: ["note", "card", "scrap"], studyNotes: true });
    const result = await dialog.showSaveDialog(window, { defaultPath: t("阅读笔记.md"), filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (result.canceled) return false;
    try { await writeFile(result.filePath, readingMarkdown(entries), { encoding: "utf8", flag: "wx", mode: 0o600 }); }
    catch { throw new Error(t("无法导出。请选择新的文件名。")); }
    return true;
  },
  learningSearch: async (_, id, query) => (await import("./learning-index.mjs")).searchLearning(store, id, query),
  conversionSettings: async (_, choose) => { if (choose) { const result = await dialog.showOpenDialog(window, { title: t("选择 Pandoc 可执行文件"), properties: ["openFile"] }); if (!result.canceled) { await atomicWrite(path.join(store.dataDir, "pandoc-path"), result.filePaths[0]); process.env.OMARKIE_PANDOC = result.filePaths[0]; } } return { word: process.platform === "darwin", libreOffice: await libreOfficePath(), pandoc: await pandocPath() }; },
  importDocument: async () => { const result = await dialog.showOpenDialog(window, { title: t("导入文档"), properties: ["openFile"], filters: [{ name: t("文档"), extensions: ["docx", "doc", "rtf", "odt", "epub", "tex", "rst", "html", "txt"] }] }); return result.canceled ? null : convertImport(result.filePaths[0], store.dataDir); },
  vaultSnapshot: (_, chaptersOnly) => vaultSnapshot(store, chaptersOnly === true),
  bibliography: async (_, folder, action, value) => {
    if (!["info", "save", "link", "disconnect", "clear", "suggest", "open"].includes(action)) throw new Error(t("CSL JSON 书目无效"));
    if (!folder || folder !== store.folder) throw new Error(t("请先打开笔记文件夹"));
    if (action === "link") {
      const result = await dialog.showOpenDialog(window, { title: t("关联 Zotero 自动导出"), properties: ["openFile"], filters: [{ name: "CSL JSON", extensions: ["json"] }] });
      if (result.canceled) return false;
      value = result.filePaths[0];
    }
    const service = await vaultBibliography(folder);
    if (action === "link") { await service.run(action, value); return true; }
    if (action !== "open") return service.run(action, value);
    const file = await service.run("pdf", value);
    if (folder !== store.folder || !file || await shell.openPath(file)) throw new Error(t("无法打开引用的本地 PDF"));
  },
  exportBundle: async (_, payload) => { const result = await dialog.showOpenDialog(window, { title: t("导出 OKF 副本压缩包"), properties: ["openDirectory"] }); return result.canceled ? null : exportBundle(store, payload, result.filePaths[0]); },
  exportConverted: async (_, id, format, source, html, options) => {
    const project = id?.folder;
    if (project !== undefined && (typeof project !== "string" || project !== store.folder)) throw new Error(t("目录已更新，请刷新后重试。"));
    if (project ? !Array.isArray(source) || !["docx", "pdf"].includes(format) : typeof source !== "string") throw new Error(t("导出格式无效。"));
    const profile = store.dataDir;
    const ext = { latex: "tex", revealjs: "html", mediawiki: "wiki" }[format] || format;
    const defaultPath = project ? `${path.basename(project)}.${ext}` : store.require(id).name.replace(/\.[^.]+$/, "." + ext);
    const result = await dialog.showSaveDialog(window, project ? { defaultPath, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] } : { defaultPath });
    if (result.canceled) return null;
    const destination = project ? await projectDestination(project, result.filePath, ext) : result.filePath;
    return convertExport(profile, format, source, html, destination, options, async file => {
      const localPage = pathToFileURL(file).href;
      const preview = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, javascript: false, partition: "document-export-" + randomUUID() } });
      try {
        preview.webContents.session.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !(request.resourceType === "mainFrame" && request.url === localPage || request.url.startsWith("data:")) }));
        preview.webContents.on("will-navigate", event => event.preventDefault());
        preview.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
        if ((await stat(file)).size > 150 * 1024 * 1024) throw new Error(t("资源过大。"));
        const markup = await readFile(file, "utf8");
        await writeFile(file, `<meta http-equiv="Content-Security-Policy" content="${csp}">` + markup, "utf8");
        await preview.loadFile(file);
        return await preview.webContents.printToPDF({ printBackground: true, pageSize: "A4" });
      } finally { preview.destroy(); }
    });
  },
  imageAction: async (_, id, sources, action, options) => {
    store.require(id);
    if (!Array.isArray(sources) || !sources.length || sources.length > 200 || sources.some(source => typeof source !== "string") || !["copy", "move", "delete", "upload"].includes(action)) throw new Error(t("图片操作无效。"));
    let destination, directory;
    if (["copy", "move"].includes(action)) {
      if (sources.length > 1) { const result = await dialog.showOpenDialog(window, {title:t("选择图片目标文件夹"),properties:["openDirectory"]}); if (result.canceled) return null; directory = result.filePaths[0]; }
      else { const result = await dialog.showSaveDialog(window, {title:action === "move" ? t("移动或重命名图片") : t("复制图片"),defaultPath:imageName(sources[0])}); if (result.canceled) return null; destination = result.filePath; }
    }
    if (action === "delete") { const result = await dialog.showMessageBox(window,{type:"warning",message:t("删除图片文件？"),detail:t("图片文件会移到废纸篓，文档中的引用也会移除。"),buttons:[t("取消"),t("移到废纸篓")],defaultId:0,cancelId:0}); if(result.response !== 1) return null; }
    return imageAction({store,id,sources,action,options,destination,directory,trash:file=>shell.trashItem(file),notice:message=>window.webContents.send("app:command",{action:"notice",message})});
  },
  ready: async () => {
    if (traceStartup) {
      const marks = await window?.webContents.executeJavaScript('performance.getEntriesByType("mark").filter(mark => mark.name.startsWith("omarkie:")).map(mark => ({ name: mark.name, startTime: mark.startTime, origin: performance.timeOrigin }))');
      for (const mark of marks || []) console.log(`[startup] ${mark.name.slice(8)} ${(mark.origin + mark.startTime - performance.timeOrigin).toFixed(1)}ms`);
    }
    rendererReady = true; revealWindow(); openFiles(pendingPdfs.splice(0)); for (const file of pending.splice(0)) {
    if (isPdf(file)) { openFiles([file]); continue; }
    try { send({ action: "opened", document: await store.open(file) }); }
    catch (error) { showError(error); }
  } return true; },
  cancelClose: () => { closing = false; },
  recent: () => workspace.recent(),
  recentAction: async (_, action, file) => { if (action !== "open") return workspace.recentAction(action, file); const item = (await workspace.recent()).find(item => item.path === file); if (!item) throw new Error(t("最近项目已移除。")); await workspace.remember(file, item.folder); return item.folder ? store.scan(file) : store.open(file); },
  searchFiles: async (_, query, options) => {
    const inventory = await store.scan();
    const result = await workspace.search(inventory.files, query, { ...options, encodings: Object.fromEntries([...store.records.values()].filter(record => record.path).map(record => [record.path, record.encoding])) });
    return { ...result, skipped: result.skipped + inventory.skipped };
  },
  reveal: async (_, file) => shell.showItemInFolder(await workspace.authorize(file, store)),
  fileOperation: async (_, operation) => {
    if (operationRunning) throw new Error(t("另一个文件操作正在进行。")); operationRunning = true;
    try {
      if (operation.action === "trash") { const answer = await dialog.showMessageBox(window, { message: t("移到废纸篓？"), detail: operation.path, buttons: [t("取消"), t("移到废纸篓")], cancelId: 0 }); if (answer.response !== 1) return null; }
      if (!await prepareOperation("prepare", { removedPath: operation.action === "trash" ? operation.path : undefined })) throw new Error(t("文件操作已取消。"));
      const execute = move => workspace.execute(operation, store, file => shell.trashItem(file), move);
      const folder = operation.action === "undo" ? workspace.undo?.folder : store.folder;
      const change = ["rename", "move", "undo", "trash"].includes(operation.action)
        ? await (await import("./reading-store.mjs")).moveReadingEntries(folder, execute, operation.action === "trash" ? operation.path : undefined) : await execute();
      workspace.apply(change, store);
      await prepareOperation("commit", change); return change;
    } finally { try { await prepareOperation("release", {}); } finally { operationRunning = false; } }
  },
  restore: async () => {
    // Launch-file problems are reported in the window's message bar, never a modal box.
    const restored = await store.restore(), notices = [];
    if (pending.length) {
      const documents = [...(restored?.documents || [])];
      let activeId = restored?.activeId;
      for (const file of pending.splice(0)) {
        if (isPdf(file)) { pendingPdfs.push(file); continue; }
        try {
          const record = await store.open(file), index = documents.findIndex(item => item.id === record.id);
          if (index < 0) documents.push(record); else documents[index] = record;
          activeId = record.id;
          if (record.controlCharacters) notices.push(t("“{{name}}”含有 {{count}} 个控制字符，显示为 ␇ 等符号，保存时原样保留。", { name: record.name, count: record.controlCharacters }));
        } catch (error) { notices.push(error.message); }
      }
      if (documents.length) return { ...restored, documents, activeId, restoreError: [restored?.restoreError, ...notices].filter(Boolean).join(" ") || undefined };
    }
    let result = restored;
    if (!result) {
      const { documents, folder } = await openShowcase(store, showcaseSource(root), path.join(app.getPath("userData"), showcaseFolderName));
      result = { documents, activeId: documents[0].id, folder: folder.folder, readingRecoveryWarning: folder.readingRecoveryWarning };
    }
    prioritizeGlass(result?.documents?.find(document => document.id === result.activeId)?.path);
    return notices.length ? { ...result, restoreError: [result.restoreError, ...notices].filter(Boolean).join(" ") } : result;
  },
  showcase: async () => {
    const { documents, folder } = await openShowcase(store, showcaseSource(root), path.join(app.getPath("userData"), showcaseFolderName), [showcaseDocuments[0]]);
    return { ...folder, document: documents[0] };
  },
  draft: (_, record) => store.registerDraft(record),
  open: async () => {
    const result = await dialog.showOpenDialog(window, {
      title: t("打开 Markdown 文件"),
      properties: ["openFile"],
      filters: [{ name: "Markdown / PDF", extensions: ["md", "markdown", "mdown", "pdf"] }],
    });
    if (result.canceled) return null;
    const file = result.filePaths[0], record = isPdf(file) ? await openPdf(file) : await store.open(file);
    if (!record) return null;
    await workspace.remember(record.path);
    prioritizeGlass(record.path);
    return record;
  },
  folder: async () => {
    const result = await dialog.showOpenDialog(window, {
      title: t("打开笔记文件夹"),
      properties: ["openDirectory"],
    });
    if (result.canceled) return null;
    const scanned = await store.scan(result.filePaths[0]);
    await workspace.remember(scanned.folder, true);
    return scanned;
  },
  scan: () => store.scan(),
  token: async (_, token) => { const record = await store.openToken(token); await workspace.remember(record.path); prioritizeGlass(record.path); return record; },
  reopen: (_, id) => store.reload(id),
  writeClipboard: (_, text) => clipboard.writeText(String(text)),
  readClipboard: () => clipboard.readText(),
  chooseImage: async (_, id, options) => {
    store.require(id);
    const result = await dialog.showOpenDialog(window, { title: t("插入图片"), properties: ["openFile"], filters: [{ name: t("图片"), extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    return { path: await store.importImage(id, new Uint8Array(await readFile(file)), path.basename(file), options), alt: path.basename(file) };
  },
  html: async (_, name, html) => {
    const result = await dialog.showSaveDialog(window, { title: t("导出 HTML"), defaultPath: String(name).replace(/\.(?:md|markdown|mdown)$/i, "") + ".html", filters: [{ name: "HTML", extensions: ["html"] }] });
    if (result.canceled) return null;
    await atomicWrite(result.filePath, String(html)); return result.filePath;
  },
  confirmClose: async (_, name) => {
    const result = await dialog.showMessageBox(window, { type: "question", message: t("保存对“{{name}}”所做的修改？", { name: String(name).slice(0,150) }), buttons: [t("保存"), t("取消"), t("不保存")], defaultId: 0, cancelId: 1 });
    return ["save", "cancel", "discard"][result.response];
  },
  save: async (_, id, text, saveAs, force, options) => {
    const record = store.require(id);
    let destination;
    if (!record.path || saveAs) {
      const result = await dialog.showSaveDialog(window, {
        title: t("保存 Markdown 文件"),
        defaultPath: record.path ?? record.name,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (result.canceled) return null;
      destination = result.filePath;
    }
    if (force) {
      const result = await dialog.showMessageBox(window, {
        type: "warning",
        message: t("覆盖磁盘上的修改？"),
        detail: t("当前草稿将替换磁盘文件。也可以取消并另存为副本。"),
        buttons: [t("取消"), t("覆盖")],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return null;
    }
    return store.save(id, text, destination, force, options);
  },
  persist: (_, value) => store.persist(value),
  check: (_, id) => store.check(id),
  reload: (_, id, encoding) => store.reload(id, encoding),
  acceptDisk: async (_, id, content, hash) => {
    const disk = await store.check(id);
    if (!disk || disk.content !== content || disk.diskHash !== hash)
      throw new Error(t("磁盘内容已再次变化。"));
    return store.acceptDisk(id, content, hash, disk.bom, disk.encoding);
  },
  image: (_, id, bytes, name, options) => store.importImage(id, bytes, name, options),
  pdf: async (_, options = {}) => {
    const title = typeof options.title === "string" && options.title ? options.title : t("文档");
    const result = await dialog.showSaveDialog(window, {
      title: t("导出 PDF"),
      defaultPath: title.replace(/\.(?:md|markdown|mdown)$/i, "") + ".pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (result.canceled) return null;
    const margin = Math.max(18, Math.min(100, Number(options.margin) || 36)) / 72;
    const escape = text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
    // Same ${title}/${pageNo}/${totalPages}/${date} variables as the macOS exporter.
    const band = template => `<div style="font-size:9px;color:gray;width:100%;padding:0 ${margin}in">${escape(typeof template === "string" ? template : "").replaceAll("${title}", escape(title)).replaceAll("${pageNo}", '<span class="pageNumber"></span>').replaceAll("${totalPages}", '<span class="totalPages"></span>').replaceAll("${date}", '<span class="date"></span>')}</div>`;
    const data = await window.webContents.printToPDF({
      printBackground: true,
      pageSize: options.paper === "letter" ? "Letter" : "A4",
      margins: { top: margin, bottom: margin, left: margin, right: margin },
      displayHeaderFooter: Boolean(options.header || options.footer),
      headerTemplate: band(options.header), footerTemplate: band(options.footer),
    });
    await atomicWrite(result.filePath, data);
    return result.filePath;
  },
  link: async (_, url) => {
    const parsed = new URL(url);
    if (!["https:", "http:", "mailto:"].includes(parsed.protocol))
      throw new Error(t("链接类型不受支持。"));
    const result = await dialog.showMessageBox(window, {
      message: t("在浏览器中打开链接？"),
      detail: parsed.href,
      buttons: [t("取消"), t("打开")],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response === 1) await shell.openExternal(parsed.href);
  },
  documentLink: async (_, id, address) => {
    const record = store.require(id), relative = decodeURIComponent(String(address).split("#")[0]);
    if (!record.path || path.isAbsolute(relative) || relative.includes(":") || relative.includes("\\")) throw new Error(t("请先保存文档，并使用相对 Markdown 文件路径。"));
    const base = await realpath(path.dirname(record.path)), target = await realpath(path.resolve(base, relative));
    if (!target.startsWith(base + path.sep)) throw new Error(t("链接位于当前文档目录之外，请用“打开文件”选择目标。"));
    send({ action: "opened", document: await store.open(target) });
  },
  discard: async (_, name) => {
    const result = await dialog.showMessageBox(window, {
      type: "question",
      message: t("关闭「{{name}}」？", { name: String(name).slice(0, 150) }),
      detail: t("尚未保存的修改将从当前会话移除。"),
      buttons: [t("取消"), t("关闭")],
      defaultId: 0,
      cancelId: 0,
    });
    return result.response === 1;
  },
  dirty: (_, value) => {
    dirty = Boolean(value);
    if (process.platform === "darwin") window?.setDocumentEdited(dirty);
  },
};
app
  .whenReady()
  .then(async () => {
    startupMark("main-process-ready");
    if (process.platform !== "darwin" && !app.hasSingleInstanceLock()) return;
    store = new DocumentStore(app.getPath("userData"));
    await rm(path.join(store.dataDir, "learning-index"), { recursive: true, force: true }).catch(showError);
    workspace = new Workspace(app.getPath("userData"));
    if (!process.env.OMARKIE_PANDOC) process.env.OMARKIE_PANDOC = await readFile(path.join(store.dataDir, "pandoc-path"), "utf8").catch(() => "");
    applyLanguage(process.env.OMARKIE_LANGUAGE || (await readFile(path.join(store.dataDir, "language"), "utf8").catch(() => "auto")).trim());
    ipcMain.on("app:language", event => { event.returnValue = event.sender === window?.webContents ? { language, choice: languageChoice } : null; });
    const preferenceWrites = new Set();
    await Promise.all([["app:preferences", "preferences.json"], ["app:plugin-preferences", "plugin-preferences.json"]].map(async ([channel, name]) => {
      const file = path.join(store.dataDir, name);
      let saved = await readFile(file, "utf8").catch(error => {
        if (error.code !== "ENOENT") console.error(error);
        return null;
      });
      let pending = saved, writing;
      ipcMain.on(channel, (event, update) => {
        if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame) {
          event.returnValue = null;
          return;
        }
        if (update === undefined) { event.returnValue = pending; return; }
        event.returnValue = null;
        if (typeof update !== "string" || update.length > 128 * 1024) return;
        try {
          const value = JSON.parse(update);
          if (!value || typeof value !== "object" || Array.isArray(value)) return;
        } catch { return; }
        pending = update;
        if (pending === saved || writing) return;
        writing = (async () => {
          while (pending !== saved) {
            const snapshot = pending;
            await atomicWrite(file, snapshot);
            saved = snapshot;
          }
        })().catch(showError).finally(() => { preferenceWrites.delete(writing); writing = undefined; });
        preferenceWrites.add(writing);
      });
    }));
    let quitAfterPreferences = false;
    app.on("before-quit", event => {
      if (!preferenceWrites.size) return;
      event.preventDefault();
      if (quitAfterPreferences) return;
      quitAfterPreferences = true;
      void Promise.all(preferenceWrites).then(() => { quitAfterPreferences = false; app.quit(); });
    });
    // Glass records append asynchronously; a quit right after a click must not drop the last ones.
    let quitAfterGlass = false;
    app.on("before-quit", event => {
      if (!glassRuntime.service) return;
      event.preventDefault();
      if (quitAfterGlass) return;
      quitAfterGlass = true;
      void closeGlassRuntime().catch(() => {}).then(() => { quitAfterGlass = false; app.quit(); });
    });
    protocol.handle("omarkie", async request => {
      try {
        if (new URL(request.url).searchParams.get("token") !== pluginToken) throw new Error(t("插件会话无效。"));
        const { bytes, mime } = await pluginResource(request.url, store.dataDir);
        const headers = { "Content-Type": mime, "X-Content-Type-Options": "nosniff" };
        const origin = request.headers.get("origin");
        if (origin === "null" || origin === "file://" || (development && origin === new URL(development).origin)) headers["Access-Control-Allow-Origin"] = origin;
        return new Response(bytes, { headers });
      } catch { return new Response("Resource unavailable", { status: 404 }); }
    });
    const photoPreviews = new PhotoPreviews(path.join(store.dataDir, "photo-previews"),
      (file, width) => chromiumPreview(window.webContents, file, width), file => shell.trashItem(file));
    // Cold preview requests carry whole JPEGs. Give the first body a head start
    // without making later requests depend on an abandoned or stalled response.
    let previewTail = Promise.resolve();
    function reservePreview(signal) {
      const turn = previewTail;
      let release;
      const sent = new Promise(resolve => { release = resolve; });
      previewTail = turn.then(() => {
        if (signal.aborted) return;
        let timeout;
        const deadline = new Promise(resolve => { timeout = setTimeout(resolve, 1500); });
        return Promise.race([sent, deadline]).finally(() => clearTimeout(timeout));
      });
      return { turn, release };
    }
    protocol.handle("omarkie-asset", async (request) => {
      try {
        const url = new URL(request.url), width = Number(url.searchParams.get("preview"));
        const [id, ...rest] = url.pathname.slice(1).split("/");
        const file = await store.asset(
          decodeURIComponent(id),
          decodeURIComponent(rest.join("/")),
        );
        const served = await photoPreviews.get(file, width);
        const source = pathToFileURL(served).href;
        if (served === file && /\.jpe?g$/i.test(file) && previewWidths.includes(width)) {
          const { size } = await stat(file);
          const abort = new AbortController(), { signal } = abort;
          const { turn, release } = reservePreview(signal);
          let reader;
          const body = new ReadableStream({
            async pull(controller) {
              try {
                if (!reader) {
                  await turn;
                  if (signal.aborted) return;
                  const response = await net.fetch(source, { signal });
                  if (!response.ok || !response.body) throw new Error("Image unavailable");
                  reader = response.body.getReader();
                }
                const { done, value } = await reader.read();
                if (signal.aborted) return;
                if (!done) { controller.enqueue(value); return; }
                controller.close();
                release();
              } catch (error) {
                controller.error(error);
                release();
              }
            },
            cancel() { abort.abort(); release(); },
          }, { highWaterMark: 0 });
          return new Response(body, { headers: { "Content-Type": "image/jpeg", "Content-Length": String(size), "Cache-Control": "no-store" } });
        }
        const response = await net.fetch(source);
        if (!url.searchParams.has("preview") || served !== file) return response;
        // The original stands in until the preview exists; keep Chromium from reusing it for this preview URL.
        const headers = new Headers(response.headers); headers.set("Cache-Control", "no-store");
        return new Response(response.body, { status: response.status, headers });
      } catch {
        return new Response("Image unavailable", { status: 404 });
      }
    });
    session.defaultSession.setSpellCheckerDictionaryDownloadURL(dictionaryDownloadURL(dictionarySource(root)));
    const devOrigin = development ? new URL(development).origin : null;
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) =>
      callback({ cancel: !!window && details.webContentsId === window.webContents.id && blocksRequest(details.url, devOrigin, remoteImages) }));
    for (const [name, handler] of Object.entries(handlers))
      ipcMain.handle(`document:${name}`, async (event, ...args) => {
        if (
          event.sender !== window?.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          return { ok: false, error: t("来源无效。") };
        try {
          return { ok: true, value: await handler(event, ...args) };
        } catch (error) {
          return { ok: false, error: error.message, code: error.code };
        }
        finally {
          if (bibliography && bibliography.root !== store.folder) releaseBibliography();
          void syncGlass(store?.folder ?? null).catch(() => { /* the glass handler reports its own error */ });
        }
      });
    function createWindow() {
      window = new BrowserWindow({
        show: process.env.OMARKIE_TEST_HIDDEN !== "1",
        width: 1380,
        height: 960,
        minWidth: 660,
        minHeight: 500,
        title: "Omarkie",
        ...(process.platform === "darwin" ? {
          titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 9 },
        } : {}),
        ...(process.platform === "linux" ? { icon: path.join(root, "icon.png") } : {}),
        backgroundColor: "#FFFFFF",
        webPreferences: {
          backgroundThrottling: process.env.OMARKIE_TEST_HIDDEN !== "1",
          preload: path.join(root, "electron/preload.cjs"),
          v8CacheOptions: "code",
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      const created = window;
      let paintReady = false, revealing = false;
      revealWindow = () => {
        if (!paintReady || !rendererReady || revealing || created.isDestroyed()) return;
        revealing = true;
        void created.webContents.executeJavaScript('getComputedStyle(document.documentElement).getPropertyValue("--paper").trim()').catch(() => "").then(color => {
          if (created.isDestroyed()) return;
          if (/^#[0-9a-f]{3,8}$/i.test(color)) created.setBackgroundColor(color);
          if (process.env.OMARKIE_TEST_HIDDEN !== "1") { created.show(); startupMark("window-shown"); }
        });
      };
      created.once("ready-to-show", () => { paintReady = true; revealWindow(); });
      session.defaultSession.setPermissionRequestHandler((_, __, callback) =>
        callback(false),
      );
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const contents = created.webContents;
      contents.on("render-process-gone", () => { stopSpeech(); detachTutor(contents); });
      contents.on("did-start-navigation", details => { if (details.isMainFrame && !details.isSameDocument) detachTutor(contents); });
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      if (process.platform === "linux") window.setMenuBarVisibility(false);
      if (development) window.loadURL(development);
      else window.loadFile(path.join(root, "dist/index.html"));
      window.on("close", (event) => {
        if (!closing && dirty) {
          event.preventDefault();
          send("quit");
        }
      });
      window.on("focus", () => { void glassRuntime.sync?.focus().catch(() => {}); });
      window.on("closed", () => {
        stopSpeech();
        detachTutor(contents);
        window = null;
        rendererReady = false;
        releaseBibliography();
      });
    }
    ipcMain.handle("app:close", (event) => {
      if (event.sender === window?.webContents) {
        closing = true;
        window.close();
        app.quit();
      }
    });
    // The Glass bridge exists before the document is usable; an agent's first CLI call never races a cold start.
    void syncGlass(store?.folder ?? null).catch(() => { /* scheduleGlassRetry retries it */ });
    createWindow();
    const command = (action) => item => {
      if (item?.type === "checkbox") item.checked = viewChecked[action] === true;
      send(action);
    };
    const groups = JSON.parse(await readFile(path.join(root, "shared/commands.json"), "utf8"));
    menuDefinitions = groups.flatMap(group => group.items);
    const roles = { "cut:": "cut", "copy:": "copy", "paste:": "paste", "selectAll:": "selectAll" };
    // A bare letter would become an application accelerator and swallow typing; the renderer
    // binds those itself so text fields keep priority.
    const accelerator = key => /^[A-Za-z]$/.test(key ?? "") ? undefined : key?.replaceAll("Mod-", "CommandOrControl+").replaceAll("Ctrl-", "Control+").replaceAll("Alt-", "Alt+").replaceAll("Shift-", "Shift+");
    buildMenu = () => Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "Omarkie", submenu: [{ label: t("关于 Omarkie"), click: command("about") }, { label: t("偏好设置…"), accelerator: "CommandOrControl+,", click: command("preferences") }, ...(process.platform === "darwin" ? [{ type: "separator" }, { role: "hide", label: t("隐藏 Omarkie") }, { role: "hideOthers", label: t("隐藏其他应用") }] : []), { type: "separator" }, { label: t("退出 Omarkie"), accelerator: "CommandOrControl+Q", click: command("quit") }] },
      ...groups.map(group => ({ label: t(group.title), submenu: group.items.filter(item => !["preferences", "newWindow", "newTab"].includes(item.action)).map(item => ({ id: item.action, label: t(item.label), enabled: commandEnabled(item), ...(checkedActions.includes(item.action) ? { type: "checkbox", checked: viewChecked[item.action] === true } : {}), accelerator: accelerator(process.platform === "darwin" ? item.key : item.pcKey ?? item.key), ...(item.selector ? { role: roles[item.selector] } : { click: command(item.action) }) })) })),
      { role: "windowMenu", label: t("窗口") }
    ]));
    buildMenu();
    if (process.platform === "linux") watchOmarchyTheme(() => send("omarchy-theme"));
    app.on("activate", () => {
      if (!window) {
        closing = false;
        createWindow();
      }
    });
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit();
    });
    app.on("will-quit", () => { void closeGlassRuntime(); });
  })
  .catch((error) => {
    console.error(error);
    app.quit();
  });
