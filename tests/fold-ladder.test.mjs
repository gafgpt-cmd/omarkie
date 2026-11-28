import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FoldBridge } from "../electron/fold-bridge.mjs";
import { createFoldRunner } from "../electron/fold-runner.mjs";
import { FoldService } from "../electron/fold-service.mjs";
import { chunkUnits } from "../shared/fold-cache.mjs";
import { NUMBER_GAP, checkFormat, checkLadderChunk, countWords } from "../shared/fold-check.mjs";
import { evidenceFits } from "../shared/fold-format.mjs";
import { FOLD_LADDER_SCHEMA, anchorReply, foldMessages, ladderReplyProblems } from "../shared/fold-prompt.mjs";
import { firstSentence } from "../shared/fold-text.mjs";
import { foldDocumentLadder, isHiddenUnit } from "../shared/fold-units.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/fold/", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(FIXTURES, "manifest.json"), "utf8"));
const fixtures = manifest.fixtures.map(entry => ({
  ...entry,
  markdown: readFileSync(path.join(FIXTURES, entry.id, "input.md"), "utf8"),
  mustKeep: JSON.parse(readFileSync(path.join(FIXTURES, entry.id, "must-keep.json"), "utf8")),
}));
const fixture = number => fixtures.find(entry => entry.number === number);
const STOPS = ["key", "takeaway", "topic"];
const roots = [];
after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));

// A note as FoldService chunks it: the units each call sees, their local stops, and the chunk's headings.
function chunked(markdown) {
  const ladder = foldDocumentLadder(markdown);
  const unitOf = new Map(ladder.units.map(unit => [unit.elementId, unit]));
  const stops = new Map(ladder.byUnit.map(entry => [entry.unit.elementId, entry.stops]));
  const chunks = chunkUnits(ladder.units).map(chunk => ({ ...chunk, units: chunk.unitIds.map(id => unitOf.get(id)).filter(unit => !isHiddenUnit(unit)) }));
  return { stops, chunks, unitOf };
}

const quote = (unit, words) => {
  const start = unit.text.indexOf(words);
  assert.ok(start >= 0, `${words} not in ${unit.elementId}`);
  return { elementId: unit.elementId, quote: words, sentence: 0, start, end: start + words.length };
};
const model = (unit, text, words = text) => ({ by: "model", text, evidence: [quote(unit, words)] });
const lead = unit => firstSentence(unit.text).head.trim();
const foldable = unit => unit.kind !== "heading" && !unit.raw && /[\p{L}\p{N}]/u.test(unit.text);

// A faithful synthetic model: every line is the unit's first sentence, quoted as its own evidence.
function faithful(units, line = unit => model(unit, lead(unit))) {
  return {
    written: units.filter(foldable).map(unit => ({ elementId: unit.elementId, role: "context", key: line(unit), takeaway: line(unit), topic: line(unit) })),
    sections: units.filter(unit => unit.kind === "heading").map(unit => ({ elementId: unit.elementId, takeaway: model(unit, lead(unit)), topic: model(unit, lead(unit)) })),
  };
}

const validate = (chunk, stops, replies) => {
  const asked = [];
  const ask = async retry => {
    asked.push(retry);
    const reply = replies(chunk.units, retry, asked.length);
    return reply && anchorReply(reply, chunk.units);
  };
  return checkLadderChunk(ask, { units: chunk.units, stops, sectionIds: chunk.sectionIds }).then(result => ({ ...result, asked }));
};

async function foldNote(markdown, replies) {
  const { stops, chunks, unitOf } = chunked(markdown);
  const written = [], sections = [], asked = [];
  for (const chunk of chunks) {
    if (!chunk.units.some(unit => unit.kind === "heading" || foldable(unit))) continue;
    const result = await validate(chunk, stops, replies);
    written.push(...result.written);
    sections.push(...result.sections);
    asked.push(...result.asked);
  }
  return { written, sections, asked, stops, unitOf };
}

