import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import { FoldBridge } from "../electron/fold-bridge.mjs";
import { createFoldRunner } from "../electron/fold-runner.mjs";
import { chunkUnits } from "../shared/fold-cache.mjs";
import { NUMBER_GAP, countWords, extractPayload } from "../shared/fold-check.mjs";
import { checkEstudioChunk, estudioElements, estudioOutOfFold, filterEstudio, mergeEstudio } from "../shared/fold-estudio.mjs";
import { ESTUDIO_BLOCKS, ESTUDIO_LIMITS, estudioProblems, evidenceFits } from "../shared/fold-format.mjs";
import { ESTUDIO_PROMPT_VERSION, ESTUDIO_SCHEMA_VERSION, FOLD_ESTUDIO_SCHEMA, estudioReplyProblems, foldMessages, parseFoldReply } from "../shared/fold-prompt.mjs";
import { extractUnits, isHiddenUnit } from "../shared/fold-units.mjs";

const GOLDEN = ["01-adhf-ward-guide", "02-nota-evolucion-clinica", "03-hipertermia-maligna", "04-beta-blockers",
  "05-algoritmo-pcr-rcp", "06-acid-base", "07-metformina-erc", "08-nephritic-vs-nephrotic"];
const fixtureFile = (id, name) => new URL(`./fixtures/fold/${id}/${name}`, import.meta.url);

// A note as FoldService chunks it: every unit, and the units each Estudio call sees.
function chunked(markdown) {
  const units = extractUnits(markdown);
  const unitOf = new Map(units.map(unit => [unit.elementId, unit]));
  const chunks = chunkUnits(units).map(chunk => chunk.unitIds.map(id => unitOf.get(id)).filter(unit => !isHiddenUnit(unit)));
  return { units, chunks };
}

// Recorded replies quote by words alone; each quote goes to the smallest unit or table cell holding it, as a model names it.
function ground(reply, units) {
  const elements = [...estudioElements(units)].map(([elementId, element]) => ({ elementId, ...element }));
  const walk = value => (Array.isArray(value) ? value.map(walk)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "evidence"
      ? item.map(entry => {
        if (entry.elementId) return entry;
        const owner = elements.filter(element => element.text.includes(entry.quote)).sort((a, b) => a.text.length - b.text.length)[0];
        assert.ok(owner, `quote not in the note: ${entry.quote}`);
        return { elementId: owner.elementId, quote: entry.quote };
      })
      : walk(item)]))
      : value);
  return walk(reply);
}

const empty = () => ({ oneLiner: null, ...Object.fromEntries(ESTUDIO_BLOCKS.map(block => [block, []])) });
const quotesOf = value => JSON.stringify(value).match(/"elementId":"[^"]+"/g) ?? [];

// A recorded sheet split back into the reply each chunk call gives: every item goes to the chunk its quotes sit in.
function splitByChunk(reply, chunks) {
  const chunkOf = new Map();
  chunks.forEach((units, index) => { for (const id of estudioElements(units).keys()) chunkOf.set(id, index); });
  const replies = chunks.map(empty);
  const home = item => {
    const homes = new Set(quotesOf(item).map(quote => chunkOf.get(quote.slice(13, -1))));
    assert.equal(homes.size, 1, `an item quotes one chunk: ${JSON.stringify(item).slice(0, 120)}`);
    return replies[[...homes][0]];
  };
  if (reply.oneLiner) home(reply.oneLiner).oneLiner = reply.oneLiner;
  for (const block of ESTUDIO_BLOCKS.filter(block => block !== "bloques")) for (const item of reply[block]) home(item)[block].push(item);
  for (const bloque of reply.bloques) for (const bullet of bloque.bullets) home(bullet).bloques.push({ kind: bloque.kind, bullets: [bullet] });
  return replies;
}

