import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Sparkles, X } from "lucide-react";
import { payloadQuestionLength } from "../../shared/payload-endpoint.mjs";
import type { ReadingTarget } from "../../shared/reading-store.ts";
import { safeProposal } from "../editor/markdown";
import { host } from "../host";
import { t } from "../i18n";
import type { Preferences } from "../preferences";
import { PayloadNotice, payloadConnection, renderPayload, validPayloadSource } from "./payload-controls";
import type { LiveTutor, TutorReply } from "./tutor-live";
import "./payload.css";

export function ProposalDiff({ before, after }: { before: string; after: string }) {
  return <div className="tutor-diff">
    <div><strong>{t("Before")}</strong><del>{before}</del></div>
    <div><strong>{t("Proposed")}</strong><ins>{after}</ins></div>
  </div>;
}

export default function TutorCurtain({ target, preferences, pendingWrites, editable, canPropose, writeError, configure, close, save, proposals, live, localRoute, setRoute }: {
  target?: ReadingTarget; preferences: Preferences; pendingWrites: boolean; editable: boolean; canPropose: boolean; writeError: string;
  configure(): void; close(): void; save(reply: TutorReply, proposal: boolean): Promise<boolean>; proposals: ReactNode[];
  live?: LiveTutor; localRoute: boolean; setRoute(route: "local" | "payload"): void;
}) {
  const panel = useRef<HTMLElement>(null), active = useRef(false), pending = useRef(false);
  const [question, setQuestion] = useState(""), [payloadBusy, setBusy] = useState(false);
  const [payloadReply, setReply] = useState<TutorReply>(), [pinnedAnswer, setPinned] = useState<TutorReply>();
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const connection = payloadConnection(preferences), source = target?.block ?? "";
  const reply = localRoute ? live?.reply : payloadReply, pinned = !!reply && pinnedAnswer === reply;
  const busy = payloadBusy || live?.status === "queued" || live?.status === "seen" || live?.status === "working";
  const canSend = localRoute || !!connection;
  const validSource = useMemo(() => validPayloadSource(source), [source]);
  const answer = useMemo(() => reply ? renderPayload(reply.body) : "", [reply]);
  useLayoutEffect(() => {
    active.current = true; panel.current?.focus();
    return () => { active.current = false; };
  }, []);

  async function send(proposal: boolean) {
    const request = question.trim();
    if (pending.current || busy || pendingWrites || !canSend || !target || !validSource || !request || (proposal && (!editable || !canPropose))) return;
    setError(""); setNotice(""); setPinned(undefined);
    if (localRoute && live) {
      if (await live.send(target, request, proposal) && active.current) setQuestion("");
      return;
    }
    if (!connection) return;
    pending.current = true; setBusy(true); setReply(undefined);
    try {
      const body = await host.payloadRequest!({ ...connection, source, question: request, ...(proposal ? { proposal: true } : {}) });
      if (!active.current) return;
      const result = { anchor: target, question: request, body };
      if (!proposal) setReply(result);
      else if (body === source.trim()) setNotice(t("No edit proposed."));
      else {
        if (!safeProposal(body)) throw new Error(t("Tutor did not return a safe paragraph. Ask for a prose rewrite."));
        if (!await save(result, true) || !active.current) return;
      }
      setQuestion("");
    } catch (err) { if (active.current) setError((err as Error).message); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }

  return <aside className="payload-panel tutor-panel" ref={panel} tabIndex={-1} aria-label={t("Tutor")}
    onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.stopPropagation(); close(); } }}>
    <header><h2><Sparkles size={14} />{t("Tutor")} <small>{t(localRoute ? "Local agent" : "Payload")}</small></h2>
      <button type="button" className="icon-button" aria-label={t("Close Tutor")} onClick={close}><X size={16} /></button></header>
    <div className="payload-body">
      {live && <div className="study-actions tutor-routes" role="group" aria-label={t("Tutor route")}>
        <button type="button" aria-pressed={localRoute} onClick={() => { setRoute("local"); setError(""); setNotice(""); }}>{t("Local agent")}</button>
        <button type="button" aria-pressed={!localRoute} onClick={() => { setRoute("payload"); setError(""); setNotice(""); }}>{t("Payload")}</button>
      </div>}
      {localRoute ? <div id="payload-send-notice" className="payload-notice">
        <p>{t("Only the selected paragraph and question go to the local agent. Nothing is sent to Payload.")}</p>
        <p>{live?.owner ? t("Connected: {{agent}}", { agent: live.owner }) : t("Queue a question, then run")} {!live?.owner && <code>omarkie-axi poll --wait</code>}</p>
      </div> : <PayloadNotice origin={connection?.confirmedOrigin} enabled={preferences.payloadEnabled} paragraph configure={configure} />}
      {target ? <details className="tutor-source"><summary>{target.quote}</summary><p>{source}</p></details> : <p>{t("Select text in a paragraph to ask the Tutor.")}</p>}
      {target && !validSource && <p className="form-error">{t("Select non-empty text up to 24 KB.")}</p>}
      <form aria-describedby="payload-send-notice" onSubmit={event => { event.preventDefault(); void send(false); }}>
        <label className="workspace-field">{t("Ask one question about this text")}
          <input type="text" autoComplete="off" maxLength={payloadQuestionLength} value={question} onChange={event => setQuestion(event.target.value)} disabled={!target || busy} />
        </label>
        <div className="study-actions">
          <button type="submit" className="primary-button" disabled={!canSend || !validSource || busy || pendingWrites || !question.trim()}>{t("Send question")}</button>
          <button type="button" disabled={!canSend || !validSource || busy || pendingWrites || !editable || !canPropose || !question.trim()} onClick={() => void send(true)}>{t("Propose edit")}</button>
        </div>
      </form>
      {payloadBusy && <p role="status">{t("Waiting for Payload…")}</p>}
      {localRoute && live?.status && <p role="status">{t(({ queued: "Queued for a local agent", seen: "Agent received the question", working: "Agent is working", done: "Agent replied" } as const)[live.status])}</p>}
      {notice && <p role="status">{notice}</p>}
      {proposals.length > 0 && <p>{t("Drafted on the Proposals sheet. The note is unchanged.")}</p>}
      {(error || writeError || localRoute && live?.problem) && <p role="alert" className="form-error">{error || writeError || live?.problem}</p>}
      {reply && <section className="tutor-answer" aria-label={t("Tutor answer")}>
        <q>{reply.anchor.quote}</q>
        <p>{reply.question}</p>
        <div className="payload-result" dangerouslySetInnerHTML={{ __html: answer }} />
        <button type="button" disabled={pinned || pendingWrites || busy} onClick={async () => {
          if (await save(reply, false) && active.current) setPinned(reply);
        }}>{pinned ? t("Pinned to paragraph") : t("Stick on paragraph")}</button>
      </section>}
      {proposals}
    </div>
  </aside>;
}
