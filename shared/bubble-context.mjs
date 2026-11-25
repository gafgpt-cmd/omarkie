// G5 comment bubbles: one place builds what a bubble would send and flags identifiers.
// Pure data: no DOM, no storage, so the X-ray, the tests and any reader agree.
import { normalizeText } from "./anchor-core.mjs";

const nestedKinds = new Set(["list-item", "table-cell", "image", "embed"]);
const mediaPattern = /!\[[^\]\n]*\]\(([^) \n]+)(?:[ \n][^)\n]*)?\)|!\[\[([^\]\n]+)\]\]/gu;
const neighbourLimit = 400;
const quoteLimit = 240;

function short(text, limit) {
  const clean = typeof text === "string" ? text : "";
  return clean.length <= limit ? clean : `${clean.slice(0, limit).toWellFormed()}…`;
}

function imageNames(markdown) {
  const names = [];
  for (const match of String(markdown ?? "").matchAll(mediaPattern)) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (!raw) continue;
    const name = raw.split(/[\\/]/u).at(-1);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// The bubble's context chip and the X-ray read the same bundle.
export function bubbleBundle(elements, element, { note = "", quote } = {}) {
  if (!element) return undefined;
  const at = elements.findIndex(item => item.id === element.id);
  const before = at > 0 ? elements.slice(0, at).reverse().find(item => !nestedKinds.has(item.kind)) : undefined;
  const after = at >= 0 ? elements.slice(at + 1).find(item => !nestedKinds.has(item.kind)) : undefined;
  const selection = typeof quote === "string" ? normalizeText(quote) : "";
  const text = element.markdown ?? "";
  return {
    note,
    element: { id: element.id, kind: element.kind, line: element.line, headings: [...(element.headings ?? [])] },
    headings: [...(element.headings ?? [])],
    text,
    quote: short(selection || normalizeText(text), quoteLimit),
    neighbours: {
      ...(before ? { before: short(before.markdown ?? "", neighbourLimit) } : {}),
      ...(after ? { after: short(after.markdown ?? "", neighbourLimit) } : {}),
    },
    images: imageNames(text),
    metadata: { note, kind: element.kind, line: element.line },
  };
}

// Exactly the fields the Tutor bridge receives; the X-ray lists these and nothing else.
export function bubblePayload(bundle, question, text = bundle?.text) {
  if (!bundle) return undefined;
  return {
    document: bundle.note,
    element: bundle.element.id,
    kind: bundle.element.kind,
    line: bundle.element.line,
    headings: bundle.headings,
    text: typeof text === "string" ? text : "",
    quote: bundle.quote,
    neighbours: bundle.neighbours,
    ...(bundle.images.length ? { images: bundle.images } : {}),
    question: typeof question === "string" ? question.trim() : "",
  };
}

// Every string the bridge receives, in one place so the X-ray's guard cannot drift from the payload.
export function payloadText(payload) {
  if (!payload) return "";
  return [payload.document, payload.headings.join("\n"), payload.quote, payload.text,
    payload.neighbours.before ?? "", payload.neighbours.after ?? "", payload.question].filter(Boolean).join("\n");
}

// Obvious identifiers only: enough to stop a careless paste, never a diagnosis of anonymity.
const identifierRules = [
  { kind: "dob", label: "Date of birth",
    pattern: /\b(?:dob|d\.o\.b\.?|date of birth|birth date|born|nacid[oa]|fecha de nacimiento|data de naixement|data de nascimento)\b[^\n]{0,32}?(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})/giu },
  { kind: "name", label: "Name",
    pattern: /\b(?:patient|paciente|pacient|pessoa|nombre|nome|name|apellidos?|surname|nombre y apellidos)[ \t]*[:=][ \t]*(\p{Lu}[\p{L}'’.-]+(?:[ \t]+\p{Lu}[\p{L}'’.-]+){0,3})/giu },
  { kind: "name", label: "Name",
    pattern: /(?:^|[^\p{L}])(?:Dr|Dra|Doctor|Doctora)\.?[ \t]+(\p{Lu}[\p{L}'’.-]+(?:[ \t]+\p{Lu}[\p{L}'’.-]+){0,2})/giu },
  { kind: "record", label: "ID or record number",
    pattern: /\b(?:mrn|nhc|nuhsa|historia(?:\s+cl[ií]nica)?|patient\s+id|record(?:\s+(?:number|no\.?))?|expediente|dni|nie|ssn|passport|pasaporte)\b\s*(?:[:#=]|\bnumber\b|\bn[º°]\b|\bno\.?)?\s*([A-Z0-9][A-Z0-9./-]{3,})/giu },
  { kind: "contact", label: "Email or phone",
    pattern: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|(?:\+\d{1,3}[\s.-]?)?(?:\d[\s.-]?){9,14}\b/gu },
  { kind: "date", label: "Full date",
    pattern: /\b(?:\d{1,2}[/.-]\d{1,2}[/.-](?:19|20)\d{2}|\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/gu },
];

export function findIdentifiers(text, { limit = 12 } = {}) {
  const source = typeof text === "string" ? text : "";
  if (!source || limit <= 0) return [];
  const found = [];
  for (const rule of identifierRules) {
    for (const match of source.matchAll(rule.pattern)) {
      const value = match[0].replace(/\s+/gu, " ").replace(/[./-]+$/u, "").trim();
      if (!value) continue;
      const index = match.index ?? 0;
      found.push({ kind: rule.kind, label: rule.label, value, index, end: index + match[0].length });
    }
  }
  found.sort((left, right) => left.index - right.index || right.end - left.end);
  const flags = [], seen = new Set();
  let covered = -1;
  for (const flag of found) {
    if (flag.index < covered) continue;
    const signature = `${flag.kind}:${flag.value}`;
    if (seen.has(signature)) { covered = flag.end; continue; }
    seen.add(signature);
    covered = flag.end;
    flags.push({ kind: flag.kind, label: flag.label, value: flag.value, index: flag.index, signature });
    if (flags.length >= limit) break;
  }
  return flags;
}

export function identifierSignature(flag) {
  return `${flag.kind}:${flag.value}`;
}
