// Read-only Bases: loads a `.base` file and the vault notes it lists, keeps one incremental index, and draws a view.
// Notes come from the embed source, so drafts, file stamps and cached text are shared with section embeds.
import { createBaseIndex, evaluateBase, parseBase, type BaseDiagnostic, type BaseResult, type ParsedBase } from "../../shared/bases.mjs";
import { vaultFiles, vaultNotes } from "./embeds.ts";
import { t } from "../i18n.ts";

export type BaseState = {
  relative: string;
  error?: "missing" | "too-large" | "yaml" | "shape";
  message?: string;
  views: { name: string; type: string }[];
  result?: BaseResult;
  diagnostics: BaseDiagnostic[];
  unread: number;
};

const index = createBaseIndex(), parsed = new Map<string, { text: string; base: ParsedBase }>();
const note = /\.(?:md|markdown|mdown)$/i;

export async function loadBase(relative: string, view?: string): Promise<BaseState> {
  const [file] = await vaultNotes([relative]);
  if (!file) return { relative, error: "missing", views: [], diagnostics: [], unread: 0 };
  let entry = parsed.get(relative);
  if (entry?.text !== file.content) parsed.set(relative, entry = { text: file.content, base: parseBase(file.content) });
  const base = entry.base;
  if (base.error) return { relative, error: base.error, message: base.message, views: [], diagnostics: [], unread: 0 };
  const listed = vaultFiles().filter(item => note.test(item.relative)), stamps = new Map(listed.map(item => [item.relative, item]));
  const notes = await vaultNotes(listed.map(item => item.relative));
  index.update(notes.map(item => ({ ...item, modified: stamps.get(item.relative)?.modified, created: stamps.get(item.relative)?.created })));
  const result = evaluateBase(base, view ?? "", index.records());
  const shown = (item: BaseDiagnostic) => !item.view && (!item.where || item.where === "global" || item.where === result.view) || item.view === result.view;
  return { relative, views: base.views.map(item => ({ name: item.name, type: item.declaredType })), result, diagnostics: base.diagnostics.filter(shown), unread: listed.length - notes.length };
}

const fileLabels: Record<string, string> = { "file.name": "Name", "file.basename": "Name", "file.path": "Path", "file.folder": "Folder", "file.ext": "Extension", "file.size": "Size", "file.ctime": "Created", "file.mtime": "Modified", "file.tags": "Tags" };
export const columnLabel = (column: { id: string; label?: string }) => column.label ?? (fileLabels[column.id] ? t(fileLabels[column.id]) : column.id.replace(/^note\./, ""));

export function diagnosticText(item: BaseDiagnostic) {
  const detail = item.detail ?? "";
  switch (item.code) {
    case "key": return t("Unknown setting \"{{name}}\" is kept in the file but ignored.", { name: detail });
    case "formula": return t("Formula \"{{name}}\" is not calculated.", { name: detail });
    case "summaries": return t("Summaries are not shown.");
    case "view-type": return t("\"{{type}}\" views are shown as a table.", { type: detail });
    case "group-by": return t("Grouping is not supported; rows are shown ungrouped.");
    case "column": return t("Column \"{{name}}\" is not supported and is hidden.", { name: detail });
    case "sort": return t("Sort by \"{{name}}\" is not supported and is skipped.", { name: detail });
    case "limit": return t("Limit \"{{value}}\" is not a positive whole number and is ignored.", { value: detail });
    case "filter": return t("Filter not applied: {{filter}} ({{reason}})", { filter: detail, reason: item.reason ?? "" });
    case "filter-limit": return t("Too many filter conditions; the rest are not applied.");
    case "views": return t("\"views\" must be a list; showing one default table.");
    case "view-limit": return t("Only the first 64 views are shown.");
    default: return item.code;
  }
}

export function errorText(state: BaseState) {
  switch (state.error) {
    case "missing": return t("This base could not be read.");
    case "too-large": return t("This base is too large to open (256 KB limit).");
    case "yaml": return t("This base has invalid YAML: {{message}}", { message: state.message ?? "" });
    case "shape": return t("This base must be a YAML mapping.");
    default: return "";
  }
}

