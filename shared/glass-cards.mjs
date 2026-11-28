// Glass cards: a static section embed, a cached AI answer, a menu of choices, a live
// calculator or a decision flow. Pure functions only; electron/glass-service.mjs owns the disk.

import { sanitizeTitle, validAnchor } from "./glass-core.mjs";
import { calcLimits, normalizeCalcInputs, normalizePrecision } from "./calc-model.mjs";
import { flowOutline, normalizeFlow } from "./flow-model.mjs";
import { headingSlug } from "./wiki-syntax.mjs";
import { isLevelId } from "./fold-format.mjs";

export const cardKinds = ["static", "ai", "menu", "calc", "flow", "fold"];
export const cardLayer = "ai-cards";
export const cardDefaults = {
  w: 300, minW: 220, maxW: 420, titleLimit: 200, linkLimit: 2048, questionLimit: 4000,
  answerLimit: 48_000, atLimit: 40, choiceCount: 24, labelLimit: 300, bodyLimit: 20_000, offsetLimit: 200_000,
  headingLimit: 300, pageBytes: 512 * 1024, citationLimit: calcLimits.citation,
};
export const cardFieldNames = new Set(["kind", "card", "layer", "title", "link", "question", "answer", "answerAt",
  "choices", "anchor", "x", "y", "w", "folded", "marked", "formula", "inputs", "unit", "citation", "precision", "flow", "proposed", "stop"]);

const text = (value, limit, empty = true) => typeof value === "string" && value.length <= limit
  && !value.includes("\u0000") && (empty || value.trim().length > 0);
const finite = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

// Accepts `[[Note#Section]]`, `[[Note|alias]]`, `Note.md#Section` and `#Section` for this note.
export function parseCardLink(value) {
  if (typeof value !== "string") return null;
  let link = value.trim();
  if (!link || link.length > cardDefaults.linkLimit) return null;
  const wiki = /^\[\[([^\]\n]+)\]\]$/.exec(link);
  if (wiki) link = wiki[1];
  link = link.split("|")[0].trim();
  if (!link || /[\u0000\\]/.test(link) || /[[\]]/.test(link) || /^[a-z][a-z0-9+.-]*:\/\//i.test(link)) return null;
  let target = link, section = "";
  const hash = link.indexOf("#");
  if (hash >= 0) { target = link.slice(0, hash).trim(); section = link.slice(hash + 1).trim().replace(/^#+/, "").trim(); }
  if (target.startsWith("/")) return null;
  if (target && target.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("."))) return null;
  if (!target && !section) return null;
  return { target, section: section.slice(0, cardDefaults.headingLimit) };
}

export function cardLink(target, section = "") {
  const name = String(target ?? "").trim();
  if (!name) return "";
  return section ? `${name}#${String(section).trim()}` : name;
}

const plain = value => String(value ?? "").normalize("NFC").replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const atx = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

function headingLines(lines) {
  const found = [];
  let fence = null, index = 0;
  if (lines[0] === "---") {
    const close = lines.findIndex((line, at) => at > 0 && (line === "---" || line === "..."));
    if (close > 0) index = close + 1;
  }
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const match = atx.exec(line);
    if (match) found.push({ index, level: match[1].length, text: match[2].trim() });
  }
  return found;
}

// Finds `path` (["Parent", "Child"]: each later heading sits inside the previous one's section).
// Exact heading text wins over its slug; `matches` counts same-named candidates at the last step.
export function sectionRange(markdown, path) {
  const lines = String(markdown ?? "").split(/\r?\n/), list = headingLines(lines);
  let from = 0, to = list.length, at = -1, matches = 0;
  for (const wanted of path) {
    const exact = [], slugged = [];
    for (let index = from; index < to; index += 1) {
      if (plain(list[index].text) === plain(wanted)) exact.push(index);
      else if (headingSlug(list[index].text) === headingSlug(String(wanted))) slugged.push(index);
    }
    let hits = exact.length ? exact : slugged;
    // `name-2` is the rendered heading id of the third `name` heading in the note.
    const numbered = !hits.length && from === 0 ? /^(.*)-(\d+)$/.exec(headingSlug(String(wanted))) : null;
    if (numbered) {
      const same = list.flatMap((heading, index) => headingSlug(heading.text) === numbered[1] ? [index] : []);
      hits = same[Number(numbered[2])] === undefined ? [] : [same[Number(numbered[2])]];
    }
    if (!hits.length) return null;
    at = hits[0]; matches = hits.length;
    let next = at + 1;
    while (next < list.length && list[next].level > list[at].level) next += 1;
    from = at + 1; to = next;
  }
  if (at < 0) return null;
  return { start: list[at].index, end: to < list.length ? list[to].index : lines.length, level: list[at].level, heading: list[at].text, matches, lines };
}

