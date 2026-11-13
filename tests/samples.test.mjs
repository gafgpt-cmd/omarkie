import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DocumentStore } from "../electron/store.mjs";
import { openSamples, sampleNotes, sampleShortcuts } from "../electron/samples.mjs";
import { createTranslator } from "../shared/i18n.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const names = async language => (await sampleNotes(root, language)).map(sample => sample.name);

test("first-run notes follow the language, with English for the rest", async () => {
  assert.deepEqual(await names("zh"), ["欢迎.md", "写作示例.md", "Markdown 语法.md"]);
  assert.deepEqual(await names("en"), ["Welcome.md", "Writing sample.md", "Markdown syntax.md"]);
  assert.deepEqual(await names("es"), ["Bienvenida.md", "Ejemplo de escritura.md", "Sintaxis Markdown.md"]);
  assert.deepEqual(await names("ca"), ["Benvinguda.md", "Exemple d'escriptura.md", "Sintaxi Markdown.md"]);
  assert.deepEqual(await names("ro"), await names("en"));
  assert.deepEqual(await names("xx"), await names("en"));
});

test("every Welcome note points to the showcase through its localized Help menu", async () => {
  for (const language of ["zh", "en", "es", "ca"]) {
    const t = createTranslator(language), [welcome] = await sampleNotes(root, language);
    assert.ok(welcome.content.includes(`${t("帮助")} > ${t("展示示例")}`), language);
  }
});

test("shortcuts read Ctrl+ off macOS", () => {
  assert.equal(sampleShortcuts("| Save | ⌘ S |\n(⌘ ,)", "linux"), "| Save | Ctrl+S |\n(Ctrl+,)");
  assert.equal(sampleShortcuts("| Save | ⌘ S |", "win32"), "| Save | Ctrl+S |");
  assert.equal(sampleShortcuts("| Save | ⌘ S |", "darwin"), "| Save | ⌘ S |");
});

test("first run writes the missing notes, keeps edited ones and opens Welcome with the folder", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "omarkie-samples-")), folder = path.join(data, "Sample notes");
  const samples = await sampleNotes(root, "en"), store = new DocumentStore(path.join(data, "recovery"));
  const first = await openSamples(store, samples, folder, "linux");
  assert.deepEqual(first.documents.map(record => record.name), samples.map(sample => sample.name));
  assert.equal(first.activeId, first.documents[0].id);
  assert.equal(first.folder, folder);
  assert.equal(first.documents[0].path, path.join(await realpath(folder), "Welcome.md"));
  const welcome = await readFile(path.join(folder, "Welcome.md"), "utf8");
  assert.ok(welcome.includes("Ctrl+S") && !welcome.includes("⌘"));
  await writeFile(path.join(folder, "Welcome.md"), "# My own note\n");
  const again = await openSamples(new DocumentStore(path.join(data, "recovery-2")), samples, folder, "linux");
  assert.equal(await readFile(path.join(folder, "Welcome.md"), "utf8"), "# My own note\n");
  assert.equal(again.documents[0].content, "# My own note\n");
});
