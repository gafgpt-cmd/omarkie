import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { t } from "../i18n";
const visibleControl = (control: HTMLElement) => (!control.closest("details:not([open])") || control.matches("summary")) && [...control.getClientRects()].some(rect => rect.width > 0 && rect.height > 0) && getComputedStyle(control).visibility === "visible";
export function Dialog({ title, close, children }: { title: string; close(): void; children: ReactNode }) {
  const root = useRef<HTMLElement>(null), closing = useRef(close);
  closing.current = close;
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Fields first: the heading's close button precedes them in the DOM.
    const usable = (selector: string) => [...root.current!.querySelectorAll<HTMLElement>(selector)].find(control => visibleControl(control) && !control.matches(":disabled"));
    (usable('input:not([type="checkbox"]),textarea,select') ?? usable("button,summary"))?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closing.current(); return; }
      if (event.key !== "Tab") return;
      const controls = [...root.current!.querySelectorAll<HTMLElement>('input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled]),summary,a[href]')].filter(visibleControl);
      const first = controls[0], last = controls.at(-1), outside = !root.current!.contains(document.activeElement);
      if (event.shiftKey && (outside || document.activeElement === first)) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && (outside || document.activeElement === last)) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keyboard, true);
    return () => { document.removeEventListener("keydown", keyboard, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closing.current(); }}>
    <section ref={root} className="utility-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog-heading"><h2>{title}</h2><button type="button" onClick={close} aria-label={t("关闭{{title}}", { title })}>×</button></div>
      {children}
    </section>
  </div>;
}
