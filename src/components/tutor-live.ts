import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { TutorReceipt } from "../types";
import { host } from "../host";
import { t } from "../i18n";
import { tutorReply, type TutorDraft, type TutorReply } from "./tutor-verbs";

type Pending = { id?: string; draft: TutorDraft; question: string; surface: "curtain" | "bubble"; settle: (reply: TutorReply | undefined) => void };

export interface LiveTutor {
  send(draft: TutorDraft, question: string, surface?: "curtain" | "bubble"): Promise<TutorReply | undefined>;
  owner: string | null;
  status?: TutorReceipt;
  reply?: TutorReply;
  problem: string;
}

export function useLiveTutor(id: string, enabled: boolean, refresh: () => void, receive: (reply: TutorReply) => Promise<void>): LiveTutor | undefined {
  const supported = !!window.desktop?.tutorBridge && !!window.desktop.onTutor && enabled;
  const lease = useRef<string>(undefined), pending = useRef<Pending>(undefined);
  const [status, setStatus] = useState<TutorReceipt>(), [owner, setOwner] = useState<string | null>(null);
  const [reply, setReply] = useState<TutorReply>(), [problem, setProblem] = useState("");
  const onRefresh = useEffectEvent(refresh), onReply = useEffectEvent(receive);
  useEffect(() => {
    const bridge = host.tutorBridge;
    if (!supported || !bridge) return;
    const active = crypto.randomUUID();
    lease.current = active;
    const settle = (value: TutorReply | undefined) => { const ask = pending.current; pending.current = undefined; ask?.settle(value); };
    const remove = host.onTutor!(event => {
      if (event.lease !== active) return;
      if (event.type === "refresh") { onRefresh(); return; }
      if (event.type === "agent") { setOwner(event.owner); return; }
      const ask = pending.current;
      if (!ask || ask.id && event.id !== ask.id) return;
      ask.id = event.id;
      if (event.type === "receipt") { setStatus(event.status); return; }
      setStatus(event.type === "reply" ? "done" : undefined);
      if (event.type === "expired") { setProblem(t("Tutor request expired.")); settle(undefined); return; }
      void (async () => {
        try {
          const result = tutorReply(ask.draft, ask.question, event.text);
          await onReply(result);
          if (lease.current === active && ask.surface === "curtain" && result.verb !== "propose") setReply(result);
          settle(result);
        } catch (error) {
          if (lease.current === active) setProblem(t((error as Error).message));
          settle(undefined);
        }
      })();
    });
    void bridge(id, { action: "attach", lease: active }).catch(error => { if (lease.current === active) setProblem(t(error.message)); });
    return () => {
      lease.current = undefined;
      pending.current?.settle(undefined);
      pending.current = undefined;
      remove();
      void bridge(id, { action: "detach", lease: active }).catch(() => {});
    };
  }, [id, supported]);

  async function send(draft: TutorDraft, question: string, surface: "curtain" | "bubble" = "curtain"): Promise<TutorReply | undefined> {
    const bridge = host.tutorBridge, active = lease.current;
    if (!active || !bridge || pending.current) return undefined;
    const { promise, resolve } = Promise.withResolvers<TutorReply | undefined>();
    const ask: Pending = { draft, question, surface, settle: resolve };
    pending.current = ask;
    setStatus("queued"); setReply(undefined); setProblem("");
    try {
      const response = await bridge(id, { action: "submit", lease: active, target: draft.anchor, question, verb: draft.verb,
        ...(draft.context ? { context: draft.context } : {}), ...(surface === "bubble" ? { origin: "bubble" as const } : {}) });
      ask.id = response?.id;
    } catch (error) {
      if (lease.current === active) { ask.settle(undefined); pending.current = undefined; setStatus(undefined); setProblem(t((error as Error).message)); }
    }
    return promise;
  }
  return supported ? { send, owner, status, reply, problem } : undefined;
}