// A heading's section: its own line stays out, every line until the next heading of the same or a higher level comes in.
export function extractSection(markdown, section = "") {
  const source = typeof markdown === "string" ? markdown : "";
  if (!source.trim()) return { status: "empty", heading: null, level: 0, markdown: "" };
  if (!plain(section)) return { status: "ok", heading: null, level: 0, markdown: source.trim() };
  const range = sectionRange(source, [section]);
  if (!range) return { status: "section-missing", heading: null, level: 0, markdown: "" };
  const body = range.lines.slice(range.start + 1, range.end).join("\n").trim();
  return { status: body ? "ok" : "empty", heading: range.heading, level: range.level, markdown: body };
}

export function normalizeChoices(value) {
  if (!Array.isArray(value) || value.length > cardDefaults.choiceCount) throw new Error("Card choices must be a list of up to 24.");
  return value.map(choice => {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) throw new Error("Each card choice needs a label.");
    const label = typeof choice.label === "string" ? choice.label.trim() : "";
    const body = choice.body === undefined || choice.body === null ? "" : choice.body;
    if (!label || label.length > cardDefaults.labelLimit || !text(label, cardDefaults.labelLimit, false)) throw new Error("A card choice label must be text up to 300 characters.");
    if (!text(body, cardDefaults.bodyLimit)) throw new Error("A card choice body must be text up to 20,000 characters.");
    return { label, body };
  });
}

export function cardFields(fields) {
  const values = {};
  for (const [field, value] of Object.entries(fields ?? {})) {
    if (!cardFieldNames.has(field)) throw new Error(`Unknown card field: ${field}.`);
    if (field === "kind") {
      if (value !== "card") throw new Error("A card keeps its kind.");
      values.kind = value;
    } else if (field === "card") {
      if (!cardKinds.includes(value)) throw new Error(`Card kind must be one of: ${cardKinds.join(", ")}.`);
      values.card = value;
    } else if (field === "layer") {
      if (value !== cardLayer) throw new Error(`Cards live on the ${cardLayer} layer.`);
      values.layer = value;
    } else if (field === "title") {
      if (!text(value, cardDefaults.titleLimit)) throw new Error("Card title must be text up to 200 characters.");
      values.title = value;
    } else if (field === "link") {
      if (value !== "" && (!text(value, cardDefaults.linkLimit) || !parseCardLink(value))) throw new Error("A card link must be a note or [[note#section]] link.");
      values.link = value;
    } else if (field === "question") {
      if (!text(value, cardDefaults.questionLimit)) throw new Error("A card question must be text up to 4,000 characters.");
      values.question = value;
    } else if (field === "answer") {
      if (!text(value, cardDefaults.answerLimit)) throw new Error("A card answer must be text up to 48,000 characters.");
      values.answer = value;
    } else if (field === "answerAt") {
      if (!text(value, cardDefaults.atLimit)) throw new Error("Card answer time must be a short timestamp.");
      values.answerAt = value;
    } else if (field === "choices") {
      values.choices = normalizeChoices(value);
    } else if (field === "formula") {
      if (!text(value, calcLimits.formula, false)) throw new Error(`A card formula must be text up to ${calcLimits.formula} characters.`);
      values.formula = value.trim();
    } else if (field === "inputs") {
      values.inputs = normalizeCalcInputs(value);
    } else if (field === "unit") {
      if (!text(value, calcLimits.unit, false)) throw new Error(`A card output unit must be text up to ${calcLimits.unit} characters.`);
      values.unit = value.trim();
    } else if (field === "citation") {
      if (!text(value, cardDefaults.citationLimit, false)) throw new Error(`A card citation is required, up to ${cardDefaults.citationLimit} characters.`);
      values.citation = value.trim();
    } else if (field === "precision") {
      values.precision = normalizePrecision(value);
    } else if (field === "flow") {
      values.flow = normalizeFlow(value);
    } else if (field === "stop") {
      if (!isLevelId(value)) throw new Error("A card stop must be a fold level.");
      values.stop = value;
    } else if (field === "proposed") {
      if (typeof value !== "boolean") throw new Error("Card proposed must be true or false.");
      values.proposed = value;
    } else if (field === "anchor") {
      if (!validAnchor(value)) throw new Error("A card needs a valid anchor.");
      values.anchor = value;
    } else if (field === "folded") {
      if (typeof value !== "boolean") throw new Error("Card folded must be true or false.");
      values.folded = value;
    } else if (field === "marked") {
      if (typeof value !== "boolean") throw new Error("Card marked must be true or false.");
      values.marked = value;
    } else if (field === "w") {
      if (!finite(value, cardDefaults.minW, cardDefaults.maxW)) throw new Error(`Card w must be a number between ${cardDefaults.minW} and ${cardDefaults.maxW}.`);
      values.w = Math.round(value);
    } else {
      if (!finite(value, -cardDefaults.offsetLimit, cardDefaults.offsetLimit)) throw new Error(`Card ${field} must be a number between -${cardDefaults.offsetLimit} and ${cardDefaults.offsetLimit}.`);
      values[field] = Math.round(value);
    }
  }
  return values;
}

