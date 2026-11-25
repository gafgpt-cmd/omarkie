// Decision flows for live cards: a small tree of questions, choices and results.
// Pure functions only; the card stores the tree, never a walk state.

export const flowLimits = {
  nodes: 30, depth: 8, question: 400, label: 200, choices: 8, result: 2000, indent: 2, outline: 20_000,
};

const text = (value, limit, empty = true) => typeof value === "string" && value.length <= limit
  && !value.includes("\u0000") && (empty || value.trim().length > 0);
const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();

// A step is `{question, choices:[{label, next}]}`; a result is `{result}`.
export function normalizeFlow(value) {
  const count = { used: 0 };
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("A flow step must be an object.");
    if (depth > flowLimits.depth) throw new Error(`A flow nests at most ${flowLimits.depth} steps deep.`);
    count.used += 1;
    if (count.used > flowLimits.nodes) throw new Error(`A flow holds at most ${flowLimits.nodes} steps.`);
    if (Object.hasOwn(node, "result")) {
      if (!text(node.result, flowLimits.result, false)) throw new Error("A flow result must be text up to 2,000 characters.");
      return { result: node.result.trim() };
    }
    if (!text(node.question, flowLimits.question, false)) throw new Error("A flow step needs a question up to 400 characters.");
    if (!Array.isArray(node.choices) || node.choices.length < 1 || node.choices.length > flowLimits.choices)
      throw new Error(`A flow step needs 1 to ${flowLimits.choices} choices.`);
    const seen = new Set();
    const choices = node.choices.map(choice => {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) throw new Error("A flow choice needs a label and a next step.");
      if (!text(choice.label, flowLimits.label, false)) throw new Error("A flow choice label must be text up to 200 characters.");
      const label = choice.label.trim();
      if (seen.has(label.toLowerCase())) throw new Error("A flow step's choices need distinct labels.");
      seen.add(label.toLowerCase());
      if (choice.next === undefined) throw new Error("A flow choice needs a next step.");
      return { label, next: walk(choice.next, depth + 1) };
    });
    return { question: node.question.trim(), choices };
  };
  return walk(value, 0);
}

// `path` is the list of choice indexes taken from the root; undefined when the path is unreachable.
export function flowAt(flow, path = []) {
  let node = flow;
  for (const step of path) {
    if (!node || !Array.isArray(node.choices) || !Number.isInteger(step) || step < 0 || step >= node.choices.length) return undefined;
    node = node.choices[step].next;
  }
  return node;
}

// Stable ids shared by the walker, the diagram and its hotspots. The root is f0, its first child f0_0.
export function flowNodeId(path = []) {
  return ["f0", ...path.map(step => String(step))].join("_");
}

export function flowPathFromId(id) {
  const match = /^f0((?:_\d+)*)$/.exec(String(id ?? ""));
  if (!match) return null;
  return match[1] ? match[1].slice(1).split("_").map(Number) : [];
}

const mermaidText = value => clean(value).replaceAll('"', "'").replaceAll("|", "/").replaceAll("`", "'")
  .replace(/\bend\b/gi, "End");

// Mermaid source with accessible title/description; node ids stay ours, so the card can map a click back.
export function flowMermaid(flow, { title = "" } = {}) {
  const lines = ["flowchart TD"];
  const name = clean(title) || clean(flow?.question) || "Decision flow";
  lines.push(`  accTitle: ${mermaidText(name).slice(0, 120)}`);
  lines.push(`  accDescr: ${mermaidText(flow?.question ?? name).slice(0, 160)}`);
  const walk = (node, path) => {
    const id = flowNodeId(path);
    if (typeof node.result === "string") {
      lines.push(`  ${id}(["${mermaidText(node.result).slice(0, 200)}"])`);
      return;
    }
    lines.push(`  ${id}{"${mermaidText(node.question).slice(0, 160)}"}`);
    node.choices.forEach((choice, index) => {
      walk(choice.next, [...path, index]);
      lines.push(`  ${id} -->|"${mermaidText(choice.label).slice(0, 80)}"| ${flowNodeId([...path, index])}`);
    });
  };
  walk(flow, []);
  return `${lines.join("\n")}\n`;
}

// Indented outline used by the dialog and by "show all steps".
// `Question: …` opens a step, `- label` adds a choice, the indented block under it is the next step.
export function flowOutline(flow, indent = 0) {
  const pad = " ".repeat(indent);
  if (typeof flow?.result === "string") return [`${pad}Result: ${flow.result}`];
  const lines = [`${pad}Question: ${flow?.question ?? ""}`];
  for (const choice of flow?.choices ?? []) lines.push(...[`${pad}- ${choice.label}`], ...flowOutline(choice.next, indent + flowLimits.indent));
  return lines;
}

export function parseFlowOutline(source) {
  const raw = String(source ?? "").replace(/\r\n?/g, "\n");
  if (raw.length > flowLimits.outline) throw new Error("A flow outline must be 20,000 characters or fewer.");
  const lines = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    if (line.includes("\t")) throw new Error("Indent flow steps with spaces, not tabs.");
    const indent = line.length - line.trimStart().length;
    if (indent % flowLimits.indent) throw new Error("Indent flow steps by two spaces.");
    const body = line.trim();
    const question = /^Question:\s*(.*)$/i.exec(body), result = /^Result:\s*(.*)$/i.exec(body), choice = /^-\s+(.*)$/.exec(body);
    if (question) lines.push({ indent, kind: "question", text: question[1] });
    else if (result) lines.push({ indent, kind: "result", text: result[1] });
    else if (choice) lines.push({ indent, kind: "choice", text: choice[1] });
    else throw new Error(`Unclear flow line: ${body.slice(0, 60)}`);
  }
  if (!lines.length) throw new Error("Write at least one question.");
  if (lines[0].kind !== "question" || lines[0].indent !== 0) throw new Error("A flow starts with a Question: line at the left edge.");
  let index = 0;
  const parse = indent => {
    const line = lines[index];
    if (!line || line.indent !== indent) throw new Error("A flow line is indented under the wrong step.");
    index += 1;
    if (line.kind === "result") return { result: line.text };
    if (line.kind !== "question") throw new Error("Each choice needs a Question: or Result: block beneath it.");
    const choices = [];
    while (lines[index]?.kind === "choice" && lines[index].indent === indent) {
      const label = lines[index].text;
      index += 1;
      const next = lines[index];
      if (!next || next.indent !== indent + flowLimits.indent) throw new Error(`The choice "${label.slice(0, 40)}" needs a step indented two spaces under it.`);
      choices.push({ label, next: parse(indent + flowLimits.indent) });
    }
    return { question: line.text, choices };
  };
  const tree = parse(0);
  if (index !== lines.length) throw new Error("A flow line sits outside its step; check the indentation.");
  return normalizeFlow(tree);
}
