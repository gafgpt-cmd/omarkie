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
import { imageAction, imageName } from "./image-actions.mjs";
import { libreOfficePath, pandocPath, convertExport, convertImport, themes, installTheme } from "./interchange.mjs";
import { Workspace } from "./workspace.mjs";
import { randomUUID } from "node:crypto";
import { atomicWrite, DocumentStore } from "./store.mjs";
import { readFile, realpath, stat } from "node:fs/promises";
import { launchFiles } from "./launch-files.mjs";
import { plugins, installPlugin } from "./plugins.mjs";
import { pluginResource, exportResource, imageSizes } from "./resources.mjs";
import { readBackground, saveBackground, clearBackground } from "./background.mjs";
import { readOmarchyTheme, watchOmarchyTheme } from "./omarchy.mjs";
import { languages, resolveLanguage } from "../shared/i18n.mjs";
import { t, useLanguage } from "./i18n.mjs";
import { blocksRequest } from "./network.mjs";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const development = process.env.OMARKIE_DEV_URL;
if (process.env.OMARKIE_DATA_DIR)
  app.setPath("userData", process.env.OMARKIE_DATA_DIR);
app.setName("Omarkie");
protocol.registerSchemesAsPrivileged([
  { scheme: "omarkie", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  {
    scheme: "omarkie-asset",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
let languageChoice = "auto", language = "zh", buildMenu = () => {}, remoteImages = false;
function applyLanguage(choice) {
  languageChoice = choice;
  language = resolveLanguage(choice, app.getPreferredSystemLanguages());
  useLanguage(language);
}
let window,
  store, workspace,
  dirty = false,
  closing = false;
const pending = [];
let rendererReady = false;
const pluginToken = randomUUID();
const authorizedPlugin = item => item && ({ ...item, url: item.url + "?token=" + pluginToken });
function openFiles(files) {
  for (const file of files) {
    if (window && rendererReady) store.open(file)
      .then(document => send({ action: "opened", document })).catch(showError);
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
const showError = (error) => dialog.showErrorBox("Omarkie", error.message);
const handshakes = new Map();
ipcMain.on("workspace:prepared", (event, id, value) => { if (event.sender !== window?.webContents) return; handshakes.get(id)?.(value); });
function prepareOperation(phase, change) { return new Promise((resolve, reject) => { const id = randomUUID(), timeout = setTimeout(() => { handshakes.delete(id); reject(new Error(t("文件操作等待超时。"))); }, 30000); handshakes.set(id, value => { clearTimeout(timeout); handshakes.delete(id); resolve(value); }); window.webContents.send("workspace:operation", id, phase, change); }); }
let operationRunning = false;
const handlers = {
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
  installPlugin: async (folder = false) => { const result = await dialog.showOpenDialog(window, folder ? { title: t("安装插件文件夹"), properties: ["openDirectory"] } : { filters: [{ name: "JavaScript", extensions: ["js", "cjs"] }], properties: ["openFile"] }); return result.canceled ? null : authorizedPlugin(await installPlugin(result.filePaths[0], store.dataDir)); },
  themes: () => themes(store.dataDir),
  omarchyTheme: () => readOmarchyTheme(),
  editRole: async (event, role) => { if (["cut", "copy", "paste", "selectAll"].includes(role)) event.sender[role](); },
  setRemoteImages: async (_, value) => { remoteImages = value === true; return true; },
  setLanguage: async (_, choice) => {
    if (choice !== "auto" && !languages.some(([code]) => code === choice)) throw new Error(t("语言无效。"));
    await atomicWrite(path.join(store.dataDir, "language"), choice);
    // will-navigate blocks a renderer location.reload(), so the main process reloads after replying.
    applyLanguage(choice); buildMenu(); setTimeout(() => window?.webContents.reload()); return true;
  },
  installTheme: async () => { const result = await dialog.showOpenDialog(window, { filters: [{ name: "CSS", extensions: ["css"] }], properties: ["openFile"] }); return result.canceled ? null : installTheme(result.filePaths[0], store.dataDir); },
  readResource: async (_, address) => exportResource(address,store,path.join(root,"dist")),
  imageSizes: (_, id, sources) => imageSizes(store, id, sources),
  conversionSettings: async (_, choose) => { if (choose) { const result = await dialog.showOpenDialog(window, { title: t("选择 Pandoc 可执行文件"), properties: ["openFile"] }); if (!result.canceled) process.env.OMARKIE_PANDOC = result.filePaths[0]; } return { word: process.platform === "darwin", libreOffice: await libreOfficePath(), pandoc: await pandocPath() }; },
  importDocument: async () => { const result = await dialog.showOpenDialog(window, { title: t("导入文档"), properties: ["openFile"], filters: [{ name: t("文档"), extensions: ["docx", "doc", "rtf", "odt", "epub", "tex", "rst", "html", "txt"] }] }); return result.canceled ? null : convertImport(result.filePaths[0], store.dataDir); },
  exportConverted: async (_, id, format, source, html) => { const record = store.require(id), ext = { latex: "tex", revealjs: "html", mediawiki: "wiki" }[format] || format; const result = await dialog.showSaveDialog(window, { defaultPath: record.name.replace(/\.[^.]+$/, "." + ext) }); return result.canceled ? null : convertExport(store.dataDir, format, source, html, result.filePath); },
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
  ready: async () => { rendererReady = true; for (const file of pending.splice(0)) {
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
      const change = await workspace.execute(operation, store, file => shell.trashItem(file)); workspace.apply(change, store);
      await prepareOperation("commit", change); return change;
    } finally { try { await prepareOperation("release", {}); } finally { operationRunning = false; } }
  },
  restore: async () => {
    const restored = await store.restore();
    if (restored) return restored;
    const localized = language === "zh" ? null : JSON.parse(await readFile(path.join(root, "shared/samples.i18n.json"), "utf-8"));
    const samples = localized ? localized[language] ?? localized.en : JSON.parse(
      await readFile(path.join(root, "shared/samples.json"), "utf-8"),
    );
    const folder = path.join(app.getPath("userData"), t("示例笔记"));
    const documents = [];
    for (const sample of samples) {
      const file = path.join(folder, sample.name);
      try {
        await readFile(file);
      } catch (error) {
        if (error.code === "ENOENT") await atomicWrite(file, process.platform !== "darwin" ? sample.content.replace(/⌘\s*/g, "Ctrl+") : sample.content);
        else throw error;
      }
      documents.push(await store.open(file));
    }
    await store.scan(folder);
    return { documents, activeId: documents[0].id, folder };
  },
  draft: (_, record) => store.registerDraft(record),
  open: async () => {
    const result = await dialog.showOpenDialog(window, {
      title: t("打开 Markdown 文件"),
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown"] }],
    });
    return result.canceled ? null : store.open(result.filePaths[0]);
  },
  folder: async () => {
    const result = await dialog.showOpenDialog(window, {
      title: t("打开笔记文件夹"),
      properties: ["openDirectory"],
    });
    return result.canceled ? null : store.scan(result.filePaths[0]);
  },
  scan: () => store.scan(),
  token: async (_, token) => { const record = await store.openToken(token); await workspace.remember(record.path); return record; },
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
    if (process.platform !== "darwin" && !app.hasSingleInstanceLock()) return;
    store = new DocumentStore(app.getPath("userData"));
    workspace = new Workspace(app.getPath("userData"));
    applyLanguage(process.env.OMARKIE_LANGUAGE || (await readFile(path.join(store.dataDir, "language"), "utf8").catch(() => "auto")).trim());
    ipcMain.on("app:language", event => { event.returnValue = event.sender === window?.webContents ? { language, choice: languageChoice } : null; });
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
    protocol.handle("omarkie-asset", async (request) => {
      try {
        const url = new URL(request.url);
        const [id, ...rest] = url.pathname.slice(1).split("/");
        const file = await store.asset(
          decodeURIComponent(id),
          decodeURIComponent(rest.join("/")),
        );
        return net.fetch(pathToFileURL(file).href);
      } catch {
        return new Response("Image unavailable", { status: 404 });
      }
    });
    const devOrigin = development ? new URL(development).origin : null;
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) =>
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
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      session.defaultSession.setPermissionRequestHandler((_, __, callback) =>
        callback(false),
      );
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
      window.on("closed", () => {
        window = null;
        rendererReady = false;
      });
    }
    ipcMain.handle("app:close", (event) => {
      if (event.sender === window?.webContents) {
        closing = true;
        window.close();
        app.quit();
      }
    });
    const command = (action) => () => send(action);
    const groups = JSON.parse(await readFile(path.join(root, "shared/commands.json"), "utf8"));
    const roles = { "cut:": "cut", "copy:": "copy", "paste:": "paste", "selectAll:": "selectAll" };
    const accelerator = key => key?.replaceAll("Mod-", "CommandOrControl+").replaceAll("Ctrl-", "Control+").replaceAll("Alt-", "Alt+").replaceAll("Shift-", "Shift+");
    buildMenu = () => Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "Omarkie", submenu: [{ label: t("关于 Omarkie"), click: command("about") }, { label: t("偏好设置…"), accelerator: "CommandOrControl+,", click: command("preferences") }, ...(process.platform === "darwin" ? [{ type: "separator" }, { role: "hide", label: t("隐藏 Omarkie") }, { role: "hideOthers", label: t("隐藏其他应用") }] : []), { type: "separator" }, { label: t("退出 Omarkie"), accelerator: "CommandOrControl+Q", click: command("quit") }] },
      ...groups.map(group => ({ label: t(group.title), submenu: group.items.filter(item => item.action !== "preferences").map(item => ({ label: t(item.label), accelerator: accelerator(process.platform === "darwin" ? item.key : item.pcKey ?? item.key), ...(item.selector ? { role: roles[item.selector] } : { click: command(item.action) }) })) })),
      { role: "windowMenu", label: t("窗口") }
    ]));
    buildMenu();
    createWindow();
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
  })
  .catch((error) => {
    console.error(error);
    app.quit();
  });
