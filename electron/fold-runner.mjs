// FoldService runner: one chunk per call, over the route main resolved for the slot. Agent route → the Glass-bridge
// job queue; Payload route → one JSON chat call. Both honour the run's abort signal, so a cancel frees its call slot.

import { anchorReply, foldVersions } from "../shared/fold-prompt.mjs";

/**
 * @param {object} options
 * @param {{ submit(request: object, signal?: AbortSignal): Promise<object> }} options.bridge agent job queue.
 * @param {(call: { connection: object, model: string, request: object, signal?: AbortSignal }) => Promise<object>} options.payload
 */
export function createFoldRunner({ bridge, payload }) {
  return {
    versions: foldVersions,
    async run(request) {
      let reply;
      if (request.route === "agent") reply = await bridge.submit(request, request.signal);
      else if (request.route === "payload") reply = await payload({ connection: request.connection, model: request.model, request, signal: request.signal });
      else throw Object.assign(new Error("Unknown fold route."), { code: "FOLD_ROUTE_LOCAL" });
      // The Estudio checker places its own quotes: they may sit in a table cell, not only a unit.
      return request.slot === "estudio" ? reply : anchorReply(reply, request.chunk.units);
    },
  };
}
