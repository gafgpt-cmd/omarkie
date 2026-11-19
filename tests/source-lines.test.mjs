import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { sourceLines } from "../shared/source-lines.mjs";
import { frontmatter } from "../shared/frontmatter.mjs";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { convertExport, pandocPath } from "../electron/interchange.mjs";
const dom = new JSDOM("<!doctype html><body></body>");
for (const key of ["window", "document", "DOMParser", "HTMLElement", "Node"]) globalThis[key] = dom.window[key];
const { imageReferences } = await import("../src/editor/images.ts");
const { localImageSources, parseBlocks, renderMarkdown } = await import("../src/editor/markdown.ts");
const { conversionMarkdown } = await import("../src/editor/print.ts");
test('Electron letterhead strips only complete metadata across supported endings', async () => {
  const converter = await pandocPath(); assert.ok(converter);
  const root = await mkdtemp(path.join(os.tmpdir(), 'letterhead-endings-')), exec = promisify(execFile);
  for (const ending of ['\n', '\r\n', '\r']) for (const bom of ['', '\uFEFF']) {
    const source = bom + '--- \t' + ending + 'type: Reference' + ending + 'title: Metadata sentinel' + ending + '... \t' + ending + '# Body sentinel\r\n\nRetained body.\r';
    const file = path.join(root, 'source.md'), destination = path.join(root, 'letter.docx'); await writeFile(file, source, 'utf8');
    await convertExport(root, 'docx', source, '', destination, { letterhead: { name: 'Example Organization', detail: 'Document service' } });
    const { stdout } = await exec(converter, [destination, '--to=plain']);
    assert.match(stdout, /Example Organization/); assert.match(stdout, /Body sentinel/); assert.doesNotMatch(stdout, /Metadata sentinel|type: Reference/);
    assert.equal(await readFile(file, 'utf8'), source);
  }
});
for (const endings of [["\n"], ["\r\n"], ["\r"], ["\r", "\r\n", "\n"]]) {
  test(`raw image exclusions, prefetch and conversion: ${JSON.stringify(endings)}`, async () => {
    const lines = ['\uFEFF---', 'type: Reference', 'cover: "![[cover.png]]"', '---', '# Body', '', '```md', '![[code.png]]', '```', '', '![[body.png]]', '', '![Reference][ref]', '', '[ref]: body.png'];
    const source = lines.map((line, index) => line + (index < lines.length - 1 ? endings[index % endings.length] : "")).join("");
    const table = sourceLines(source); assert.deepEqual(table.lines, lines);
    assert.equal(table.lines[10], '![[body.png]]'); assert.equal(source.slice(table.offsets[10], table.offsets[11]).replace(/[\r\n]+$/, ''), '![[body.png]]');
    const metadata = parseBlocks(source).find(block => block.kind === 'frontmatter'); assert.equal(metadata.fromLine, 1); assert.equal(metadata.toLine, 4);
    assert.ok(metadata.source.startsWith('\uFEFF---')); assert.ok(metadata.source.endsWith('---'));
    assert.deepEqual(imageReferences(source).map(image => image.url), ['body.png', 'body.png']);
    assert.deepEqual(localImageSources(source), ['body.png']);
    const rendered = document.createElement('article'); rendered.innerHTML = renderMarkdown(source, 'fixture');
    assert.equal(rendered.querySelectorAll('img').length, 2);
    const previous = window.desktop, reads = [];
    window.desktop = { readResource: async url => { const path = decodeURIComponent(new URL(url).pathname.split('/').slice(2).join('/')); reads.push(path); assert.equal(path, 'body.png'); return { ok: true, value: { mime: 'image/png', base64: 'aW1hZ2U=' } }; } };
    try {
      const converted = await conversionMarkdown(source, rendered);
      assert.deepEqual(reads, ['body.png']); assert.equal(frontmatter(converted).yaml, frontmatter(source).yaml);
      const copy = document.createElement('article'); copy.innerHTML = renderMarkdown(converted, 'fixture');
      assert.ok([...copy.querySelectorAll('img')].every(image => image.getAttribute('src') === 'data:image/png;base64,aW1hZ2U='));
      assert.equal(copy.querySelectorAll('img').length, 2);
    } finally { window.desktop = previous; }
  });
}
