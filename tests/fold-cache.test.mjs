import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CHUNK_LIMIT, assembleFold, chunkKey, chunkUnits, foldRecord, planChunks, queueOrder } from "../shared/fold-cache.mjs";
import { isFold } from "../shared/fold-format.mjs";
import { extractUnits } from "../shared/fold-units.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/fold/", import.meta.url));
const fixtures = readdirSync(FIXTURES).filter(name => /^\d{2}-/.test(name)).sort()
  .map(id => ({ id, markdown: readFileSync(`${FIXTURES}${id}/input.md`, "utf8") }));
const SETTINGS = Object.freeze({ schemaVersion: 1, promptVersion: 1, slot: "ladder", route: "agent", agent: "opencode", model: "deepseek-v4.1-flash", outLang: "es" });
const keys = chunks => chunks.map(chunk => chunk.key);
const changed = (before, after) => keys(after).filter(key => !keys(before).includes(key)).length;

// One word inside a unit gets one letter more; offsets come from the unit itself.
function editWord(markdown, unit) {
  const match = /\p{L}{4,}/u.exec(unit.markdown);
  assert.ok(match, `${unit.elementId} needs a word to edit`);
  const at = unit.from + match.index + match[0].length;
  return markdown.slice(0, at) + "x" + markdown.slice(at);
}

const sectionOf = units => {
  const sections = [];
  for (const unit of units) if (unit.kind === "heading" || !sections.length) sections.push([unit.elementId]); else sections.at(-1).push(unit.elementId);
  return sections;
};

test("chunks hold at most 12 units, cover every unit once in order, and never split a section under the limit", () => {
  for (const { id, markdown } of fixtures) {
    const units = extractUnits(markdown);
    const chunks = chunkUnits(units);
    assert.deepEqual(chunks.flatMap(chunk => chunk.unitIds), units.map(unit => unit.elementId), id);
    assert.ok(chunks.every(chunk => chunk.unitIds.length >= 1 && chunk.unitIds.length <= CHUNK_LIMIT), id);
    const home = new Map(chunks.flatMap(chunk => chunk.unitIds.map(unitId => [unitId, chunk.index])));
    for (const section of sectionOf(units)) {
      if (section.length <= CHUNK_LIMIT) assert.equal(new Set(section.map(unitId => home.get(unitId))).size, 1, `${id}: section ${section[0]} split`);
    }
  }
});

test("a section over the limit becomes full slices that share no chunk with its neighbours", () => {
  const body = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1} of the long section.`).join("\n\n");
  const markdown = `# Short\n\nIntro line.\n\n## Long\n\n${body}\n\n## After\n\nTail line.\n`;
  const units = extractUnits(markdown);
  const chunks = chunkUnits(units);
  const long = units.findIndex(unit => unit.kind === "heading" && unit.text.includes("Long"));
  const slices = chunks.filter(chunk => chunk.unitIds.some(unitId => units.findIndex(unit => unit.elementId === unitId) >= long
    && units.findIndex(unit => unit.elementId === unitId) <= long + 30));
  assert.deepEqual(slices.map(chunk => chunk.unitIds.length), [12, 12, 7]);
  assert.equal(slices[0].unitIds[0], units[long].elementId);
  assert.ok(!slices.some(chunk => chunk.unitIds.includes(units.at(-1).elementId) || chunk.unitIds.includes(units[0].elementId)));
});

test("chunk keys are deterministic and move with every key field, unit hash and pin", () => {
  const units = extractUnits(fixtures[0].markdown);
  const base = planChunks(units, SETTINGS);
  assert.deepEqual(keys(planChunks(units, { ...SETTINGS })), keys(base));
  assert.ok(keys(base).every(key => /^[0-9a-f]{64}$/.test(key)));
  for (const [field, value] of [["schemaVersion", 2], ["promptVersion", 2], ["route", "payload"], ["agent", "claude"], ["model", "other"], ["outLang", "en"], ["slot", "estudio"]]) {
    const moved = planChunks(units, { ...SETTINGS, [field]: value });
    assert.equal(changed(base, moved), base.length, field);
  }
  const hashes = base.find(chunk => chunk.hashes.length > 1).hashes;
  assert.notEqual(chunkKey(SETTINGS, hashes), chunkKey(SETTINGS, [...hashes].reverse()));
  assert.throws(() => chunkKey({ ...SETTINGS, model: "" }, hashes), /model/);
  assert.equal(chunkKey({ ...SETTINGS, created: "2026-11-28T00:00:00Z" }, hashes), chunkKey(SETTINGS, hashes));
});