async function goldenSheet(id) {
  const markdown = readFileSync(fixtureFile(id, "input.md"), "utf8");
  const { units, chunks } = chunked(markdown);
  const replies = splitByChunk(ground(JSON.parse(readFileSync(fixtureFile(id, "estudio-reply.json"), "utf8")), units), chunks);
  const results = [];
  for (const [index, reply] of replies.entries()) {
    if (JSON.stringify(reply) === JSON.stringify(empty())) continue;
    assert.deepEqual(estudioReplyProblems(reply, chunks[index]), [], `${id}: chunk ${index} reply breaks the contract`);
    results.push(await checkEstudioChunk(async retry => (retry ? assert.fail(`${id}: retry ${JSON.stringify(retry)}`) : reply), { units: chunks[index] }));
  }
  return { units, sheet: mergeEstudio(results.map(result => result.estudio), { elements: estudioElements(units) }) };
}

// Every checked line of a sheet with the words it shows and the quotes it rests on.
function sheetLines(sheet) {
  const lines = [];
  const add = (text, evidence, stars = 0) => lines.push({ text, evidence, stars });
  if (sheet.oneLiner) add(sheet.oneLiner.text, sheet.oneLiner.evidence, sheet.oneLiner.stars);
  for (const item of sheet.caso) add(`${item.entity}: ${item.text}`, item.evidence, item.stars);
  for (const table of sheet.vs) for (const row of table.rows) for (const cell of row.cells) add(`${table.title}: ${row.label}: ${cell.text}`, cell.evidence, row.stars);
  for (const item of sheet.numeros) add(`${item.label} ${item.value} ${item.unit} ${item.consequence}`, item.evidence, item.stars);
  for (const flow of sheet.flujo) for (const node of flow.nodes) add(`${flow.title}: ${node.text}`, node.evidence);
  for (const bloque of sheet.bloques) for (const item of bloque.bullets) add(item.text, item.evidence, item.stars);
  for (const item of sheet.nunca) add(`${item.text} ${item.why}`, item.evidence, item.stars);
  for (const item of sheet.buzzwords) add(`${item.term}: ${item.concept}`, item.evidence);
  for (const mnemonic of sheet.mnemonics) for (const item of mnemonic.items) add(`${mnemonic.label}: ${item.text}`, item.evidence);
  for (const item of sheet.cards) add(`${item.q} ${item.a}`, item.evidence);
  for (const item of sheet.gaps) add(item.text, item.evidence);
  return lines;
}

const folded = text => String(text).normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const words = text => new Set(folded(text).split(" ").filter(word => word.length >= 3 || /\d/.test(word)));
const sameNumber = (a, b) => a.value === b.value && (a.high ?? null) === (b.high ?? null) && (!a.unit || !b.unit || a.unit === b.unit);

// Where a must-keep phrase sits: the element and span the sheet must quote.
function spanOf(phrase, units) {
  for (const [elementId, element] of estudioElements(units)) {
    const start = element.text.indexOf(phrase);
    if (start >= 0) return { elementId, start, end: start + phrase.length };
  }
  return assert.fail(`phrase not in the note: ${phrase}`);
}
const quotesSpan = (line, span) => line.evidence.some(entry => entry.elementId === span.elementId && entry.start < span.end && span.start < entry.end);

