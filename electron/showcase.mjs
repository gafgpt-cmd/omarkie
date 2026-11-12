import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// The showcase notes ship inside the application (app.asar in packages) and are copied into the
// user's data folder, where they are ordinary documents the user can edit.
export const showcaseFolderName = "Showcase";
export const showcaseDocuments = ["travel-journal.md", "recipe-card.md", "space-explainer.md", "launch-plan.md", "poetry-and-type.md"];
export const showcaseSource = root => path.join(root, "docs", "showcase");

// Copies only files missing from the target, so the user's edits are never overwritten.
export async function copyShowcase(source, target) {
  const copied = [];
  async function walk(relative) {
    await mkdir(path.join(target, relative), { recursive: true });
    for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
      const item = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(item);
      else if (entry.isFile()) {
        try { await writeFile(path.join(target, item), await readFile(path.join(source, item)), { flag: "wx" }); copied.push(item); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      }
    }
  }
  await walk("");
  return copied;
}

// Copies what is missing, opens the documents (the travel journal first) and shows the folder.
export async function openShowcase(store, source, folder, names = showcaseDocuments) {
  await copyShowcase(source, folder);
  const documents = [];
  for (const name of names) documents.push(await store.open(path.join(folder, name)));
  return { documents, folder: await store.scan(folder) };
}
