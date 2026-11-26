// Pick an element, name the complaint, choose a replacement: the words, the licence gate and
// the journal replay live here so the halo, omarkie-axi and the tests read one rule set.
// Nothing in this module touches the disk or the network.

export const swapActionList = ["enhance", "find", "generate", "rewrite", "redraw"];
export const swapActionLabels = { enhance: "Enhance", find: "Find better", generate: "Generate", rewrite: "Rewrite", redraw: "Redraw" };
export const swapDestinations = {
  cover: { label: "Cover on my glass only", hint: "the note is untouched" },
  replace: { label: "Replace in page", hint: "edits this note" },
};
export const swapDefaults = {
  candidates: 4, minEdge: 200, complaintLimit: 2_000, textLimit: 40_000,
  proposalBatch: 8, proposalNote: 20, proposalHour: 12, searchResults: 6,
  previewBytes: 1_500_000, voiceSeconds: 30,
};
export const allowedLicences = ["cc0", "by", "by-sa"];
const licenceReasons = {
  "by-nc": "NC: no commercial use",
  "by-nc-sa": "NC: no commercial use",
  "by-nc-nd": "NC: no commercial use",
  "by-nd": "ND: no crops or derivatives",
  "all-rights-reserved": "No licence for reuse",
  copyright: "No licence for reuse",
  unknown: "No licence given",
};

// Pictures get the three picture actions, prose gets Rewrite, a Mermaid fence gets Redraw.
// A plain code fence is not a diagram; an unsupported element offers nothing.
export function swapActionsFor(element) {
  const kind = element?.kind;
  if (kind === "image" || kind === "embed") return ["enhance", "find", "generate"];
  if (kind === "code") return /^(mermaid|sequence|flow)$/i.test(String(element?.language ?? "")) ? ["redraw"] : [];
  if (["paragraph", "heading", "list", "list-item", "table-cell", "quote", "callout"].includes(kind)) return ["rewrite"];
  return [];
}

export function swapSupports(kind) {
  return swapActionsFor({ kind }).length > 0 || swapActionsFor({ kind: "code", language: "mermaid" }).length > 0;
}

export const isSwapId = value => typeof value === "string" && /^sw-[a-z0-9]{6,32}$/.test(value);

export function normalLicence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const code = String(value.code ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!code || code.length > 40) return null;
  const version = value.version === undefined || value.version === null ? null : String(value.version).trim().slice(0, 16);
  const licenceUrl = typeof value.url === "string" && /^https?:\/\//i.test(value.url) ? value.url.slice(0, 2_048) : null;
  const attribution = typeof value.attribution === "string" ? value.attribution.trim().slice(0, 2_000) : "";
  const required = value.required !== false;
  return { code, version: version || null, url: licenceUrl, attribution, required };
}

// CC0, CC BY and CC BY-SA are the only defaults: the other Creative Commons codes forbid what a swap does.
export function licenceVerdict(licence) {
  if (!licence) return { allowed: false, code: "ATTRIBUTION_MISSING", reason: "No licence data" };
  if (licence.code === "own") return { allowed: true, reason: "" };
  if (licence.code === "local") return { allowed: true, reason: "" };
  if (allowedLicences.includes(licence.code)) return { allowed: true, reason: "" };
  return { allowed: false, code: "LICENCE_NOT_ALLOWED", reason: licenceReasons[licence.code] ?? "This licence is not on the allow list" };
}

const onlineSources = new Set(["commons", "openverse"]);
export const isOnlineSource = source => onlineSources.has(String(source ?? "").toLowerCase());

