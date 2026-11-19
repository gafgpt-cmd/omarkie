// Adapted from obgnail/typora_plugin editor_width_slider (MIT); see READING-NOTICE.
import { t } from "../../i18n.ts";
import { type ReadingAPI } from "./dom.ts";
export default ({ BasePlugin, utils }: any) => class extends BasePlugin {
  control?: HTMLElement;
  call() { if (this.control) this.control.hidden = !this.control.hidden; }
  process() {
    const api: ReadingAPI = utils.reading, label = document.createElement("label"), input = document.createElement("input"), value = document.createElement("output");
    label.className = "reading-width-slider md-ui"; label.textContent = t("Editor columns"); input.type = "range"; input.min = "40"; input.max = "160"; input.step = "1"; input.setAttribute("aria-label", t("Editor columns"));
    const sync = () => { input.value = String(api.width()); value.textContent = input.value; };
    input.addEventListener("input", () => { api.setWidth(Number(input.value)); value.textContent = input.value; });
    label.append(input, value); document.querySelector(".writing-area")?.append(label); this.control = label; sync();
    utils.insertStyle("width", `.reading-width-slider{position:absolute;right:16px;bottom:32px;display:flex;align-items:center;gap:8px;background:var(--sidebar);border:1px solid var(--border);padding:8px;font-size:12px;z-index:4}.reading-width-slider[hidden]{display:none}.reading-width-slider input{width:120px}`);
    utils.eventHub.on("displayChanged", sync);
    api.own(() => { label.remove(); this.control = undefined; });
  }
};
