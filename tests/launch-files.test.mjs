import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchFiles, launchLinks } from "../electron/launch-files.mjs";

test("installed file associations preserve spaces and Unicode without treating switches as files", () => {
  const folder = path.resolve("notes");
  assert.deepEqual(launchFiles(["Omarkie.exe", "--inspect.md", "会议 notes.md", "not.txt", "会议 notes.md", "Book Name.PDF"], true, folder), [path.join(folder, "会议 notes.md"), path.join(folder, "Book Name.PDF")]);
});
test("development launch omits the Electron application directory", () => {
  assert.deepEqual(launchFiles(["electron", "editor.md", "note.markdown"], false), [path.resolve("note.markdown")]);
});
test("Linux desktop %U file URLs decode spaces and Unicode before opening a document", () => {
  const file=path.resolve('会议 notes #1.md');
  assert.deepEqual(launchFiles(['omarkie',pathToFileURL(file).href,'file:///%ZZ.md'],true),[file]);
});
test("omarkie://open links reach a vault note line and refuse escapes", () => {
  assert.deepEqual(launchLinks(["omarkie", "--flag", "omarkie://open?note=Physiology%2FRenal.md&line=12&stop=key"]), [{ note: "Physiology/Renal.md", line: 12 }]);
  for (const bad of ["omarkie://open?note=..%2Fx.md&line=1", "omarkie://open?note=%2Fetc%2Fx.md", "omarkie://open?note=a.txt", "omarkie://open?note=a.md&line=0", "omarkie://other?note=a.md"])
    assert.deepEqual(launchLinks([bad]), [], bad);
});
