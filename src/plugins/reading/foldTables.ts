// Adapted from obgnail/typora_plugin collapse_table (MIT); see READING-NOTICE.
import { t } from "../../i18n.ts";
import { blockKey, button, type ReadingAPI } from "./dom.ts";
export default ({ BasePlugin, utils }: any) => class extends BasePlugin {
  process() {
    const api: ReadingAPI = utils.reading, states = new Map<string, Map<string, boolean>>(), owned = new Map<HTMLElement, () => void>();
    utils.insertStyle("tables", `.reading-table-folded>tbody{display:none!important}.reading-table-fold{display:block;font-size:12px!important}@media print{.reading-table-folded>tbody{display:table-row-group!important}.reading-table-fold{display:none!important}}`);
    api.own(() => { for (const cleanup of owned.values()) cleanup(); });
    api.onPaint(() => {
      for (const [node, cleanup] of owned) if (!node.isConnected) { cleanup(); owned.delete(node); }
      const documentId = api.documentId();
      if (!states.has(documentId)) states.set(documentId, new Map());
      if (states.size > 100) states.delete(states.keys().next().value!);
      const saved = states.get(documentId)!;
      for (const table of api.root()?.querySelectorAll<HTMLElement>("table") || []) {
        if (owned.has(table) || table.closest(".md-window-spacer,.fence-preview")) continue;
        const cell = table.querySelector("th"), key = blockKey(table, "table"); if (!cell) continue;
        const apply = () => { const collapsed = saved.get(key) ?? false; table.classList.toggle("reading-table-folded", collapsed); toggle.setAttribute("aria-expanded", String(!collapsed)); toggle.textContent = collapsed ? t("Expand table") : t("Fold table"); };
        const toggle = button(t("Fold table"), () => { saved.set(key, !(saved.get(key) ?? false)); apply(); });
        toggle.classList.add("reading-table-fold"); cell.prepend(toggle); apply();
        owned.set(table, () => { toggle.remove(); table.classList.remove("reading-table-folded"); });
      }
    });
  }
};
