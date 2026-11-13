import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./store.mjs";

// First-run notes: Chinese in samples.json, other languages in samples.i18n.json, English for the rest.
export async function sampleNotes(root, language) {
  if (language === "zh") return JSON.parse(await readFile(path.join(root, "shared/samples.json"), "utf8"));
  const localized = JSON.parse(await readFile(path.join(root, "shared/samples.i18n.json"), "utf8"));
  return localized[language] ?? localized.en;
}
export const sampleShortcuts = (content, platform) => platform === "darwin" ? content : content.replace(/⌘\s*/g, "Ctrl+");

// Writes only missing notes, so the user's edits are never overwritten, then opens them (Welcome first) and shows the folder.
export async function openSamples(store, samples, folder, platform = process.platform) {
  const documents = [];
  for (const sample of samples) {
    const file = path.join(folder, sample.name);
    try { await readFile(file); }
    catch (error) { if (error.code === "ENOENT") await atomicWrite(file, sampleShortcuts(sample.content, platform)); else throw error; }
    documents.push(await store.open(file));
  }
  await store.scan(folder);
  return { documents, activeId: documents[0].id, folder };
}