test("golden set: a faithful reply meets the schema contract; every stored model line is 100% grounded and Key ≤ Brief", async () => {
  for (const { id, markdown } of fixtures) {
    const { chunks } = chunked(markdown);
    for (const chunk of chunks) assert.deepEqual(ladderReplyProblems(faithful(chunk.units), chunk.units), [], `${id} chunk ${chunk.index}`);

    const { written, sections, stops, unitOf } = await foldNote(markdown, units => faithful(units));
    // A unit whose own words carry markup (fixture 14's injected link and HTML) keeps no model line: it shows its own words.
    const expected = [...unitOf.values()].filter(unit => foldable(unit) && !isHiddenUnit(unit) && checkFormat(lead(unit)).ok).map(unit => unit.elementId);
    assert.deepEqual(written.map(entry => entry.elementId), expected, `${id}: every foldable unit written once, raw units never`);
    for (const entry of written) {
      const words = Object.fromEntries(STOPS.map(stop => [stop, countWords(entry[stop].text)]));
      const brief = stops.get(entry.elementId).brief;
      if (brief) assert.ok(words.key <= countWords(brief), `${id} ${entry.elementId}: Key ${words.key} > Brief`);
      assert.ok(words.takeaway <= words.key && words.topic <= words.takeaway, `${id} ${entry.elementId}: ${JSON.stringify(words)}`);
      for (const stop of STOPS) {
        const line = entry[stop];
        assert.ok(checkFormat(line.text).ok, `${id} ${entry.elementId} ${stop}`);
        if (line.by !== "model") continue;
        for (const evidence of line.evidence) {
          assert.equal(evidence.elementId, entry.elementId, `${id} ${entry.elementId} ${stop}: quotes its own unit`);
          assert.ok(evidenceFits(unitOf.get(evidence.elementId).text, evidence), `${id} ${entry.elementId} ${stop}: ${evidence.quote}`);
        }
      }
    }
    for (const entry of sections) {
      for (const stop of ["takeaway", "topic"]) {
        if (entry[stop].by !== "model") continue;
        for (const evidence of entry[stop].evidence) {
          assert.equal(unitOf.get(evidence.elementId).sectionId, entry.elementId, `${id} section ${entry.elementId}`);
          assert.ok(evidenceFits(unitOf.get(evidence.elementId).text, evidence), `${id} section ${entry.elementId}`);
        }
      }
    }
  }
});

test("fixtures 1-2: a model that writes the whole unit at every stop is held to the size ladder", async () => {
  for (const number of [1, 2]) {
    const { markdown, id } = fixture(number);
    const verbose = units => faithful(units, unit => model(unit, unit.text));
    const { written, stops } = await foldNote(markdown, verbose);
    let demoted = 0;
    for (const entry of written) {
      const brief = stops.get(entry.elementId).brief, full = stops.get(entry.elementId).full;
      const key = countWords(entry.key.text), takeaway = countWords(entry.takeaway.text), topic = countWords(entry.topic.text);
      assert.ok(key <= countWords(brief || full) && takeaway <= key && topic <= takeaway, `${id} ${entry.elementId}`);
      if (countWords(full) > countWords(brief)) {
        demoted++;
        assert.deepEqual(entry.key, { by: "author", text: brief }, `${id} ${entry.elementId}: Key over Brief shows Brief words`);
        assert.equal(entry.checks.monotonic, "fail");
      }
    }
    assert.ok(demoted > 0, `${id}: some unit is longer than its Brief`);
  }
});

const dropToken = (phrase, token) => phrase.replace(new RegExp(`(?<![\\p{L}])${token}(?![\\p{L}])\\s*`, "iu"), "").trim();

