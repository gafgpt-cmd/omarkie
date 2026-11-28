import assert from "node:assert/strict";
import test from "node:test";
import readingCore from "../shared/reading-core.cjs";
import { foldBlock, foldDragType, foldPayload, readFoldPayload, readFoldTransfer, writeFoldTransfer } from "../src/components/fold/drag.ts";

const line = () => foldPayload({
  note: "Physiology/Renal.md", title: "Renal", stop: "key", by: "author", line: 12, endLine: 14, headings: ["Renal", "Filtration"],
  text: "GFR falls as afferent tone rises.", quote: "Glomerular filtration rate falls when the afferent arteriole constricts.\nEfferent tone does the opposite.",
});
// The DataTransfer surface the browser gives dragstart, copy and drop handlers.
class Transfer {
  data = new Map();
  get types() { return [...this.data.keys()]; }
  setData(type, value) { this.data.set(type, value); }
  getData(type) { return this.data.get(type) ?? ""; }
}

test("a dragged fold line fills all four types with its evidence and the way back", () => {
  const data = new Transfer();
  writeFoldTransfer(data, line());
  assert.deepEqual(data.types.sort(), [foldDragType, "text/markdown", "text/plain", "text/uri-list"].sort());
  assert.equal(data.getData("text/uri-list"), "omarkie://open?note=Physiology%2FRenal.md&line=12&stop=key");
  assert.equal(data.getData("text/markdown"), [
    "> **GFR falls as afferent tone rises.**", ">",
    "> Glomerular filtration rate falls when the afferent arteriole constricts.", "> Efferent tone does the opposite.", ">",
    "> — [[Physiology/Renal#Filtration]] · L12", "",
  ].join("\n"));
  assert.match(data.getData("text/plain"), /^GFR falls as afferent tone rises\.\n\n“Glomerular filtration[\s\S]*”\n— Renal › Filtration, L12$/);
  assert.deepEqual(readFoldTransfer(data), line());
});

test("an unsaved note's line carries no link and the payload never trusts foreign shapes", () => {
  const data = new Transfer();
  writeFoldTransfer(data, { ...line(), note: "" });
  assert.equal(data.types.includes("text/uri-list"), false);
  for (const bad of [{ note: "../secret.md" }, { note: "/etc/passwd" }, { stop: "summary" }, { line: 0 }, { endLine: 3 }, { quote: " " }, { format: "textfold" }])
    assert.equal(readFoldPayload(JSON.stringify({ ...line(), ...bad })), null, JSON.stringify(bad));
  assert.equal(readFoldPayload("{"), null);
});

test("a linked excerpt pastes as its own block", () => {
  assert.match(foldBlock(line(), "Intro text"), /^\n\n> \*\*GFR[\s\S]*L12\n\n$/);
  assert.match(foldBlock(line(), "Intro\n\n"), /^> \*\*GFR/);
});

test("an evidence scrap keeps the quoted author words through the journal", () => {
  const core = readingCore(() => "digest");
  const item = { type: "scrap", id: "fold-1", sheet: "notes", kind: "evidence", anchor: null, body: "GFR falls as afferent tone rises.",
    question: "Glomerular filtration rate falls when the afferent arteriole constricts.", stackOf: null, folded: false };
  assert.equal(core.validate({ action: "put", item }).item.question, item.question);
});