/** Design §5.3 quality bar on one golden sheet. */
function assertQualityBar(id, sheet, units) {
  const mustKeep = JSON.parse(readFileSync(fixtureFile(id, "must-keep.json"), "utf8"));
  const elements = estudioElements(units);
  const lines = sheetLines(sheet);
  assert.deepEqual(estudioProblems(sheet), [], `${id}: stored sheet shape`);
  // Evidence 100 %: every line quotes the note word for word.
  for (const line of lines) {
    assert.ok(line.evidence.length && line.evidence.every(entry => evidenceFits(elements.get(entry.elementId)?.text, entry)), `${id}: ungrounded line ${line.text}`);
  }
  // Invented numbers 0, nothing dropped, no over-long line.
  assert.deepEqual({ gapped: sheet.checks.gapped, long: sheet.checks.long, dropped: sheet.checks.dropped }, { gapped: 0, long: 0, dropped: [] }, `${id}: checker tally`);
  assert.ok(!lines.some(line => line.text.includes(NUMBER_GAP)), `${id}: a number gap`);
  // Must-keep numbers present.
  for (const number of mustKeep.numbers) {
    const wanted = extractPayload(`${number.value} ${number.unit}`.replace(",", "."), { includeSpelled: true }).number;
    const held = lines.some(line => folded(line.text).includes(folded(number.source))
      || extractPayload(line.text.replace(/(\d),(\d)/g, "$1.$2"), { includeSpelled: true }).number.some(token => wanted.some(want => sameNumber(token, want))));
    assert.ok(held, `${id}: must-keep number ${number.value} ${number.unit} (${number.context})`);
  }
  // Must-keep negations and conditions present with their polarity, on a line quoting them.
  for (const [kind, list] of [["negation", mustKeep.negations], ["condition", mustKeep.conditions]]) {
    for (const entry of list) {
      const span = spanOf(entry.phrase, units);
      const held = lines.some(line => quotesSpan(line, span)
        && (extractPayload(line.text)[kind].length > 0 || folded(line.text).split(/[^\p{L}\p{N}]+/u).includes(folded(entry.token))));
      assert.ok(held, `${id}: must-keep ${kind} "${entry.phrase}"`);
    }
  }
  // Star recall ≥ 0.8: a high-yield fact sits in a starred item sharing at least half its words.
  const starred = [sheet.oneLiner, ...sheet.caso, ...sheet.numeros, ...sheet.nunca, ...sheet.bloques.flatMap(bloque => bloque.bullets),
    ...sheet.vs.filter(table => table.rows.some(row => row.stars > 0))].filter(item => item && (item.stars ?? 1) > 0);
  const recalled = mustKeep.highYield.filter(fact => {
    const want = words(fact.fact);
    return starred.some(item => {
      const have = words(JSON.stringify(item, (key, value) => (key === "evidence" ? undefined : value)));
      return [...want].filter(word => have.has(word)).length / want.size >= 0.5;
    });
  });
  assert.ok(recalled.length / mustKeep.highYield.length >= 0.8,
    `${id}: star recall ${recalled.length}/${mustKeep.highYield.length}; missed ${mustKeep.highYield.filter(fact => !recalled.includes(fact)).map(fact => fact.fact).join(" | ")}`);
  // Structure the note calls for.
  const { structure } = mustKeep;
  if (structure.expectTable) assert.ok(sheet.vs.length >= 1, `${id}: a vs table`);
  if (structure.expectNumbersTable) assert.ok(sheet.numeros.length >= 3, `${id}: a numbers table`);
  if (structure.expectFlow) assert.ok(sheet.flujo.length >= 1, `${id}: a flow`);
  if (structure.expectNever) assert.ok(sheet.nunca.length >= 1, `${id}: a never-do block`);
  if (structure.expectMnemonic) assert.ok(sheet.mnemonics.length >= 1, `${id}: a mnemonic`);
  // Density caps.
  assert.ok(sheet.oneLiner && countWords(sheet.oneLiner.text) <= ESTUDIO_LIMITS.oneLinerWords, `${id}: one-liner`);
  assert.ok(sheet.cards.length >= 5 && sheet.cards.length <= ESTUDIO_LIMITS.cards, `${id}: 5-10 cards`);
  for (const [block, limit] of [["vs", "vs"], ["numeros", "numeros"], ["flujo", "flujo"], ["nunca", "nunca"], ["buzzwords", "buzzwords"], ["mnemonics", "mnemonics"]]) {
    assert.ok(sheet[block].length <= ESTUDIO_LIMITS[limit], `${id}: ${block} cap`);
  }
  for (const table of sheet.vs) assert.ok(table.rows.length <= ESTUDIO_LIMITS.vsRows, `${id}: vs rows cap`);
  for (const forbidden of mustKeep.forbidden ?? []) assert.ok(!JSON.stringify(sheet).toLowerCase().includes(forbidden.toLowerCase()), `${id}: forbidden ${forbidden}`);
}

