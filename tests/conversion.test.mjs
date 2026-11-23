import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://editor.test/' });
for (const key of ['window', 'document', 'DOMParser', 'HTMLElement', 'Node']) globalThis[key] = dom.window[key];
const { exportDiagramBlocks, renderMarkdown } = await import('../src/editor/markdown.ts');
const { conversionMarkdown } = await import('../src/editor/print.ts');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNNsAAAAASUVORK5CYII=';
test('conversion embeds reference images and sized HTML images while preserving code, math and footnotes', async () => {
  const source = `# 中文\n\n![inline](${png})\n\n<img src="${png}" alt="尺寸" width="120" />\n\n![参考][fig]\n\n[fig]: ${png} "title"\n\n行内 $E=mc^2$ 和脚注[^n]。\n\n[^n]: 脚注内容\n\n\`\`\`text\n![code](missing.png)\n\`\`\`\n`;
  const root = document.createElement('article'); root.innerHTML = renderMarkdown(source, 'fixture');
  const converted = await conversionMarkdown(source, root);
  assert.ok(converted.includes(`src="${png}"`) && converted.includes('width="120"'));
  assert.ok(converted.includes(`[fig]: ${png} "title"`));
  assert.ok(converted.includes('![code](missing.png)'));
  assert.ok(converted.includes('$E=mc^2$') && converted.includes('[^n]: 脚注内容'));
});
test('missing export resources fail explicitly instead of producing a broken converted file', async () => {
  await assert.rejects(conversionMarkdown('![missing](no-file.png)', document.createElement('article')), /无法读取导出图片/);
});
test('diagram export recognizes spaced and nested fences without consuming surrounding Markdown', () => {
  const first = '``` mermaid\r\ngraph TD\r\n  A --> B\r\n```\r\n';
  const second = '> ~~~mermaid\r\n> graph LR\r\n> Start --> Finish\r\n> ~~~\r\n';
  const code = '````text\r\n```mermaid\r\nNot a diagram\r\n```\r\n````\r\n';
  const source = `${code}\r\n${first}\r\n${second}\r\nKeep this paragraph.`;
  const blocks = exportDiagramBlocks(source);
  assert.deepEqual(blocks.map(block => [block.language, block.body, block.prefix, source.slice(block.from, block.to)]), [
    ['mermaid', 'graph TD\n  A --> B\n', '', first],
    ['mermaid', 'graph LR\nStart --> Finish\n', '> ', second],
  ]);
});
test('raster conversion keeps the diagram and following paragraph in one quote', async () => {
  const source = '> Before\n>\n> ``` mermaid\n> graph TD\n> A --> B\n> ```\n> After\n';
  const root = document.createElement('article');
  root.innerHTML = renderMarkdown(source, 'fixture');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  Object.defineProperty(svg, 'viewBox', { value: { baseVal: { width: 20, height: 30 } } });
  root.querySelector('.mermaid-block').replaceChildren(svg);
  const canvas = dom.window.HTMLCanvasElement.prototype;
  const { getContext, toDataURL } = canvas;
  const { Image, XMLSerializer } = globalThis;
  canvas.getContext = () => ({ fillRect() {}, drawImage() {} });
  canvas.toDataURL = () => png;
  globalThis.Image = class { async decode() {} };
  globalThis.XMLSerializer = dom.window.XMLSerializer;
  try {
    const output = document.createElement('article');
    output.innerHTML = renderMarkdown(await conversionMarkdown(source, root), 'fixture');
    assert.equal(output.children.length, 1);
    assert.equal(output.firstElementChild.tagName, 'BLOCKQUOTE');
    const quote = output.firstElementChild;
    assert.deepEqual([...quote.querySelectorAll('p')].map(p => p.textContent.trim()), ['Before', '', 'After']);
    assert.equal(quote.querySelector('img')?.getAttribute('src'), png);
  } finally {
    Object.assign(canvas, { getContext, toDataURL });
    Object.assign(globalThis, { Image, XMLSerializer });
  }
});
