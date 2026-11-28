import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "./Dialog";
import { loadBase, renderBase, type BaseState } from "../editor/bases";
import { onEmbedsChanged } from "../editor/embeds";
import { t } from "../i18n";

// A `.base` file as a read-only view. Re-evaluates when notes, drafts or the base itself change; a slower earlier
// load never overwrites a newer one.
export function BaseView({ relative, close, open }: { relative: string; close(): void; open(relative: string): void }) {
  const [view, setView] = useState<string>();
  const [state, setState] = useState<BaseState>();
  const [revision, setRevision] = useState(0);
  const surface = useRef<HTMLDivElement>(null), request = useRef(0);
  useEffect(() => onEmbedsChanged(() => setRevision(value => value + 1)), []);
  useEffect(() => {
    const id = ++request.current;
    void loadBase(relative, view).then(next => { if (id === request.current) setState(next); });
  }, [relative, view, revision]);
  const actions = useRef({ close, open });
  actions.current = { close, open };
  useEffect(() => { if (state && surface.current) renderBase(surface.current, state, path => { actions.current.close(); actions.current.open(path); }); }, [state]);
  const current = state?.result?.view ?? undefined, views = state?.views ?? [];
  const tabs = useRef<HTMLDivElement>(null);
  const step = (event: KeyboardEvent, at: number) => {
    const next = event.key === "ArrowRight" ? at + 1 : event.key === "ArrowLeft" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : null;
    if (next === null || !views.length) return;
    event.preventDefault();
    const target = (next + views.length) % views.length;
    setView(views[target].name);
    tabs.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[target]?.focus();
  };
  return <Dialog title={relative.split("/").at(-1)?.replace(/\.base$/i, "") || t("Base")} close={close}>
    <div className="base-dialog">
      <p className="base-path">{relative} · {t("Read-only")}</p>
      {views.length > 1 && <div ref={tabs} className="base-tabs" role="tablist" aria-label={t("Views")}>
        {views.map((item, at) => <button key={item.name} type="button" role="tab" aria-selected={item.name === current} tabIndex={item.name === current ? 0 : -1} onClick={() => setView(item.name)} onKeyDown={event => step(event, at)}>{item.name}</button>)}
      </div>}
      {!state && <p className="base-count" role="status">{t("Loading notes…")}</p>}
      <div ref={surface} className="base-surface" role={views.length > 1 ? "tabpanel" : undefined} />
    </div>
  </Dialog>;
}
