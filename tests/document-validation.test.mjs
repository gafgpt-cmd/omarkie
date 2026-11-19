import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
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
        const record = { id: 'fixture', path: relative ? path.resolve('fixture-vault', relative) : null, name, content, savedContent: content };
        const files = inVault ? [{ path: record.path, relative, token: 'fixture', name }] : [];
        let changes = 0, scans = 0;
        host.vaultSnapshot = async () => { scans++; return { notes: [{ token: 'fixture', relative: relative.replace(/\\/g, '/'), path: record.path, content }], assets: [], truncated: false }; };
        const props = { record, documents: [record], files, preferences: {}, initial: 'okf', close() {}, async open() {}, async change() { changes++; }, async create() { changes++; }, async convert() {} };
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
    } finally { host.vaultSnapshot = originalSnapshot; }
  } finally { await act(async () => root.unmount()); await server.close(); dom.window.close(); }
});
