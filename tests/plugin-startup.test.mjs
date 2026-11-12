import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterDocumentPaint } from "../src/plugins/startup.ts";

test("bundled catalog never evaluates disabled modules, and enable imports only its module", async () => {
  const evaluated = [];
  const hooks = registerHooks({
    load(url, context, next) {
      if (!url.endsWith('?typora-plugin')) return next(url, context);
      return { format: 'module', shortCircuit: true, source: `globalThis.__pluginEvaluated.push(${JSON.stringify(url)}); export default () => class {};` };
    },
  });
  globalThis.__pluginEvaluated = evaluated;
  try {
    const { bundledPlugins } = await import('../src/plugins/catalog.ts');
    assert.equal(bundledPlugins.length, 8);
    assert.deepEqual(evaluated, []);
    assert.ok(bundledPlugins.every(plugin => !plugin.factory && typeof plugin.load === 'function'));
    await bundledPlugins[0].load();
    assert.equal(evaluated.length, 1);
    assert.match(evaluated[0], /auto_number/);
  } finally { hooks.deregister(); delete globalThis.__pluginEvaluated; }
});

test("startup returns before loading plugins and allows a document paint first; cancellation prevents loading", () => {
  const frames = new Map(); let id = 0, loaded = false;
  globalThis.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const frame = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); };
  try {
    const cancel = afterDocumentPaint(() => { loaded = true; return new Promise(() => {}); });
    assert.equal(loaded, false);
    frame(); assert.equal(loaded, false);
    frame(); assert.equal(loaded, true);
    cancel(); loaded = false;
    const stop = afterDocumentPaint(() => { loaded = true; });
    frame(); stop(); frame(); assert.equal(loaded, false);
  } finally { delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame; }
});
