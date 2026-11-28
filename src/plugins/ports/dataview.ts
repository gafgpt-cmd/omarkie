// Dataview port: renders ```dataview fences (TABLE and LIST over frontmatter) as read-only previews.
// Query language from blacksmithgu/obsidian-dataview (MIT); see third-party/obsidian-ports/NOTICE.
// Reads notes only through utils.ports; clicking a fence still opens its source for editing.
import { language, t } from "../../i18n.ts";
import { button } from "../reading/dom.ts";
import type { PortContext, PortSnapshot } from "./capabilities.ts";
import { buildIndex, executeQuery, type DataviewIndex, type QueryOutput } from "./dataview-engine.ts";
import { parseInnerLink, parseQuery } from "./dataview-query.ts";
import { isObject, Link, valueText, type Literal } from "./dataview-values.ts";

const FENCES = '.md-fence[data-fence] > pre.fence-body > code[data-highlight-language="dataview"]';
const ROW_LIMIT = 500;
const EDIT_DELAY = 400;
const STYLE = `.dataview-result{cursor:default;margin:0}
.dataview-result table{margin:0}
.dataview-result td>ul,.dataview-result li>ul{margin:0;padding-left:1.2em}
.dataview-result .dataview-list{margin:0;padding-left:1.4em}
.dataview-result button.dataview-link{border:0;background:none;padding:0;margin:0;font:inherit;color:var(--accent);cursor:pointer;text-decoration:underline;text-underline-offset:2px;text-align:left}
.dataview-result button.dataview-link:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
.dataview-result .dataview-empty{color:var(--muted)}
.dataview-result .dataview-meta,.dataview-result .dataview-warning{margin:6px 0 0;color:var(--muted);font-size:12px}
.dataview-result .dataview-error{margin:0;padding:6px 10px;border-left:3px solid #ce5858;background:var(--code);white-space:pre-wrap}
.dataview-result .dataview-status{margin:0;color:var(--muted)}
@media print{.dataview-result .dataview-meta{display:none}}`;

