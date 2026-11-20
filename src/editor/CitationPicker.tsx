import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { host } from "../host";
import { t } from "../i18n";
import type { CitationMatch } from "../types";
import { citationAt, citationDraft } from "./citationSyntax";
import type { CitationDraft } from "./citationSyntax";
import { imeKey } from "./composition";

type Popup = ({ kind: "suggest"; draft: CitationDraft; options: CitationMatch[]; index: number } | { kind: "pdf"; id: string }) & { left: number; top: number };
interface EditorCitationContext {
  text: string;
  caret: number | null;
  excluded(at: number): boolean;
  coords(at: number): { left: number; bottom: number } | null;
  position(x: number, y: number): number | null;
  insert(from: number, to: number, text: string): void;
}
function place(left: number, top: number) {
  return { left: Math.max(4, Math.min(left, innerWidth - 245)), top: Math.max(4, Math.min(top, innerHeight - 285)) };
}
export function useCitationPicker(folder: string | undefined, editor: () => EditorCitationContext | null, editable: boolean, notify: (message: string) => void) {
  const [popup, setPopup] = useState<Popup | null>(null);
  const revision = useRef(0), pending = useRef<CitationDraft | null>(null);
  const current = useRef(folder); current.current = folder;
  const pickerId = useId();
  function close() {
    ++revision.current;
    pending.current = null;
    setPopup(null);
  }
  useEffect(() => { close(); return () => { ++revision.current; }; }, [folder, editable]);
  function update(text: string, at: number) {
    if (!folder || !editable) return;
    const draft = citationDraft(text, at);
    const context = draft && editor();
    if (!draft || !context || context.caret !== at || context.excluded(draft.from)) { if (pending.current || popup) close(); return; }
    pending.current = draft;
    const request = ++revision.current;
    void host.bibliography!(folder, "suggest", draft.query).then(options => {
      if (request !== revision.current || current.current !== folder) return;
      const latest = editor();
      if (latest?.caret !== draft.at || !options.length) { close(); return; }
      const rect = latest.coords(draft.at);
      if (rect) setPopup({ kind: "suggest", draft, options, index: 0, ...place(rect.left, rect.bottom + 6) });
    }).catch(error => { if (request === revision.current && current.current === folder) { pending.current = null; notify(error.message); } });
  }
  function cursor() {
    if (pending.current && pending.current.at !== editor()?.caret) close();
  }
  function choose(option: CitationMatch, draft: CitationDraft) {
    const context = editor();
    const latest = editable && context?.caret != null ? citationDraft(context.text, context.caret) : undefined;
    close();
    if (!context || latest?.from !== draft.from || context.excluded(latest.from)) return false;
    const query = latest.query.toLowerCase();
    if (![option.id, option.title, option.authors].some(value => value.toLowerCase().includes(query))) return false;
    context.insert(latest.from, latest.to, `[@${option.id}]`);
    return true;
  }
  function open(id: string) {
    close();
    if (folder) void host.bibliography!(folder, "open", id).catch(error => notify(error.message));
  }
  function keydown(event: KeyboardEvent) {
    if (!folder || imeKey(event.nativeEvent)) return;
    if (event.key === "Escape" && (pending.current || popup)) {
      close(); event.preventDefault(); event.stopPropagation(); return;
    }
    if (popup?.kind === "suggest" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && ["ArrowUp", "ArrowDown", "Enter", "Tab"].includes(event.key)) {
      if (event.key === "Enter" || event.key === "Tab") {
        if (!choose(popup.options[popup.index], popup.draft)) return;
      } else {
        const index = (popup.index + (event.key === "ArrowDown" ? 1 : -1) + popup.options.length) % popup.options.length;
        setPopup({ ...popup, index });
        document.getElementById(`${pickerId}-${index}`)?.scrollIntoView({ block: "nearest" });
      }
      event.preventDefault(); event.stopPropagation();
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && event.key === "Enter") {
      const context = editor();
      const cite = context?.caret != null && citationAt(context.text, context.caret);
      if (cite && !context!.excluded(cite.from)) {
        event.preventDefault(); event.stopPropagation(); open(cite.id);
      }
    }
  }
  function contextMenu(event: MouseEvent) {
    if (!folder || !(event.target instanceof Element) || !event.target.closest(".rich-document,.source-surface .cm-content")) return;
    const context = editor(), at = context?.position(event.clientX, event.clientY);
    const cite = context && at != null && citationAt(context.text, at);
    if (!cite) return;
    event.preventDefault(); event.stopPropagation();
    close(); setPopup({ kind: "pdf", id: cite.id, ...place(event.clientX, event.clientY) });
  }
  const content = popup && folder && <div className="emoji-completion" style={{ left: popup.left, top: popup.top }}
    role={popup.kind === "suggest" ? "listbox" : undefined} aria-label={popup.kind === "suggest" ? t("引用建议") : undefined}
    onPointerDown={event => event.preventDefault()}>
    {popup.kind === "pdf" ? <button type="button" onClick={() => open(popup.id)}>{t("打开引用的 PDF")}</button>
      : popup.options.map((option, index) => <button key={option.id} type="button" role="option" id={`${pickerId}-${index}`} aria-selected={index === popup.index}
        onClick={() => choose(option, popup.draft)}>{option.id}{option.title && ` · ${option.title}`}{option.authors && ` · ${option.authors}`}</button>)}
  </div>;
  return { update, cursor, close, keydown, contextMenu, content };
}
