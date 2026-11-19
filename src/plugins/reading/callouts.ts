// Adapted from obgnail/typora_plugin callouts (MIT); see third-party/typora-plugins/READING-NOTICE.
import { t } from "../../i18n.ts";
import { blockKey, button, type ReadingAPI } from "./dom.ts";
export default ({ BasePlugin, utils }: any) => class extends BasePlugin {
  process() {
    const api: ReadingAPI = utils.reading;
    const states = new Map<string, Map<string, boolean>>(), owned = new Map<HTMLElement, () => void>();
    utils.insertStyle("callouts", `.reading-callout{position:relative}.reading-callout>.reading-fold{float:right;position:relative;z-index:2}.reading-callout.reading-folded>p:first-of-type{max-height:var(--callout-title-height);overflow:hidden}.reading-callout.reading-folded>:not(p:first-of-type):not(.reading-fold){display:none!important}@media print{.reading-callout.reading-folded>p:first-of-type{max-height:none}.reading-callout.reading-folded>:not(.reading-fold){display:revert!important}.reading-fold{display:none!important}}`);
    api.own(() => { for (const cleanup of owned.values()) cleanup(); });
    api.onPaint(() => {
      for (const [node, cleanup] of owned) if (!node.isConnected) { cleanup(); owned.delete(node); }
      const documentId = api.documentId();
      if (!states.has(documentId)) states.set(documentId, new Map());
      if (states.size > 100) states.delete(states.keys().next().value!);
      const saved = states.get(documentId)!;
      for (const quote of api.root()?.querySelectorAll<HTMLElement>("blockquote[data-alert]") || []) {
        if (owned.has(quote) || quote.closest(".md-window-spacer")) continue;
        quote.classList.add("reading-callout");
        const fold = quote.dataset.calloutFold;
        if (!fold) { owned.set(quote, () => quote.classList.remove("reading-callout")); continue; }
        const key = blockKey(quote, "blockquote[data-alert]"), paragraph = quote.querySelector<HTMLElement>(":scope>p");
        if (!paragraph) continue;
        const apply = () => {
          const collapsed = saved.get(key) ?? fold === "-";
          quote.classList.toggle("reading-folded", collapsed);
          toggle.textContent = collapsed ? "▸" : "▾";
          toggle.setAttribute("aria-expanded", String(!collapsed));
          const line = parseFloat(getComputedStyle(paragraph).lineHeight) || 28;
          const breakNode = paragraph.querySelector("br");
          let height = line;
          if (breakNode) { const range = document.createRange(); range.setStart(paragraph, 0); range.setEndBefore(breakNode); const rect = range.getBoundingClientRect?.(); if (rect?.height) height = Math.max(line, rect.bottom - paragraph.getBoundingClientRect().top); }
          paragraph.style.setProperty("--callout-title-height", `${height}px`);
        };
        const toggle = button(t("Fold callout"), () => { saved.set(key, !(saved.get(key) ?? fold === "-")); apply(); });
        toggle.classList.add("reading-fold"); quote.prepend(toggle); apply();
        owned.set(quote, () => { toggle.remove(); quote.classList.remove("reading-callout", "reading-folded"); paragraph.style.removeProperty("--callout-title-height"); });
      }
    });
  }
};