export default ({ BasePlugin, utils }: PortContext) => class Dataview extends BasePlugin {
  staticActions = [{ act_value: "refresh", act_name: t("Refresh Dataview queries") }];
  private refresh = () => {};

  hotkey() {
    const hotkey = this.config.HOTKEY;
    return typeof hotkey === "string" && hotkey ? [{ hotkey, callback: () => this.call("refresh") }] : [];
  }

  call(action?: string) { if (action === "refresh") this.refresh(); }

  process() {
    const api = utils.reading, ports = utils.ports;
    const previews = new Map<HTMLElement, { node: HTMLElement; key: string }>();
    let snapshot: PortSnapshot | null = null, failure = "", loading: Promise<void> | null = null;
    let cached: { snapshot: PortSnapshot; relative: string | null; content: string; index: DataviewIndex } | null = null;
    let generation = 0, disposed = false, timer = 0;
    utils.insertStyle("dataview", STYLE);

    const open = (target: string) => {
      ports.note.open(target).then(opened => { if (!opened) utils.notification.show(t("Could not open “{{path}}”.", { path: target })); },
        (error: Error) => utils.notification.show(error.message));
    };

    const load = () => {
      if (loading || disposed) return;
      const request: Promise<void> = loading = ports.vault.snapshot().then(
        value => { if (loading === request) { snapshot = value; failure = ""; } },
        (error: Error) => { if (loading === request) failure = error.message; },
      ).finally(() => { if (loading !== request) return; loading = null; generation++; render(); });
    };

    // Unsaved edits to the current note count, as in DocumentTools; other notes come from the folder snapshot.
    const indexFor = (base: PortSnapshot) => {
      const { relative, content } = ports.note.active();
      if (cached?.snapshot === base && cached.relative === relative && cached.content === content) return { index: cached.index, origin: relative ?? "" };
      const notes = relative ? [...base.notes.filter(note => note.relative.replaceAll("\\", "/") !== relative), { relative, content }] : base.notes;
      cached = { snapshot: base, relative, content, index: buildIndex({ ...base, notes }) };
      return { index: cached.index, origin: relative ?? "" };
    };

    const paragraph = (className: string, text: string, role?: string) => {
      const node = document.createElement("p");
      node.className = className; node.textContent = text;
      if (role) node.setAttribute("role", role);
      return node;
    };

    const link = (value: Link, index: DataviewIndex, origin: string) => {
      const target = index.resolve(origin, value.path) ?? value.path;
      const node = button(value.label(), () => open(target));
      node.classList.add("dataview-link");
      node.title = target;
      return node;
    };

    // Strings may hold wiki links; they become link buttons, the rest stays plain text. Nothing is parsed as HTML.
    const text = (value: string, parent: Node, index: DataviewIndex, origin: string) => {
      let last = 0;
      for (const match of value.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
        if (match.index > last) parent.appendChild(document.createTextNode(value.slice(last, match.index)));
        parent.appendChild(link(parseInnerLink(match[1]), index, origin));
        last = match.index + match[0].length;
      }
      if (last < value.length) parent.appendChild(document.createTextNode(value.slice(last)));
    };

    const cell = (value: Literal | undefined, parent: Node, index: DataviewIndex, origin: string) => {
      if (value === null || value === undefined || (Array.isArray(value) && !value.length)) {
        const empty = document.createElement("span");
        empty.className = "dataview-empty"; empty.textContent = "–"; empty.setAttribute("aria-label", t("Empty"));
        parent.appendChild(empty);
      } else if (value instanceof Link) parent.appendChild(link(value, index, origin));
      else if (Array.isArray(value) || isObject(value)) {
        const list = document.createElement("ul");
        for (const [key, item] of Array.isArray(value) ? value.map(item => [null, item] as const) : Object.entries(value)) {
          const entry = document.createElement("li");
          if (key !== null) entry.append(`${key}: `);
          cell(item, entry, index, origin);
          list.appendChild(entry);
        }
        parent.appendChild(list);
      } else if (typeof value === "string") text(value, parent, index, origin);
      else parent.appendChild(document.createTextNode(valueText(value, language)));
    };

    const output = (node: HTMLElement, result: QueryOutput, index: DataviewIndex, origin: string) => {
      const total = result.type === "table" ? result.rows.length : result.items.length;
      if (!total) node.appendChild(paragraph("dataview-status", t("No results."), "status"));
      else if (result.type === "table") {
        const table = document.createElement("table"), head = table.createTHead().insertRow(), body = table.createTBody();
        for (const name of result.names) { const header = document.createElement("th"); header.scope = "col"; header.textContent = name; head.appendChild(header); }
        for (const row of result.rows.slice(0, ROW_LIMIT)) {
          const line = body.insertRow();
          for (const value of row) cell(value, line.insertCell(), index, origin);
        }
        node.appendChild(table);
      } else {
        const list = document.createElement("ul");
        list.className = "dataview-list";
        for (const item of result.items.slice(0, ROW_LIMIT)) {
          const entry = document.createElement("li");
          if (item.id !== undefined) { cell(item.id, entry, index, origin); entry.append(": "); }
          cell(item.value, entry, index, origin);
          list.appendChild(entry);
        }
        node.appendChild(list);
      }
      for (const warning of result.warnings) node.appendChild(paragraph("dataview-warning", warning));
      if (total > ROW_LIMIT) node.appendChild(paragraph("dataview-warning", t("Showing the first {{shown}} of {{total}} results.", { shown: ROW_LIMIT, total })));
      node.appendChild(paragraph("dataview-meta", t("Results: {{results}} · Notes: {{notes}}", { results: total, notes: result.scanned })));
    };

    const fill = (node: HTMLElement, source: string) => {
      node.replaceChildren();
      node.removeAttribute("aria-busy");
      if (failure) { node.appendChild(paragraph("dataview-error", failure, "alert")); return; }
      if (!snapshot) { node.setAttribute("aria-busy", "true"); node.appendChild(paragraph("dataview-status", t("Reading notes…"), "status")); return; }
      try {
        const { index, origin } = indexFor(snapshot);
        output(node, executeQuery(parseQuery(source), index, origin, language), index, origin);
      } catch (error) {
        node.replaceChildren(paragraph("dataview-error", error instanceof RangeError ? t("This query is nested too deeply.") : (error as Error).message, "alert"));
      }
    };

    const render = () => {
      if (disposed) return;
      for (const [fence, preview] of previews) if (!fence.isConnected) { preview.node.remove(); previews.delete(fence); }
      const codes = [...api.root()?.querySelectorAll<HTMLElement>(FENCES) ?? []];
      if (!codes.length) return;
      if (!snapshot && !failure) load();
      for (const code of codes) {
        const fence = code.closest<HTMLElement>(".md-fence")!, source = code.textContent ?? "", key = `${generation}\n${source}`;
        const existing = previews.get(fence);
        if (existing?.key === key && existing.node.parentElement === fence) continue;
        const node = existing?.node ?? document.createElement("div");
        node.className = "fence-preview md-ui dataview-result";
        node.contentEditable = "false";
        node.setAttribute("role", "region");
        node.setAttribute("aria-label", t("Dataview results"));
        fill(node, source);
        if (node.parentElement !== fence) fence.prepend(node);
        previews.set(fence, { node, key });
      }
    };

    const reload = () => { snapshot = null; failure = ""; cached = null; loading = null; generation++; render(); };
    this.refresh = () => {
      if (!api.root()?.querySelector(FENCES)) { utils.notification.show(t("This note has no Dataview queries.")); return; }
      reload();
    };
    utils.eventHub.on("fileOpened", reload);
    utils.eventHub.on("fileEdited", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { generation++; render(); }, EDIT_DELAY);
    });
    api.own(() => {
      disposed = true; window.clearTimeout(timer);
      for (const { node } of previews.values()) node.remove();
      previews.clear(); cached = null; snapshot = null;
    });
    api.onPaint(render);
  }
};
