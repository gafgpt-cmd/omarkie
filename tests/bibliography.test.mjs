import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VaultBibliography, readVaultBibliography } from "../electron/bibliography.mjs";
import { citationAt, citationDraft } from "../src/editor/citationSyntax.ts";

const entry = (id, extra) => ({ id, type: "book", title: `Evidence for ${id}`, ...extra });

test("citation replacement preserves neighboring Markdown and ignores literal and link forms", () => {
  assert.deepEqual(citationDraft("Text [@preSuffix], tail", 10), { from: 5, to: 17, at: 10, query: "pre" });
  assert.deepEqual(citationDraft("[@", 2), { from: 0, to: 2, at: 2, query: "" });
  for (const source of ["\\[@abc]", "[[@abc]]", "[@abc](url)", "[@abc][ref]"]) {
    const at = source.indexOf("@") + 4;
    assert.equal(citationDraft(source, at), undefined, source);
    assert.equal(citationAt(source, at), undefined, source);
  }
  assert.deepEqual(citationAt("A [@a/b:v1-x] B", 8), { from: 2, to: 13, id: "a/b:v1-x" });
});

test("vault access isolates imports and a live export survives malformed and replacement writes", { timeout: 15000 }, async t => {
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "omarkie-bibliography-")));
  const data = path.join(scratch, "profile"), vault = path.join(scratch, "vault"), other = path.join(scratch, "other");
  await Promise.all([mkdir(vault), mkdir(other)]);
  let notify;
  const changed = () => notify?.();
  const library = new VaultBibliography(data, vault, changed);
  t.after(() => library.close());
  const first = JSON.stringify([entry("manual")]);
  await library.run("save", first);
  await assert.rejects(library.run("save", JSON.stringify([entry("dupe"), entry("dupe")])));
  assert.equal(await readVaultBibliography(data, vault), first);
  assert.equal(await readVaultBibliography(data, other), "");

  const source = path.join(scratch, "zotero.json"), replacement = path.join(scratch, "new.json");
  const pdf = path.join(scratch, "Evidence Résumé.pdf"), impostor = path.join(scratch, "fake.pdf");
  await writeFile(pdf, "%PDF-1.7\n");
  await writeFile(impostor, "not a PDF");
  await writeFile(source, JSON.stringify([entry("zotero", { "omarkie-pdf": ["https://example.org/a.pdf", "relative.pdf", impostor, pdf] }), entry("not-pdf", { "omarkie-pdf": [impostor] })]));
  await library.run("link", source);
  assert.equal(await library.run("pdf", "zotero"), pdf);
  assert.equal(await library.run("pdf", "not-pdf"), null);
  assert.equal(await library.run("pdf", pdf), null);
  assert.doesNotMatch(await readVaultBibliography(data, vault), /omarkie-pdf|Résumé/);
  async function waitForChange(write) {
    const signal = new Promise(resolve => { notify = resolve; });
    await write();
    await signal;
  }
  await waitForChange(() => writeFile(source, "["));
  assert.equal((await library.run("info")).stale, true);
  assert.deepEqual((await library.run("suggest", "zotero")).map(match => match.id), ["zotero"]);
  const latest = JSON.stringify([entry("replacement", { author: [{ family: "Rivera" }] })]);
  await writeFile(replacement, latest);
  await waitForChange(() => rename(replacement, source));
  assert.deepEqual((await library.run("suggest", "riv")).map(match => match.id), ["replacement"]);
  assert.equal((await library.run("info")).stale, false);
  library.close();
  const reopened = new VaultBibliography(data, vault, () => {});
  t.after(() => reopened.close());
  assert.equal((await reopened.run("info")).csl, latest);
  await reopened.run("disconnect");
  await writeFile(source, "[]");
  assert.equal(await readVaultBibliography(data, vault), latest);
  await reopened.run("clear");
  assert.equal(await readVaultBibliography(data, vault), "");
});
