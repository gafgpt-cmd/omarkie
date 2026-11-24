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
        window.firstNotePaint = { mode, visible: !!view?.getClientRects().length, text: !!view?.textContent, editable: view?.getAttribute('contenteditable') !== 'false', image: !!active?.querySelector('.rich-document img'), richBuilt: !!active?.querySelector('.rich-document [data-cid]') };
      }
    }).observe({ entryTypes: ['mark'] });
  });
}
async function verifyPaint(page, mode, image) {
  await page.waitForFunction(() => window.firstNotePaint !== null);
  const result = await page.evaluate(() => ({ observation: window.firstNotePaint, painted: performance.getEntriesByName('omarkie:first-document-painted')[0]?.startTime, ready: performance.getEntriesByName('omarkie:editor-ready').filter(entry => entry.detail?.mode === window.firstNotePaint.mode)[0]?.startTime }));
  assert.deepEqual(result.observation, { mode, visible: true, text: true, editable: true, image, richBuilt: mode === 'rich' });
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
  const nodeListeners = () => application.evaluate(() => {
    const { Server } = process.getBuiltinModule('node:net');
    return process._getActiveHandles().filter(handle => handle instanceof Server && handle.listening).length;
  });
  assert.equal(await nodeListeners(), 0, 'no Learning mode listener when disabled');
  assert.ok(!requested.some(url => /LearningMode-/.test(url)));
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
  await page.evaluate(() => localStorage.setItem('omarkie-plugins-v1', JSON.stringify({ learning_mode: { enabled: true } })));
  requested = [];
  await page.addInitScript(() => {
    const mark = performance.mark.bind(performance);
    performance.mark = (name, options) => {
      if (name === 'omarkie:first-document-painted') window.firstLearningPaint = !document.querySelector('.study-rail');
      return mark(name, options);
    };
  });
  let markedBeforeChunk = false;
  await page.route(/\/LearningMode-[^/]+\.js$/, async route => {
    markedBeforeChunk = await page.evaluate(() => window.firstLearningPaint);
    await route.continue();
  });
  await page.reload();
  await page.waitForSelector('.study-rail');
  assert.equal(markedBeforeChunk, true, 'Learning chunk is requested after the first document paint');
  assert.deepEqual(await pluginResources(), []);
  assert.ok(!requested.some(url => /\/runtime-[^/]+\.js$/.test(url)), 'Learning mode does not boot the compatibility runtime');
  assert.equal(await nodeListeners(), 0, 'offline Learning mode opens no listener when enabled');
  console.log('PASS: disabled bundled modules stay unloaded; enabled plugin follows document paint');
} finally { await application.close(); }

const fallbackDirectory = await mkdtemp(path.join(os.tmpdir(), 'omarkie-source-startup-'));
const fallbackFile = path.join(fallbackDirectory, 'fallback.md');
await writeFile(fallbackFile, '# Fallback\n\n' + 'source-only '.repeat(30000), 'utf8');
const fallbackEnv = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: fallbackDirectory, OMARKIE_LANGUAGE: 'zh' });
delete fallbackEnv.ELECTRON_RUN_AS_NODE; delete fallbackEnv.OMARKIE_DEV_URL;
const fallbackApplication = await electron.launch({ args: [process.cwd(), ...headlessArguments, fallbackFile], env: fallbackEnv });
const fallbackErrors = []; let fallbackPage;
try {
  const page = await fallbackApplication.firstWindow(); fallbackPage = page;
  page.on('pageerror', error => fallbackErrors.push(error.message)); page.on('crash', () => fallbackErrors.push('renderer crashed'));
  await page.waitForSelector('.document-editor:not([hidden]) .source-surface:not([hidden]) .cm-content');
  await waitForSession(fallbackDirectory, fallbackFile);
  await observePaint(page); await page.reload();
  await page.waitForSelector('.document-editor:not([hidden]) .source-surface:not([hidden]) .cm-content');
  await verifyPaint(page, 'source', false);
  assert.equal(await page.locator('.source-toggle').getAttribute('aria-pressed'), 'true');
  await page.evaluate(() => localStorage.setItem('omarkie-plugins-v1', JSON.stringify({ read_only: { enabled: true } })));
  await page.reload();
  await page.waitForSelector('.document-editor:not([hidden]) .source-surface:not([hidden]) .cm-content[contenteditable="false"]');
  await verifyPaint(page, 'source', false);
  assert.deepEqual(fallbackErrors, []);
  console.log('PASS: source fallback exists and paints before optional read-only activation');
} catch (error) {
  const evidence = process.env.OMARKIE_QA_DIR || fallbackDirectory;
  await fallbackPage?.screenshot({ path: path.join(evidence, 'source-startup-failure.png'), timeout: 5000 }).catch(() => {});
  await writeFile(path.join(evidence, 'source-startup-failure.json'), JSON.stringify({ directory: fallbackDirectory, errors: fallbackErrors, error: error.stack }, null, 2), 'utf8');
  throw error;
} finally { await fallbackApplication.close(); }