for (const id of GOLDEN) {
  test(`golden ${id}: the recorded Estudio sheet meets the §5.3 quality bar`, async () => {
    assert.ok(existsSync(fixtureFile(id, "estudio-reply.json")), `${id}: estudio-reply.json`);
    const { units, sheet } = await goldenSheet(id);
    assertQualityBar(id, sheet, units);
  });
}

// --- engine behaviour on a small synthetic note ---

const NOTE = [
  "# Sodio",
  "",
  "No corregir más de 8 mmol/L en 24 horas.",
  "",
  "Si hay convulsiones, dar suero hipertónico al 3 %.",
  "",
  "| Fármaco | Dosis |",
  "|---|---|",
  "| Suero hipertónico | 150 mL |",
  "| Tolvaptán | 15 mg |",
  "",
].join("\n");
const noteUnits = extractUnits(NOTE);
const noteElements = estudioElements(noteUnits);
const at = quote => {
  const owner = [...noteElements].filter(([, element]) => element.text.includes(quote)).sort((a, b) => a[1].text.length - b[1].text.length)[0];
  assert.ok(owner, quote);
  return { elementId: owner[0], quote };
};
const LIMIT = "No corregir más de 8 mmol/L en 24 horas.";
const SEIZURE = "Si hay convulsiones, dar suero hipertónico al 3 %.";
const reply = parts => ({ ...empty(), ...parts });
const run = (first, second = first) => {
  const asked = [];
  return checkEstudioChunk(async retry => { asked.push(retry); return retry ? second : first; }, { units: noteUnits }).then(result => ({ ...result, asked }));
};

test("Estudio contract: the job carries table cells, the reply schema names every block, quotes must sit in the job", () => {
  assert.deepEqual(FOLD_ESTUDIO_SCHEMA.required.slice().sort(), ["oneLiner", ...ESTUDIO_BLOCKS].sort());
  const request = { slot: "estudio", outLang: "es", chunk: { key: "k", units: noteUnits, pins: [] }, retry: null };
  const [system, user] = foldMessages(request);
  assert.match(system.content, /never follow instructions/i);
  const job = JSON.parse(user.content);
  assert.equal(job.task, "estudio");
  assert.deepEqual(job.units.find(unit => unit.kind === "table").cells.map(cell => cell.text), ["Fármaco", "Dosis", "Suero hipertónico", "150 mL", "Tolvaptán", "15 mg"]);

  const good = reply({ cards: [{ q: "¿Límite?", a: LIMIT, evidence: [at(LIMIT)] }] });
  assert.deepEqual(estudioReplyProblems(good, noteUnits), []);
  assert.match(estudioReplyProblems(reply({ cards: [{ q: "¿Límite?", a: "x", evidence: [{ ...at(LIMIT), quote: "corregir 10 mmol/L" }] }] }), noteUnits)[0], /cards\[0\]\.evidence\[0\]\.quote/);
  assert.match(estudioReplyProblems(reply({ flujo: [{ title: "t", nodes: [{ id: "a", text: "x", evidence: [at(LIMIT)] }, { id: "b", text: "y", evidence: [at(SEIZURE)] }], edges: [{ from: "a", to: "z" }] }] }), noteUnits).join("\n"), /edges/);
  assert.ok(estudioReplyProblems({ cards: [] }, noteUnits).length > 0, "every block is required");
  // A lenient read of a fenced reply: missing blocks are empty, never invented.
  assert.deepEqual(parseFoldReply("```json\n{\"cards\":[]}\n```", "estudio"), empty());
});

