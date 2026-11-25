import test from "node:test";
import assert from "node:assert/strict";
import { cardFields, cardPageMarkdown, cardTitle } from "../shared/glass-cards.mjs";
import { assertCalcDefinition, evaluateCalc, normalizeCalcInputs } from "../shared/calc-model.mjs";
import { flowAt, flowMermaid, flowNodeId, flowOutline, flowPathFromId, normalizeFlow, parseFlowOutline } from "../shared/flow-model.mjs";

// Synthetic data only: no real drug, protocol or dose table lives in these tests.
const weight = { key: "weight", label: "Weight", unit: "kg", min: 0, max: 200 };
const dose = { key: "dose", label: "Dose", unit: "mg/kg", min: 0, max: 10 };
const calc = (over = {}) => ({ formula: "dose * weight", inputs: [dose, weight], unit: "mg", precision: 2, citation: "Synthetic protocol §1", ...over });

test("a weight-based formula keeps the card's unit", async () => {
  const result = await evaluateCalc(calc(), { dose: 2, weight: 70 });
  assert.equal(result.ok, true);
  assert.equal(result.display, "140");
  assert.equal(result.unit, "mg", "the shown unit never becomes g");
  assert.equal(result.flags.length, 0);
  const exact = await evaluateCalc(calc({ formula: "dose * weight" }), { dose: 0.1, weight: 82.4 });
  assert.equal(exact.display, "8.24");
  assert.equal(exact.unit, "mg");
});

test("a same-dimension result is shown in the card's unit, never rewritten", async () => {
  const result = await evaluateCalc(calc({ inputs: [{ ...dose, label: "Dose" }, weight] }), { dose: 15, weight: 68 });
  assert.equal(result.ok, true, "mathjs simplifies to g internally");
  assert.equal(result.display, "1020");
  assert.equal(result.unit, "mg");
});

test("a formula whose dimension does not match the output unit is rejected", async () => {
  const result = await evaluateCalc(calc({ unit: "mL" }), { dose: 2, weight: 70 });
  assert.equal(result.ok, false);
  assert.match(result.error, /outputs mL/);
});