test("a one-word edit changes exactly one chunk key on every golden fixture", () => {
  for (const { id, markdown } of fixtures) {
    const units = extractUnits(markdown);
    const prose = units.filter(unit => unit.kind === "paragraph" && /\p{L}{4,}/u.test(unit.markdown));
    const picks = [...new Set([prose[0], prose[Math.floor(prose.length / 2)], prose.at(-1)])].filter(Boolean);
    assert.ok(picks.length, id);
    const before = planChunks(units, SETTINGS);
    for (const unit of picks) {
      const after = planChunks(extractUnits(editWord(markdown, unit)), SETTINGS);
      assert.deepEqual(after.map(chunk => chunk.unitIds.length), before.map(chunk => chunk.unitIds.length), `${id}: boundaries moved`);
      assert.equal(changed(before, after), 1, `${id}: ${unit.elementId}`);
    }
  }
});

test("a must-keep pin re-keys only the chunk that holds it, whatever the pin order", () => {
  const units = extractUnits(fixtures.find(fixture => fixture.id.startsWith("12-")).markdown);
  const base = planChunks(units, SETTINGS);
  assert.ok(base.length > 3);
  const target = units.find(unit => unit.elementId === base[2].unitIds.at(-1));
  const other = units.find(unit => unit.elementId === base[2].unitIds[0]);
  const pins = [{ elementId: target.elementId, quote: target.text.slice(0, 20) }, { elementId: other.elementId, quote: other.text.slice(0, 12) }];
  const pinned = planChunks(units, SETTINGS, pins);
  assert.equal(changed(base, pinned), 1);
  assert.notEqual(pinned[2].key, base[2].key);
  assert.deepEqual(keys(planChunks(units, SETTINGS, [...pins].reverse())), keys(pinned));
  assert.deepEqual(keys(planChunks(units, SETTINGS, [{ elementId: "paragraph-missing", quote: "x" }])), keys(base));
});

test("the visible chunk queues first, the rest keep document order", () => {
  const chunks = chunkUnits(extractUnits(fixtures.find(fixture => fixture.id.startsWith("12-")).markdown));
  const order = queueOrder(chunks, chunks[3].unitIds[1]).map(chunk => chunk.index);
  assert.deepEqual(order, [3, ...chunks.map(chunk => chunk.index).filter(index => index !== 3)]);
  assert.deepEqual(queueOrder(chunks, "paragraph-none").map(chunk => chunk.index), chunks.map(chunk => chunk.index));
});

test("assembly maps cached lines onto shifted duplicate ids and carries only lines whose quotes still fit", () => {
  const section = (title, count) => [`## ${title}`, ...Array.from({ length: count }, (_, index) => `${title} line ${index + 1} stays here.`)].join("\n\n");
  const original = `${section("Alpha", 8)}\n\nSame closing sentence.\n\n${section("Beta", 8)}\n\nSame closing sentence.\n`;
  const units = extractUnits(original);
  const chunks = planChunks(units, SETTINGS);
  assert.equal(chunks.length, 2);
  const duplicate = units.filter(unit => unit.text === "Same closing sentence.");
  assert.match(duplicate[1].elementId, /-2$/);
  const meta = { ...SETTINGS, created: "2026-11-28T00:00:00Z" };
  const model = unit => ({ by: "model", text: unit.text, evidence: [{ elementId: unit.elementId, quote: unit.text, sentence: 0, start: 0, end: unit.text.length }] });
  const entry = unit => ({ elementId: unit.elementId, role: "context", key: model(unit), takeaway: model(unit), topic: model(unit), checks: {} });
  const record = foldRecord(meta, chunks[1].unitIds.map(unitId => units.find(unit => unit.elementId === unitId)), [entry(duplicate[1])], []);
  const previous = foldRecord(meta, units, [entry(duplicate[0]), entry(duplicate[1])], []);

  const edited = original.replace("Same closing sentence.", "Changed closing sentence.");
  const now = extractUnits(edited);
  const nowChunks = planChunks(now, SETTINGS);
  assert.equal(nowChunks[1].key, chunks[1].key);
  const fold = assembleFold(meta, now, nowChunks, new Map([[chunks[1].key, record]]), previous);
  assert.ok(isFold(fold));
  const moved = now.find(unit => unit.text === "Same closing sentence.");
  assert.equal(moved.elementId, duplicate[0].elementId);
  assert.deepEqual(fold.written.map(item => item.elementId), [moved.elementId]);
  assert.equal(fold.written[0].key.evidence[0].elementId, moved.elementId);

  const otherWriter = assembleFold({ ...meta, model: "other" }, now, planChunks(now, { ...SETTINGS, model: "other" }), new Map(), previous);
  assert.deepEqual(otherWriter.written, []);
});
