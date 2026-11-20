import assert from "node:assert/strict";
import test from "node:test";
import { collectReadingItems, readingSummary } from "../shared/reading-collector.ts";
import { createMarkdown } from "../shared/markdown.mjs";

test("extracts source-ordered highlights and nested callouts with heading paths", () => {
  const markdown = [
    "# Parent", "", "## *Section*", "", "Lead ==first== and ==**second** &amp; more==.", "",
    "> [!tip]- Title", "> Callout with ==third==.", ">", "> > [!custom]+ Inner", "> > Nested body", "",
    "| ==cell== | Column |", "| --- | --- |", "| ==last== | Value |", "", "# Next", "", "==end==",
  ].join("\r\n");
  const items = collectReadingItems(markdown);
  assert.deepEqual(items.map(({ kind, target }) => [kind, target.line, target.quote]), [
    ["highlight", 5, "first"], ["highlight", 5, "second & more"],
    ["callout", 7, "> [!tip]- Title\n> Callout with ==third==.\n>\n> > [!custom]+ Inner\n> > Nested body"],
    ["highlight", 7, "third"], ["callout", 10, "> [!custom]+ Inner\n> Nested body"],
    ["highlight", 13, "cell"], ["highlight", 15, "last"], ["highlight", 19, "end"],
  ]);
  assert.deepEqual(items[3].target, {
    block: "> [!tip]- Title\r\n> Callout with ==third==.", headings: ["Parent", "Section"], line: 7, quote: "third",
  });
  assert.deepEqual(items.at(-1).target.headings, ["Next"]);
});

test("ignores invisible and literal syntax instead of treating it as annotations", () => {
  const markdown = [
    "---", "title: ==secret==", "---", "", "`==code==` and \\==escaped==.", "",
    "<!-- ==comment== -->", "", "```md", "==fenced==", "> [!note] not a callout", "```", "",
    "    ==indented code==", "", "> Normal quote", "", "[link](https://example.test/==path==)",
  ].join("\n");
  assert.deepEqual(collectReadingItems(markdown), []);
});

test("summary keeps callout Markdown and renders highlight text literally", () => {
  const items = collectReadingItems("- > [!warning]+ **Check**\n  > Body\n\n==`<b>` and a \\*==\n");
  const markdown = readingSummary(items, "Reading summary", "Source: [A].md");
  const html = createMarkdown().render(markdown);
  assert.match(html, /<h1[^>]*>Reading summary<\/h1>/);
  assert.match(html, /Source: \[A\]\.md/);
  assert.match(html, /data-alert="warning" data-callout-fold="\+"/);
  assert.match(html, /<strong>Check<\/strong>[\s\S]*Body[\s\S]*&lt;b&gt; and a \*/);
});