function firstLine(value, limit = 90) {
  const line = String(value ?? "").split(/\r?\n/).map(item => item.trim()).find(Boolean) ?? "";
  return line.length > limit ? `${line.slice(0, limit).toWellFormed()}…` : line;
}

export function cardTitle(card) {
  const explicit = typeof card?.title === "string" ? card.title.trim() : "";
  if (explicit) return explicit.slice(0, cardDefaults.titleLimit);
  if (card?.card === "ai") return firstLine(card.question) || "AI answer";
  if (card?.card === "menu") return firstLine(card.choices?.[0]?.label) || "Menu";
  if (card?.card === "calc") return firstLine(card.formula, 60) || "Calculator";
  if (card?.card === "flow") return firstLine(card.flow?.question, 80) || "Decision flow";
  if (card?.card === "fold") return firstLine(card.question, 80) || "Fold line";
  const parsed = parseCardLink(card?.link ?? "");
  if (!parsed) return "Card";
  if (parsed.section) return parsed.section.slice(0, cardDefaults.titleLimit);
  return (parsed.target.split("/").at(-1)?.replace(/\.(?:md|markdown|mdown)$/i, "") || "Card").slice(0, cardDefaults.titleLimit);
}

export function cardIcon(card) {
  if (card?.card === "ai") return "sparkles";
  if (card?.card === "menu") return "list";
  if (card?.card === "calc") return "calculator";
  if (card?.card === "flow") return "flow";
  if (card?.card === "fold") return "fold";
  return "book";
}

// The new note is plain Markdown a person can read later; the source note is never touched.
export function cardPageMarkdown(card, { markdown = "" } = {}) {
  const title = cardTitle(card).replace(/\s+/g, " ").trim() || "Card";
  const lines = [`# ${title}`, ""];
  if (card.card === "static") {
    const parsed = parseCardLink(card.link);
    if (parsed) lines.push(`> Embedded from ${parsed.section ? `[[${parsed.target || "this note"}#${parsed.section}]]` : `[[${parsed.target || "this note"}]]`}.`, "");
    if (markdown.trim()) lines.push(markdown.trim(), "");
  } else if (card.card === "ai") {
    if (card.question?.trim()) lines.push(`**Q:** ${card.question.trim()}`, "");
    if (card.answer?.trim()) lines.push(card.answer.trim(), "");
  } else if (card.card === "calc") {
    lines.push("> Live calculator card. Results are computed in Omarkie from the inputs and are never stored.", "");
    if (card.formula?.trim()) lines.push(`**Formula:** \`${card.formula.trim()}\` → ${card.unit ?? ""}`.trim(), "");
    if (Array.isArray(card.inputs) && card.inputs.length) {
      lines.push("**Inputs**", "");
      for (const input of card.inputs) lines.push(`- ${input.label || input.key} (${input.key}): ${input.min ?? "…"} – ${input.max ?? "…"} ${input.unit}`);
      lines.push("");
    }
    if (card.citation?.trim()) lines.push(`**Citation:** ${card.citation.trim()}`, "");
  } else if (card.card === "flow") {
    lines.push("> Live decision flow. Walks in Omarkie; no answer is stored in the note.", "");
    if (card.flow) lines.push("```text", ...flowOutline(card.flow), "```", "");
    if (card.citation?.trim()) lines.push(`**Citation:** ${card.citation.trim()}`, "");
  } else if (card.card === "fold") {
    // The line as it read at its stop, then the author's own words it was folded from.
    if (card.question?.trim()) lines.push(card.question.trim(), "");
    if (card.answer?.trim()) lines.push(...card.answer.trim().split(/\r?\n/).map(line => line ? `> ${line}` : ">"), "");
    const parsed = parseCardLink(card.link ?? "");
    if (parsed) lines.push(`Source: ${parsed.section ? `[[${parsed.target || "this note"}#${parsed.section}]]` : `[[${parsed.target || "this note"}]]`}`, "");
  } else {
    for (const choice of card.choices ?? []) {
      lines.push(`## ${choice.label}`, "");
      if (choice.body?.trim()) lines.push(choice.body.trim(), "");
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export function cardPageStem(card) {
  return sanitizeTitle(cardTitle(card)).replace(/\.(?:md|markdown|mdown)$/i, "").slice(0, 100) || "Card";
}
