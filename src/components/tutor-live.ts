import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { TutorReceipt } from "../types";
import { host } from "../host";
import { t } from "../i18n";
import { tutorReply, type TutorDraft, type TutorReply } from "./tutor-verbs";

type Pending = { id?: string; draft: TutorDraft; question: string };

export function useLiveTutor(id: string, enabled: boolean, refresh: () => void, receive: (reply: TutorReply) => Promise<void>) {
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
    const remove = host.onTutor!(event => {
      if (event.lease !== active) return;
      if (event.type === "refresh") { onRefresh(); return; }
      if (event.type === "agent") { setOwner(event.owner); return; }
      const ask = pending.current;
      if (!ask || ask.id && event.id !== ask.id) return;
      ask.id = event.id;
      if (event.type === "receipt") { setStatus(event.status); return; }
      pending.current = undefined;
      setStatus(event.type === "reply" ? "done" : undefined);
      if (event.type === "expired") { setProblem(t("Tutor request expired.")); return; }
      void (async () => {
        try {
          const result = tutorReply(ask.draft, ask.question, event.text);
          await onReply(result);
          if (lease.current === active && result.verb !== "propose") setReply(result);
        } catch (error) { if (lease.current === active) setProblem(t((error as Error).message)); }
      })();
    });
    void bridge(id, { action: "attach", lease: active }).catch(error => { if (lease.current === active) setProblem(t(error.message)); });
    return () => {
      lease.current = undefined; pending.current = undefined; remove();
      void bridge(id, { action: "detach", lease: active }).catch(() => {});
    };
  }, [id, supported]);

  async function send(draft: TutorDraft, question: string) {
    const bridge = host.tutorBridge, active = lease.current;
    if (!active || !bridge || pending.current) return false;
    const ask: Pending = { draft, question };
    pending.current = ask;
    setStatus("queued"); setReply(undefined); setProblem("");
    try {
      const response = await bridge(id, { action: "submit", lease: active, target: draft.anchor, question, verb: draft.verb });
      ask.id = response?.id;
      return lease.current === active;
    } catch (error) {
      if (lease.current === active) { pending.current = undefined; setStatus(undefined); setProblem(t((error as Error).message)); }
      return false;
    }
  }
  return supported ? { send, owner, status, reply, problem } : undefined;
}

export type LiveTutor = NonNullable<ReturnType<typeof useLiveTutor>>;
