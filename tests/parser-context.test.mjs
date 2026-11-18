import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { references, referenceIndex, bundlePlan } from "../shared/references.mjs";
import { DocumentStore } from "../electron/store.mjs";
import { vaultSnapshot, exportBundle } from "../electron/document-workflows.mjs";
const dom = new JSDOM("<!doctype html><body></body>");
for (const key of ["window", "document", "DOMParser", "HTMLElement", "Node"]) globalThis[key] = dom.window[key];
const { imageReferences, updateImageReferences } = await import("../src/editor/images.ts");
const { imageRange, resizedImage } = await import("../src/plugins/reading/imageSyntax.ts");
const { localImageSources, renderMarkdown, setMarkdownOptions } = await import("../src/editor/markdown.ts");
const { conversionMarkdown } = await import("../src/editor/print.ts");
const { MarkdownDocument } = await import("../src/editor/model.ts");
const { renderNode } = await import("../src/editor/richRender.ts");
const defaults = { inlineMath: true, highlight: true, subscript: true, superscript: true, emoji: true };
const note = (relative, content) => ({ relative, content, token: relative });
function article(source) { const element = document.createElement("article"); element.innerHTML = renderMarkdown(source, "fixture"); return element; }
async function converted(source, expected) {
  const previous = window.desktop, reads = [];
  window.desktop = { readResource: async uri => {
    const name = decodeURIComponent(new URL(uri).pathname.split("/").slice(2).join("/"));
    assert.ok(expected.includes(name), `unexpected resource ${name}`); reads.push(name);
    return { ok: true, value: { mime: "image/png", base64: Buffer.from(name).toString("base64") } };
  } };
  try {
    const copy = await conversionMarkdown(source, article(source));
    assert.deepEqual(reads.sort(), [...expected].sort());
    assert.ok([...article(copy).querySelectorAll("img")].every(image => image.getAttribute("src").startsWith("data:image/png;base64,")));
    return copy;
  } finally { window.desktop = previous; }
}