test("payload loss: a dropped negation retries once naming it, then shows the author's words (fixtures 3, 7, 10, 14)", async () => {
  let cases = 0;
  for (const number of [3, 7, 10, 14]) {
    const { markdown, mustKeep, id } = fixture(number);
    const { chunks, stops } = chunked(markdown);
    for (const { token, phrase } of mustKeep.negations) {
      const chunk = chunks.find(item => item.units.some(unit => foldable(unit) && unit.text.includes(phrase)));
      if (!chunk) continue;
      const target = chunk.units.find(unit => foldable(unit) && unit.text.includes(phrase));
      const lossy = dropToken(phrase, token);
      assert.notEqual(lossy, phrase, `${id}: ${token}`);
      for (const fixed of [false, true]) {
        const replies = (units, retry) => {
          const reply = faithful(units);
          const entry = reply.written.find(item => item.elementId === target.elementId);
          entry.key = fixed && retry ? model(target, phrase) : model(target, lossy, phrase);
          return reply;
        };
        const result = await validate(chunk, stops, replies);
        const entry = result.written.find(item => item.elementId === target.elementId);
        assert.deepEqual(result.retried, [target.elementId], `${id} ${token}: ${phrase}`);
        assert.equal(result.asked.length, 2);
        assert.ok(result.asked[1][target.elementId].length > 0, `${id} ${token}: the retry names the lost words`);
        if (fixed) {
          assert.deepEqual([entry.key.by, entry.key.text], ["model", phrase], `${id} ${token}`);
          assert.equal(entry.checks.negation, "pass");
        } else {
          assert.deepEqual(entry.key, { by: "author", text: stops.get(target.elementId).brief }, `${id} ${token}: ${phrase}`);
          assert.equal(entry.checks.negation, "fail");
          assert.ok(result.warnings >= 1);
        }
      }
      cases++;
    }
  }
  assert.ok(cases >= 8, `negation cases found: ${cases}`);
});

test("payload loss: a failed retry call still shows the author's words, never the lossy line", async () => {
  const { markdown, mustKeep } = fixture(10);
  const { chunks, stops } = chunked(markdown);
  const { token, phrase } = mustKeep.negations.find(item => chunks.some(chunk => chunk.units.some(unit => unit.text.includes(item.phrase))));
  const chunk = chunks.find(item => item.units.some(unit => unit.text.includes(phrase)));
  const target = chunk.units.find(unit => unit.text.includes(phrase));
  const result = await validate(chunk, stops, (units, retry) => {
    if (retry) return null;
    const reply = faithful(units);
    reply.written.find(item => item.elementId === target.elementId).key = model(target, dropToken(phrase, token), phrase);
    return reply;
  });
  const entry = result.written.find(item => item.elementId === target.elementId);
  assert.deepEqual(result.retried, [target.elementId]);
  assert.deepEqual(entry.key, { by: "author", text: stops.get(target.elementId).brief });
});

test("payload loss: an invented or changed number becomes a visible gap, never a new number (fixtures 7, 10)", async () => {
  for (const number of [7, 10]) {
    const { markdown, mustKeep, id } = fixture(number);
    const { chunks, stops } = chunked(markdown);
    let cases = 0;
    for (const { source } of mustKeep.numbers) {
      const chunk = chunks.find(item => item.units.some(unit => foldable(unit) && unit.text.includes(source)));
      if (!chunk) continue;
      const target = chunk.units.find(unit => foldable(unit) && unit.text.includes(source));
      const changed = source.replace(/\d+/u, digits => String(Number(digits) + 7));
      const result = await validate(chunk, stops, units => {
        const reply = faithful(units);
        reply.written.find(item => item.elementId === target.elementId).key = model(target, changed, source);
        return reply;
      });
      const key = result.written.find(item => item.elementId === target.elementId).key;
      assert.ok(!key.text.includes(changed.match(/\d+/u)[0]) || key.by === "author", `${id}: ${changed} → ${key.text}`);
      assert.ok(key.text.includes(NUMBER_GAP) || key.by === "author", `${id}: ${source}`);
      assert.equal(result.written.find(item => item.elementId === target.elementId).checks.number, "fail");
      cases++;
    }
    assert.ok(cases >= 3, `${id}: number cases ${cases}`);
  }
});