function cell(value: unknown, text: string) {
  const td = document.createElement("td");
  if (typeof value === "boolean") {
    const box = document.createElement("input");
    box.type = "checkbox"; box.checked = value; box.disabled = true; box.tabIndex = -1;
    box.setAttribute("aria-label", value ? t("Yes") : t("No"));
    td.append(box);
  } else td.textContent = text;
  if (typeof value === "number") td.className = "base-number";
  return td;
}

// Draws notices, the table and the row count into `container`. Rows open their note on click or Enter; arrows,
// Home and End move between rows, one tab stop for the whole table.
export function renderBase(container: HTMLElement, state: BaseState, open: (relative: string) => void) {
  const parts: HTMLElement[] = [];
  const notice = (text: string, role: "alert" | "note") => { const line = document.createElement("p"); line.className = `base-notice base-notice-${role}`; line.setAttribute("role", role); line.textContent = text; parts.push(line); };
  if (state.error) { notice(errorText(state), "alert"); container.replaceChildren(...parts); return; }
  const result = state.result!;
  if (result.incomplete) notice(t("Some filters are not supported, so this view may list extra notes."), "alert");
  for (const item of state.diagnostics) notice(diagnosticText(item), "note");
  if (state.unread) notice(t("Notes that could not be read: {{unread}}", { unread: state.unread }), "note");
  const table = document.createElement("table"), head = document.createElement("tr"), body = document.createElement("tbody");
  table.className = "base-table";
  table.setAttribute("aria-label", result.view ?? "");
  result.columns.forEach((column, at) => {
    const th = document.createElement("th"); th.scope = "col"; th.textContent = columnLabel(column);
    const values = result.rows.map(row => row.values[at].value).filter(value => value !== null && value !== undefined && value !== "");
    if (values.length && values.every(value => typeof value === "number")) th.className = "base-number";
    head.append(th);
  });
  const thead = document.createElement("thead"); thead.append(head);
  result.rows.forEach((row, at) => {
    const tr = document.createElement("tr");
    tr.tabIndex = at ? -1 : 0; tr.dataset.path = row.path; tr.className = "base-row";
    tr.title = t("Open {{note}}", { note: row.path });
    tr.setAttribute("aria-label", t("Open {{note}}", { note: row.path }));
    row.values.forEach((item, column) => {
      const id = result.columns[column].id, td = cell(item.value, id === "file.name" || id === "file.basename" ? row.name : item.text);
      if (id === "file.name" || id === "file.basename") td.className = "base-name";
      tr.append(td);
    });
    body.append(tr);
  });
  const move = (from: HTMLElement, to: Element | null | undefined) => { if (!(to instanceof HTMLElement)) return; from.tabIndex = -1; to.tabIndex = 0; to.focus(); };
  body.addEventListener("click", event => { const row = (event.target as Element).closest<HTMLElement>("tr[data-path]"); if (row) open(row.dataset.path!); });
  body.addEventListener("keydown", event => {
    const row = (event.target as Element).closest<HTMLElement>("tr[data-path]");
    if (!row || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(row.dataset.path!); }
    else if (event.key === "ArrowDown") { event.preventDefault(); move(row, row.nextElementSibling); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(row, row.previousElementSibling); }
    else if (event.key === "Home") { event.preventDefault(); move(row, body.firstElementChild); }
    else if (event.key === "End") { event.preventDefault(); move(row, body.lastElementChild); }
  });
  table.append(thead, body);
  if (result.rows.length) parts.push(table);
  else notice(t("No notes match this view."), "note");
  const count = document.createElement("p");
  count.className = "base-count"; count.setAttribute("role", "status");
  count.textContent = result.limited ? t("Showing {{shown}} of {{total}} notes", { shown: result.rows.length, total: result.total }) : t("Notes: {{total}}", { total: result.total });
  parts.push(count);
  const focused = container.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest<HTMLElement>("tr[data-path]")?.dataset.path : undefined;
  container.replaceChildren(...parts);
  const again = focused && [...body.children].find(row => (row as HTMLElement).dataset.path === focused) as HTMLElement | undefined;
  if (again) { body.querySelector<HTMLElement>("tr[tabindex='0']")?.setAttribute("tabindex", "-1"); again.tabIndex = 0; again.focus(); }
}
