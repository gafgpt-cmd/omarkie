import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { projectDestination, vaultSnapshot } from "../electron/document-workflows.mjs";
import { exportResource } from "../electron/resources.mjs";
import { DocumentStore } from "../electron/store.mjs";
import { createTranslator } from "../shared/i18n.mjs";
import { projectChapters } from "../shared/project-export.mjs";

const t = createTranslator("en");
const note = (relative, content) => ({ relative, path: relative, token: relative, content });

test("draft order wins, ties are deterministic, and only export copies lose metadata", () => {
  const notes = [note("c.md", "---\norder: \"0\"\n---\nUnordered"), note("b/chapter.md", "---\norder: 10\n---\nSecond"),
    note("a/chapter.md", "\uFEFF---\r\norder: 10\r\n...\r\nFirst tie\r\n"), note("d.md", "---\norder: 50\n---\nDisk body")];
  const draft = { path: "d.md", content: "---\rorder: -1\r---\rDraft body" };
  const snapshot = { notes, truncated: false }, original = structuredClone(snapshot);
  assert.deepEqual(projectChapters(snapshot, [draft], t).map(chapter => [chapter.relative, chapter.body]), [
    ["d.md", "Draft body"], ["a/chapter.md", "First tie\n"], ["b/chapter.md", "Second"], ["c.md", "Unordered"],
  ]);
  assert.deepEqual(snapshot, original);
  assert.throws(() => projectChapters({ ...snapshot, truncated: true }, [], t), /Incomplete inventory/);
  assert.throws(() => projectChapters({ notes: [], truncated: false }, [], t), /no Markdown chapters/);
  assert.throws(() => projectChapters({ notes: [note("broken.md", "---\norder: [\n---\n")], truncated: false }, [], t), /frontmatter: broken\.md/);
});

test("unopened chapters resolve identical asset names locally without granting access outside the project", async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "omarkie-project-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, "project"), outside = path.join(scratch, "outside.png");
  await writeFile(outside, "outside");
  for (const chapter of ["a", "b"]) {
    const folder = path.join(root, chapter);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "chapter.md"), "![figure](image.png)");
    await writeFile(path.join(folder, "image.png"), chapter);
  }
  const store = new DocumentStore(path.join(scratch, "profile"));
  await store.scan(root);
  const { notes } = await vaultSnapshot(store, true);
  const address = (index, source) => `omarkie-asset://local/${notes[index].token}/${encodeURIComponent(source)}`;
  for (const [index, chapter] of ["a", "b"].entries()) {
    const resource = await exportResource(address(index, "image.png"), store, "", true);
    assert.equal(Buffer.from(resource.base64, "base64").toString(), chapter);
  }
  assert.equal(store.records.size, 0);
  await assert.rejects(exportResource(address(0, "../../outside.png"), store, "", true));
  await assert.rejects(exportResource(address(0, outside), store, "", true));
  if (process.platform !== "win32") {
    await symlink(outside, path.join(root, "a", "linked.png"));
    await assert.rejects(exportResource(address(0, "linked.png"), store, "", true));
  }
  await assert.rejects(exportResource("https://example.invalid/image.png", store, "", true), /来源/);
});

test("project output cannot overwrite a source asset through a destination symlink", async t => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "omarkie-project-output-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = path.join(await realpath(scratch), "project"), asset = path.join(root, "asset.docx");
  await mkdir(root);
  await writeFile(asset, "existing source asset");
  await assert.rejects(projectDestination(root, asset, "docx"));
  await assert.rejects(projectDestination(root, path.join(scratch, "output.md"), "docx"));
  if (process.platform !== "win32") {
    const link = path.join(scratch, "linked.docx");
    await symlink(asset, link);
    await assert.rejects(projectDestination(root, link, "docx"));
  }
  assert.equal(await projectDestination(root, path.join(scratch, "output.docx"), "docx"), path.join(await realpath(scratch), "output.docx"));
});
