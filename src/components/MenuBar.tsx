import { useEffect, useRef, useState } from "react";
import { commandGroups, commandKey, commandsByAction, shortcutLabel, type CommandDefinition } from "../commands";
import { t } from "../i18n";
// Linux hides the native menu bar (its font cannot follow the theme); this one renders the same commands with theme styles.
// Clipboard roles run in the main process: Chromium refuses a scripted paste.
const editing: Record<string, string> = { cut: "cut", copy: "copy", paste: "paste", "select-all": "selectAll" };
const appMenu = { title: "Omarkie", items: [{ label: "关于 Omarkie", action: "about" }, ...["preferences", "plugins", "close-window"].map(action => commandsByAction.get(action)!)] };
const menus = [appMenu, ...commandGroups.map(group => ({ ...group, items: group.items.filter(item => !["preferences", "plugins", "close-window"].includes(item.action)) }))];
export function MenuBar({ command, rendered, disabled, context }: { command(action: string): void; rendered: boolean; disabled: boolean; context: string }) {
  const [open, setOpen] = useState<number | null>(null), root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (open === null) return;
    const dismiss = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(null); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
      else if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); setOpen(index => ((index ?? 0) + (event.key === "ArrowRight" ? 1 : menus.length - 1)) % menus.length); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = [...(root.current?.querySelectorAll<HTMLButtonElement>(".menu-bar-panel button:not([disabled])") ?? [])], index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[index < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    document.addEventListener("mousedown", dismiss); document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("mousedown", dismiss); document.removeEventListener("keydown", keyboard); };
  }, [open]);
  const off = (item: CommandDefinition) => !!item.context && (disabled || (["rich", "table"].includes(item.context) && !rendered) || (item.context === "table" && context !== "table_open"));
  const run = (item: CommandDefinition) => { setOpen(null); if (editing[item.action]) void window.desktop?.editRole(editing[item.action]); else command(item.action); };
  // mousedown default would move focus out of the editor and drop its selection before the command runs.
  return <nav className="menu-bar" ref={root} aria-label={t("菜单栏")} onMouseDown={event => event.preventDefault()}>
    {menus.map((menu, index) => <div className="menu-bar-item" key={menu.title}>
      <button type="button" aria-haspopup="menu" aria-expanded={open === index} onClick={() => setOpen(open === index ? null : index)} onMouseEnter={() => open !== null && setOpen(index)}>{menu === appMenu ? menu.title : t(menu.title)}</button>
      {open === index && <div className="more-menu menu-bar-panel" role="menu" aria-label={menu === appMenu ? menu.title : t(menu.title)}>
        {menu.items.map(item => <button type="button" role="menuitem" key={item.action} disabled={off(item)} onClick={() => run(item)}><span>{t(item.label)}</span><kbd>{shortcutLabel(commandKey(item))}</kbd></button>)}
      </div>}
    </div>)}
  </nav>;
}
