import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCleanScript } from "../electron/clean-script.mjs";
import { cleanWithEngine } from "../src/clean-converted.ts";
import { properties } from "../shared/frontmatter.mjs";

const fixture = fileURLToPath(new URL("./fixtures/clean-script.cjs", import.meta.url));

test("converted page furniture, text and structures clean deterministically", async () => {
  const source = ["<!-- page: 1 -->", "Sample publication", "", "Introduction", "", "A reconst-", "ruction of the result.", "", "• First", "• Second", "", "Page 1", "Copyright notice", "<!-- page: 2 -->", "Sample publication", "", "1.First", "2.Second", "3.Third", "", "| Key | Value |", "| A | B |", "", "Figure 1. Sample image", "", "![Sample](figure.png)", "", "Page 2", "Copyright notice", ""].join("\n");
  const cleaned = await cleanWithEngine(source, 'Sample "text".md');
  assert.deepEqual(properties(cleaned), { type: "Reference", title: 'Sample "text"', tags: [] });
  assert.match(cleaned, /## Introduction\n\nA reconstruction of the result\./);
  assert.match(cleaned, /- First\n- Second/);
  assert.match(cleaned, /1\. First\n2\. Second\n3\. Third/);
  assert.match(cleaned, /\| Key \| Value \|\n\| --- \| --- \|\n\| A \| B \|/);
  assert.match(cleaned, /!\[Sample\]\(figure\.png\)\nFigure 1\. Sample image/);
  assert.doesNotMatch(cleaned, /publication|Copyright|Page \d|<!-- page:/i);
  assert.equal(await cleanWithEngine(cleaned, "Ignored.md"), cleaned);
});

test("cleanup preserves existing frontmatter, fenced content and mixed endings", async () => {
  const locked = '---\r\ntitle: Original # keep\r\n...\r\n\n```text\n<!-- page: 1 -->\n• Example\n```\r\n\r\n$$\n1\n$$\n\n| Col | Alt |\n| --- | --- |\n| X | Y |\r\n\n';
  const body = "A transfor-\nmation.\r\n\n2024\n";
  assert.equal(await cleanWithEngine(locked + body, "Note.md"), locked + "A transformation.\r\n\n2024\n");
});

test("configured engine supplements safe cleanup and rejects partial results", async () => {
  const initial = "---\r\ncustom: preserved\r\n---\r\npublisher artifact\r\n\r\nMethods\r\n\r\nA note.\r\n";
  const run = mode => body => runCleanScript(body, JSON.stringify([process.execPath, fixture, mode]));
  assert.equal(await cleanWithEngine(initial, "Note.md", run("complete")), "---\r\ncustom: preserved\r\n---\r\n## Methods\r\n\r\nA note.\r\n");
  await assert.rejects(cleanWithEngine(initial, "Note.md", run("partial")), /清理脚本失败。文档未更改。/);
  await assert.rejects(runCleanScript("text", '[]'), /清理脚本设置无效。/);
});
