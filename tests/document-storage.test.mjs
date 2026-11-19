import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'https://fixture.invalid', storageQuota: 1200000 });
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'localStorage', 'getComputedStyle']) globalThis[key] = key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');

test('document storage failures show alerts and preserve saved UI state', async () => {
  const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, watch: null }, appType: 'custom' });
  const root = createRoot(document.getElementById('root'));
  const original = dom.window.Storage.prototype.setItem;
  try {
    const { DocumentTools } = await server.ssrLoadModule('/src/components/DocumentTools.tsx');
    const props = { record: { name: 'fixture.md', content: 'x'.repeat(900000) }, documents: [], files: [], folder: null, preferences: {}, initial: 'writing', close() {}, async open() {}, async change() {}, async create() {}, async convert() {} };
    const buttons = () => [...document.querySelectorAll('button')];
    const button = name => buttons().find(button => button.textContent === name);
    const field = name => [...document.querySelectorAll('label')].find(label => label.firstChild?.textContent === name).querySelector('input,textarea');
    const alert = () => document.querySelector('[role="alert"]');
    async function input(name, value) {
      const element = field(name), prototype = element.tagName === 'INPUT' ? dom.window.HTMLInputElement.prototype : dom.window.HTMLTextAreaElement.prototype;
      await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    }
    async function click(name) { assert.ok(button(name), name); await act(async () => button(name).click()); }
    await act(async () => root.render(createElement(DocumentTools, props)));
    await input('模板名称', 'First'); await click('将当前笔记存为模板');
    assert.ok(button('用 First 新建笔记')); assert.equal(alert(), null);
    const saved = localStorage.getItem('omarkie-templates');
    await input('模板名称', 'Second'); await click('将当前笔记存为模板');
    assert.match(alert().textContent, /quota/i);
    assert.equal(button('用 Second 新建笔记'), undefined); assert.ok(button('用 First 新建笔记'));
    assert.equal(localStorage.getItem('omarkie-templates'), saved);
    dom.window.Storage.prototype.setItem = function () { throw new dom.window.DOMException('Storage denied', 'SecurityError'); };
    await click('删除模板');
    assert.equal(alert().textContent, 'Storage denied'); assert.ok(button('用 First 新建笔记'));
    assert.equal(localStorage.getItem('omarkie-templates'), saved);
    for (const [label, key] of [['信头名称', 'omarkie-letter-name'], ['信头详细信息', 'omarkie-letter-detail']]) {
      await input(label, 'Unsaved');
      assert.equal(alert().textContent, 'Storage denied'); assert.equal(field(label).value, ''); assert.equal(localStorage.getItem(key), null);
    }
    dom.window.Storage.prototype.setItem = original;
    await click('删除模板'); assert.equal(button('用 First 新建笔记'), undefined); assert.deepEqual(JSON.parse(localStorage.getItem('omarkie-templates')), []);
    await input('信头名称', 'Saved name'); await input('信头详细信息', 'Saved details');
    assert.equal(alert(), null); assert.equal(localStorage.getItem('omarkie-letter-name'), 'Saved name'); assert.equal(localStorage.getItem('omarkie-letter-detail'), 'Saved details');
    await act(async () => root.render(createElement(DocumentTools, { ...props, key: 'reload' })));
    assert.equal(field('信头名称').value, 'Saved name'); assert.equal(field('信头详细信息').value, 'Saved details');
  } finally {
    dom.window.Storage.prototype.setItem = original;
    await act(async () => root.unmount()); await server.close(); dom.window.close();
  }
});
