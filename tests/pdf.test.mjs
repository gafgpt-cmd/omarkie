import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { convertPdf, pdfConverter } from "../electron/pdf.mjs";

// A stand-in converter with the pdf-md calling convention: <file.pdf> --output <folder>; writes Markdown and a picture.
async function fixture(t, body = 'const [file,, out] = process.argv.slice(2); const fs = require("fs"), path = require("path"); fs.appendFileSync(process.env.CALLS, "x"); fs.mkdirSync(path.join(out, "_images"), { recursive: true }); fs.writeFileSync(path.join(out, "_images", "page1.png"), "png"); fs.writeFileSync(path.join(out, path.basename(file, ".pdf") + ".md"), "# Converted\\n\\n![p](_images/page1.png)\\n"); fs.writeFileSync(path.join(out, "notes.md"), "x");') {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-pdf-")); t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, "convert.cjs"), pdf = path.join(root, "Book Name.pdf"), data = path.join(root, "data"), calls = path.join(root, "calls");
  await writeFile(script, body); await writeFile(pdf, "%PDF-1.7"); await mkdir(data); await writeFile(calls, "");
  process.env.CALLS = calls;
  return { root, script, pdf, data, calls, converter: [process.execPath, script] };
}

test("the converter comes from the environment, the data folder or PATH, and none means no conversion", async t => {
  const { root, script, data } = await fixture(t);
  assert.deepEqual(await pdfConverter(data, { OMARKIE_PDF_CONVERTER: JSON.stringify([process.execPath, script]) }), [process.execPath, script]);
  await writeFile(path.join(data, "pdf-converter"), process.execPath + "\n");
  assert.deepEqual(await pdfConverter(data, {}), [process.execPath]);
  const bin = path.join(root, "bin"), empty = path.join(root, "empty"); await mkdir(bin); await mkdir(empty);
  const shim = path.join(bin, process.platform === "win32" ? "pdf-md.cmd" : "pdf-md"); await writeFile(shim, "", { mode: 0o755 });
  assert.deepEqual(await pdfConverter(empty, { PATH: bin }), [shim]);
  assert.equal(await pdfConverter(empty, { PATH: empty }), null);
  await assert.rejects(pdfConverter(empty, { OMARKIE_PDF_CONVERTER: '["", 1]' }));
});

test("a PDF converts once into a Markdown copy with its pictures; a changed PDF converts again", async t => {
  const { pdf, data, calls, converter } = await fixture(t);
  const markdown = await convertPdf(pdf, data, converter);
  assert.equal(path.basename(markdown), "Book Name.md");
  assert.match(await readFile(markdown, "utf8"), /# Converted/);
  assert.equal(await readFile(path.join(path.dirname(markdown), "_images", "page1.png"), "utf8"), "png");
  assert.equal(await convertPdf(pdf, data, converter), markdown);
  assert.equal((await readFile(calls, "utf8")).length, 1);
  await utimes(pdf, new Date(), new Date(Date.now() + 5000));
  assert.notEqual(await convertPdf(pdf, data, converter), markdown);
  assert.equal((await readFile(calls, "utf8")).length, 2);
});

test("a failing converter or one that writes no Markdown leaves no copy behind", async t => {
  const failing = await fixture(t, 'process.stderr.write("engine crashed\\n"); process.exit(3);');
  await assert.rejects(convertPdf(failing.pdf, failing.data, failing.converter), error => /engine crashed/.test(error.stderr));
  const silent = await fixture(t, "");
  await assert.rejects(convertPdf(silent.pdf, silent.data, silent.converter), /Markdown/);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(path.join(silent.data, "PDF")), []);
});