// Every candidate must carry provenance before it can be shown; online ones also carry a licence.
export function candidateIssues(candidate) {
  const issues = [];
  if (!candidate || typeof candidate !== "object") return [{ code: "UNSUPPORTED_KIND", hint: "Not a candidate." }];
  const width = Number(candidate.width), height = Number(candidate.height);
  if (candidate.kind !== "rewrite" && candidate.kind !== "redraw") {
    if (!Number.isFinite(width) || !Number.isFinite(height) || Math.min(width, height) < swapDefaults.minEdge)
      issues.push({ code: "CANDIDATE_TOO_SMALL", hint: `Pictures must be at least ${swapDefaults.minEdge}×${swapDefaults.minEdge} px.` });
  }
  if (candidate.kind === "rewrite" || candidate.kind === "redraw") {
    if (typeof candidate.text !== "string" || !candidate.text.trim()) issues.push({ code: "UNSUPPORTED_KIND", hint: "The replacement text is empty." });
    if (typeof candidate.text === "string" && candidate.text.length > swapDefaults.textLimit)
      issues.push({ code: "OUTPUT_TOO_LARGE", hint: "The replacement is too long for one element." });
  }
  const online = isOnlineSource(candidate.source) || candidate.online === true;
  const licence = normalLicence(candidate.licence);
  if (online) {
    if (!licence) issues.push({ code: "ATTRIBUTION_MISSING", hint: "An online candidate needs its licence before it can be applied." });
    else {
      const verdict = licenceVerdict(licence);
      if (!verdict.allowed) issues.push({ code: verdict.code, hint: verdict.reason });
      if (licence.required && !licence.attribution) issues.push({ code: "ATTRIBUTION_MISSING", hint: "The licence needs an author credit." });
      if (!candidate.sourceUrl || !/^https?:\/\//i.test(String(candidate.sourceUrl))) issues.push({ code: "ATTRIBUTION_MISSING", hint: "The candidate has no source URL." });
      if (!candidate.title || !String(candidate.title).trim()) issues.push({ code: "ATTRIBUTION_MISSING", hint: "The candidate has no title." });
    }
  } else if (candidate.kind !== "rewrite" && candidate.kind !== "redraw" && !licence) {
    // Vault and local pictures still say where they came from.
    issues.push({ code: "ATTRIBUTION_MISSING", hint: "Say where this picture came from." });
  }
  return issues;
}

export function candidateAllowed(candidate) {
  const issues = candidateIssues(candidate);
  return issues.length ? { ok: false, code: issues[0].code, hint: issues[0].hint } : { ok: true, code: null, hint: "" };
}

const quote = text => `"${String(text ?? "").replace(/"/g, "'").trim()}"`;
const ACCESSED = value => new Date(value ?? Date.now()).toISOString().slice(0, 10);

// Commons and Openverse both ask for credit, a licence link and the changes made; one line carries all three.
export function attributionText(candidate, { accessed, operations = [] } = {}) {
  const licence = normalLicence(candidate?.licence);
  const title = String(candidate?.title ?? "").trim() || "Untitled";
  const changes = operations.filter(Boolean).join(", ");
  const tail = `${changes ? `${changes}; ` : ""}accessed ${ACCESSED(accessed)}`;
  if (licence?.code === "own") {
    const where = String(candidate?.vaultPath ?? candidate?.sourceUrl ?? candidate?.notes ?? "").trim();
    return `${quote(title)} from your vault${where ? ` — ${where}` : ""} (${tail})`;
  }
  if (licence?.code === "local" || licence?.code === "tutor") {
    const how = String(candidate?.sourceLabel ?? "").trim().toLowerCase() || "made on this machine";
    return `${quote(title)} ${how} (${changes ? `${changes}; ` : ""}accessed ${ACCESSED(accessed)})`;
  }
  const creator = String(licence?.attribution || candidate?.creator || "").trim() || "Unknown creator";
  const name = licence
    ? `${String(licence.code).toUpperCase().replace(/-/g, " ")}${licence.version ? ` ${licence.version}` : ""}`
    : "No licence";
  const via = String(candidate?.sourceLabel ?? candidate?.source ?? "the web").trim();
  const url = String(candidate?.sourceUrl ?? licence?.url ?? "").trim();
  return `${quote(title)} by ${creator}, ${name}, via ${via}${url ? ` — ${url}` : ""} (${tail})`;
}

export const swapFootnoteId = swapId => `swap-${String(swapId ?? "").replace(/^sw-/, "")}`;
export const swapFootnote = (swapId, text) => `[^${swapFootnoteId(swapId)}]: ${String(text ?? "").trim()}`;
export const swapFootnoteRef = swapId => `[^${swapFootnoteId(swapId)}]`;

// The image line or the paragraph that would replace the element, plus its attribution footnote.
export function replacementLines(candidate, { imageMarkdown, swapId, accessed, operations } = {}) {
  const footnote = swapFootnote(swapId, attributionText(candidate, { accessed, operations }));
  if (candidate?.kind === "rewrite" || candidate?.kind === "redraw") {
    const body = String(candidate.text ?? "").replace(/\r\n?/g, "\n").trimEnd().split("\n");
    return candidate.kind === "redraw" ? ["```mermaid", ...body, "```", "", footnote] : [...body, "", footnote];
  }
  if (!imageMarkdown) throw new Error("A picture replacement needs its Markdown line.");
  return [`${imageMarkdown}${swapFootnoteRef(swapId)}`, "", footnote];
}

// One compare widget for the original and each candidate: the original is always first and labelled Current.
export function compareSet(original, candidates = []) {
  const rows = [original, ...candidates].filter(Boolean).slice(0, swapDefaults.candidates + 1);
  return rows.map((candidate, index) => ({ ...candidate, current: index === 0, compareIndex: index }));
}

// Online search is opt-in twice: the person clicks, and the vault must allow it.
export function onlineAllowed({ requested, neverOnline } = {}) {
  if (neverOnline === true) return { allowed: false, code: "SOURCE_OFFLINE", reason: "This vault never goes online." };
  if (requested !== true) return { allowed: false, code: "CONSENT_REQUIRED", reason: "Search online only when asked." };
  return { allowed: true, code: null, reason: "" };
}

// An agent may leave proposals behind; they wait as cards and are rate-capped per batch, per note and per hour.
export function capProposals(proposals, { now = Date.now(), hourMs = 3_600_000 } = {}) {
  const open = (proposals ?? []).filter(item => item && !item.dismissed && !item.applied);
  const seen = new Set(), kept = [];
  const fresh = open.filter(item => now - Number(item.at ?? 0) < hourMs);
  for (const item of [...fresh, ...open.filter(item => !fresh.includes(item))]) {
    const key = `${item.element}\u0001${item.candidateId ?? item.title ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  const hour = kept.filter(item => now - Number(item.at ?? 0) < hourMs).slice(0, swapDefaults.proposalHour);
  const older = kept.filter(item => now - Number(item.at ?? 0) >= hourMs).slice(0, Math.max(0, swapDefaults.proposalNote - hour.length));
  return [...hour, ...older].slice(0, swapDefaults.proposalNote);
}

// Journal replay for swap ops: applied swaps in order, open proposals, dismissed ids.
export function replaySwaps(text) {
  const applied = new Map(), undone = new Set(), proposals = new Map(), dismissed = new Set();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.op === "swap" && isSwapId(record.swapId)) {
      proposals.delete(record.swapId);
      if (undone.has(record.swapId)) continue;
      applied.set(record.swapId, record);
    } else if (record?.op === "swap-propose" && isSwapId(record.swapId)) {
      if (!undone.has(record.swapId)) proposals.set(record.swapId, record);
    } else if (record?.op === "swap-dismiss" && isSwapId(record.swapId)) {
      proposals.delete(record.swapId);
      dismissed.add(record.swapId);
    } else if (record?.op === "swap-undo" && isSwapId(record.swapId)) {
      undone.add(record.swapId);
      applied.delete(record.swapId);
      proposals.delete(record.swapId);
    }
  }
  return { applied: [...applied.values()], proposals: [...proposals.values()], dismissed };
}

// Journal records carry an ISO time; previews and tests may pass epoch milliseconds.
function swapTime(entry) {
  const value = entry?.at;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

// The newest swap still applied on each element; that is what one click restores.
// Newest first, so the panel's "last change" is the one the person just made.
export function latestSwaps(applied) {
  const latest = new Map();
  for (const entry of applied ?? []) {
    const key = entry.element?.id ?? entry.swapId;
    const known = latest.get(key);
    if (!known || swapTime(entry) >= swapTime(known)) latest.set(key, entry);
  }
  return [...latest.values()].sort((left, right) => swapTime(right) - swapTime(left));
}

// Replace just the element's bytes; the preview rows are the same text the write uses.
export function swapDiff(text, element, lines, eol = "\n") {
  if (!Array.isArray(lines) || !lines.length) throw new Error("Nothing to write.");
  const from = Number(element?.from), to = Number(element?.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > text.length)
    throw new Error("The element position is outside the note.");
  const next = `${text.slice(0, from)}${lines.join(eol)}${text.slice(to)}`;
  const split = value => value.split(eol);
  const oldLines = split(text), newLines = split(next);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let end = 0;
  while (end < oldLines.length - start && end < newLines.length - start &&
    oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]) end += 1;
  const rows = [
    ...oldLines.slice(Math.max(0, start - 2), start).map(line => ({ kind: "context", text: line })),
    ...oldLines.slice(start, oldLines.length - end).map(line => ({ kind: "remove", text: line })),
    ...newLines.slice(start, newLines.length - end).map(line => ({ kind: "add", text: line })),
    ...oldLines.slice(oldLines.length - end, oldLines.length - end + 2).map(line => ({ kind: "context", text: line })),
  ];
  return { rows, added: newLines.slice(start, newLines.length - end), removed: oldLines.slice(start, oldLines.length - end), next };
}
