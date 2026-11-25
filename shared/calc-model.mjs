// Live calculator cards: named inputs with units, one formula, one fixed output unit.
// Pure functions only; results are recomputed from inputs and never stored.

export const calcLimits = {
  inputs: 12, keyLength: 24, label: 120, unit: 40, formula: 1000, citation: 2000, precision: 6, defaultPrecision: 2,
};

// mathjs has no µ glyph in its unit names; these aliases resolve only inside the engine,
// while every result is shown in the unit the card carries.
const engineUnit = value => String(value ?? "").replaceAll("µg", "ug").replaceAll("μg", "ug")
  .replaceAll("mcg", "ug").replaceAll("µ", "u").replaceAll("μ", "u");
const engineFormula = value => String(value ?? "").replaceAll("µg", "ug").replaceAll("μg", "ug").replaceAll("mcg", "ug");
const label = input => input?.label?.trim() || input?.key || "input";

let mathPromise;
function mathematics() {
  // mathjs is Apache-2.0 and ships locally; the module loads only when a card evaluates.
  return mathPromise ??= import("mathjs").then(({ create, all }) => create(all, { number: "BigNumber", precision: 64 }));
}

const operatorNames = new Set(["+", "-", "*", "/", "^", "%", "mod"]);
const nodeTypes = new Set(["ConstantNode", "SymbolNode", "OperatorNode", "ParenthesisNode"]);

// mathjs is not a sandbox, so only constants, declared inputs, parentheses and arithmetic run.
function compileFormula(math, formula, keys) {
  if (typeof formula !== "string" || !formula.trim()) throw new Error("The card needs a formula.");
  if (formula.length > calcLimits.formula) throw new Error("The formula must be 1,000 characters or fewer.");
  let node;
  try { node = math.parse(engineFormula(formula)); }
  catch (error) { throw new Error(`The formula does not parse: ${error.message}`); }
  const symbols = new Set();
  node.traverse(item => {
    if (!nodeTypes.has(item.type)) throw new Error(`The formula may only use numbers, its inputs and arithmetic (${item.type}).`);
    if (item.type === "OperatorNode" && !operatorNames.has(item.op)) throw new Error(`The operator ${item.op} is not allowed in a card formula.`);
    if (item.type === "SymbolNode") {
      if (!keys.has(item.name)) throw new Error(`The formula uses "${item.name}", which is not one of the card's inputs.`);
      symbols.add(item.name);
    }
  });
  return { node, symbols };
}

export function normalizeCalcInputs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > calcLimits.inputs)
    throw new Error(`A calculator card needs 1 to ${calcLimits.inputs} inputs.`);
  const keys = new Set();
  return value.map(input => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Each input needs a key and a unit.");
    const key = String(input.key ?? "").trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || key.length > calcLimits.keyLength)
      throw new Error("An input key starts with a letter and uses letters, digits or _ (max 24).");
    if (keys.has(key)) throw new Error(`The input "${key}" is defined twice.`);
    keys.add(key);
    const unit = String(input.unit ?? "").trim();
    if (!unit || unit.length > calcLimits.unit || unit.includes("\u0000")) throw new Error(`The input "${key}" needs a unit.`);
    const name = input.label === undefined || input.label === null ? "" : String(input.label).trim();
    if (name.length > calcLimits.label || name.includes("\u0000")) throw new Error("An input label must be text up to 120 characters.");
    const range = (side, name) => {
      const raw = input[name];
      if (raw === undefined || raw === null || raw === "") return null;
      const number = Number(raw);
      if (!Number.isFinite(number)) throw new Error(`The ${side} range of "${key}" must be a number.`);
      return number;
    };
    const min = range("lower", "min"), max = range("upper", "max");
    if (min !== null && max !== null && min > max) throw new Error(`The range of "${key}" starts above its end.`);
    return { key, label: name, unit, min, max };
  });
}

export function normalizePrecision(value) {
  if (value === undefined || value === null || value === "") return calcLimits.defaultPrecision;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > calcLimits.precision)
    throw new Error(`Precision must be a whole number of decimals between 0 and ${calcLimits.precision}.`);
  return number;
}

