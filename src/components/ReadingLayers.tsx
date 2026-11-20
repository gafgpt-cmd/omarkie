import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState } from "react";
import { Eye, EyeOff, Layers, LockKeyhole, PencilLine, X } from "lucide-react";
import type { ReadingTarget } from "../../shared/reading-store.ts";
import type { EditorHandle } from "../editor/MarkdownEditor";
import { host } from "../host";
import { t } from "../i18n";
import { readingSelection } from "./reading-selection";
import "./reading-layers.css";

const MarginNotes = lazy(() => import("./MarginNotes"));
type Layer = "card" | "note" | "ask" | "visual" | "clean";
export interface ReadingLayerState { active: Layer; note: boolean; visual: boolean }
interface ReadingLayerAction {
  visible: boolean;
  open(target?: ReadingTarget): void;
  close(): void;
}
export interface ReadingLayerActions {
  clean?: ReadingLayerAction;
  ask?: ReadingLayerAction;
  card?: ReadingLayerAction;
}
interface Selection { target: ReadingTarget; x: number; y: number }

export default function ReadingLayers({ id, content, saved, state, change, editor, actions = {}, close }: {
  id: string; content: string; saved: boolean; state: ReadingLayerState;
  change(state: ReadingLayerState): void;
  editor(): EditorHandle | undefined;
  actions?: ReadingLayerActions;
  close(): void;
}) {
  const [store] = useState(() => host.readingStore!);
  const [selection, setSelection] = useState<Selection>(), [draft, setDraft] = useState<{ id: string; body: string }>();
  const [saving, setSaving] = useState(false), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const popover = useRef<HTMLDivElement>(null);
  const shouldFocus = useRef(false);
  const canSelect = saved || !!actions.ask || !!actions.card;
  const visible = (layer: Layer) => layer === "note" || layer === "visual" ? state[layer] : !!actions[layer]?.visible;
  function setVisible(layer: Layer, value: boolean) {
    if (layer === "note" || layer === "visual") change({ ...state, [layer]: value });
    else if (value) actions[layer]?.open();
    else actions[layer]?.close();
  }
  function activate(layer: Layer) {
    if (layer === "note" || layer === "visual") change({ ...state, active: layer, [layer]: true });
    else {
      if (!visible(layer)) actions[layer]?.open();
      change({ ...state, active: layer });
    }
  }
  function dismiss(restoreFocus = false) {
    if (saving) return;
    setSelection(undefined); setDraft(undefined); setError("");
    if (restoreFocus) editor()?.focus();
  }
  const capture = useEffectEvent((surface: HTMLElement, keyboard: boolean, image?: HTMLImageElement) => {
    if (draft || saving) return false;
    const current = editor();
    const next = current && readingSelection(current, surface, image);
    if (!next) return false;
    shouldFocus.current = keyboard;
    setSelection(next); setError("");
    return true;
  });
  const closeSelection = useEffectEvent((event: Event) => {
    if (!draft && !popover.current?.contains(event.target as Node)) dismiss();
  });
  useEffect(() => {
    if (!canSelect) return;
    const surface = (node: EventTarget | null) => {
      const parent = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
      const element = parent?.closest<HTMLElement>(".rich-document,.cm-content");
      return element && element.closest(".writing-area > .document-editor:not([hidden])") ? element : null;
    };
    const point = (event: PointerEvent) => {
      const target = surface(event.target);
      if (target && event.button === 0) capture(target, false, event.target instanceof HTMLImageElement ? event.target : undefined);
    };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const keyboard = event.altKey && event.key === "Enter";
      const target = surface(event.target) || (keyboard ? surface(window.getSelection()?.focusNode || null) : null);
      if (!target) return;
      if ((keyboard || event.shiftKey && /^(Arrow|Home|End|Page)/.test(event.key)) && capture(target, keyboard) && keyboard) event.preventDefault();
    };
    document.addEventListener("pointerup", point);
    document.addEventListener("pointerdown", closeSelection, true);
    document.addEventListener("keyup", key);
    return () => { document.removeEventListener("pointerup", point); document.removeEventListener("pointerdown", closeSelection, true); document.removeEventListener("keyup", key); };
  }, [canSelect]);
  useEffect(() => {
    if (!selection || !shouldFocus.current) return;
    shouldFocus.current = false;
    const panel = popover.current;
    (panel?.querySelector<HTMLButtonElement>("[data-layer-active]:enabled") || panel?.querySelector<HTMLButtonElement>("button:enabled"))?.focus();
  }, [selection]);

  function choose(layer: "note" | "ask" | "card") {
    if (!selection) return;
    if (layer === "note") {
      activate("note"); setDraft({ id: crypto.randomUUID(), body: "" });
    } else {
      try { actions[layer]?.open(selection.target); change({ ...state, active: layer }); dismiss(); }
      catch (error) { setError((error as Error).message); }
    }
  }
  async function save() {
    if (!selection || !draft?.body.trim() || saving) return;
    setSaving(true); setError("");
    try {
      await store(id, { action: "put", item: { type: "note", id: draft.id, body: draft.body.trim(), anchor: selection.target } });
      setRevision(current => current + 1); setSelection(undefined); setDraft(undefined); editor()?.focus();
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  }

  const rows = [
    { layer: "card", code: "L5", label: t("卡片"), available: !!actions.card },
    { layer: "note", code: "L4", label: t("页边笔记"), available: true },
    { layer: "ask", code: "L3", label: t("问答摘要"), available: !!actions.ask },
    { layer: "visual", code: "L2", label: t("排版"), available: true },
    { layer: "clean", code: "L1", label: t("清理"), available: !!actions.clean },
  ] as const;
  return <>
    <aside className="layers-rail" aria-label={t("阅读图层")}>
      <header><h2><Layers size={16} />{t("阅读图层")}</h2><button type="button" aria-label={t("关闭阅读图层")} onClick={close}><X size={16} /></button></header>
      <ul>
        {rows.map(({ layer, code, label, available }) => {
          const on = visible(layer), active = state.active === layer, eyeLabel = on ? t("隐藏{{layer}}", { layer: label }) : t("显示{{layer}}", { layer: label });
          return <li key={layer} data-layer={code} data-active={active || undefined}>
            <button type="button" disabled={!available} onClick={() => setVisible(layer, !on)} aria-label={eyeLabel} title={eyeLabel} aria-pressed={on}>{on ? <Eye size={17} /> : <EyeOff size={17} />}</button>
            <button type="button" className="layers-row" aria-pressed={active} disabled={!available} onClick={() => activate(layer)}>
              <small>{code}</small><span>{label}</span>{active && <PencilLine size={14} aria-label={t("当前图层")} />}
            </button>
          </li>;
        })}
        <li className="layers-canvas" data-layer="L0"><LockKeyhole size={16} /><small>L0</small><span>{t("源文档")}</span></li>
      </ul>
      <p>{t("眼睛切换显示，铅笔标记当前图层。")}</p>
    </aside>
    {state.note && <Suspense fallback={<aside className="layers-margin" role="status">{t("正在读取页边笔记…")}</aside>}>
      <MarginNotes id={id} content={content} revision={revision} enabled={saved} store={store} editor={editor} />
    </Suspense>}
    {selection && <div className="layers-selection" role="dialog" aria-label={t("选区操作")} ref={popover}
      style={{ left: `clamp(8px, ${selection.x}px, 100vw - min(18rem, 96vw) - 8px)`, top: `clamp(36px, ${selection.y + 8}px, calc(100dvh - ${draft ? 192 : 154}px))` }}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); dismiss(true); } }}>
      {draft ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <label>{t("给自己写笔记")}<textarea autoFocus value={draft.body} maxLength={65536} disabled={saving} onChange={event => setDraft({ ...draft, body: event.target.value })} /></label>
        <div><button type="button" disabled={saving} onClick={() => dismiss(true)}>{t("取消")}</button><button type="submit" disabled={saving || !draft.body.trim()}>{t("固定笔记")}</button></div>
      </form> : <>
        <button type="button" disabled={!saved} data-layer-active={state.active === "note" || undefined} onClick={() => choose("note")}>{t("给自己写笔记")}</button>
        <button type="button" disabled={!actions.ask} data-layer-active={state.active === "ask" || undefined} onClick={() => choose("ask")}>{t("询问选中内容")}</button>
        <button type="button" disabled={!actions.card} data-layer-active={state.active === "card" || undefined} onClick={() => choose("card")}>{t("制作卡片")}</button>
      </>}
      {error && <p role="alert">{error}</p>}
    </div>}
  </>;
}
