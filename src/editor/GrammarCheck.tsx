import { useLayoutEffect, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { host } from "../host";
import { t } from "../i18n";
import { grammarDefault, grammarEndpoint, grammarMatches, grammarTextLimit } from "../../shared/grammar.mjs";
import type { GrammarMatch } from "../../shared/grammar.mjs";
import "./grammar.css";

type Surface = { root: HTMLElement; range(from: number, to: number): Range | null };
type Results = { content: string; text: string; matches: GrammarMatch[] };

export default function GrammarCheck({ url, approvedOrigin = "", content, mode, readOnly, snapshot, surface, apply }: {
  url?: string; approvedOrigin?: string; content: string; mode: "rich" | "source" | null; readOnly: boolean;
  snapshot(): string | null; surface(): Surface | null;
  apply(text: string, match: GrammarMatch, replacement: string): boolean;
}) {
  const [confirm, setConfirm] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(""), [results, setResults] = useState<Results | null>(null);
  const [selected, setSelected] = useState<{ match: GrammarMatch; rect?: DOMRect } | null>(null);
  const popup = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const current = useRef({ snapshot, surface }); current.current = { snapshot, surface };
  const active = results?.content === content ? results : null;
  const match = active && selected && active.matches.includes(selected.match) ? selected.match : null;
  const endpoint = grammarEndpoint(url ?? grammarDefault);

  useLayoutEffect(() => {
    if (!active?.matches.length || !mode) return;
    const view = current.current.surface();
    if (!view) return;
    let ranges: { range: Range; match: GrammarMatch }[] = [];
    const update = () => {
      ranges = current.current.snapshot() === active.text ? active.matches.flatMap(match => {
        const range = view.range(match.from, match.to);
        return range ? [{ range, match }] : [];
      }) : [];
      if (typeof Highlight !== "undefined") CSS.highlights.set("omarkie-grammar", new Highlight(...ranges.map(({ range }) => range)));
    };
    const click = (event: MouseEvent) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || !window.getSelection()?.isCollapsed) return;
      for (const item of ranges) {
        for (const rect of item.range.getClientRects()) {
          if (event.clientX < rect.left || event.clientX > rect.right + 1 || event.clientY < rect.top || event.clientY > rect.bottom) continue;
          setSelected({ match: item.match, rect });
          return;
        }
      }
      setSelected(null);
    };
    const observer = new MutationObserver(update);
    observer.observe(view.root, { childList: true, characterData: true, subtree: true });
    view.root.addEventListener("click", click);
    update();
    return () => {
      observer.disconnect();
      view.root.removeEventListener("click", click);
      CSS.highlights?.delete("omarkie-grammar");
    };
  }, [active, mode]);

  useLayoutEffect(() => {
    if (!match) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        event.stopPropagation(); button.current?.focus();
      } else if (event.type === "pointerdown" && (popup.current?.contains(event.target as Node) || button.current === event.target)) return;
      setSelected(null);
    };
    popup.current?.querySelector("button")?.focus({ preventScroll: true });
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [match]);

  function prepare() {
    setStatus("");
    if (!endpoint) { setStatus(t("Enter a valid LanguageTool check URL in Preferences.")); return; }
    if (!endpoint.local && approvedOrigin !== endpoint.origin) { setStatus(t("Allow this LanguageTool origin in Preferences first.")); return; }
    const text = snapshot();
    if (!text?.trim()) return;
    if (text.length > grammarTextLimit) { setStatus(t("LanguageTool checks notes up to 20,000 characters.")); return; }
    setSelected(null); setConfirm(text);
  }

  async function send() {
    setConfirm(null);
    const text = confirm;
    if (!endpoint || !host.checkGrammar || !text || (!endpoint.local && approvedOrigin !== endpoint.origin)) return;
    if (snapshot() !== text) { setStatus(t("The note changed. Check grammar again.")); return; }
    setBusy(true); setResults(null);
    try {
      const matches = grammarMatches(await host.checkGrammar(endpoint.url, approvedOrigin, text), text);
      if (current.current.snapshot() === text) setResults({ content, text, matches });
    } catch { setStatus(t("LanguageTool could not check this note. Check the endpoint and try again.")); }
    finally { setBusy(false); }
  }

  const rect = match ? selected?.rect : undefined;
  return <div className="grammar-bar">
    <button ref={button} onClick={prepare} disabled={busy || !mode || !content}>{t("Check grammar…")}</button>
    {active?.matches.length ? <label>{t("Grammar findings")} <select value={match ? active.matches.indexOf(match) : ""} onChange={event => setSelected(event.target.value === "" ? null : { match: active.matches[Number(event.target.value)] })}>
      <option value="">{t("Choose a finding")}</option>
      {active.matches.map((item, index) => <option key={index} value={index}>{`${index + 1}. ${item.message}`}</option>)}
    </select></label> : null}
    <span role="status">{busy ? t("Checking grammar…") : status || (active && !active.matches.length ? t("No grammar findings.") : "")}</span>
    {confirm && endpoint && <Dialog title={t("Send to LanguageTool?")} close={() => setConfirm(null)}>
      <p className="workspace-path">{endpoint.url}</p>
      <p>{t("This sends the current Markdown note to this server. Do not send patient data or other sensitive text unless this server is approved for it.")}</p>
      <div className="dialog-actions"><button onClick={() => setConfirm(null)}>{t("取消")}</button><button className="primary-button" onClick={() => void send()}>{t("Send note")}</button></div>
    </Dialog>}
    {match && active && <div ref={popup} role="dialog" aria-label={t("Grammar quick fix")} className="grammar-fix" style={rect ? { position: "fixed", left: Math.max(8, Math.min(rect.left, innerWidth - 310)), top: Math.min(rect.bottom + 4, innerHeight - 220) } : undefined}>
      <p>{match.message}</p>
      {match.to > match.from && <del>{active.text.slice(match.from, match.to)}</del>}
      {!readOnly && match.fixes.map(fix => <button key={fix} onClick={() => {
        if (apply(active.text, match, fix)) { setResults(null); setStatus(""); }
        else setStatus(t("The note changed. Check grammar again."));
        setSelected(null);
      }}>{fix || t("Remove this text")}</button>)}
      <button onClick={() => { setSelected(null); button.current?.focus(); }}>{t("关闭")}</button>
    </div>}
  </div>;
}
