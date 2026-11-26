import assert from "node:assert/strict";
import { test } from "node:test";
import { linkFor, noteMergeSettings } from "../shared/glass-merge.mjs";

// A picture is written where the link resolves. Markdown resolves a relative link from the note's
// folder; `![[…]]` resolves from the vault root. These are the four cases the merge writes.
test("a root note links the picture beside itself", () => {
  const settings = noteMergeSettings({ notePath: "map.md" });
  assert.equal(settings.attachmentFolder, "");
  assert.equal(linkFor(settings, "dot.png"), "dot.png");
});

test("a nested note places the picture beside itself and links the bare name", () => {
  const settings = noteMergeSettings({ notePath: "notes/map.md" });
  assert.equal(settings.attachmentFolder, "notes");
  assert.equal(linkFor(settings, "notes/dot.png"), "dot.png");
});

test("an Obsidian attachment folder is linked relative to the note", () => {
  const settings = noteMergeSettings({ appJson: { attachmentFolderPath: "assets", useMarkdownLinks: true }, notePath: "notes/map.md" });
  assert.equal(linkFor(settings, "assets/dot.png"), "../assets/dot.png");
  const root = noteMergeSettings({ appJson: { attachmentFolderPath: "assets", useMarkdownLinks: true }, notePath: "map.md" });
  assert.equal(linkFor(root, "assets/dot.png"), "assets/dot.png");
});

test("a note-relative folder setting links from the note, not the vault", () => {
  const settings = noteMergeSettings({ appJson: { attachmentFolderPath: "./media", useMarkdownLinks: true }, notePath: "notes/map.md" });
  assert.equal(settings.attachmentFolder, "notes/media");
  assert.equal(linkFor(settings, "notes/media/dot.png"), "media/dot.png");
});

test("wikilinks keep the vault path, spaces survive, NFD names keep their code points", () => {
  const obsidian = noteMergeSettings({ appJson: {}, notePath: "notes/map.md" });
  assert.equal(linkFor(obsidian, "notes/dot.png"), "notes/dot.png");
  const spaces = noteMergeSettings({ notePath: "notes/map.md" });
  assert.equal(linkFor(spaces, "notes/a b (1).png"), "a b (1).png");
  const nfd = "notes/Cafe\u0301.png";
  assert.equal(linkFor(spaces, nfd), "Cafe\u0301.png");
});

test("a picture whose name collides in the note's folder still resolves after the rename", async () => {
  const { assetFile } = await import("../shared/glass-images.mjs");
  const settings = noteMergeSettings({ notePath: "notes/map.md" });
  const name = assetFile("dot.png", "png", new Set(["dot.png"]));
  assert.equal(name, "dot-2.png");
  assert.equal(linkFor(settings, `notes/${name}`), name);
});