for (const endings of [["\n"], ["\r\n"], ["\r"], ["\r", "\n", "\r\n"]]) for (const quote of [false, true]) {
  test(`table cell contexts preserve original ranges: ${JSON.stringify({ endings, quote })}`, async () => {
    const rows = [
      '| [[Target\\|Alias]] #head | <span>[[literal]] #hidden</span> | $\\text{![[math.png]]}$ |',
      '| --- | --- | --- |',
      '| ![[figure.png\\| 100 x 50 ]] #body | ![[figure.png\\|Caption\\|More]] | [Link](Target.md "A \\| B") |',
      '| <img alt="real\\|alt" src="html.png" width="100"> | $[[literal]] #math$ | <span>![[hidden.png]] #html</span> |',
    ];
    const source = rows.map((row, index) => (quote ? '> ' : '') + row + endings[index % endings.length]).join('');
    const parsed = references(source), images = imageReferences(source), before = article(source);
    assert.deepEqual(parsed.references.map(ref => ref.target), ['Target', 'figure.png', 'figure.png', 'Target.md', 'html.png']);
    assert.equal(parsed.references[0].alias, 'Alias');
    assert.deepEqual(parsed.tags, [{ tag: 'head', line: 1 }, { tag: 'body', line: 3 }]);
    assert.deepEqual(images.map(image => [image.url, image.alt]), [['figure.png', 'figure.png'], ['figure.png', 'Caption|More'], ['html.png', 'real|alt']]);
    assert.deepEqual(localImageSources(source), ['figure.png', 'html.png']);
    for (const ref of [...parsed.references, ...images]) assert.equal(source.slice(ref.from, ref.to), ref.source);
    assert.ok(images.every(image => image.table));
    assert.equal(before.querySelectorAll('th').length, 3); assert.equal(before.querySelectorAll('td').length, 6);
    assert.equal(before.querySelector('a').textContent, 'Alias');
    const document = new MarkdownDocument(source), leaves = new Map(), rich = globalThis.document.createElement('article');
    for (const node of document.nodes) rich.append(renderNode(node, 'fixture', leaves, document.environment));
    assert.deepEqual([...rich.querySelectorAll('img')].map(image => image.getAttribute('alt')), ['figure.png', 'Caption|More', 'real|alt']);
    for (const leaf of leaves.values()) for (let index = 0; index < leaf.raw.length; index++) assert.equal(document.text[leaf.positions[index]], leaf.raw[index]);
    for (const object of rich.querySelectorAll('.md-object-source')) {
      const inline = object.parentElement, leaf = leaves.get(inline.closest('[data-leaf]').dataset.leaf);
      const from = leaf.positions[Number(inline.dataset.inlineFrom)], to = leaf.positions[Number(inline.dataset.inlineTo)];
      assert.equal(document.text.slice(from, to), object.textContent);
    }
    assert.equal(document.toMarkdown(), source);
    const range = imageRange(source, images[0].from); assert.equal(range.source, '![[figure.png\\| 100 x 50 ]]');
    const resized = resizedImage(range.source, 300, 150), changed = source.slice(0, range.from) + resized + source.slice(range.to);
    assert.equal(resized, '![[figure.png\\|300x150]]');
    assert.equal(imageReferences(changed)[0].url, 'figure.png'); assert.equal(article(changed).querySelector('img').getAttribute('height'), '150');
    const model = new MarkdownDocument(source); model.replaceSource(changed, 'document-command'); assert.equal(model.toMarkdown(), changed);
    assert.equal(model.undo(), true); assert.equal(model.toMarkdown(), source);
    const moved = article(updateImageReferences(source, { 'figure.png': 'replacement.png' }));
    assert.equal(moved.querySelectorAll('td').length, 6); assert.equal(moved.querySelectorAll('img').length, 3); assert.equal(moved.querySelectorAll('img')[1].getAttribute('alt'), 'Caption|More');
    const conversion = await converted(source, ['figure.png', 'html.png']);
    assert.equal(article(conversion).querySelectorAll('td').length, 6); assert.equal(article(conversion).querySelectorAll('img')[1].getAttribute('alt'), 'Caption|More');
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'table-context-'))), vault = path.join(root, 'vault'), output = path.join(root, 'output');
    await mkdir(vault); await mkdir(output);
    for (const [name, bytes] of [['start.md', source], ['Target.md', '# Target'], ['figure.png', 'figure bytes'], ['html.png', 'HTML bytes'], ['unused.png', 'unused']]) await writeFile(path.join(vault, name), bytes);
    const store = new DocumentStore(path.join(root, 'profile')); await store.scan(vault);
    const inventory = await vaultSnapshot(store), index = referenceIndex(inventory); assert.deepEqual(index.broken, []); assert.deepEqual(index.unused.map(asset => asset.relative), ['unused.png']);
    const plan = bundlePlan(inventory), destination = await exportBundle(store, plan, output), copy = article(await readFile(path.join(destination, 'notes/start.md'), 'utf8'));
    assert.equal(copy.querySelectorAll('td').length, 6); assert.equal(copy.querySelectorAll('img').length, 3);
    assert.equal(copy.querySelector('a').getAttribute('href'), '../notes/Target.md');
    assert.deepEqual([...copy.querySelectorAll('img')].map(image => image.getAttribute('alt')), [...before.querySelectorAll('img')].map(image => image.getAttribute('alt')));
    assert.equal(copy.querySelector('a[title]').getAttribute('title'), 'A | B');
    assert.deepEqual(plan.assets.map(asset => asset.source).sort(), ['figure.png', 'html.png']);
    assert.equal(await readFile(path.join(vault, 'start.md'), 'utf8'), source);
  });
}

test('escaped backticks leave visible controls while actual code spans remain opaque', async () => {
  const tick = '`', visible = '\\' + tick + ' [[Target]] #topic ![[figure.png]] \\' + tick;
  const code = [1, 2, 3].map(length => tick.repeat(length) + ' [[hidden]] #hidden ![[hidden.png]] ' + tick.repeat(length));
  const source = code.join('\r\n\r') + '\r\n\r' + visible;
  const parsed = references(source); assert.deepEqual(parsed.references.map(ref => ref.target), ['Target', 'figure.png']); assert.deepEqual(parsed.tags.map(tag => tag.tag), ['topic']);
  assert.deepEqual(imageReferences(source).map(image => image.url), ['figure.png']); assert.deepEqual(localImageSources(source), ['figure.png']);
  const plan = bundlePlan({ notes: [note('start.md', source), note('Target.md', '# Target')], assets: [{ relative: 'figure.png' }], truncated: false });
  const before = article(source), copy = article(plan.notes[0].content), conversion = article(await converted(source, ['figure.png']));
  for (const output of [copy, conversion]) assert.deepEqual([...output.querySelectorAll('code')].map(code => code.textContent), [...before.querySelectorAll('code')].map(code => code.textContent));
  assert.equal(copy.querySelector('a').getAttribute('href'), '../notes/Target.md'); assert.equal(conversion.querySelectorAll('img').length, 1);
});

