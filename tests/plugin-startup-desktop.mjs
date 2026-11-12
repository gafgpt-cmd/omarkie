import { _electron as electron } from 'playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await mkdtemp(path.join(os.tmpdir(), 'omarkie-plugin-startup-'));
const file = path.join(directory, 'startup.md');
await writeFile(file, '# Startup\n\nDocument remains available.\n', 'utf8');
const env = { ...process.env, OMARKIE_DATA_DIR: directory, OMARKIE_LANGUAGE: 'zh' };
delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL;
const application = await electron.launch({ args: [process.cwd(), file], env });
try {
  const page = await application.firstWindow();
  // Resource Timing omits file:// loads, so plugin chunks are observed as requests.
  let requested = [];
  page.on('request', request => requested.push(request.url()));
  await page.waitForSelector('.app-shell');
  await page.waitForFunction(() => document.querySelector('.document-editor:not([hidden]) .rich-document h1')?.textContent.includes('Startup'));
  const pluginResources = async () => requested.filter(name => /(?:auto_number|collapse_paragraph|collapse_list|read_only|no_image|blur|static_markers|dark)-[^/]+\.js/.test(name));
  assert.deepEqual(await pluginResources(), []);
  await page.evaluate(() => localStorage.setItem('omarkie-plugins-v1', JSON.stringify({ read_only: { enabled: true } })));
  // The reload restores from session.json, which the renderer writes after a short debounce.
  const persisted = async () => { try { return JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8')).documents?.some(document => document.path === file); } catch { return false; } };
  for (let tries = 0; !(await persisted()); tries++) { assert.ok(tries < 100, 'session with the opened file is persisted'); await new Promise(resolve => setTimeout(resolve, 100)); }
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
  const loaded = await pluginResources();
  assert.equal(loaded.length, 1); assert.match(loaded[0], /read_only/);
  console.log('PASS: disabled bundled modules stay unloaded; enabled plugin follows document paint');
} finally { await application.close(); }