export async function unitError(unit) {
  const value = String(unit ?? "").trim();
  if (!value || value.length > calcLimits.unit || value.includes("\u0000")) return "A unit must be text up to 40 characters.";
  const math = await mathematics();
  try { math.unit(1, engineUnit(value)); return null; }
  catch { return `"${value}" is not a unit maths can read.`; }
}

// Creation-time check: the formula, every input unit and the output unit must agree before the card saves.
export async function assertCalcDefinition({ formula, inputs, unit } = {}) {
  const keys = new Set((inputs ?? []).map(input => input.key));
  const math = await mathematics();
  compileFormula(math, formula, keys);
  for (const input of inputs ?? []) {
    const problem = await unitError(input.unit);
    if (problem) throw new Error(`The input "${input.key}": ${problem}`);
  }
  const problem = await unitError(unit);
  if (problem) throw new Error(`The output ${problem}`);
  return true;
}

export function formatCalcValue(value, precision = calcLimits.defaultPrecision) {
  const digits = normalizePrecision(precision);
  if (!Number.isFinite(value)) return "";
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0 && value !== 0) return value.toExponential(2);
  return String(rounded);
}

export function calcRangeText(input) {
  if (!input || (input.min === null && input.max === null)) return "";
  return `${input.min === null ? "…" : input.min} – ${input.max === null ? "…" : input.max} ${input.unit}`.trim();
}

// Values are a session record {key: number}; out-of-range inputs are flagged, never silently clamped.
export async function evaluateCalc(card, values = {}) {
  const inputs = normalizeCalcInputs(card?.inputs);
  const precision = normalizePrecision(card?.precision);
  const math = await mathematics();
  const flags = [];
  const scope = {};
  for (const input of inputs) {
    const raw = values?.[input.key];
    if (raw === undefined || raw === null || String(raw).trim() === "")
      return { ok: false, error: `Fill in ${label(input)}.` };
    const number = Number(String(raw).replace(",", "."));
    if (!Number.isFinite(number)) return { ok: false, error: `${label(input)} must be a number.` };
    if (input.min !== null && number < input.min)
      flags.push({ key: input.key, side: "below", message: `${label(input)} ${number} ${input.unit} is below the accepted ${calcRangeText(input)}.` });
    if (input.max !== null && number > input.max)
      flags.push({ key: input.key, side: "above", message: `${label(input)} ${number} ${input.unit} is above the accepted ${calcRangeText(input)}.` });
    const problem = await unitError(input.unit);
    if (problem) return { ok: false, error: `The input "${input.key}": ${problem}` };
    scope[input.key] = math.unit(number, engineUnit(input.unit));
  }
  const outputProblem = await unitError(card?.unit);
  if (outputProblem) return { ok: false, error: `The output ${outputProblem}` };
  let node;
  try { ({ node } = compileFormula(math, card?.formula, new Set(inputs.map(input => input.key)))); }
  catch (error) { return { ok: false, error: error.message }; }
  let result;
  try { result = node.evaluate(scope); }
  catch (error) { return { ok: false, error: `The formula cannot run: ${error.message}` }; }
  if (!math.isUnit(result)) {
    let shown = "";
    try { shown = math.format(result); } catch { shown = String(result); }
    return { ok: false, error: `The formula must produce ${card.unit}; it produced ${shown}, which has no unit.` };
  }
  let number;
  try { number = result.toNumber(engineUnit(card.unit)); }
  catch { return { ok: false, error: `The formula gives ${result.toString()}, but this card outputs ${card.unit}. Choose one unit.` }; }
  if (!Number.isFinite(number)) return { ok: false, error: "The formula did not produce a finite number." };
  const rounded = Number(number.toFixed(precision));
  if (rounded === 0 && number !== 0)
    flags.push({ key: "result", side: "precision", message: `The result rounds to 0 at ${precision} dp; raise the card's precision.` });
  return { ok: true, value: number, display: formatCalcValue(number, precision), unit: card.unit, precision, flags };
}