test('hidden image syntax cannot trigger conversion reads; actual HTML resources remain', async () => {
  const source = ['<!-- ![[comment.png]] <img src="comment-html.png"> -->', '$\\text{![[math.png]]}$', '$$\n\\text{![[display.png]]}\n$$', '<textarea>![[opaque.png]] <img src="opaque-html.png"></textarea>', '<span>![[literal.png]] <img src="html.png" alt="visible"></span>', '<pre>[[literal]] #literal <img src="html.png" alt="pre image"></pre>', '![![alt](hidden-alt.png)](figure.png)'].join('\r\n\r\n');
  const parsed = references(source); assert.deepEqual(parsed.references.map(ref => ref.target), ['html.png', 'html.png', 'figure.png']); assert.deepEqual(parsed.tags, []);
  assert.deepEqual(imageReferences(source).map(image => image.url), ['html.png', 'html.png', 'figure.png']);
  assert.deepEqual(localImageSources(source), ['html.png', 'figure.png']);
  assert.equal(article(source).querySelectorAll('img').length, 3);
  const output = await converted(source, ['html.png', 'figure.png']); assert.equal(article(output).querySelectorAll('img').length, 3);
});

test('literal link metadata and quoted HTML attributes never become resources', async () => {
  const title = '![Example](fake.png) ![[fake.png]] <img src="fake.png"> [[Ghost]] #literal';
  const span = `<span title='<img src="fake.png"> ![[fake.png]] [[Ghost]] #literal'>text</span>`;
  const source = [`[Home](Target.md '${title}')`, span, '<a title=\'href="Ghost.md" src="ghost.png"\' href="Target.md">Target</a>', '<img alt=\' src="ghost.png" ![alt](fake.png)\' src="real.png">', '![Visible](fake.png)'].join('\r\n\r\n');
  const parsed = references(source), before = article(source);
  assert.deepEqual(parsed.references.map(ref => ref.target), ['Target.md', 'Target.md', 'real.png', 'fake.png']);
  assert.deepEqual(parsed.tags, []);
  assert.equal(before.querySelectorAll('img').length, 2);
  assert.deepEqual(imageReferences(source).map(image => image.url), ['real.png', 'fake.png']);
  assert.deepEqual(localImageSources(source), ['real.png', 'fake.png']);
  const plan = bundlePlan({ notes: [note('start.md', source), note('Target.md', '# Target')], assets: [{ relative: 'real.png' }, { relative: 'fake.png' }], truncated: false });
  const conversion = await converted(source, ['real.png', 'fake.png']);
  for (const copy of [plan.notes[0].content, conversion]) {
    assert.ok(copy.includes(title)); assert.ok(copy.includes(span));
    assert.equal(article(copy).querySelectorAll('img').length, 2);
    assert.equal(article(copy).querySelector('a').getAttribute('title'), before.querySelector('a').getAttribute('title'));
  }
});

for (const ending of ['\n', '\r\n', '\r']) test(`reference image conversion uses actual images, not literal uses: ${JSON.stringify(ending)}`, async () => {
  const literal = '`![alt][ref]`', definition = '[ref]: missing.png', hidden = literal + ending + ending + definition;
  assert.deepEqual(imageReferences(hidden), []);
  assert.equal(await converted(hidden, []), hidden);
  const source = [literal, '![Full][image]', '![image][]', '![image]', '![Multiline][multi' + ending + 'line]', '[Normal][image]', definition, '[image]: real.png', '[multi' + ending + 'line]: real.png'].join(ending + ending);
  const images = imageReferences(source);
  assert.deepEqual(images.map(image => image.url), ['real.png', 'real.png', 'real.png', 'real.png']);
  for (const image of images) assert.equal(source.slice(image.from, image.to), image.source);
  const copy = await converted(source, ['real.png']);
  assert.ok(copy.includes(literal)); assert.ok(copy.includes(definition)); assert.ok(copy.includes('[image]: real.png'));
  assert.equal(article(copy).querySelectorAll('img').length, 4);
  assert.equal(article(copy).querySelector('a').getAttribute('href'), 'real.png');
});

test('images and code inside link labels retain their own source boundaries', async () => {
  const source = '[![Visible](real.png) `![[hidden.png]]`](Target.md "![[title.png]]")';
  assert.deepEqual(imageReferences(source).map(image => image.url), ['real.png']);
  assert.deepEqual(references(source).references.map(ref => ref.target), ['Target.md', 'real.png']);
  const copy = await converted(source, ['real.png']);
  assert.ok(copy.includes('`![[hidden.png]]`')); assert.ok(copy.includes('"![[title.png]]"'));
});

test('image context follows the current inline-math preference', () => {
  try {
    setMarkdownOptions({ ...defaults, inlineMath: false });
    const source = '$![[figure.png]]$'; assert.equal(article(source).querySelectorAll('img').length, 1);
    assert.deepEqual(imageReferences(source).map(image => image.url), ['figure.png']);
  } finally { setMarkdownOptions(defaults); }
});
