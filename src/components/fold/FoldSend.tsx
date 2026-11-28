import { useLayoutEffect, useRef } from "react";
import { ClipboardCopy, Inbox, Layers, StickyNote } from "lucide-react";
import { t } from "../../i18n";
import type { FoldTarget } from "./drag";

export interface FoldNotice { message: string; error?: boolean; undo?(): Promise<void>; show?(): void }

// The keyboard way to drag a line out (D on a line): the same targets the drag reaches, plus the clipboard.
export function FoldSendMenu({ x, y, targets, pick, copy, close }: {
  x: number; y: number; targets: FoldTarget[]; pick(target: FoldTarget): void; copy(): void; close(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  // Below the line, lifted to stay inside the view near the bottom edge.
  useLayoutEffect(() => {
    const element = menu.current!, room = (element.offsetParent as HTMLElement | null)?.clientHeight ?? innerHeight;
    if (y + element.offsetHeight > room - 8) element.style.top = `${Math.max(8, room - element.offsetHeight - 8)}px`;
    element.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [y]);
  const page = targets.filter(target => target.kind === "page"), sheets = targets.filter(target => target.kind === "sheet"), tray = targets.filter(target => target.kind === "tray");
  const item = (target: FoldTarget) => <button type="button" role="menuitem" tabIndex={-1} key={`${target.kind}:${target.id}`} data-fold-target={target.kind}
    data-sheet={target.kind === "sheet" ? target.id : undefined} onClick={() => pick(target)}>
    {target.kind === "page" ? <StickyNote size={14} aria-hidden="true" /> : target.kind === "tray" ? <Inbox size={14} aria-hidden="true" /> : <Layers size={14} aria-hidden="true" />}
    <span>{target.label}</span>
  </button>;
  return <div ref={menu} className="fold-send" role="menu" aria-label={t("Send line to")} style={{ left: x, top: y }}
    onKeyDown={event => {
      const items = [...menu.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')], at = items.indexOf(document.activeElement as HTMLElement);
      const go = (index: number) => items[(index + items.length) % items.length]?.focus({ preventScroll: true });
      if (event.key === "ArrowDown") go(at + 1);
      else if (event.key === "ArrowUp") go(at - 1);
      else if (event.key === "Home") go(0);
      else if (event.key === "End") go(items.length - 1);
      else if (event.key === "Escape" || event.key === "Tab") close();
      else return;
      event.preventDefault(); event.stopPropagation();
    }}>
    {page.map(item)}
    {sheets.length > 0 && <><div role="separator" /><p className="fold-send-heading" aria-hidden="true">{t("Study sheets")}</p></>}
    {sheets.map(item)}
    {tray.map(item)}
    {targets.length > 0 && <div role="separator" />}
    <button type="button" role="menuitem" tabIndex={-1} data-fold-target="copy" onClick={copy}><ClipboardCopy size={14} aria-hidden="true" /><span>{t("Copy linked excerpt")}</span></button>
  </div>;
}

export function FoldSentNote({ notice, dismiss }: { notice: FoldNotice; dismiss(): void }) {
  return <div className="fold-sent" role={notice.error ? "alert" : "status"} data-error={notice.error || undefined}>
    <span>{notice.message}</span>
    {notice.show && <button type="button" onClick={notice.show}>{t("Show on page")}</button>}
    {notice.undo && <button type="button" onClick={() => { const undo = notice.undo!; dismiss(); void undo(); }}>{t("撤销")}</button>}
  </div>;
}
