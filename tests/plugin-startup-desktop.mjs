import { _electron as electron } from 'playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";
import { bundledPlugins } from "../src/plugins/catalog.ts";

const directory = await mkdtemp(path.join(os.tmpdir(), 'omarkie-plugin-startup-'));
const file = path.join(directory, 'startup.md');
await writeFile(file, '# Startup\n\nDocument remains available.\n\n![Startup image](startup.png)\n', 'utf8');
await writeFile(path.join(directory, 'startup.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNNsAAAAASUVORK5CYII=', 'base64'));
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: directory, OMARKIE_LANGUAGE: 'zh' });
delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL;
async function waitForSession(directory, file) {
  const target = await realpath(file), deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if (JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8')).documents?.some(record => record.path === target)) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('opened document did not reach the durable session');
}
async function observePaint(page) {
  await page.addInitScript(() => {
    window.firstNotePaint = null;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.name !== 'omarkie:first-document-painted') continue;
        const active = document.querySelector('.document-editor:not([hidden])');
        const mode = entry.detail?.mode;
        const view = active?.querySelector(mode === 'source' ? '.source-surface:not([hidden]) .cm-content' : '.rich-document');
        window.firstNotePaint = { mode, visible: !!view?.getClientRects().length, text: !!view?.textContent, editable: view?.getAttribute('contenteditable') !== 'false', image: !!active?.querySelector('img') };
      }
    }).observe({ entryTypes: ['mark'] });
  });
}
async function verifyPaint(page, mode, image) {
  await page.waitForFunction(() => window.firstNotePaint !== null);
  const result = await page.evaluate(() => ({ observation: window.firstNotePaint, painted: performance.getEntriesByName('omarkie:first-document-painted')[0]?.startTime, ready: performance.getEntriesByName('omarkie:editor-ready').filter(entry => entry.detail?.mode === window.firstNotePaint.mode)[0]?.startTime }));
  assert.deepEqual(result.observation, { mode, visible: true, text: true, editable: true, image });
  assert.ok(Number.isFinite(result.ready) && result.ready <= result.painted, 'actual editor readiness precedes the document paint mark');
}
const application = await electron.launch({ args: [process.cwd(), ...headlessArguments, file], env });
try {
  const page = await application.firstWindow();
  // Resource Timing omits file:// loads, so plugin chunks are observed as requests.
  let requested = [];
  page.on('request', request => requested.push(request.url()));
  await page.waitForFunction(() => document.querySelector('.document-editor:not([hidden]) .rich-document h1')?.textContent.includes('Startup'));
  await waitForSession(directory, file);
  await observePaint(page);
  await page.reload();
  await page.waitForSelector('.app-shell');
  await page.waitForFunction(() => document.querySelector('.document-editor:not([hidden]) .rich-document h1')?.textContent.includes('Startup'));
  await page.waitForFunction(() => performance.getEntriesByName("omarkie:first-document-painted").length > 0);
  await verifyPaint(page, 'rich', true);
  const implementations = new RegExp(`(?:${bundledPlugins.map(plugin => plugin.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})-[^/]+\\.js`);
  const pluginResources = async () => requested.filter(name => implementations.test(name));
  assert.deepEqual(await pluginResources(), []);
  await page.evaluate(() => localStorage.setItem('omarkie-plugins-v1', JSON.stringify({ read_only: { enabled: true } })));
  await waitForSession(directory, file);
  await page.addInitScript(() => {
    window.documentPaintedBeforePlugin = false;
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.document-editor:not([hidden]) .rich-document h1')?.textContent.includes('Startup')) return;
      observer.disconnect();
      requestAnimationFrame(() => { window.documentPaintedBeforePlugin = !document.querySelector('.document-editor:not([hidden]) .rich-document[contenteditable="false"]'); });
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  requested = []; await page.reload();
  await page.waitForSelector('.app-shell');
  await page.waitForFunction(() => document.querySelector('.document-editor:not([hidden]) .rich-document h1')?.textContent.includes('Startup'));
  await page.waitForFunction(() => document.querySelector('.document-editor:not([hidden]) .rich-document[contenteditable="false"]'));
  assert.equal(await page.evaluate(() => window.documentPaintedBeforePlugin), true);
  await verifyPaint(page, 'rich', true);
  const loaded = await pluginResources();
  assert.equal(loaded.length, 1); assert.match(loaded[0], /read_only/);
  console.log('PASS: disabled bundled modules stay unloaded; enabled plugin follows document paint');
} finally { await application.close(); }

const fallbackDirectory = await mkdtemp(path.join(os.tmpdir(), 'omarkie-source-startup-'));
const fallbackFile = path.join(fallbackDirectory, 'fallback.md');
await writeFile(fallbackFile, '# Fallback\n\n' + 'source-only '.repeat(30000), 'utf8');
const fallbackEnv = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: fallbackDirectory, OMARKIE_LANGUAGE: 'zh' });
delete fallbackEnv.ELECTRON_RUN_AS_NODE; delete fallbackEnv.OMARKIE_DEV_URL;
const fallbackApplication = await electron.launch({ args: [process.cwd(), ...headlessArguments, fallbackFile], env: fallbackEnv });
try {
  const page = await fallbackApplication.firstWindow();
  await page.waitForSelector('.document-editor:not([hidden]) .source-surface:not([hidden]) .cm-content');
  await waitForSession(fallbackDirectory, fallbackFile);
  await observePaint(page); await page.reload();
  await page.waitForSelector('.document-editor:not([hidden]) .source-surface:not([hidden]) .cm-content');
  await verifyPaint(page, 'source', false);
  await page.evaluate(() => localStorage.setItem('omarkie-plugins-v1', JSON.stringify({ read_only: { enabled: true } })));
  await page.reload();
  await page.waitForSelector('.document-editor:not([hidden]) .source-surface:not([hidden]) .cm-content[contenteditable="false"]');
  await verifyPaint(page, 'source', false);
  console.log('PASS: source fallback exists and paints before optional read-only activation');
} finally { await fallbackApplication.close(); }
