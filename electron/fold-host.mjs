// `fold:*` IPC behind the renderer (design §4.1): resolves the note, the slot's route and the vault's online rule,
// then drives FoldService. A route that would send note text off the computer runs only when the user allowed that
// destination for the slot, and never in a never-online vault. Progress events go to `send`.

import { readFile } from "node:fs/promises";
import { foldRoute } from "../shared/fold-route.mjs";
import { SLOTS } from "../shared/fold-format.mjs";
import { properties } from "../shared/frontmatter.mjs";
import { languages } from "../shared/languages.mjs";
import { FoldBridge } from "./fold-bridge.mjs";
import { createFoldRunner } from "./fold-runner.mjs";
import { FoldService } from "./fold-service.mjs";
import { readGlassSettings } from "./glass-state.mjs";
import { t } from "./i18n.mjs";
import { requestFoldPayload } from "./payload.mjs";

const codes = new Set(languages.map(([code]) => code));
const noteIdPattern = /^[a-z0-9]{4,32}$/;
const fail = (message, code) => Object.assign(new Error(message), { code });

/** The user-facing reason a slot cannot fold now. */
export function foldRouteMessage(route) {
  if (route.code === "FOLD_ROUTE_LOCAL") return t("This slot folds locally: no model is called. Choose a route in Preferences → Fold.");
  if (route.code === "FOLD_OFFLINE") return t("This vault never goes online; only a loopback route can fold.");
  if (route.code === "FOLD_MODEL_UNSET") return t("Name a model for this fold slot in Preferences → Fold.");
  if (route.code === "FOLD_PAYLOAD_UNSET") return t("Configure and allow the Payload endpoint in Preferences.");
  if (route.code === "FOLD_EGRESS_UNCONFIRMED") return t("Allow this slot to send note text to {{destination}} in Preferences → Fold first.", { destination: route.egress.destination ?? "?" });
  return null;
}

// What the renderer may show: the route and where text goes. The Payload connection stays in main.
const routeView = route => ({ slot: route.slot, route: route.route, ...(route.agent ? { agent: route.agent } : {}), ...(route.model ? { model: route.model } : {}),
  egress: route.egress, ready: route.ready, code: route.code, message: foldRouteMessage(route) });

export class FoldHost {
  /**
   * @param {object} options
   * @param {() => any} options.glass the open GlassService of the current vault, or null.
   * @param {() => object | null} options.preferences parsed app preferences.
   * @param {() => string} options.language app language, the default fold language.
   * @param {(event: object) => void} options.send `fold:progress` sink.
   */
  constructor({ glass, preferences, language, send, appData, payload = requestFoldPayload, bridge = new FoldBridge(), concurrency = 2 }) {
    Object.assign(this, { glass, preferences, language, send, appData, bridge });
    this.service = new FoldService({ storeDir: () => glass()?.storeDir ?? null, runner: createFoldRunner({ bridge, payload: call => payload(call) }), concurrency });
    this.service.on("progress", event => send(event));
  }

  async #note(note, create) {
    const glass = this.glass();
    if (!glass) throw fail(t("Open a note folder before folding."), "FOLD_NO_STORE");
    const { note: name, file } = await glass.validateNote(note);
    const markdown = await readFile(file, "utf8");
    if (!glass.initialized && (create || await glass.existingStore())) await glass.initialize();
    const known = glass.initialized ? (create ? await glass.identify(name) : glass.notesByPath.get(name)) : null;
    return { glass, markdown, noteId: known?.id ?? null, title: known?.title ?? name };
  }

  async #route(glass, slot) {
    if (!SLOTS.includes(slot)) throw fail(t("Unknown fold slot."), "VALIDATION_ERROR");
    const { neverOnline } = await readGlassSettings(glass.root, { appData: this.appData });
    return foldRoute({ slot, preferences: this.preferences(), neverOnline });
  }

  /** `fold:get {note, slot?}`: cached fold, chunk states and the slot's route. */
  async get(request) {
    const { glass, markdown, noteId, title } = await this.#note(request?.note, false);
    const route = await this.#route(glass, request?.slot ?? "ladder");
    return { ...await this.service.get({ noteId, title, markdown }), route: routeView(route) };
  }

  /** `fold:run {note, slot, sections?, visible?, outLang?}`: starts a run; chunks stream as `fold:progress`. */
  async run(request) {
    const slot = request?.slot ?? "ladder";
    if (slot !== "ladder") throw fail(t("Only the Ladder slot can run a fold."), "FOLD_SLOT_UNAVAILABLE");
    const sections = request?.sections ?? null, visible = request?.visible ?? null;
    if (sections !== null && (!Array.isArray(sections) || sections.length > 1000 || !sections.every(id => typeof id === "string" && id.length <= 64))) throw fail("Invalid fold sections.", "VALIDATION_ERROR");
    if (visible !== null && (typeof visible !== "string" || visible.length > 64)) throw fail("Invalid visible chunk.", "VALIDATION_ERROR");
    if (request?.outLang !== undefined && !codes.has(request.outLang)) throw fail("Invalid fold language.", "VALIDATION_ERROR");
    // The route is decided before the note is touched: a refused route reads nothing and sends nothing.
    const glass = this.glass();
    if (!glass) throw fail(t("Open a note folder before folding."), "FOLD_NO_STORE");
    const route = await this.#route(glass, slot);
    if (!route.ready) throw Object.assign(fail(foldRouteMessage(route), route.code), { route: routeView(route) });
    const { markdown, noteId, title } = await this.#note(request.note, true);
    const outLang = request.outLang ?? noteLanguage(markdown) ?? this.language();
    const { runId, done } = this.service.run({ noteId, title, markdown, route: route.route, agent: route.agent, model: route.model, outLang,
      sections, visible, connection: route.connection ?? null });
    done.catch(error => this.send({ runId, noteId, phase: "error", error: { message: error?.message ?? String(error), code: error?.code ?? "FOLD_FAILED" } }));
    return { runId, noteId, outLang, route: routeView(route) };
  }

  /** `fold:cancel {noteId}`: finished chunks stay; the rest stay local. */
  cancel(request) {
    if (!noteIdPattern.test(String(request?.noteId))) throw fail("Invalid fold note id.", "VALIDATION_ERROR");
    return { cancelled: this.service.cancel({ noteId: request.noteId }) };
  }

  async close() {
    const closing = this.service.close();
    this.bridge.close();
    await closing;
  }
}

function noteLanguage(markdown) {
  try {
    const value = properties(markdown);
    const lang = String(value.lang ?? value.language ?? "").toLowerCase().split(/[-_]/)[0];
    return codes.has(lang) ? lang : null;
  } catch { return null; }
}