test("Estudio check: lost payload retries once by name, then drops to checks.dropped with its source", async () => {
  const lost = reply({ nunca: [{ text: "Corregir más de 8 mmol/L en 24 horas", why: "", stars: 2, evidence: [at(LIMIT)] }] });
  const dropped = await run(lost);
  assert.equal(dropped.asked.length, 2);
  assert.deepEqual(dropped.asked[1].map(entry => [entry.block, entry.lost.length > 0]), [["nunca", true]]);
  assert.deepEqual(dropped.estudio.nunca, []);
  assert.deepEqual(dropped.estudio.checks.dropped.map(entry => [entry.block, entry.evidence[0].quote]), [["nunca", LIMIT]]);

  const fixed = await run(lost, reply({ nunca: [{ text: "No corregir más de 8 mmol/L en 24 horas", why: "", stars: 2, evidence: [at(LIMIT)] }] }));
  assert.deepEqual([fixed.estudio.nunca.map(item => item.text), fixed.estudio.checks.dropped], [["No corregir más de 8 mmol/L en 24 horas"], []]);
});

test("Estudio check: an invented number shows as a gap, markup drops the item, a broken mnemonic or flow never stands", async () => {
  const { estudio, asked } = await run(reply({
    cards: [{ q: "¿Ritmo máximo?", a: "No corregir más de 10 mmol/L en 24 horas", evidence: [at(LIMIT)] }],
    buzzwords: [{ term: "Convulsiones", concept: "[suero](https://example.test) hipertónico", evidence: [at(SEIZURE)] }],
    mnemonics: [{ label: "Sodio", word: "ST", items: [{ letter: "S", text: "Suero hipertónico", evidence: [at("Suero hipertónico")] }, { letter: "X", text: "Tolvaptán", evidence: [at("Tolvaptán")] }] }],
  }));
  assert.deepEqual(asked, [null]);
  assert.equal(estudio.cards[0].a, `No corregir ${NUMBER_GAP} en 24 horas`);
  assert.equal(estudio.checks.gapped, 1);
  assert.deepEqual([estudio.buzzwords, estudio.mnemonics], [[], []]);
  assert.deepEqual(estudio.checks.dropped.map(entry => entry.block).sort(), ["buzzwords", "mnemonics"]);
});

test("Estudio vs tables: a row label or header copies its source cells; a row's payload is read across label and cells", async () => {
  const table = { title: "Fármacos", columns: ["Dosis"], rows: [
    { label: "Suero hipertónico", stars: 1, cells: [{ text: "150 mL", evidence: [at("150 mL")] }] },
    { label: "Tolvaptán", stars: 1, cells: [{ text: "15 mg", evidence: [at("15 mg")] }] },
  ] };
  const { estudio } = await run(reply({ vs: [table] }));
  assert.deepEqual(estudio.vs, [table].map(item => ({ ...item, rows: item.rows.map(row => ({ ...row, cells: row.cells.map(cell => ({ ...cell, evidence: [{ ...cell.evidence[0], sentence: 0, start: 0, end: cell.text.length }] })) })) })));
  const invented = await run(reply({ vs: [{ ...table, rows: [{ ...table.rows[0], label: "Suero 7 %" }, table.rows[1]] }] }));
  assert.ok(invented.estudio.vs[0].rows[0].label.includes(NUMBER_GAP), "a number its source row lacks is a gap");
});

