import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import MarkdownIt from "markdown-it";
import mark from "markdown-it-mark";
import { payloadEndpoint, payloadInputBytes, payloadQuestionLength } from "../../shared/payload-endpoint.mjs";
import { host } from "../host";
import { t } from "../i18n";
import type { Preferences } from "../preferences";
import "./payload.css";

const preview = new MarkdownIt({ html: false, breaks: true }).use(mark).disable(["image", "link", "autolink", "reference"]);

export default function PayloadPanel({ mode, source, selection, preferences, editable, append, configure, close }: {
  mode: "summary" | "question"; source: string; selection: boolean; preferences: Preferences;
  editable: boolean; append(markdown: string): void; configure(): void; close(): void;
}) {
  const [summary, setSummary] = useState("");
  const [answer, setAnswer] = useState("");
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [inserted, setInserted] = useState(false);
  const pending = useRef(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.focus(); }, []);
  const endpoint = payloadEndpoint(preferences.payloadBaseUrl);
  const allowed = endpoint && (endpoint.local || preferences.payloadAllowedOrigins.includes(endpoint.origin));
  const configured = preferences.payloadEnabled && allowed && !!preferences.payloadModel.trim();
  const validSource = useMemo(() => source.length <= payloadInputBytes && !!source.trim() && new TextEncoder().encode(source).length <= payloadInputBytes, [source]);
  const summaryHtml = useMemo(() => summary ? preview.render(summary) : "", [summary]);

  async function send(ask: boolean) {
    if (pending.current || !configured || !endpoint || !validSource || (ask && !question.trim())) return;
    pending.current = true;
    setBusy(true);
    setError("");
    if (ask) setAnswer("");
    try {
      const result = await host.payloadRequest!({
        baseUrl: preferences.payloadBaseUrl, confirmedOrigin: endpoint.origin, ...(endpoint.local ? {} : { allowedOrigin: endpoint.origin }),
        model: preferences.payloadModel, modernLimit: preferences.payloadModernLimit, source, ...(ask ? { question: question.trim() } : {}),
      });
      if (ask) { setAnswer(preview.render(result)); setQuestion(""); }
      else {
        // Model output may try to load remote resources when inserted into the note.
        setSummary(result.replace(/!\[/g, "&#33;[").replace(/<(?=[A-Za-z!/?])/g, "&lt;"));
        setInserted(false);
      }
    } catch (err) { setError((err as Error).message); }
    finally { pending.current = false; setBusy(false); }
  }

  return <aside className="payload-panel" ref={panel} tabIndex={-1} aria-label={t("Payload")} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
    <header><h2>{t("Payload")}</h2><button type="button" className="icon-button" aria-label={t("Close Payload")} onClick={close}><X size={16} /></button></header>
    <div className="payload-body">
      {configured && endpoint ? <div className="payload-notice" id="payload-send-notice">
        <p>{selection ? t("Sends the selected text to {{origin}}.", { origin: endpoint.origin }) : t("Sends this note’s text to {{origin}}.", { origin: endpoint.origin })}</p>
        <p>{t("Do not send identifiable medical data. Even a local server can forward requests.")}</p>
      </div> : <p>{t(preferences.payloadEnabled ? "Configure and allow the Payload endpoint in Preferences." : "Enable Payload")} <button type="button" onClick={configure}>{t("偏好设置")}</button></p>}
      {!validSource && <p className="form-error">{t("Select non-empty text up to 24 KB to use Payload.")}</p>}
      {mode === "summary" && !summary && <button type="button" className="primary-button" aria-describedby="payload-send-notice" disabled={!configured || !validSource || busy} onClick={() => void send(false)}>{t("Send text for summary")}</button>}
      {summary && <section aria-label={t("Payload summary")}>
        <div className="payload-result" dangerouslySetInnerHTML={{ __html: summaryHtml }} />
        <button type="button" disabled={!editable || inserted} onClick={() => {
          try { append(summary); setInserted(true); setError(""); }
          catch (err) { setError((err as Error).message); }
        }}>{inserted ? t("Callout inserted") : t("Append as callout")}</button>
      </section>}
      {(mode === "question" || summary) && <form aria-describedby="payload-send-notice" onSubmit={event => { event.preventDefault(); void send(true); }}>
        <label className="workspace-field">{t("Ask one question about this text")}<input type="text" autoComplete="off" maxLength={payloadQuestionLength} value={question} onChange={event => setQuestion(event.target.value)} disabled={busy} /></label>
        <button className="primary-button" disabled={!configured || !validSource || busy || !question.trim()}>{t("Send question")}</button>
      </form>}
      {busy && <p role="status">{t("Waiting for Payload…")}</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
      {answer && <section aria-label={t("Payload answer")} className="payload-result" dangerouslySetInnerHTML={{ __html: answer }} />}
    </div>
  </aside>;
}
