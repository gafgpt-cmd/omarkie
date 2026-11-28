// Capability broker for first-party Obsidian ports. A port sees only `utils.ports`: every call is checked against the
// grants in its catalog entry, Obsidian APIs outside that slice fail with a message naming the call, and the whole
// surface goes dead when the plugin is turned off.
import { t } from "../../i18n.ts";
import type { CardDraftSource } from "./srs-cards.ts";
import type { ReadingAPI } from "../reading/dom.ts";

export type Capability = "vault:read" | "note:read" | "note:open" | "cards:draft";
export interface PortSnapshot { notes: { relative: string; content: string }[]; assets: { relative: string }[]; truncated: boolean }
export interface ActiveNote { relative: string | null; content: string }
/** Host side, implemented by the app. Paths are relative to the open folder with `/` separators. */
export interface PortProvider {
  snapshot(): Promise<PortSnapshot>;
  activeNote(): ActiveNote;
  open(relative: string): Promise<boolean>;
  draftCards(drafts: CardDraftSource[], found: number): void;
}
/** What a port calls. */
export interface PortAPI {
  vault: { snapshot(): Promise<PortSnapshot> };
  note: { active(): ActiveNote; open(relative: string): Promise<boolean> };
  cards: { draft(drafts: CardDraftSource[], found: number): void };
}
/** The slice of the plugin runtime context the ports use. */
export interface PortUtils {
  ports: PortAPI;
  reading: ReadingAPI;
  insertStyle(name: string, css: string): void;
  notification: { show(message: string): void };
  eventHub: { on(name: string, callback: (...args: unknown[]) => unknown): void };
}
export interface PortPlugin { config: Record<string, unknown>; utils: PortUtils }
export interface PortContext { BasePlugin: new (name: string, config: Record<string, unknown>, i18n: unknown) => PortPlugin; utils: PortUtils }

export class CapabilityError extends Error {
  constructor(message: string) { super(message); this.name = "CapabilityError"; }
}

export function capabilityLabel(capability: Capability) {
  const labels: Record<Capability, () => string> = {
    "vault:read": () => t("Read notes in the open folder"),
    "note:read": () => t("Read the current note"),
    "note:open": () => t("Open notes"),
    "cards:draft": () => t("Propose study cards for review"),
  };
  return labels[capability]();
}

const network = () => t("Obsidian ports have no network access.");
const write = () => t("Obsidian ports cannot change files; notes stay read-only.");
const node = () => t("Node.js and shell access are not available.");
const internals = () => t("Obsidian app and workspace internals are not available.");
const view = () => t("Direct DOM, CSS and editor extensions are not available; Omarkie renders port output.");
const review = () => t("Ports only propose cards; you review and save them in Study cards.");
/** Obsidian calls a port might reach for, with the reason Omarkie refuses each. Keys are `namespace.member`. */
const DENIED: Record<string, () => string> = {
  requestUrl: network, request: network, fetch: network, XMLHttpRequest: network, WebSocket: network,
  require: node, process: node, shell: node, child_process: node,
  app: internals, workspace: internals, "workspace.getLeaf": internals, "workspace.activeLeaf": internals, metadataCache: internals, plugins: internals, fileManager: write,
  MarkdownRenderer: view, registerEditorExtension: view, registerMarkdownPostProcessor: view, registerMarkdownCodeBlockProcessor: view, registerView: view,
  addStyle: view, document: view, window: view, createEl: view, createDiv: view, createSpan: view,
  "vault.adapter": write, "vault.modify": write, "vault.create": write, "vault.createBinary": write, "vault.createFolder": write, "vault.delete": write,
  "vault.trash": write, "vault.rename": write, "vault.process": write, "vault.append": write, "vault.copy": write,
  "note.write": write, "note.replace": write, "note.modify": write, "note.setContent": write,
  "cards.save": review, "cards.put": review, "cards.schedule": review, "cards.answer": review,
};

/** Rejects anything that is not a plain path inside the open folder. */
export function folderPath(relative: unknown): string {
  const path = typeof relative === "string" ? relative.replaceAll("\\", "/") : "";
  if (!path || path.includes("\0") || /^(?:[a-zA-Z]:)?\//.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.split("/").some(part => part === ".." || part === "."))
    throw new CapabilityError(t("Path “{{path}}” is outside the open folder.", { path: String(relative) }));
  return path;
}

/** Builds the API one running port sees. `dispose` ends every grant, including calls still in flight. */
export function portHost(plugin: { name: string; capabilities?: readonly Capability[] }, provider?: PortProvider) {
  const grants = new Set(plugin.capabilities ?? []);
  let disposed = false;
  const live = () => { if (disposed) throw new CapabilityError(t("{{plugin}} is turned off; its access has ended.", { plugin: plugin.name })); };
  const need = (capability: Capability) => {
    live();
    if (!grants.has(capability)) throw new CapabilityError(t("{{plugin}} has no permission to: {{capability}}.", { plugin: plugin.name, capability: capabilityLabel(capability) }));
    if (!provider) throw new CapabilityError(t("Open a folder in the desktop app to use {{plugin}}.", { plugin: plugin.name }));
    return provider;
  };
  const after = async <T>(value: Promise<T>) => { const result = await value; live(); return result; };
  const api: PortAPI = {
    // Async members reject instead of throwing, so callers handle every refusal in one place.
    vault: { snapshot: async () => after(need("vault:read").snapshot()) },
    note: {
      active: () => need("note:read").activeNote(),
      open: async relative => { const host = need("note:open"); return after(host.open(folderPath(relative))); },
    },
    cards: {
      draft: (drafts, found) => {
        const host = need("cards:draft");
        if (!Array.isArray(drafts) || drafts.some(draft => typeof draft?.front !== "string" || typeof draft.back !== "string" || !draft.anchor))
          throw new CapabilityError(t("Card drafts need a question, an answer and a source."));
        host.draftCards(drafts, found);
      },
    },
  };
  const refuse = (name: string): never => {
    live();
    const reason = DENIED[name];
    throw new CapabilityError(reason ? t("{{call}} is not available: {{reason}}", { call: name, reason: reason() }) : t("{{call}} is not part of the Omarkie port API.", { call: name }));
  };
  // Symbols and `then` stay undefined so the API can be logged and awaited without tripping the guard.
  const guard = <T extends object>(target: T, prefix: string): T => new Proxy(target, {
    get(object, key) {
      if (typeof key === "symbol" || key === "then") return undefined;
      if (Object.hasOwn(object, key)) { const value = Reflect.get(object, key); return value && typeof value === "object" ? guard(value, `${prefix}${key}.`) : value; }
      return refuse(prefix + key);
    },
    set(_object, key) { return refuse(prefix + String(key)); },
    defineProperty(_object, key) { return refuse(prefix + String(key)); },
    deleteProperty(_object, key) { return refuse(prefix + String(key)); },
  });
  return { api: guard(api, ""), dispose: () => { disposed = true; } };
}