test("an unreadable unit and an undeclared symbol are rejected with clear text", async () => {
  const badUnit = await evaluateCalc(calc({ inputs: [{ ...dose, unit: "mgg" }, weight] }), { dose: 2, weight: 70 });
  assert.equal(badUnit.ok, false);
  assert.match(badUnit.error, /mgg/);
  const stray = await evaluateCalc(calc({ formula: "limit * weight" }), { dose: 2, weight: 70 });
  assert.equal(stray.ok, false);
  assert.match(stray.error, /"limit".*not one of the card's inputs/);
  const call = await evaluateCalc(calc({ formula: "sqrt(weight)" }), { dose: 2, weight: 70 });
  assert.equal(call.ok, false);
  assert.match(call.error, /FunctionNode|arithmetic/);
});

test("values outside the declared range are flagged, not clamped", async () => {
  const result = await evaluateCalc(calc(), { dose: 2, weight: 240 });
  assert.equal(result.ok, true);
  assert.equal(result.display, "480");
  assert.equal(result.flags.length, 1);
  assert.equal(result.flags[0].key, "weight");
  assert.match(result.flags[0].message, /above the accepted 0 – 200 kg/);
});

test("every input must be filled and numeric", async () => {
  assert.match((await evaluateCalc(calc(), { dose: 2 })).error, /Fill in Weight/);
  assert.match((await evaluateCalc(calc(), { dose: "two", weight: 70 })).error, /must be a number/);
});

test("a card only saves when its formula and units can run", async () => {
  await assert.doesNotReject(assertCalcDefinition(calc()));
  await assert.rejects(assertCalcDefinition(calc({ formula: "dose +" })), /does not parse/);
  await assert.rejects(assertCalcDefinition(calc({ inputs: [{ ...dose, unit: "mgg" }, weight] })), /not a unit/);
  await assert.rejects(assertCalcDefinition(calc({ unit: "moons" })), /not a unit/);
});

test("a mobile microgram spelling works in the engine but the card keeps its own glyph", async () => {
  const inputs = [{ key: "dose", label: "Dose", unit: "µg/kg", min: 0, max: 100 }, weight];
  await assert.doesNotReject(assertCalcDefinition({ formula: "dose * weight", inputs, unit: "µg" }));
  const result = await evaluateCalc({ formula: "dose * weight", inputs, unit: "µg", precision: 0, citation: "Synthetic" }, { dose: 2, weight: 70 });
  assert.equal(result.ok, true);
  assert.equal(result.unit, "µg");
  assert.equal(result.display, "140");
});

test("a calculator card requires a citation", () => {
  assert.throws(() => cardFields({ card: "calc", formula: "dose * weight", inputs: [dose, weight], unit: "mg", citation: "" }), /citation is required/);
  const fields = cardFields({ card: "calc", formula: "dose * weight", inputs: [dose, weight], unit: "mg", citation: "Synthetic §1", proposed: true });
  assert.equal(fields.citation, "Synthetic §1");
  assert.equal(fields.proposed, true);
});

test("inputs are validated before anything runs", () => {
  assert.throws(() => normalizeCalcInputs([]), /at least one|1 to 12/);
  assert.throws(() => normalizeCalcInputs([dose, dose]), /defined twice/);
  assert.throws(() => normalizeCalcInputs([{ key: "2dose", unit: "mg" }]), /starts with a letter/);
  assert.throws(() => normalizeCalcInputs([{ key: "dose", unit: "mg", min: 9, max: 1 }]), /starts above its end/);
});

const flow = {
  question: "Is the patient stable?",
  choices: [
    { label: "Yes", next: { result: "Follow the protocol" } },
    { label: "No", next: {
      question: "Allergic to the drug?",
      choices: [
        { label: "Yes", next: { result: "Use the alternative" } },
        { label: "No", next: { result: "Give the loading dose" } },
      ],
    } },
  ],
};

test("a flow walks one decision per step", () => {
  const walk = normalizeFlow(flow);
  assert.equal(flowAt(walk, [])?.question, "Is the patient stable?");
  assert.equal(flowAt(walk, [1])?.question, "Allergic to the drug?");
  assert.equal(flowAt(walk, [1, 0])?.result, "Use the alternative");
  assert.equal(flowAt(walk, [9]), undefined);
});

test("flow ids round-trip to paths for the diagram hotspots", () => {
  assert.equal(flowNodeId([]), "f0");
  assert.equal(flowNodeId([1, 0]), "f0_1_0");
  assert.deepEqual(flowPathFromId("f0_1_0"), [1, 0]);
  assert.deepEqual(flowPathFromId("f0"), []);
  assert.equal(flowPathFromId("nope"), null);
});

test("the Mermaid preview keeps our ids, strict-safe text and an accessible description", () => {
  const source = flowMermaid(flow, { title: "Synthetic flow" });
  assert.match(source, /^flowchart TD/);
  assert.match(source, /accTitle: Synthetic flow/);
  assert.match(source, /accDescr: Is the patient stable\?/);
  assert.match(source, /f0_1_0\(\["Use the alternative"\]\)/);
  assert.match(source, /f0 -->\|"Yes"\| f0_0/);
  assert.doesNotMatch(source, /\bclick\b/);
  assert.match(flowMermaid(normalizeFlow({ question: "What now?", choices: [{ label: "end", next: { result: "Done" } }] })), /End/);
});

test("the outline parses back to the same tree", () => {
  const parsed = parseFlowOutline(flowOutline(normalizeFlow(flow)).join("\n"));
  assert.deepEqual(parsed, normalizeFlow(flow));
  assert.throws(() => parseFlowOutline("Question: Root?\n- Yes"), /needs a step/);
  assert.throws(() => parseFlowOutline("Result: Only a result"), /starts with a Question/);
  assert.throws(() => parseFlowOutline("Question: Root?\n- Yes\n\tResult: tab"), /spaces, not tabs/);
});

test("a flow rejects too many steps and duplicate labels", () => {
  assert.throws(() => normalizeFlow({ question: "Root?", choices: [{ label: "A", next: { result: "x" } }, { label: "a", next: { result: "y" } }] }), /distinct/);
  let deep = { result: "leaf" };
  for (let index = 0; index < 10; index += 1) deep = { question: `Question ${index}?`, choices: [{ label: "Next", next: deep }] };
  assert.throws(() => normalizeFlow(deep), /at most 8 steps deep/);
});

test("a live card's page keeps the citation and never stores a result", () => {
  const title = cardTitle({ card: "calc", formula: "dose * weight", inputs: [dose, weight], unit: "mg" });
  assert.equal(title, "dose * weight");
  const page = cardPageMarkdown({ card: "calc", formula: "dose * weight", inputs: [dose, weight], unit: "mg",
    citation: "Synthetic protocol §1", precision: 2 });
  assert.match(page, /Formula:/);
  assert.match(page, /Synthetic protocol §1/);
  assert.match(page, /never stored/);
  assert.doesNotMatch(page, /140/);
  const flowPage = cardPageMarkdown({ card: "flow", flow: normalizeFlow(flow), citation: "Synthetic flow source" });
  assert.match(flowPage, /Question: Is the patient stable\?/);
  assert.match(flowPage, /Synthetic flow source/);
});
