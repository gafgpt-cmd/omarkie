// Fold model routes (design §4.5, no paid surprise): per-slot route settings, egress classification, and the
// route decision main enforces before any call. Pure ESM.
// Default route is local: no model call, nothing leaves the computer. A route that sends note text off the
// computer runs only after the user allowed that exact destination for that slot; a never-online vault
// keeps loopback only.

import { AGENTS, SLOTS } from "./fold-format.mjs";
import { payloadEndpoint } from "./payload-endpoint.mjs";

export const SLOT_ROUTES = Object.freeze(["local", "agent", "payload"]);

// Captain call C2: the agent and model each slot uses once its agent route is switched on.
// `payloadModel` empty = the model set in the Payload preferences.
const slotDefaults = Object.freeze({
  ladder: Object.freeze({ route: "local", agent: "opencode", agentModel: "deepseek-v4.1-flash", payloadModel: "", allow: null }),
  estudio: Object.freeze({ route: "local", agent: "claude", agentModel: "claude-opus-5.5", payloadModel: "", allow: null }),
});

export const defaultFoldSlots = () => ({ ladder: { ...slotDefaults.ladder }, estudio: { ...slotDefaults.estudio } });

const modelText = value => typeof value === "string" && value.length <= 256 ? value : null;
const destinationText = value => typeof value === "string" && value.length > 0 && value.length <= 2048 ? value : null;

/** Stored slot settings, repaired field by field; anything unknown falls back to the local default. */
export function foldSlotsFrom(value) {
  const slots = defaultFoldSlots();
  if (!value || typeof value !== "object") return slots;
  for (const slot of SLOTS) {
    const saved = value[slot];
    if (!saved || typeof saved !== "object") continue;
    if (SLOT_ROUTES.includes(saved.route)) slots[slot].route = saved.route;
    if (AGENTS.includes(saved.agent)) slots[slot].agent = saved.agent;
    for (const field of ["agentModel", "payloadModel"]) {
      const model = modelText(saved[field]);
      if (model !== null) slots[slot][field] = model;
    }
    slots[slot].allow = destinationText(saved.allow);
  }
  return slots;
}

/** Payload connection from app preferences, as the Payload panel builds it; null when not usable. */
export function foldPayloadConnection(preferences) {
  const endpoint = payloadEndpoint(preferences?.payloadBaseUrl);
  const allowed = Array.isArray(preferences?.payloadAllowedOrigins) ? preferences.payloadAllowedOrigins : [];
  if (preferences?.payloadEnabled !== true || !endpoint || (!endpoint.local && !allowed.includes(endpoint.origin))) return null;
  return { baseUrl: preferences.payloadBaseUrl, origin: endpoint.origin, local: endpoint.local, modernLimit: preferences.payloadModernLimit === true };
}

/**
 * Where a slot's text goes. `none`: nothing is called. `loopback`: a server on this computer.
 * `remote`: the text leaves the computer (an agent's own service, or a non-loopback Payload origin).
 */
export function foldEgress(setting, preferences) {
  if (setting.route === "agent") return { kind: "remote", destination: `agent:${setting.agent}` };
  if (setting.route === "payload") {
    const endpoint = payloadEndpoint(preferences?.payloadBaseUrl);
    if (!endpoint) return { kind: "remote", destination: null };
    return { kind: endpoint.local ? "loopback" : "remote", destination: endpoint.origin };
  }
  return { kind: "none", destination: null };
}

/**
 * The route decision for one slot. `ready` only when a call may run now; `code` names the reason otherwise.
 * `connection` is what the runner needs for a Payload call; an agent route needs none.
 */
export function foldRoute({ slot, preferences, neverOnline = false }) {
  if (!SLOTS.includes(slot)) throw new TypeError("Unknown fold slot.");
  const setting = foldSlotsFrom(preferences?.foldSlots)[slot];
  const egress = foldEgress(setting, preferences);
  const base = { slot, route: setting.route, egress };
  if (setting.route === "local") return { ...base, ready: false, code: "FOLD_ROUTE_LOCAL" };
  if (neverOnline && egress.kind !== "loopback") return { ...base, ready: false, code: "FOLD_OFFLINE" };
  // A Payload route needs Payload itself first: its model falls back to the Payload one.
  const connection = setting.route === "payload" ? foldPayloadConnection(preferences) : null;
  if (setting.route === "payload" && !connection) return { ...base, ready: false, code: "FOLD_PAYLOAD_UNSET" };
  const model = setting.route === "payload" ? setting.payloadModel.trim() || String(preferences?.payloadModel ?? "").trim() : setting.agentModel.trim();
  if (!model) return { ...base, ready: false, code: "FOLD_MODEL_UNSET" };
  if (connection) {
    if (egress.kind === "remote" && setting.allow !== egress.destination) return { ...base, model, ready: false, code: "FOLD_EGRESS_UNCONFIRMED" };
    return { ...base, model, ready: true, code: null, connection: { ...connection, neverOnline: neverOnline === true } };
  }
  if (setting.allow !== egress.destination) return { ...base, agent: setting.agent, model, ready: false, code: "FOLD_EGRESS_UNCONFIRMED" };
  return { ...base, agent: setting.agent, model, ready: true, code: null };
}
