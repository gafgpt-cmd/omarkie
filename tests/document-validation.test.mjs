import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, readFile, realpath } from "node:fs/promises";
import { DocumentStore } from "../electron/store.mjs";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'https://fixture.invalid' });
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'localStorage', 'getComputedStyle']) globalThis[key] = key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');

test('note OKF validation uses vault-relative root identity without modifying drafts', async () => {
  const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom' });
  const root = createRoot(document.getElementById('root'));
  try {
    const { DocumentTools } = await server.ssrLoadModule('/src/components/DocumentTools.tsx');
    const { host } = await server.ssrLoadModule('/src/host.ts');
    const originalSnapshot = host.vaultSnapshot;
    const version = '---\nokf_version: "0.2"\n---\n# Home';
    const error = 'index.md 的前置元数据只能包含 okf_version';
    try {
      for (const [relative, name, content, expected, inVault] of [
        ['index.md', 'index.md', version, [], true],
        ['nested/index.md', 'index.md', version, [error], true],
        ['deep/nested/index.md', 'index.md', version, [error], true],
        ['nested\\index.md', 'index.md', version, [error], true],
        ['index.md', 'index.md', '---\ntype: Reference\n---\n# Home', [error], true],
        ['note.md', 'note.md', '---\ntype: Reference\n---\n# Note', [], true],
        ['log.md', 'log.md', '## 2026-01-01\nEntry', [], true],
        ['index.md', 'index.md', version, [error], false],
        [null, 'index.md', version, [error], false],
      ]) {
        const folder = path.resolve('fixture-vault');
        const record = { id: 'fixture', path: relative ? path.resolve(inVault ? folder : 'outside-vault', relative) : null, name, content, savedContent: content };
        const files = inVault ? [{ path: record.path, relative, token: 'fixture', name }] : [];
        let changes = 0, scans = 0;
        host.vaultSnapshot = async () => { scans++; return { notes: [{ token: 'fixture', relative: relative.replace(/\\/g, '/'), path: record.path, content }], assets: [], truncated: false }; };
        const props = { record, documents: [record], files, folder, preferences: {}, initial: 'okf', close() {}, async open() {}, async change() { changes++; }, async create() { changes++; }, async convert() {} };
        await act(async () => root.render(createElement(DocumentTools, props)));
        const click = async name => { const button = [...document.querySelectorAll('button')].find(button => button.textContent === name); assert.ok(button, name); await act(async () => button.click()); };
        const report = () => [...document.querySelectorAll('li')].map(item => item.textContent);
        await click('校验笔记 OKF');
        assert.deepEqual(report(), [...expected, '校验完成。'], String(relative));
        assert.equal(scans, 0);
        if (inVault) {
          await click('校验文件夹 OKF');
          assert.deepEqual(report(), [...expected.map(issue => `${relative.replace(/\\/g, '/')}: ${issue}`), '校验完成。']);
        }
        assert.equal(changes, 0); assert.equal(record.content, content); assert.equal(record.savedContent, content);
      }
      const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), 'validation-listing-')));
      await Promise.all(Array.from({ length: 1000 }, (_, index) => writeFile(path.join(folder, `a${String(index).padStart(4, '0')}.md`), '# Earlier')));
      const file = path.join(folder, 'index.md'); await writeFile(file, version);
      const store = new DocumentStore(path.join(folder, 'profile')), listing = await store.scan(folder), record = await store.open(file);
      assert.equal(listing.truncated, true); assert.equal(listing.files.length, 1000); assert.ok(!listing.files.some(entry => entry.path === record.path));
      await act(async () => root.render(createElement(DocumentTools, { record, documents: [record], folder: listing.folder, files: listing.files, preferences: {}, initial: 'okf', close() {}, async open() {}, async change() { assert.fail('validation changed a draft'); }, async create() {}, async convert() {} })));
      await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '校验笔记 OKF').click());
      assert.deepEqual([...document.querySelectorAll('li')].map(item => item.textContent), ['校验完成。']);
      assert.equal(record.content, version); assert.equal(await readFile(file, 'utf8'), version);
    } finally { host.vaultSnapshot = originalSnapshot; }
  } finally { await act(async () => root.unmount()); await server.close(); dom.window.close(); }
});