test("Estudio merge: duplicates fold together, order never matters, caps keep the starred, the one-liner is the most starred", () => {
  const anchored = entry => ({ ...entry, sentence: 0, start: noteElements.get(entry.elementId).text.indexOf(entry.quote), end: noteElements.get(entry.elementId).text.indexOf(entry.quote) + entry.quote.length });
  const card = (q, quote) => ({ q, a: quote, evidence: [anchored(at(quote))] });
  const sheet = parts => ({ ...reply(parts), checks: { dropped: [] } });
  const a = sheet({ oneLiner: { text: "Corrección lenta del sodio", stars: 1, evidence: [anchored(at(LIMIT))] }, cards: [card("¿Límite?", LIMIT), card("¿Convulsiones?", SEIZURE)] });
  const b = sheet({ oneLiner: { text: "Convulsiones: suero hipertónico", stars: 2, evidence: [anchored(at(SEIZURE))] }, cards: [card("¿Límite?", LIMIT)],
    nunca: [{ text: "No corregir más de 8 mmol/L en 24 horas", why: "", stars: 2, evidence: [anchored(at(LIMIT))] }] });
  const merged = mergeEstudio([a, b], { elements: noteElements });
  assert.deepEqual(mergeEstudio([b, a], { elements: noteElements }), merged);
  assert.deepEqual(merged.cards.map(item => item.q), ["¿Límite?", "¿Convulsiones?"], "reading order, one copy each");
  assert.equal(merged.oneLiner.text, "Convulsiones: suero hipertónico");
  assert.equal(mergeEstudio([sheet({ oneLiner: b.oneLiner }), sheet({ oneLiner: { ...a.oneLiner, stars: 2 } })], { elements: noteElements }).oneLiner.text, "Corrección lenta del sodio", "a tie goes to reading order");
  assert.deepEqual(estudioProblems(merged), []);

  const names = ["alfa", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliett"];
  const many = sheet({ nunca: names.map(name => ({ text: name, why: "", stars: name === "juliett" ? 2 : 0, evidence: [anchored(at(LIMIT))] })) });
  const capped = mergeEstudio([many], { elements: noteElements }).nunca;
  assert.deepEqual(capped.map(item => item.text), ["alfa", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "juliett"].slice(0, ESTUDIO_LIMITS.nunca), "the starred item survives the cap");

  // A stale carry keeps only items whose every quote still holds; a pin no line holds is out of fold.
  const kept = filterEstudio(merged, entry => entry.quote !== SEIZURE);
  assert.deepEqual([kept.oneLiner, kept.cards.map(item => item.q)], [null, ["¿Límite?"]]);
  assert.deepEqual(estudioOutOfFold(merged, [{ elementId: at(LIMIT).elementId, quote: "No corregir más de 8 mmol/L en 24 horas" }]), []);
  assert.equal(estudioOutOfFold(kept, [{ elementId: at("15 mg").elementId, quote: "15 mg" }]).length, 1);
});

test("Estudio over the agent route: the job shows the Estudio task and cells; a reply outside its contract goes back", async () => {
  const bridge = new FoldBridge();
  const runner = createFoldRunner({ bridge, payload: () => assert.fail("no Payload call") });
  assert.deepEqual(runner.versions("estudio"), { promptVersion: ESTUDIO_PROMPT_VERSION, schemaVersion: ESTUDIO_SCHEMA_VERSION });
  const pending = runner.run({ slot: "estudio", route: "agent", agent: "opencode", model: "m", outLang: "es", chunk: { key: "k", units: noteUnits, pins: [] }, retry: null });
  const answer = request => new Promise(resolve => bridge.client(request, resolve, "wait"));
  const { job } = await answer({ action: "poll", agent: "opencode" });
  assert.equal(job.task, "estudio");
  assert.ok(job.units.some(unit => unit.cells?.length === 6));
  const bad = await answer({ action: "reply", id: job.id, reply: reply({ cards: [{ q: "¿Dosis?", a: "20 mg", evidence: [{ ...at("15 mg"), quote: "20 mg" }] }] }) });
  assert.equal(bad.code, "FOLD_REPLY_INVALID");
  const good = reply({ cards: [{ q: "¿Dosis de tolvaptán?", a: "15 mg", evidence: [at("15 mg")] }] });
  assert.equal((await answer({ action: "reply", id: job.id, reply: good })).status, "done");
  assert.deepEqual(await pending, good);
  bridge.close();
});
