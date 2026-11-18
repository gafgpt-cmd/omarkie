// Adapted from obgnail/typora_plugin slash_commands prefix/snippet behavior (MIT); see READING-NOTICE.
import { t } from "../../i18n.ts";
import { button, listen, type ReadingAPI } from "./dom.ts";
export default ({ BasePlugin, utils }: any) => class extends BasePlugin {
  process() {
    const api: ReadingAPI = utils.reading, menu = document.createElement("div");
    menu.className = "reading-slash-menu md-ui"; menu.setAttribute("role", "listbox"); menu.setAttribute("aria-label", t("Slash commands")); menu.hidden = true; document.body.append(menu);
    const commands = [
      { keyword: "heading", label: t("一级标题"), snippet: "# " },
      { keyword: "table", label: t("插入表格"), snippet: "| A | B |\n| --- | --- |\n|  |  |" },
      { keyword: "code", label: t("代码块"), snippet: "```\n\n```" },
      { keyword: "quote", label: t("引用"), snippet: "> " },
      { keyword: "task", label: t("任务列表"), snippet: "- [ ] " },
      { keyword: "callout", label: t("Callout"), snippet: "> [!note]\n> " },
      { keyword: "divider", label: t("水平分割线"), snippet: "---\n" },
    ];
    let active = 0, matched = commands, anchor: { from: number; to: number; text: string; document: string } | null = null, dismissed = "";
    const hide = () => { menu.hidden = true; anchor = null; };
    const choose = (index: number) => { if (!anchor || !api.editable() || anchor.document !== api.documentId()) { hide(); return; } const saved = anchor; hide(); api.replaceRange(saved.from, saved.to, matched[index].snippet, saved.text); };
    const draw = () => {
      menu.replaceChildren();
      matched.forEach((command, index) => { const item = button(`/${command.keyword} · ${command.label}`, () => choose(index)); item.setAttribute("role", "option"); item.setAttribute("aria-selected", String(index === active)); menu.append(item); });
    };
    const refresh = () => {
      const selected = api.selection(); if (!api.editable() || !selected || selected.from !== selected.to || selected.context !== "paragraph_open") { hide(); return; }
      const text = utils.getCurrentFileContent(), from = Math.max(text.lastIndexOf("\n", selected.from - 1), text.lastIndexOf("\r", selected.from - 1)) + 1, input = text.slice(from, selected.from), match = /^\/([a-z]*)$/i.exec(input);
      if (!match || dismissed === `${api.documentId()}:${from}:${input}`) { hide(); return; }
      matched = commands.filter(command => command.keyword.startsWith(match[1].toLowerCase()));
      if (!matched.length) { hide(); return; }
      const changed = !anchor || anchor.from !== from || anchor.text !== input;
      anchor = { from, to: selected.to, text: input, document: api.documentId() }; if (changed) active = 0;
      draw(); menu.hidden = false;
      const selection = window.getSelection(), rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : api.root()?.getBoundingClientRect();
      menu.style.left = `${Math.max(0, Math.min(innerWidth - 280, rect?.left || 0))}px`; menu.style.top = `${Math.max(0, Math.min(innerHeight - 280, (rect?.bottom || 0) + 8))}px`;
    };
    utils.insertStyle("slash", `.reading-slash-menu{position:fixed;z-index:40;width:280px;max-height:270px;overflow:auto;border:1px solid var(--border);background:var(--paper);color:var(--ink);box-shadow:0 6px 20px #0003;padding:4px}.reading-slash-menu[hidden]{display:none}.reading-slash-menu button{display:block;width:100%;padding:8px;text-align:left;font-size:13px}.reading-slash-menu [aria-selected=true]{background:var(--selected)}`);
    menu.addEventListener("pointerdown", event => event.preventDefault());
    listen(api, document, "keydown", ((event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || menu.hidden || !api.root()?.contains(event.target as Node)) return;
      if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key === "Escape") { if (anchor) dismissed = `${anchor.document}:${anchor.from}:${anchor.text}`; hide(); }
        else if (event.key === "Enter") choose(active);
        else { active = (active + (event.key === "ArrowDown" ? 1 : -1) + matched.length) % matched.length; draw(); }
      }
    }) as EventListener, true);
    listen(api, document, "selectionchange", refresh);
    listen(api, document, "pointerdown", event => { if (!menu.contains(event.target as Node)) hide(); });
    listen(api, document, "compositionstart", hide, true);
    for (const event of ["fileEdited", "fileOpened"]) utils.eventHub.on(event, refresh);
    api.own(() => menu.remove());
  }
};
