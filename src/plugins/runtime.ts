import DOMPurify from "dompurify";
import { adaptThemeCss } from "../themes.ts";
import type { PluginDefinition, PluginState, PluginAction } from "./types.ts";
import { PluginEvents } from "./events.ts";
import { imeKey } from "../editor/composition.ts";
import { StateRecorder } from "./stateRecorder.ts";
import { t } from "../i18n.ts";

interface Options {
  getMarkdown(): string; getPath(): string | null; getSelection(): string;
  insert(text: string): void; replace(text: string): void;
  setReadOnly(value: boolean): void; notify(message: string): void;
  changed(id: string, state: PluginState): void;
  saveConfig(id: string, config: Record<string, any>): void;
  getDocumentId?(): string;
  getNumbered?(): { line: number; counter: string }[];
  composing?(): boolean;
  reservedHotkeys?: string[];
}
interface Running {
  definition: PluginDefinition; plugin: any; disposed: boolean;
  cleanup: (() => void)[]; styles: Map<string, HTMLStyleElement>;
  events: PluginEvents;
  shortcuts: { hotkey: string; callback: () => unknown }[];
  shortcutsPaused?: boolean;
  file: any;
  actionMeta?: Record<string,unknown>;
  recorder?: StateRecorder;
}
export function matchesHotkey(event: KeyboardEvent, shortcut: string, mac = /Mac/.test(navigator.platform)) {
  const parts = shortcut.toLowerCase().split(/[+-]/).map(x => x.trim()).filter(Boolean), key = parts.pop();
  const mod = parts.includes("mod"), meta = parts.includes("meta") || parts.includes("command") || (mod && mac);
  const ctrl = parts.includes("ctrl") || parts.includes("control") || (mod && !mac);
  const physical = event.code?.startsWith("Key") ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
  return key === physical && event.metaKey === meta && event.ctrlKey === ctrl && event.altKey === (parts.includes("alt") || parts.includes("option")) && event.shiftKey === parts.includes("shift");
}
// Export hooks outlive the component tree, like upstream's exportHelper; print.ts reads them while building the document.
const exportHelpers = new Map<string, { before?: (options: { type: string }) => unknown; failed(error: unknown): void }>();
export function pluginExportStyles(options: { type: string }) {
  let css = "";
  for (const helper of exportHelpers.values()) { try { const value = helper.before?.(options); if (typeof value === "string") css += value + "\n"; } catch (error) { helper.failed(error); } }
  return css ? adaptThemeCss(css).replace(/<\/style/gi, "<\\/style") : "";
}
// Spacers stand for blocks outside the rendered window; plugins must neither mark, style nor walk through them.
const isSpacer = (node: unknown) => node instanceof Element && node.classList.contains("md-window-spacer");
function hotkeySignature(shortcut: string, mac = /Mac/.test(navigator.platform)) {
  const parts = shortcut.toLowerCase().split(/[+-]/).map(value => value.trim()).filter(Boolean), key = parts.pop();
  const allowed = ["mod", "meta", "command", "ctrl", "control", "alt", "option", "shift"];
  if (!key || parts.some(part => !allowed.includes(part))) throw new Error(t("无法识别快捷键：{{shortcut}}", { shortcut }));
  return [parts.includes("meta") || parts.includes("command") || (mac && parts.includes("mod")), parts.includes("ctrl") || parts.includes("control") || (!mac && parts.includes("mod")), parts.includes("alt") || parts.includes("option"), parts.includes("shift"), key].join(":");
}
export class PluginRuntime {
  private running = new Map<string, Running>();
  private queues = new Map<string, Promise<void>>();
  private locks = new Set<Running>();
  private stopped = false;
  private observer: MutationObserver;
  private options: Options;
  private previousDocument: { id: string; path: string | null; text: string } | null = null;
  private anchor: Element | null = null;
  constructor(options: Options) {
    this.options = options;
    document.addEventListener("keydown", this.keydown, true);
    document.addEventListener("selectionchange", this.focus);
    this.observer = new MutationObserver(records => this.syncDOM(records));
    // data-window is re-set on every windowed render, so spacer records say when the window moved.
    this.observer.observe(document.getElementById("root") || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-window"] });
    this.syncDOM();
  }
  private write = () => document.querySelector<HTMLElement>('.document-editor:not([hidden]) .rich-document') || document.querySelector<HTMLElement>(".rich-document");
  private marked: HTMLElement | null = null;
  private focus = () => {
    const root = this.write(), anchor = window.getSelection()?.anchorNode;
    if (!root || !anchor || !root.contains(anchor)) return;
    this.anchor = anchor.nodeType === 1 ? anchor as Element : anchor.parentElement;
    let block = anchor.nodeType === 1 ? anchor as Element : anchor.parentElement;
    while (block?.parentElement && block.parentElement !== root) block = block.parentElement;
    if (!block || isSpacer(block) || block.parentElement !== root) block = null;
    if (block === this.focused) return;
    this.focused?.classList.remove("md-focus"); this.focused = block; block?.classList.add("md-focus");
  };
  private focused: Element | null = null;
  private windowStyle: HTMLStyleElement | null = null;
  private seeds = new Map<HTMLElement, string>();
  // Typora markers are only needed while a plugin runs, and the editor replaces whole blocks, so marking added nodes is enough.
  private syncDOM(records?: MutationRecord[]) {
    const root = this.write();
    for (const other of document.querySelectorAll('.rich-document[id="write"]')) if (other !== root) other.removeAttribute("id");
    if (!root) return;
    root.id = "write";
    if (!this.running.size) { this.marked = null; this.seeds.clear(); this.windowStyle?.remove(); this.windowStyle = null; return; }
    const partial = !!records && root === this.marked;
    const scopes = partial ? records.flatMap(record => [...record.addedNodes]).filter((node): node is Element => node.nodeType === 1 && root.contains(node)) : [root];
    this.marked = root;
    if (scopes.length) {
      for (const scope of scopes) this.mark(root, scope);
      for (const item of this.running.values()) item.recorder?.sync();
      this.focus();
    }
    const spacers = partial ? [...scopes, ...records.map(record => record.target)].filter((node): node is HTMLElement => isSpacer(node) && node.parentElement === root) : [...root.querySelectorAll<HTMLElement>(":scope > .md-window-spacer")];
    if (spacers.length || (partial && records.some(record => [...record.removedNodes].some(isSpacer)))) this.seedWindow(root, spacers);
  }
  // Windowed rendering replaces off-screen blocks with spacers, and CSS counters only see rendered blocks:
  // each spacer sets auto_number's counters to their values after the blocks it stands for, from the model.
  private seedWindow(root: HTMLElement, spacers: HTMLElement[]) {
    const numbered = spacers.length ? this.options.getNumbered?.() : undefined;
    for (const spacer of new Set(spacers)) {
      const line = Number((spacer.nextElementSibling as HTMLElement | null)?.dataset.line);
      if (!numbered || !line) { this.seeds.delete(spacer); continue; }
      const counts = new Map(["content-h1", "content-h2", "content-h3", "content-h4", "content-h5", "content-h6", "image", "fence"].map(name => [name, 0]));
      for (const item of numbered) if (item.line < line && counts.has(item.counter)) {
        counts.set(item.counter, counts.get(item.counter)! + 1);
        const level = Number(/^content-h(\d)$/.exec(item.counter)?.[1]);
        if (level < 6) counts.set(`content-h${level + 1}`, 0);
      }
      this.seeds.set(spacer, `.md-window-spacer[data-window="${spacer.dataset.window}"]{counter-set:${[...counts].map(([name, count]) => `${name} ${count}`).join(" ")}}`);
    }
    for (const spacer of this.seeds.keys()) if (spacer.parentElement !== root) this.seeds.delete(spacer);
    const css = [...this.seeds.values()].join("\n");
    if (!css) { this.windowStyle?.remove(); this.windowStyle = null; return; }
    if (!this.windowStyle) { this.windowStyle = document.createElement("style"); this.windowStyle.dataset.pluginWindow = ""; document.head.append(this.windowStyle); }
    if (this.windowStyle.textContent !== css) this.windowStyle.textContent = css;
  }
  private mark(root: HTMLElement, scope: Element) {
    const within = (selector: string) => [...(scope.matches(selector) ? [scope as HTMLElement] : []), ...scope.querySelectorAll<HTMLElement>(selector)];
    for (const child of scope === root ? root.children : scope.parentElement === root ? [scope] : []) if (!isSpacer(child)) { child.setAttribute("cid", child.getAttribute("data-cid") || child.getAttribute("data-leaf") || "block"); if (child !== this.focused) child.classList.remove("md-focus"); }
    for (const element of within("ul,ol")) { element.setAttribute("mdtype","list"); element.classList.add(element.tagName === "UL" ? "ul-list" : "ol-list"); }
    for (const element of within("h1,h2,h3,h4,h5,h6")) if (element.parentElement === root) { element.setAttribute("mdtype","heading"); element.classList.add("md-heading"); }
    for (const element of within("table")) element.classList.add("md-table");
    const aliases: Record<string, string> = { s: "del", sub: "subscript", sup: "superscript", math: "inline_math", mark: "highlight" };
    for (const inline of within(".md-inline[data-mark]")) {
      const mark = inline.dataset.mark!; inline.setAttribute("md-inline", aliases[mark] || mark);
      inline.classList.add("md-pair-s");
      if (mark === "image") inline.classList.add("md-image", "md-img-loaded");
      if (mark === "link") inline.classList.add("md-link");
      if (mark === "math") inline.classList.add("md-inline-math");
    }
  }
  documentChanged() {
    if (this.options.composing?.()) return;
    this.syncDOM(this.observer.takeRecords());
    const next = { id: this.options.getDocumentId?.() || this.options.getPath() || "untitled", path: this.options.getPath(), text: this.options.getMarkdown() };
    const previous = this.previousDocument;
    this.previousDocument = next;
    for (const item of this.running.values()) {
      item.file?.freshLock();
      if (!previous || previous.id !== next.id || previous.path !== next.path) {
        for (const type of ["beforeFileOpen", "fileOpened", "otherFileOpened", "fileContentLoaded"]) this.publish(item, type, next.path);
      } else if (previous.text !== next.text) this.publish(item, "fileEdited", next.path);
    }
  }
  event(name: string, ...args: any[]) { for (const item of this.running.values()) this.publish(item,name,...args); }
  actions(id: string): PluginAction[] {
    const item=this.running.get(id); if (!item || item.disposed) return [];
    const meta={}, root=this.write(), anchor=this.anchor && root?.contains(this.anchor) ? this.anchor : root;
    try {
      const list=[...(item.plugin.staticActions || []), ...(item.plugin.getDynamicActions?.(anchor,meta) || [])];
      item.actionMeta=meta;
      return list.filter(action=>typeof action.act_value==='string' && !action.act_hidden).map(action=>({value:action.act_value,name:String(action.act_name || action.act_value),disabled:!!action.act_disabled,checked:typeof action.act_state==='boolean'?action.act_state:undefined}));
    } catch(error) {void this.fail(item,error);return [];}
  }
  private publish(item: Running, name: string, ...args: any[]) {
    if (!item.disposed) item.events.emit(name,...args);
  }
  private keydown = (event: KeyboardEvent) => {
    if (imeKey(event) || this.options.composing?.() || (event.target instanceof Element && event.target.closest('input,textarea,select,[role="dialog"]'))) return;
    for (const item of this.running.values()) for (const shortcut of item.shortcutsPaused ? [] : item.shortcuts) {
      if (matchesHotkey(event, shortcut.hotkey)) {
        event.preventDefault(); event.stopImmediatePropagation();
        void this.invoke(item.definition.id, undefined, shortcut.callback); return;
      }
    }
  };
  private async fail(item: Running, error: unknown) {
    if (item.disposed) return;
    await this.dispose(item);
    if (this.stopped || this.running.has(item.definition.id)) return;
    this.options.changed(item.definition.id, { enabled: false, status: "error", error: error instanceof Error ? error.message : String(error) });
  }
  private context(item: Running) {
    const own = (cleanup: () => void) => { if (item.disposed) cleanup(); else item.cleanup.push(cleanup); };
    const insert = (...args: any[]) => { const text = args.length > 1 ? args[1] : args[0]; if (!item.disposed && typeof text === "string") this.options.insert(text); };
    const proxies = new WeakMap<object, object>(), tracked = new WeakMap<object, any>(), listeners = new WeakMap<EventListener, EventListener>(), restored = new WeakMap<object, Set<PropertyKey>>();
    const recorder = new StateRecorder(this.write, () => this.options.getDocumentId?.() || this.options.getPath() || "untitled");
    item.recorder = recorder; own(() => recorder.clear());
    const unwrap = (value: any) => (value && typeof value === "object" && proxies.get(value)) || value;
    // Nodes reached from a tracked node stay tracked, so class, style and listener changes made through them are undone on unload.
    const wrap = (value: any) => value instanceof Element ? track(value) : value;
    const listener = (fn: EventListener) => { let wrapped = listeners.get(fn); if (!wrapped) { wrapped = event => fn.call(wrap(event.currentTarget), new Proxy(event, { get: (event, key) => { const value = Reflect.get(event, key, event); return typeof value === "function" ? value.bind(event) : wrap(value); } })); listeners.set(fn, wrapped); } return wrapped; };
    const track = <T extends object>(target: T): T => { target = unwrap(target); if (tracked.has(target)) return tracked.get(target); const proxy = new Proxy(target, { get: (object, key) => {
      if (key === "addEventListener") return (name: string, fn: EventListener, opts?: boolean | AddEventListenerOptions) => { const wrapped = typeof fn === "function" ? listener(fn) : fn; (object as EventTarget).addEventListener(name, wrapped, opts); own(() => (object as EventTarget).removeEventListener(name, wrapped, opts)); };
      if (key === "removeEventListener") return (name: string, fn: EventListener, opts?: boolean | AddEventListenerOptions) => (object as EventTarget).removeEventListener(name, listeners.get(fn) || fn, opts);
      if (key === "style") {
        const style = (object as HTMLElement).style;
        return new Proxy(style, { get: (style, prop) => { const value = Reflect.get(style, prop, style); return typeof value === "function" ? value.bind(style) : value; }, set: (style, prop, value) => {
          if (item.disposed || isSpacer(object)) return true;
          const seen = restored.get(style) || new Set<PropertyKey>(); restored.set(style, seen);
          if (!seen.has(prop)) { seen.add(prop); const previous = Reflect.get(style, prop, style); own(() => { Reflect.set(style, prop, previous, style); }); }
          return Reflect.set(style, prop, value, style);
        } });
      }
      if (key === "classList") {
        const list = (object as Element).classList;
        return new Proxy(list, { get(list, prop) {
          if (["add", "remove", "toggle"].includes(String(prop))) return (...args: any[]) => {
            if (item.disposed || isSpacer(object)) return;
            const names = prop === "toggle" ? [args[0]] : args;
            const previous = names.map(name => list.contains(name));
            const result = (list[prop as "toggle"] as any)(...args);
            own(() => names.forEach((name, i) => list.toggle(name, previous[i]))); return result;
          };
          const value = Reflect.get(list, prop, list); return typeof value === "function" ? value.bind(list) : value;
        } });
      }
      const value = Reflect.get(object, key, object);
      if (typeof key === "string" && key.endsWith("Sibling") && isSpacer(value)) return null;
      return typeof value === "function" ? (...args: any[]) => wrap(value.apply(object, args.map(unwrap))) : wrap(value);
    } }); proxies.set(proxy, target); tracked.set(target, proxy); return proxy; };
    // Native DOM APIs reject Proxy arguments; plugins get versions that unwrap tracked nodes and disconnect on unload.
    const observed = (name: string) => {
      const Base = (window as any)[name]; if (typeof Base !== "function") return undefined;
      return class extends Base {
        constructor(...args: any[]) { super(...args); own(() => this.disconnect()); }
        observe(target: any, ...rest: any[]) { return super.observe(unwrap(target), ...rest); }
        unobserve(target: any) { return super.unobserve?.(unwrap(target)); }
      };
    };
    const observers = { MutationObserver: observed("MutationObserver"), ResizeObserver: observed("ResizeObserver"), IntersectionObserver: observed("IntersectionObserver"), getComputedStyle: (element: Element, pseudo?: string | null) => window.getComputedStyle(unwrap(element), pseudo) };
    const scopedDocument = new Proxy(document, { get: (target, key) => {
      if (key === "documentElement" || key === "body") return track(target[key]);
      if (key === "querySelector") return (selector: string) => { const element = target.querySelector(selector); return element && track(element); };
      if (key === "addEventListener") return (name: string, fn: EventListener, opts?: boolean | AddEventListenerOptions) => { target.addEventListener(name, fn, opts); own(() => target.removeEventListener(name, fn, opts)); };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const insertStyle = (name: string, css: string) => {
      if (item.disposed) return;
      let style = item.styles.get(name);
      if (!style) { style = document.createElement("style"); style.dataset.plugin = item.definition.id; item.styles.set(name, style); document.head.append(style); }
      style.textContent = adaptThemeCss(css).replace(/(\d+)\s+ms\b/g, "$1ms");
    };
    const eventType = Object.fromEntries(["allPluginsHadInjected", "fileContentLoaded", "fileEdited", "beforeFileOpen", "fileOpened", "otherFileOpened", "beforeToggleSourceMode", "afterToggleSidebar", "toggleSettingPage", "outlineUpdated"].map(name => [name,name]));
    const on = (name: string, callback: (...args: any[]) => unknown, order = 0, once = false) =>
      item.disposed ? () => {} : item.events.on(name, callback, order, once);
    const activeTimers = new Map<number,boolean>();
    own(() => { for (const [id,repeat] of activeTimers) repeat ? window.clearInterval(id) : window.clearTimeout(id); activeTimers.clear(); });
    const timed = (repeat: boolean, callback: (...args: any[]) => unknown, delay = 0, ...args: any[]) => {
      if (item.disposed) return 0;
      const invoke = () => { if (!repeat) activeTimers.delete(id); if (!item.disposed) { try { Promise.resolve(callback(...args)).catch(error => this.fail(item,error)); } catch(error) { void this.fail(item,error); } } };
      const id = repeat ? window.setInterval(invoke,delay) : window.setTimeout(invoke,delay);
      activeTimers.set(id,repeat); return id;
    };
    const clearTimer = (id: number) => { window.clearTimeout(id); window.clearInterval(id); activeTimers.delete(id); };
    const timers = { setTimeout: (callback: (...args: any[]) => unknown, delay?: number, ...args: any[]) => timed(false,callback,delay,...args), setInterval: (callback: (...args: any[]) => unknown, delay?: number, ...args: any[]) => timed(true,callback,delay,...args), clearTimeout: clearTimer, clearInterval: clearTimer };
    const scopedWindow = new Proxy(window, { get(target,key) {
      if (key in timers) return timers[key as keyof typeof timers];
      if (key in observers) return observers[key as keyof typeof observers];
      if (key === "document") return scopedDocument;
      if (key === "addEventListener") return (name: string, fn: EventListener, opts?: boolean | AddEventListenerOptions) => { target.addEventListener(name,fn,opts); own(() => target.removeEventListener(name,fn,opts)); };
      const value = Reflect.get(target,key,target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const register = (bindings: any) => {
      if (item.disposed) return;
      for (const binding of Array.isArray(bindings) ? bindings : [bindings]) {
        if (Array.isArray(binding)) { register(binding); continue; }
        if (!binding?.hotkey || typeof binding.callback !== "function") continue;
        for (const hotkey of Array.isArray(binding.hotkey) ? binding.hotkey : [binding.hotkey]) {
          const signature = hotkeySignature(hotkey);
          if (this.options.reservedHotkeys?.some(key => hotkeySignature(key) === signature)) throw new Error(t("快捷键 {{hotkey}} 已被编辑器使用，请在插件设置中更换。", { hotkey }));
          for (const other of this.running.values()) if (other !== item && other.shortcuts.some(entry => hotkeySignature(entry.hotkey) === signature)) throw new Error(t("快捷键 {{hotkey}} 已被其他插件使用。", { hotkey }));
          item.shortcuts = item.shortcuts.filter(entry => hotkeySignature(entry.hotkey) !== signature);
          item.shortcuts.push({ hotkey, callback: binding.callback });
        }
      }
    };
    const file: any = {
      lock: () => { if (item.disposed) return; this.locks.add(item); this.options.setReadOnly(true); },
      unlock: () => { if (item.disposed) return; this.locks.delete(item); this.options.setReadOnly(this.locks.size > 0); },
      freshLock() {}, option: {},
      getFilePath: () => this.options.getPath(),
      editor: { getMarkdown: () => this.options.getMarkdown(), getValue: () => this.options.getMarkdown(), getSelection: () => this.options.getSelection(), insertText: insert },
    };
    Object.defineProperty(file, "isLocked", { configurable: true, enumerable: true, get: () => this.locks.size > 0, set: value => value ? file.lock() : file.unlock() });
    item.file = file;
    const entities = { get eWrite() { const root = document.getElementById("write"); if (!root) throw new Error(t("请先打开文档。")); return track(root); }, get eContent() { const content = document.querySelector(".writing-area"); return content && track(content); }, querySelectorInWrite: (selector: string) => { const element = [...(this.write()?.querySelectorAll(selector) || [])].find(element => !isSpacer(element)); return element ? track(element) : null; }, querySelectorAllInWrite: (selector: string) => [...(this.write()?.querySelectorAll(selector) || [])].filter(element => !isSpacer(element)).map(track) };
    const utils: any = {
      PLUGIN_LOAD_ABORT: Symbol("PLUGIN_LOAD_ABORT"), supportHasSelector: CSS.supports("selector(:has(*))"), entities,
      insertStyle, upsertStyle: insertStyle, replaceStyle: insertStyle, removeStyle: (name: string) => { item.styles.get(name)?.remove(); item.styles.delete(name); },
      notification: { show: (message: string) => { if (!item.disposed) this.options.notify(String(message)); } },
      eventHub: { eventType, on, addEventListener: on, off: item.events.off, removeEventListener: item.events.off, once: (name: string, callback: (...args: any[]) => unknown, order?: number) => on(name,callback,order,true), emit: (name: string, ...args: any[]) => { if (!item.disposed) this.event(name,...args); }, publishEvent: (name: string, ...args: any[]) => { if (!item.disposed) this.event(name,...args); } },
      hotkeyHub: { register, registerSingle: (hotkey: string | string[], callback: () => unknown) => register({hotkey,callback}), unregister: (hotkey: string) => { const signature = hotkeySignature(hotkey); item.shortcuts = item.shortcuts.filter(entry => hotkeySignature(entry.hotkey) !== signature); }, pause: () => { item.shortcutsPaused = true; }, resume: () => { item.shortcutsPaused = false; } },
      settings: {
        save: async (_name: string, values: Record<string, any>) => { if (item.disposed) return; Object.assign(item.plugin.config, values); this.options.saveConfig(item.definition.id, {...values}); },
        autoSave: (plugin: any) => { plugin.config = new Proxy(plugin.config, { set: (target,key,value) => { if (Object.is(target[key],value)) return true; Reflect.set(target,key,value); if (!item.disposed) this.options.saveConfig(item.definition.id,{...target}); return true; } }); },
      },
      stateRecorder: { register: (definition: any) => recorder.register({ ...definition, stateGetter: (element: Element) => definition.stateGetter(track(element)), stateRestorer: (element: Element, state: unknown) => definition.stateRestorer(track(element), state) }), unregister: recorder.unregister },
      // No eval under the content security policy; plugins fall back to their built-in behavior.
      safeEval: () => undefined,
      exportHelper: {
        register: (name: string, before?: (options: { type: string }) => unknown) => { if (item.disposed) return; const entry = { before, failed: (error: unknown) => void this.fail(item, error) }; exportHelpers.set(name, entry); own(() => { if (exportHelpers.get(name) === entry) exportHelpers.delete(name); }); },
        unregister: (name: string) => { exportHelpers.delete(name); }, registerNative() {}, unregisterNative() {},
      },
      metaKeyPressed: (event: MouseEvent) => /Mac/.test(navigator.platform) ? event.metaKey : event.ctrlKey,
      modifierKey: (shortcut: string) => { const parts = shortcut.toLowerCase().split(/[+-]/).map(part => part.trim()); return (event: MouseEvent) => event.shiftKey === parts.includes("shift") && event.altKey === parts.includes("alt") && utils.metaKeyPressed(event) === (parts.includes("ctrl") || parts.includes("mod")); },
      compareVersion: (a: string, b: string) => { const x = String(a).split("."), y = String(b).split("."); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (Number(x[i]) || 0) - (Number(y[i]) || 0); if (d) return d > 0 ? 1 : -1; } return 0; },
      chromeVersion: /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] || "0",
      getStyleText: (name: string) => item.styles.get(name)?.textContent || "",
      getPlugin: (id: string) => this.running.get(id)?.plugin, getPluginFn: (id: string, fn: string) => { const plugin = this.running.get(id)?.plugin; return plugin?.[fn]?.bind(plugin); },
      callPluginFn: (id: string, fn: string, ...args: any[]) => { const plugin = this.running.get(id)?.plugin; return plugin?.[fn]?.(...args); },
      getCurrentFilePath: () => this.options.getPath(), getFilePath: () => this.options.getPath(), getCurrentFileContent: () => this.options.getMarkdown(),
      getSelection: () => this.options.getSelection(), insertText: insert,
      editCurrentFile: async (change: (text: string) => string) => {
        if (item.disposed) return;
        const text = change(this.options.getMarkdown());
        if (!item.disposed) this.options.replace(text);
      },
      waitUntil: async (predicate: () => any, interval = 30, timeout = 3000) => { for (let i = 0; !item.disposed && i <= Math.ceil(timeout / Math.max(1, interval)); i++) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, interval)); } throw new Error(t("插件等待的编辑器接口不可用。")); },
      debounce: (callback: (...args: any[]) => unknown, delay = 100) => { let timer: number; return (...args: any[]) => { timers.clearTimeout(timer); timer = timers.setTimeout(callback,delay,...args); }; },
      throttle: (callback: (...args: any[]) => unknown, delay = 100) => { let last = -Infinity; return (...args: any[]) => { const now = Date.now(); if (!item.disposed && now-last >= delay) { last=now; return callback(...args); } }; },
      decorator: { afterCall: (target: () => any, name: string, callback: (...args: any[]) => void) => {
        if (item.disposed) return;
        const object = target(); if (!object) return; const original = object[name]; if (typeof original !== "function") throw new Error(t("尚不支持接口：{{name}}", { name }));
        object[name] = function(...args: any[]) { const result = original.apply(this, args); if (!item.disposed) callback(result, ...args); return result; };
        own(() => { object[name] = original; });
      } },
    };
    class BasePlugin {
      fixedName: string; config: any; i18n: any; utils = utils; pluginName: string;
      constructor(name: string, config: any, i18n: any) { this.fixedName = name; this.config = config; this.i18n = i18n; this.pluginName = config.NAME || item.definition.name; }
      prepare() {} init() {} style() {} html() {} hotkey() {} process() {} postprocess() {} call(_action?: string, _meta?: any) {}
    }
    const jquery = (selector: string | Element) => {
      const nodes: HTMLElement[] = typeof selector === "string" ? [...document.querySelectorAll<HTMLElement>(selector)] : selector ? [unwrap(selector)] : [];
      return { removeClass: (name: string) => nodes.forEach(node => track(node).classList.remove(name)), addClass: (name: string) => nodes.forEach(node => track(node).classList.add(name)), get: (i: number) => nodes[i], length: nodes.length };
    };
    class BaseCustomPlugin extends BasePlugin {
      callback(_anchor?: Element) {}
      call() { const anchor = window.getSelection()?.anchorNode?.parentElement || document.getElementById("write"); return this.callback(anchor || undefined); }
    }
    return { BasePlugin, BaseCustomPlugin, utils, File: file, $: jquery, document: scopedDocument, window: scopedWindow, ...timers, ...observers,
      require: (name: string) => { throw new Error(t("尚不支持模块「{{name}}」。当前兼容层不提供 Node/Electron 或外部模块。", { name })); } };
  }
  setEnabled(definition: PluginDefinition, enabled: boolean) {
    const previous = this.queues.get(definition.id) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (this.stopped) return;
      const current = this.running.get(definition.id);
      if (enabled && current && JSON.stringify(current.definition.config) === JSON.stringify(definition.config)) return;
      if (current) await this.dispose(current);
      if (!enabled) { this.options.changed(definition.id, { enabled: false, status: "disabled" }); return; }
      const item: Running = { definition: { ...definition, config: structuredClone(definition.config) }, plugin: null, disposed: false, cleanup: [], styles: new Map(), events: new PluginEvents(error => { void this.fail(item,error); }), shortcuts: [], file: null };
      this.running.set(definition.id, item); this.options.changed(definition.id, { enabled: true, status: "loading" });
      try {
        this.syncDOM();
        const factory = definition.factory || (definition.url ? (await import(/* @vite-ignore */ definition.url)).default : undefined);
        if (item.disposed || this.stopped) return;
        if (!factory) throw new Error(t("插件缺少入口。"));
        const context = this.context(item), Constructor = factory(context);
        if (typeof Constructor !== "function") throw new Error(t("插件需要导出 module.exports.plugin 类。"));
        const labels: Record<string,string> = { modeEnabled: t("已开启"), modeDisabled: t("已关闭"), pluginName: definition.name, "$label.RECORD_COLLAPSE": t("记住折叠状态"),
          "$label.ENABLE_OUTLINE": t("大纲编号"), "$label.ENABLE_CONTENT": t("正文编号"), "$label.ENABLE_TOC": t("目录编号"), "$label.ENABLE_TABLE": t("表格编号"), "$label.ENABLE_IMAGE": t("图片编号"), "$label.ENABLE_FENCE": t("代码块编号"),
          "act.collapse_all": t("折叠全部章节"), "act.expand_all": t("展开全部章节"), "act.collapse_others": t("折叠其他章节"), "act.toggle_current": t("折叠 / 展开当前章节"), "act.toggle_recursive": t("递归折叠 / 展开当前章节"), "act.toggle_siblings": t("折叠 / 展开同级章节"), "act.toggle_all_siblings": t("全局折叠 / 展开同级章节") };
        const label = (key: string, variables?: Record<string, unknown>) => (labels[key] || key).replace(/{{\s*(\w+)\s*}}/g, (match, name) => String(variables?.[name] ?? match));
        const plugin = new Constructor(definition.id, item.definition.config, { t: label, fillActions: (actions: any[], prefix = "act.") => actions.map(action=>({...action,act_name:action.act_name || labels[prefix + action.act_value] || action.act_value})) }); item.plugin = plugin;
        if (await plugin.prepare?.() === context.utils.PLUGIN_LOAD_ABORT) throw new Error(t("此插件不支持当前环境。"));
        if (item.disposed || this.stopped) return;
        const style = plugin.style?.(); if (typeof style === "string") context.utils.insertStyle(definition.id, style); else if (style) throw new Error(t("插件使用了尚未支持的外部样式资源。"));
        const html = plugin.html?.(); if (html) { const node = document.createElement("div"); node.innerHTML = DOMPurify.sanitize(html); document.body.append(node); item.cleanup.push(() => node.remove()); }
        context.utils.hotkeyHub.register(plugin.hotkey?.());
        await plugin.init?.();
        if (item.disposed || this.stopped) return;
        await plugin.process?.();
        if (item.disposed || this.stopped) return;
        await plugin.postprocess?.();
        this.publish(item, "allPluginsHadInjected");
        await Promise.resolve();
        if (!item.disposed && !this.stopped) this.options.changed(definition.id, { enabled: true, status: "ready" });
      } catch (error) { await this.fail(item, error); }
    });
    this.queues.set(definition.id, next); return next;
  }
  async invoke(id: string, action?: string, callback?: () => unknown) {
    const item = this.running.get(id); if (!item || item.disposed) return;
    try { await (callback ? callback() : item.plugin.call?.(action || (id === "static_markers" ? "toggle_state" : undefined), item.actionMeta)); } catch (error) { await this.fail(item, error); }
  }
  private async dispose(item: Running) {
    if (item.disposed) return;
    item.disposed = true;
    // Release effects before awaiting plugin teardown: its promise may outlive
    // a replacement instance, or never settle. Late host calls are inert.
    for (const cleanup of item.cleanup.reverse()) { try { cleanup(); } catch {} }
    for (const style of item.styles.values()) style.remove();
    item.events.clear(); item.shortcuts = [];
    this.locks.delete(item); this.options.setReadOnly(this.locks.size > 0);
    if (this.running.get(item.definition.id) === item) this.running.delete(item.definition.id);
    if (!this.running.size) { this.marked = null; this.seeds.clear(); this.windowStyle?.remove(); this.windowStyle = null; }
    const label = document.getElementById("footer-word-count-label"); if (!this.locks.size && label) delete label.dataset.value;
    try { await item.plugin?.destroy?.(); } catch { /* Owned resources were already released. */ }
  }
  async destroy() {
    this.stopped = true; this.observer.disconnect(); document.removeEventListener("keydown", this.keydown, true); document.removeEventListener("selectionchange", this.focus); this.windowStyle?.remove();
    const disposing = [...this.running.values()].map(item => this.dispose(item));
    await Promise.all([...this.queues.values(), ...disposing].map(task => task.catch(() => {})));
  }
}
