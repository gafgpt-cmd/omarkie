import { randomUUID } from "node:crypto";
import readingCore from "../shared/reading-core.cjs";
import tutorBridge from "../shared/tutor-bridge.cjs";
import { digest } from "./store.mjs";
import { readingScope } from "./reading-store.mjs";
import { listenBridge } from "./tutor-transport.mjs";

const { readingAnchor } = readingCore(digest);
const ttl = 60 * 60 * 1000;

export function tutorSessions(store) {
  const vaults = new Map(), bindings = new Map();
  let tail = Promise.resolve();
  function serialize(run) {
    const operation = tail.then(run);
    tail = operation.catch(() => {});
    return operation;
  }
  async function detach(window, lease) {
    const binding = bindings.get(window);
    if (!binding || lease && lease !== binding.lease) return;
    bindings.delete(window);
    const { root, broker } = binding.vault;
    if (broker.unbind(window.id)) return;
    vaults.delete(root);
    const close = await binding.vault.close;
    await close?.();
  }
  function createVault(root) {
    const broker = tutorBridge(randomUUID, (id, event) => {
      for (const [window, binding] of bindings) {
        if (window.id !== id || binding.vault.root !== root || window.isDestroyed() || !binding.current()) continue;
        window.send("tutor:event", { ...event, lease: binding.lease });
      }
    }, readingAnchor, () => Date.now() + ttl);
    const vault = { root, broker, close: undefined };
    vaults.set(root, vault);
    return vault;
  }
  function request(window, id, request) {
    return serialize(async () => {
      const lease = request?.lease;
      if (!request || typeof lease !== "string" || !/^[a-f0-9-]{36}$/.test(lease)) throw new Error("Invalid Tutor session.");
      if (request.action === "detach") return detach(window, lease);
      if (request.action !== "attach" && request.action !== "submit") throw new Error("Invalid Tutor action.");
      const { root, document, current } = await readingScope(store, id);
      const old = bindings.get(window);
      if (old && (old.lease !== lease || old.vault.root !== root || old.document !== document)) await detach(window, old.lease);
      if (!current() || window.isDestroyed()) throw new Error("Open a saved Markdown note in this vault.");
      const vault = vaults.get(root) ?? createVault(root);
      const { broker } = vault;
      bindings.set(window, { lease, vault, document, current });
      const bound = broker.bind(window.id, document);
      if (bound.error) { await detach(window, lease); throw new Error(bound.error); }
      if (request.action === "attach") return {};
      if (!vault.close) {
        try { vault.close = listenBridge(root, broker); await vault.close; }
        catch (error) { vault.close = undefined; throw error; }
      }
      const result = broker.submit(window.id, request);
      if (result.error) throw new Error(result.error);
      return result;
    });
  }
  return { request, detach: window => serialize(() => detach(window)) };
}
