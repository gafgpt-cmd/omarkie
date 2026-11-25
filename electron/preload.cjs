const { contextBridge, ipcRenderer } = require("electron");
const call = (name, ...args) => ipcRenderer.invoke(`document:${name}`, ...args);
contextBridge.exposeInMainWorld("desktop", {
  viewState: (focus, typewriter, sidebar, checked, disabled, context) => call("viewState", focus, typewriter, sidebar, checked, disabled, context),
  language: () => ipcRenderer.sendSync("app:language"), setLanguage: choice => call("setLanguage", choice),
  loadPreferences: () => ipcRenderer.sendSync("app:preferences"),
  // Hand off before the renderer can close. Main writes to disk asynchronously.
  savePreferences: value => ipcRenderer.sendSync("app:preferences", value),
  loadPluginPreferences: () => ipcRenderer.sendSync("app:plugin-preferences"),
  savePluginPreferences: value => ipcRenderer.sendSync("app:plugin-preferences", value),
  payloadRequest: request => call("payloadRequest", request),
  payloadKey: (baseUrl, value) => call("payloadKey", baseUrl, value),
  readResource: (address, project) => call("readResource", address, project),
  imageSizes: (id, sources) => call("imageSizes", id, sources),
  background: () => call("background"), chooseBackground: () => call("chooseBackground"), clearBackground: () => call("clearBackground"),
  plugins: () => call("plugins"), installPlugin: folder => call("installPlugin", folder), removePlugin: id => call("removePlugin", id),
  themes: () => call("themes"), omarchyTheme: () => call("omarchyTheme"), editRole: role => call("editRole", role), setRemoteImages: value => call("setRemoteImages", value), installTheme: () => call("installTheme"), conversionSettings: choose => call("conversionSettings", choose), importDocument: () => call("importDocument"), exportConverted: (id, format, source, html, options) => call("exportConverted", id, format, source, html, options), imageAction: (id, sources, action, options) => call("imageAction", id, sources, action, options),
  spellcheckLanguages: languages => call("spellcheckLanguages", languages),
  readAloud: text => call("readAloud", text),
  checkGrammar: (url, approvedOrigin, text) => call("checkGrammar", url, approvedOrigin, text),
  ready: () => call("ready"),
  cancelClose: () => call("cancelClose"),
  fileOperation: operation => call("fileOperation", operation),
  recent: () => call("recent"),
  recentAction: (action, path) => call("recentAction", action, path),
  searchFiles: (query, options) => call("searchFiles", query, options),
  reveal: path => call("reveal", path),
  onFileOperation: callback => { const listener = async (_, id, phase, change) => { try { ipcRenderer.send("workspace:prepared", id, await callback(phase, change)); } catch { ipcRenderer.send("workspace:prepared", id, false); } }; ipcRenderer.on("workspace:operation", listener); return () => ipcRenderer.removeListener("workspace:operation", listener); },
  restore: () => call("restore"),
  registerDraft: (record) => call("draft", record),
  open: () => call("open"),
  openFolder: () => call("folder"),
  showcase: () => call("showcase"),
  scan: () => call("scan"),
  readingStore: (id, request) => call("readingStore", id, request),
  glassState: request => call("glassState", request),
  onGlass: callback => {
    const listener = (_, event) => callback(event);
    ipcRenderer.on("glass:event", listener);
    return () => ipcRenderer.removeListener("glass:event", listener);
  },
  tutorBridge: (id, request) => call("tutorBridge", id, request),
  onTutor: callback => {
    const listener = (_, event) => callback(event);
    ipcRenderer.on("tutor:event", listener);
    return () => ipcRenderer.removeListener("tutor:event", listener);
  },
  learningSearch: (id, query) => call("learningSearch", id, query),
  glass: request => call("glass", request),
  captureRegion: rect => call("captureRegion", rect),
  ocrAvailable: () => call("ocrAvailable"),
  glassOcr: request => call("glassOcr", request),
  exportGlass: request => call("glassExport", request),
  importGlass: () => call("glassImport"),
  sharedGlass: note => call("sharedGlass", note),
  sharedGlassState: request => call("sharedGlassState", request),
  onGlassChanged: callback => {
    const listener = (_, event) => callback(event);
    ipcRenderer.on("glass:changed", listener);
    return () => ipcRenderer.removeListener("glass:changed", listener);
  },
  onGlassStorage: callback => {
    const listener = (_, status) => callback(status);
    ipcRenderer.on("glass:storage", listener);
    return () => ipcRenderer.removeListener("glass:storage", listener);
  },
  vaultSnapshot: chaptersOnly => call("vaultSnapshot", chaptersOnly),
  bibliography: (folder, action, value) => call("bibliography", folder, action, value),
  exportBundle: payload => call("exportBundle", payload),
  cleanConverted: body => call("cleanConverted", body),
  openToken: (token) => call("token", token),
  reopen: id => call("reopen", id),
  chooseImage: (id, options) => call("chooseImage", id, options),
  exportHtml: (name, html) => call("html", name, html),
  writeClipboard: text => call("writeClipboard", text),
  readClipboard: () => call("readClipboard"),
  confirmClose: name => call("confirmClose", name),
  save: (id, text, saveAs = false, force = false, options) =>
    call("save", id, text, saveAs, force, options),
  persist: (session) => call("persist", session),
  check: (id) => call("check", id),
  reload: (id, encoding) => call("reload", id, encoding),
  acceptDisk: (id, content, hash) => call("acceptDisk", id, content, hash),
  importImage: (id, bytes, name, options) => call("image", id, bytes, name, options),
  exportPdf: (_html, options) => call("pdf", options),
  openLink: (url) => call("link", url),
  openDocumentLink: (id, url) => call("documentLink", id, url),
  confirmDiscard: (name) => call("discard", name),
  setDirty: (dirty) => call("dirty", dirty),
  closeWindow: () => ipcRenderer.invoke("app:close"),
  onCommand: (callback) => {
    const listener = (_, command) => callback(command);
    ipcRenderer.on("app:command", listener);
    return () => ipcRenderer.removeListener("app:command", listener);
  },
});