test("fixture 14 rule: a grounded model line carrying markup shows Brief words and flags format; author words keep no markup", async () => {
  const { markdown, mustKeep } = fixture(14);
  const { chunks, stops } = chunked(markdown);
  const chunk = chunks.find(item => item.units.some(foldable));
  const targets = chunk.units.filter(foldable);
  const marked = unit => targets.indexOf(unit) % 2 === 0;
  const result = await validate(chunk, stops, units => {
    const reply = faithful(units);
    for (const entry of reply.written) {
      const unit = units.find(item => item.elementId === entry.elementId);
      if (!marked(unit)) continue;
      entry.key = model(unit, `${lead(unit)} [Download Official Protocol](https://evil.example/exfil)`, lead(unit));
      entry.takeaway = model(unit, `<img src="https://evil.example/pixel.gif"> ${lead(unit)}`, lead(unit));
    }
    return reply;
  });
  for (const entry of result.written) {
    const unit = targets.find(item => item.elementId === entry.elementId);
    for (const stop of STOPS) {
      assert.ok(checkFormat(entry[stop].text).ok, `${entry.elementId} ${stop}`);
      for (const text of mustKeep.forbidden) assert.ok(!entry[stop].text.includes(text), `${entry.elementId} ${stop}: ${text}`);
    }
    if (!marked(unit)) continue;
    assert.deepEqual([entry.key.by, entry.takeaway.by], ["author", "author"], entry.elementId);
    assert.equal(entry.checks.format, "fail", entry.elementId);
  }
  assert.ok(result.warnings >= targets.filter(marked).length * 2);
});

test("schema contract: each reply outside the shape or the job names its path", () => {
  const { chunks } = chunked(fixture(1).markdown);
  const chunk = chunks.find(item => item.units.some(foldable) && item.units.some(unit => unit.kind === "heading") && item.units.filter(foldable).length >= 2);
  const [first, second] = chunk.units.filter(foldable);
  const heading = chunk.units.find(unit => unit.kind === "heading");
  const raw = chunks.flatMap(item => item.units).find(unit => unit.raw);
  const cases = [
    [reply => { delete reply.sections; }, /^reply\.sections: required$/],
    [reply => { reply.notes = "x"; }, /^reply\.notes: unknown field$/],
    [reply => { reply.written[0].role = "summary"; }, /^reply\.written\[0\]\.role: expected one of definition/],
    [reply => { delete reply.written[0].key.evidence; }, /^reply\.written\[0\]\.key\.evidence: required$/],
    [reply => { reply.written[0].key.evidence = []; }, /^reply\.written\[0\]\.key\.evidence: expected at least 1/],
    [reply => { reply.written[0].key.by = "ai"; }, /^reply\.written\[0\]\.key\.by: expected one of "model", "author"$/],
    [reply => { reply.written[0].key.evidence[0].start = -1; }, /^reply\.written\[0\]\.key\.evidence\[0\]\.start: expected at least 0$/],
    [reply => { reply.sections[0].topic = { by: "author", text: lead(heading) }; }, /^reply\.sections\[0\]\.topic\.by: expected "model"$/],
    [reply => { reply.written.push({ ...reply.written[0], elementId: "paragraph-elsewhere" }); }, /paragraph-elsewhere is not a unit of this job/],
    [reply => { reply.written.push({ ...reply.written[0] }); }, new RegExp(`${first.elementId} is answered twice`)],
    [reply => { reply.written.shift(); }, new RegExp(`^reply\\.written: missing ${first.elementId}$`)],
    [reply => { reply.sections.shift(); }, new RegExp(`^reply\\.sections: missing ${heading.elementId}$`)],
    [reply => { reply.written.push({ ...reply.written[0], elementId: heading.elementId }); }, /is a heading: answer it in sections/],
    [reply => { reply.written[0].key = model(second, lead(second)); }, /^reply\.written\[0\]\.key\.evidence\[0\]\.elementId: quote this unit only$/],
    [reply => { reply.written[0].key.evidence[0].quote = "words the author never wrote"; }, /^reply\.written\[0\]\.key\.evidence\[0\]\.quote: not found word for word/],
    [reply => { reply.written[0].topic = { by: "author", text: "Invented author words." }; }, /^reply\.written\[0\]\.topic\.text: an author line copies the unit text exactly$/],
  ];
  for (const [mutate, expected] of cases) {
    const reply = structuredClone(faithful(chunk.units));
    mutate(reply);
    const problems = ladderReplyProblems(reply, chunk.units);
    assert.ok(problems.some(problem => expected.test(problem)), `${expected}: ${problems.join(" | ")}`);
  }
  if (raw) {
    const rawChunk = chunks.find(item => item.units.includes(raw));
    const reply = faithful(rawChunk.units);
    reply.written.push({ elementId: raw.elementId, role: "dose", key: { by: "author", text: "x" }, takeaway: { by: "author", text: "x" }, topic: { by: "author", text: "x" } });
    assert.ok(ladderReplyProblems(reply, rawChunk.units).some(problem => /is a raw \w+ unit: skip it/.test(problem)));
  }
  assert.deepEqual(ladderReplyProblems([], chunk.units), ["reply: expected an object"]);
});

