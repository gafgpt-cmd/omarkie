import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { references, referenceIndex, bundlePlan } from '../shared/references.mjs';
import { DocumentStore } from '../electron/store.mjs';
import { vaultSnapshot, exportBundle } from '../electron/document-workflows.mjs';
const dom = new JSDOM('<!doctype html><body></body>');
for (const key of ['window', 'document', 'DOMParser', 'HTMLElement', 'Node']) globalThis[key] = dom.window[key];
const { renderMarkdown, localImageSources } = await import('../src/editor/markdown.ts');
const { imageReferences } = await import('../src/editor/images.ts');
const { resizedImage, imageRange } = await import('../src/plugins/reading/imageSyntax.ts');
const { conversionMarkdown } = await import('../src/editor/print.ts');
const note = (relative, content) => ({ token: relative, relative, content });
const article = source => { const node = document.createElement('article'); node.innerHTML = renderMarkdown(source, 'fixture'); return node; };
async function converted(source) {
  const previous = window.desktop;
  window.desktop = { readResource: async () => ({ ok: true, value: { mime: 'image/png', base64: Buffer.from('image bytes').toString('base64') } }) };
  try { return await conversionMarkdown(source, article(source)); } finally { window.desktop = previous; }
}

for (const wiki of [false, true]) test(`exact dimensions survive every image consumer: wiki=${wiki}`, async () => {
  const markup = wiki ? '![[a.png|80x40]]' : '![alt](a.png)';
  for (const attributes of ['width=100 height=50 data-width=40 data-height=20', 'data-width=40 data-height=20 width="100px" height=\'50px\'', 'width=100 data-note="width=40 height=20" height=50']) {
    const source = `${markup}{${attributes}}`, expected = [100, 50];
    const dimensions = node => [Number(node.getAttribute('width')), Number(node.getAttribute('height'))];
    assert.deepEqual(dimensions(article(source).querySelector('img')), expected);
    const [image] = imageReferences(source); assert.equal(image.source, source); assert.deepEqual([image.width, image.height], ['100', '50']);
    assert.deepEqual(localImageSources(source), ['a.png']);
    const index = referenceIndex({ notes: [note('start.md', source)], assets: [{ relative: 'a.png' }], truncated: false });
    assert.deepEqual([index.edges[0].ref.width, index.edges[0].ref.height], ['100', '50']);
    const copy = bundlePlan({ notes: [note('start.md', source)], assets: [{ relative: 'a.png' }], truncated: false }).notes[0].content;
    assert.deepEqual(dimensions(article(copy).querySelector('img')), expected); assert.ok(copy.includes(attributes));
    assert.deepEqual(dimensions(article(await converted(source)).querySelector('img')), expected);
    const range = imageRange(source, 0), resized = resizedImage(range.source, 300, 150);
    assert.deepEqual(dimensions(article(resized).querySelector('img')), [300, 150]);
    assert.deepEqual(imageReferences(resized).map(image => [image.width, image.height]), [['300', '150']]);
    assert.ok(resized.includes(attributes.includes('data-note') ? 'data-note="width=40 height=20"' : 'data-width=40 data-height=20'));
  }
  const opaque = markup + '{data-width=40 data-height=20}';
  assert.deepEqual(imageReferences(opaque).map(image => [image.width, image.height]), [[wiki ? '80' : '', wiki ? '40' : '']]);
  assert.ok(article(opaque).textContent.includes('{data-width=40 data-height=20}'));
});

for (const eol of ['\n', '\r\n', '\r']) for (const container of ['quote', 'list']) {
  test(`container links retain destinations, labels and titles: ${container} ${JSON.stringify(eol)}`, async () => {
    const prefix = container === 'quote' ? '> ' : '  ', first = container === 'quote' ? '> ' : '- ';
    const body = [
      `${first}[Home][multi`, `${prefix}line]`, `${prefix}`, `${prefix}[Inline](`, `${prefix}index.md`, `${prefix}'A > B')`, `${prefix}`,
      `${prefix}![Photo][image`, `${prefix}id]`, `${prefix}`, `${prefix}![Inline photo](`, `${prefix}photo.png`, `${prefix}'Photo > title')`, `${prefix}`,
      `${prefix}[Multi`, `${prefix}label][home]`, `${prefix}`, `${prefix}![Multi`, `${prefix}image][photo]`,
      '', '[multi line]: index.md "Reference > title"', '[image id]: photo.png "Image > title"', '[home]: index.md', '[photo]: photo.png',
    ];
    const source = body.join(eol), parsed = references(source);
    assert.deepEqual(parsed.references.map(ref => ref.target), ['index.md', 'index.md', 'photo.png', 'photo.png', 'index.md', 'photo.png']);
    for (const ref of parsed.references) assert.equal(source.slice(ref.from, ref.to), ref.source);
    assert.deepEqual(imageReferences(source).map(image => image.url), ['photo.png', 'photo.png', 'photo.png']);
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'container-reference-'))), vault = path.join(root, 'vault'), output = path.join(root, 'output');
    await mkdir(vault); await mkdir(output);
    for (const [name, bytes] of [['start.md', source], ['index.md', '# Home'], ['photo.png', 'image bytes']]) await writeFile(path.join(vault, name), bytes);
    const store = new DocumentStore(path.join(root, 'profile')); await store.scan(vault);
    const inventory = await vaultSnapshot(store), index = referenceIndex(inventory);
    assert.deepEqual(index.broken, []); assert.deepEqual(index.unused, []); assert.equal(index.backlinks(index.notes.find(note => note.relative === 'index.md')).length, 3);
    const plan = bundlePlan(inventory), destination = await exportBundle(store, plan, output), copied = await readFile(path.join(destination, 'notes/start.md'), 'utf8');
    const before = article(source), after = article(copied);
    const labels = node => [...node.querySelectorAll('a,img')].map(item => [item.tagName, item.tagName === 'IMG' ? item.getAttribute('alt') : item.textContent, item.getAttribute('title')]);
    assert.deepEqual(labels(after), labels(before));
    assert.deepEqual([...after.querySelectorAll('a')].map(link => link.getAttribute('href')), Array(3).fill('../notes/_index.md'));
    assert.deepEqual(imageReferences(copied).map(image => image.url), Array(3).fill('../assets/photo.png'));
    const copyIndex = referenceIndex({ notes: plan.notes, assets: [{ relative: 'assets/photo.png' }], truncated: false }); assert.deepEqual(copyIndex.broken, []);
    const convertedSource = await converted(source); assert.equal(article(convertedSource).querySelectorAll('img').length, 3);
    assert.ok([...article(convertedSource).querySelectorAll('img')].every(image => image.getAttribute('src').startsWith('data:image/png;base64,')));
    assert.equal(await readFile(path.join(vault, 'start.md'), 'utf8'), source); assert.equal(await readFile(path.join(destination, 'assets/photo.png'), 'utf8'), 'image bytes');
  });
}
