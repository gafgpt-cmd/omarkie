import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Sparkles, X } from "lucide-react";
import { payloadQuestionLength } from "../../shared/payload-endpoint.mjs";
import type { ReadingTarget } from "../../shared/reading-store.ts";
import { parseBlocks } from "../editor/markdown";
import { host } from "../host";
import { t } from "../i18n";
import type { Preferences } from "../preferences";
import { PayloadNotice, payloadConnection, renderPayload, validPayloadSource } from "./payload-controls";
import "./payload.css";

export function safeProposal(text: string) {
  if (!text || text.length > 24_000 || /[\r\n\x00-\x08\x0b-\x1f[<]/.test(text)) return false;
  const blocks = parseBlocks(text);
  return blocks.length === 1 && blocks[0].kind === "paragraph_open" && blocks[0].source === text;
}

export function ProposalDiff({ before, after }: { before: string; after: string }) {
  return <div className="tutor-diff">
    <div><strong>{t("Before")}</strong><del>{before}</del></div>
    <div><strong>{t("Proposed")}</strong><ins>{after}</ins></div>
  </div>;
}

type Reply = { anchor: ReadingTarget; question: string; body: string };
export default function TutorCurtain({ target, preferences, pendingWrites, editable, canPropose, writeError, configure, close, save, proposals }: {
  target?: ReadingTarget; preferences: Preferences; pendingWrites: boolean; editable: boolean; canPropose: boolean; writeError: string;
  configure(): void; close(): void; save(reply: Reply, proposal: boolean): Promise<boolean>; proposals: ReactNode[];
}) {
  const panel = useRef<HTMLElement>(null), active = useRef(false), pending = useRef(false);
  const [question, setQuestion] = useState(""), [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<Reply>(), [pinned, setPinned] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const connection = payloadConnection(preferences), source = target?.block ?? "";
  const validSource = useMemo(() => validPayloadSource(source), [source]);
  const answer = useMemo(() => reply ? renderPayload(reply.body) : "", [reply]);
  useLayoutEffect(() => {
    active.current = true; panel.current?.focus();
    return () => { active.current = false; };
  }, []);

  async function send(proposal: boolean) {
    const request = question.trim();
    if (pending.current || pendingWrites || !connection || !target || !validSource || !request || (proposal && (!editable || !canPropose))) return;
    pending.current = true; setBusy(true); setError(""); setNotice(""); setReply(undefined); setPinned(false);
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
    <header><h2><Sparkles size={14} />{t("Tutor")} <small>{t("Payload")}</small></h2>
      <button type="button" className="icon-button" aria-label={t("Close Tutor")} onClick={close}><X size={16} /></button></header>
    <div className="payload-body">
      <PayloadNotice origin={connection?.confirmedOrigin} enabled={preferences.payloadEnabled} paragraph configure={configure} />
      {target ? <details className="tutor-source"><summary>{target.quote}</summary><p>{source}</p></details> : <p>{t("Select text in a paragraph to ask the Tutor.")}</p>}
      {target && !validSource && <p className="form-error">{t("Select non-empty text up to 24 KB to use Payload.")}</p>}
      <form aria-describedby="payload-send-notice" onSubmit={event => { event.preventDefault(); void send(false); }}>
        <label className="workspace-field">{t("Ask one question about this text")}
          <input type="text" autoComplete="off" maxLength={payloadQuestionLength} value={question} onChange={event => setQuestion(event.target.value)} disabled={!target || busy} />
        </label>
        <div className="study-actions">
          <button type="submit" className="primary-button" disabled={!connection || !validSource || busy || pendingWrites || !question.trim()}>{t("Send question")}</button>
          <button type="button" disabled={!connection || !validSource || busy || pendingWrites || !editable || !canPropose || !question.trim()} onClick={() => void send(true)}>{t("Propose edit")}</button>
        </div>
      </form>
      {busy && <p role="status">{t("Waiting for Payload…")}</p>}
      {notice && <p role="status">{notice}</p>}
      {proposals.length > 0 && <p>{t("Drafted on the Proposals sheet. The note is unchanged.")}</p>}
      {(error || writeError) && <p role="alert" className="form-error">{error || writeError}</p>}
      {reply && <section className="tutor-answer" aria-label={t("Tutor answer")}>
        <q>{reply.anchor.quote}</q>
        <p>{reply.question}</p>
        <div className="payload-result" dangerouslySetInnerHTML={{ __html: answer }} />
        <button type="button" disabled={pinned || pendingWrites || busy} onClick={async () => {
          if (await save(reply, false) && active.current) setPinned(true);
        }}>{pinned ? t("Pinned to paragraph") : t("Stick on paragraph")}</button>
      </section>}
      {proposals}
    </div>
  </aside>;
}