test("the instruction carries the schema the contract check enforces; note text reaches the model only as JSON data", () => {
  const { markdown } = fixture(14);
  const { chunks } = chunked(markdown);
  const chunk = chunks.find(item => item.units.some(foldable));
  const units = chunk.units.map(unit => ({ ...unit, brief: unit.text.split(". ")[0] }));
  const [system, user] = foldMessages({ slot: "ladder", outLang: "es", chunk: { units, pins: [] } });
  const embedded = system.content.match(/JSON Schema, and nothing else: (\{.*\})$/mu);
  assert.deepEqual(JSON.parse(embedded[1]), FOLD_LADDER_SCHEMA);
  assert.match(system.content, /language "es"/u);
  for (const unit of units) assert.ok(!system.content.includes(unit.text.slice(0, 40)), "note text never enters the instruction");
  const job = JSON.parse(user.content);
  assert.deepEqual(job.units.map(unit => unit.text), units.map(unit => unit.text));
  assert.deepEqual(job.units.map(unit => unit.briefWords), units.map(unit => countWords(unit.brief)));
});

test("agent route: the bridge sends a reply outside the contract back to the agent, then takes the fixed one", async () => {
  const { chunks } = chunked(fixture(2).markdown);
  const chunk = chunks.find(item => item.units.some(foldable));
  const bridge = new FoldBridge();
  const answer = request => new Promise(resolve => bridge.client(request, resolve, "wait-ladder"));
  const units = chunk.units.map(unit => ({ elementId: unit.elementId, kind: unit.kind, raw: unit.raw, sectionId: unit.sectionId, text: unit.text, brief: "" }));
  const pending = bridge.submit({ slot: "ladder", agent: "opencode", model: "m", outLang: "es", chunk: { key: "k", units, pins: [] } });
  const { job } = await answer({ action: "poll", agent: "opencode" });
  const bad = faithful(units);
  bad.written[0].takeaway = { by: "author", text: "Palabras que el autor nunca escribió." };
  const refused = await answer({ action: "reply", id: job.id, reply: bad });
  assert.equal(refused.code, "FOLD_REPLY_INVALID");
  assert.match(refused.error, /reply\.written\[0\]\.takeaway\.text: an author line copies the unit text exactly/u);
  assert.deepEqual(refused.problems, ladderReplyProblems(bad, units));
  assert.equal((await answer({ action: "view", id: job.id })).job.state, "claimed", "the job stays with the agent");
  assert.equal((await answer({ action: "reply", id: job.id, reply: faithful(units) })).status, "done");
  assert.deepEqual(await pending, faithful(units));
  bridge.close();
});

test("fixtures 1-2: the first written section streams within the local share of the 6 s target", async t => {
  for (const number of [1, 2]) {
    const { markdown, lang, id } = fixture(number);
    const root = await mkdtemp(path.join(tmpdir(), "omarkie-fold-ladder-"));
    roots.push(root);
    const bridge = new FoldBridge();
    // An instant model through the real runner: every millisecond measured here is Omarkie's own share.
    bridge.submit = async request => faithful(request.chunk.units);
    const fold = new FoldService({ storeDir: root, runner: createFoldRunner({ bridge, payload: () => { throw new Error("no payload"); } }) });
    let firstChunk = null;
    const started = performance.now();
    fold.on("progress", event => { if (event.phase === "chunk" && firstChunk === null) firstChunk = performance.now() - started; });
    const result = await fold.run({ noteId: "ladder0note", title: id, markdown, route: "agent", agent: "opencode", model: "m", outLang: lang }).done;
    assert.deepEqual([result.state, result.errors], ["done", 0], id);
    assert.ok(firstChunk !== null && firstChunk <= 1000, `${id}: first section after ${firstChunk?.toFixed(1)} ms of local work`);
    t.diagnostic(`${id}: first section ${firstChunk.toFixed(1)} ms local`);
    await fold.close();
  }
});
