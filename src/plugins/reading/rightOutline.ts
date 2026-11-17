// Adapted from obgnail/typora_plugin right_outline tree/folding (MIT); see READING-NOTICE.
import { t } from "../../i18n.ts";
import { button, listen, type ReadingAPI } from "./dom.ts";
export default ({ BasePlugin, utils }: any) => class extends BasePlugin {
  panel?: HTMLElement;
  call() { if (this.panel) { this.panel.hidden = !this.panel.hidden; this.panel.parentElement?.classList.toggle("reading-has-outline", !this.panel.hidden); } }
  process() {
    const api: ReadingAPI = utils.reading, panel = document.createElement("aside"), list = document.createElement("nav"), title = document.createElement("h2"), parent = document.querySelector(".writing-area");
    panel.className = "reading-right-outline"; panel.setAttribute("aria-label", t("Right outline")); title.textContent = t("大纲"); list.setAttribute("aria-label", t("大纲")); panel.append(title, list); parent?.append(panel); parent?.classList.add("reading-has-outline"); this.panel = panel;
    utils.insertStyle("right-outline", `.reading-has-outline{padding-right:clamp(160px,24vw,260px)}.reading-right-outline{position:absolute;right:0;top:0;bottom:0;width:clamp(160px,24vw,260px);overflow:auto;border-left:1px solid var(--border);background:var(--sidebar);color:var(--ink);padding:16px 10px;z-index:3}.reading-right-outline[hidden]{display:none}.reading-right-outline h2{font-size:13px;margin:0 0 12px}.reading-outline-row{display:flex;align-items:baseline}.reading-outline-row>button{font-size:13px;padding:6px;text-align:left;overflow-wrap:anywhere;min-width:0}.reading-outline-row>button:last-child{flex:1}.reading-outline-row[aria-current=true]{background:var(--selected)}@media print{.reading-right-outline{display:none}.reading-has-outline{padding-right:0}}`);
    let signature = "";
    const collapsed = new Set<string>();
    const highlight = () => {
      const root = api.root(), top = root?.parentElement?.getBoundingClientRect().top ?? 0;
      let line = 1;
      for (const heading of root?.querySelectorAll<HTMLElement>(":scope>h1,:scope>h2,:scope>h3,:scope>h4,:scope>h5,:scope>h6") || []) if (heading.getBoundingClientRect().top <= top + 60) line = Number(heading.dataset.line) || line;
      for (const row of list.querySelectorAll<HTMLElement>("[data-line]")) row.setAttribute("aria-current", String(Number(row.dataset.line) === line));
    };
    const render = () => {
      const headings = api.headings(), next = api.documentId() + JSON.stringify(headings);
      if (signature === next) { highlight(); return; } signature = next;
      list.replaceChildren(); let hiddenLevel = 7;
      headings.forEach((heading, index) => {
        if (heading.level > hiddenLevel) return;
        hiddenLevel = 7;
        const key = `${api.documentId()}:${heading.id}`, folded = collapsed.has(key), children = headings[index + 1]?.level > heading.level;
        const row = document.createElement("div"); row.className = "reading-outline-row"; row.dataset.line = String(heading.line); row.style.paddingLeft = `${(heading.level - 1) * 10}px`;
        if (children) { const toggle = button(t("Fold outline section"), () => { if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key); signature = ""; render(); }); toggle.textContent = folded ? "▸" : "▾"; toggle.setAttribute("aria-expanded", String(!folded)); row.append(toggle); }
        row.append(button(heading.text, () => api.jump(heading.line))); list.append(row);
        if (folded) hiddenLevel = heading.level;
      });
      if (collapsed.size > 2000) collapsed.clear(); highlight();
    };
    api.onPaint(render);
    for (const event of ["fileOpened", "fileEdited", "outlineUpdated"]) utils.eventHub.on(event, render);
    listen(api, document, "scroll", highlight, true);
    api.own(() => { panel.remove(); parent?.classList.remove("reading-has-outline"); this.panel = undefined; });
  }
};
