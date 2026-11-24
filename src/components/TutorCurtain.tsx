import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Sparkles, X } from "lucide-react";
import { payloadQuestionLength } from "../../shared/payload-endpoint.mjs";
import type { ReadingTarget } from "../../shared/reading-store.ts";
import { host } from "../host";
import { t } from "../i18n";
import type { Preferences } from "../preferences";
import { PayloadNotice, payloadConnection, renderPayload, validPayloadSource } from "./payload-controls";
import type { LiveTutor } from "./tutor-live";
import { tutorLabels, tutorReply, type TutorDraft, type TutorReply, type TutorVerb } from "./tutor-verbs";
import "./payload.css";

export function ProposalDiff({ before, after }: { before: string; after: string }) {
  return <div className="tutor-diff">
    <div><strong>{t("Before")}</strong><del>{before}</del></div>
    <div><strong>{t("Proposed")}</strong><ins>{after}</ins></div>
  </div>;
}

const modes = ["answer", "simplify", "check", "explain", "quiz", "exam", "glossary"] as const;
const textRequired: Partial<Record<TutorVerb, true>> = { answer: true, check: true, propose: true, explain: true, grade: true };

export default function TutorCurtain({ target, draft, preferences, pendingWrites, editable, canPropose, writeError, configure, close,
  save, receive, proposals, live, localRoute, setRoute, makeCard }: {
  target?: ReadingTarget; draft?: TutorDraft; preferences: Preferences; pendingWrites: boolean; editable: boolean; canPropose: boolean; writeError: string;
  configure(): void; close(): void; save(reply: TutorReply): Promise<boolean>; receive(reply: TutorReply): Promise<void>; proposals: ReactNode[];
  live?: LiveTutor; localRoute: boolean; setRoute(route: "local" | "payload"): void;
  makeCard(reply?: TutorReply): void;
}) {
  const panel = useRef<HTMLElement>(null), input = useRef<HTMLInputElement>(null), active = useRef(false), pending = useRef(false);
  const [question, setQuestion] = useState(""), [payloadBusy, setBusy] = useState(false);
  const [mode, setMode] = useState<TutorVerb>("answer"), [context, setContext] = useState<TutorDraft>();
  const [payloadReply, setReply] = useState<TutorReply>(), [pinned, setPinned] = useState(new Set<string>());
  const [error, setError] = useState("");
  const connection = payloadConnection(preferences);
  const anchor = context?.anchor ?? target, source = anchor?.block ?? "";
  const reply = localRoute ? live?.reply : payloadReply;
  const busy = payloadBusy || live?.status === "queued" || live?.status === "seen" || live?.status === "working";
  const canSend = localRoute || !!connection;
  const validSource = useMemo(() => validPayloadSource(source), [source]);
  const answer = useMemo(() => reply ? renderPayload(reply.body) : "", [reply]);
  useLayoutEffect(() => {
    active.current = true; panel.current?.focus();
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (!draft) return;
    setMode(draft.verb); setContext(draft); setQuestion(draft.text ?? "");
    if (document.activeElement === panel.current) input.current?.focus();
  }, [draft]);

  function choose(verb: TutorVerb) { setContext(undefined); setMode(verb); setQuestion(""); setError(""); }
  async function send(verb: TutorVerb) {
    if (pending.current || busy || pendingWrites || !canSend || !anchor || !validSource || (verb === "propose" && (!editable || !canPropose))) return;
    const entered = question.trim();
    const request = verb === "grade" && context?.text ? `${context.text.slice(0, 470)}\n\n${entered.slice(0, 520)}` : entered || (!textRequired[verb] ? t(tutorLabels[verb]) : "");
    if (!request) return;
    const task = { anchor, verb, parent: context?.parent, text: entered };
    setError("");
    if (localRoute && live) {
      if (await live.send(task, request) && active.current) setQuestion("");
      return;
    }
    if (!connection) return;
    pending.current = true; setBusy(true); setReply(undefined);
    try {
      const body = await host.payloadRequest!({ ...connection, source, question: request,
        ...(verb === "propose" ? { proposal: true } : verb !== "answer" ? { tutorVerb: verb } : {}) });
      if (!active.current) return;
      const result = tutorReply(task, request, body);
      await receive(result);
      if (verb !== "propose") setReply(result);
      setQuestion("");
    } catch (err) { if (active.current) setError(t((err as Error).message)); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  async function pin(reply: TutorReply) {
    if (!pinned.has(reply.id) && await save(reply) && active.current) setPinned(ids => new Set(ids).add(reply.id));
  }
  const prompt = mode === "answer" ? "Ask one question about this text" : mode === "check" ? "Your correction" : mode === "explain" ? "Your explanation" : mode === "grade" ? "Your answer" : "Instructions (optional)";
  return <aside className="payload-panel tutor-panel" ref={panel} tabIndex={-1} aria-label={t("Tutor")}
    onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.stopPropagation(); close(); } }}>
    <header><h2><Sparkles size={14} />{t("Tutor")} <small>{t(localRoute ? "Local agent" : "Payload")}</small></h2>
      <button type="button" className="icon-button" aria-label={t("Close Tutor")} onClick={close}><X size={16} /></button></header>
    <div className="payload-body">
      {live && <div className="study-actions tutor-routes" role="group" aria-label={t("Tutor route")}>
        <button type="button" aria-pressed={localRoute} onClick={() => { setRoute("local"); setError(""); }}>{t("Local agent")}</button>
        <button type="button" aria-pressed={!localRoute} onClick={() => { setRoute("payload"); setError(""); }}>{t("Payload")}</button>
      </div>}
      {localRoute ? <div id="payload-send-notice" className="payload-notice">
        <p>{t("Only the selected paragraph and question go to the local agent. Nothing is sent to Payload.")}</p>
        <p>{live?.owner ? t("Connected: {{agent}}", { agent: live.owner }) : t("Queue a question, then run")} {!live?.owner && <code>omarkie-axi poll --wait</code>}</p>
      </div> : <PayloadNotice origin={connection?.confirmedOrigin} enabled={preferences.payloadEnabled} paragraph configure={configure} />}
      {anchor ? <details className="tutor-source"><summary>{anchor.quote}</summary><p>{source}</p></details> : <p>{t("Select text in a paragraph to ask the Tutor.")}</p>}
      {anchor && !validSource && <p className="form-error">{t("Select non-empty text up to 24 KB.")}</p>}
      <div className="study-actions tutor-verbs" role="group" aria-label={t("Tutor actions")}>
        {modes.map(verb => <button type="button" key={verb} aria-pressed={verb === mode} disabled={!anchor || busy} onClick={() => choose(verb)}>{t(tutorLabels[verb])}</button>)}
        <button type="button" disabled={!anchor || busy} onClick={() => makeCard(reply)}>{t("制作卡片")}</button>
      </div>
      <form aria-describedby="payload-send-notice" onSubmit={event => { event.preventDefault(); void send(mode); }}>
        <label className="workspace-field">{t(prompt)}
          <input ref={input} type="text" autoComplete="off" maxLength={mode === "grade" ? 520 : payloadQuestionLength} value={question}
            onChange={event => setQuestion(event.target.value)} disabled={!anchor || busy} />
        </label>
        <div className="study-actions">
          <button type="submit" className="primary-button" disabled={!canSend || !validSource || busy || pendingWrites || (textRequired[mode] && !question.trim()) || (mode === "propose" && (!editable || !canPropose))}>
            {t(mode === "answer" ? "Send question" : mode === "propose" ? "Draft proposal" : tutorLabels[mode])}
          </button>
          {mode === "answer" && <button type="button" disabled={!canSend || !validSource || busy || pendingWrites || !editable || !canPropose || !question.trim()} onClick={() => void send("propose")}>{t("Propose edit")}</button>}
        </div>
      </form>
      {payloadBusy && <p role="status">{t("Waiting for Payload…")}</p>}
      {localRoute && live?.status && <p role="status">{t(({ queued: "Queued for a local agent", seen: "Agent received the question", working: "Agent is working", done: "Agent replied" } as const)[live.status])}</p>}
      {proposals.length > 0 && <p>{t("Drafted on the Proposals sheet. The note is unchanged.")}</p>}
      {(error || writeError || localRoute && live?.problem) && <p role="alert" className="form-error">{error || writeError || live?.problem}</p>}
      {reply && <section className="tutor-answer" aria-label={t("Tutor answer")}>
        <q>{reply.anchor.quote}</q>
        {reply.text && <p>{reply.text}</p>}
        <div className="payload-result" dangerouslySetInnerHTML={{ __html: answer }} />
        <div className="study-actions">
          <button type="button" disabled={pinned.has(reply.id) || pendingWrites || busy} onClick={() => void pin(reply)}>{pinned.has(reply.id) ? t("Pinned to paragraph") : t("Stick on paragraph")}</button>
          {reply.verb === "quiz" ? <button type="button" disabled={busy} onClick={() => {
            setMode("grade"); setContext({ anchor: reply.anchor, verb: "grade", text: reply.body }); setQuestion(""); input.current?.focus();
          }}>{t("Answer quiz")}</button> : <button type="button" disabled={busy || pendingWrites} onClick={async () => {
            const parent = reply.parent ?? reply.id;
            if (!reply.parent) await pin(reply);
            if (!active.current) return;
            setMode("simplify"); setContext({ anchor: reply.anchor, verb: "simplify", parent }); setQuestion(`${t("Explain more simply:")} ${reply.body.slice(0, 760)}`);
          }}>{t("Still lost")}</button>}
        </div>
      </section>}
      {proposals}
    </div>
  </aside>;
}
