import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, computePosition, flip, offset, shift, type Placement } from "@floating-ui/dom";
import type { EditorHandle } from "../editor/MarkdownEditor";
import type { ReadingTarget } from "../../shared/reading-store.ts";
import { bubbleBundle, bubblePayload, findIdentifiers, payloadText, type BubbleBundle } from "../../shared/bubble-context.mjs";
import { markdownElements, type PageElement } from "../../shared/element-model.mjs";
import { captureAnchor, liveBlocks, resolveAnchor, type GlassAnchor } from "../glass/anchor-map";
import { anchorFrom } from "../glass/glass-state";
import type { GlassMagnet } from "../glass/glass-model";
import { elementNode } from "../glass/element-node";
import { elementKindName } from "../glass/element-label";
import { Mic, Square } from "lucide-react";
import { transcribeCapture, VoiceRecorder, voiceInfo } from "../voice/voice-client";
import { t } from "../i18n";
import { renderPayload } from "./payload-controls";
import type { LiveTutor } from "./tutor-live";
import type { TutorReply } from "./tutor-verbs";
import "./bubble.css";

// G5: a comment bubble is a magnet on the glass. The bubble is the request surface;
// the Tutor bridge is the only channel and nothing leaves before an explicit Send.
interface Entry { role: "you" | "agent"; text: string; at: string }
interface Bubble {
  id: string; element: string; elementKind: string; line: number; headings: string[]; text: string; thread: Entry[]; anchor: GlassAnchor;
  selection?: string; marked: boolean;
}
interface Shown { bubble: Bubble; bundle: BubbleBundle; node: HTMLElement; order: number }

const maxEntries = 100, maxQuestion = 1000;
const roles = new Set(["you", "agent"]);

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === "string") ? value as string[] : undefined;
}

function threadOf(value: unknown): Entry[] | undefined {
  if (!Array.isArray(value) || value.length > maxEntries) return;
  const entries: Entry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return;
    const entry = item as Record<string, unknown>;
    if (typeof entry.role !== "string" || !roles.has(entry.role) || typeof entry.text !== "string" || !entry.text.trim()) return;
    entries.push({ role: entry.role as Entry["role"], text: entry.text, at: typeof entry.at === "string" ? entry.at : "" });
  }
  return entries;
}

function bubbleFrom(magnet: GlassMagnet): Bubble | undefined {
  const { fields } = magnet, anchor = anchorFrom(fields.anchor);
  if (magnet.kind !== "comment" || typeof fields.element !== "string" || typeof fields.elementKind !== "string" ||
      typeof fields.line !== "number" || !Number.isFinite(fields.line)) return;
  const headings = strings(fields.headings), thread = threadOf(fields.thread);
  if (!headings || !thread || !anchor) return;
  return { id: magnet.id, element: fields.element, elementKind: fields.elementKind, line: fields.line,
    headings, text: typeof fields.text === "string" ? fields.text : "", thread, anchor,
    marked: fields.marked === true,
    ...(typeof fields.selection === "string" && fields.selection ? { selection: fields.selection } : {}) };
}

// One positioner per bubble part: Floating UI follows scroll, resize and reflow.
function Anchored({ node, placement, gap, along = 0, children }: { node: HTMLElement; placement: Placement; gap: number; along?: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const floating = box.current;
    if (!floating || !node.isConnected) return;
    const update = () => {
      void computePosition(node, floating, { placement, strategy: "absolute", middleware: [offset({ mainAxis: gap, crossAxis: along }), flip({ padding: 8 }), shift({ padding: 8 })] })
        .then(({ x, y }) => {
          if (!floating.isConnected) return;
          // Clipping ancestors can be wider than the window (narrow layouts), so clamp to the visible edge.
          const frame = (floating.offsetParent as HTMLElement | null)?.getBoundingClientRect();
          const left = frame?.left ?? 0, least = 8 - left, most = window.innerWidth - 8 - left - floating.offsetWidth;
          floating.style.left = `${most >= least ? Math.min(Math.max(x, least), most) : least}px`;
          const top = frame?.top ?? 0, highest = 8 - top, lowest = window.innerHeight - 8 - top - floating.offsetHeight;
          floating.style.top = `${lowest >= highest ? Math.min(Math.max(y, highest), lowest) : highest}px`;
        });
    };
    return autoUpdate(node, floating, update);
  }, [node, placement, gap, along]);
  return <div className="bubble-anchor" ref={box}>{children}</div>;
}

export default function BubbleLayer({ root, editor, note, live, pin, magnets, reload, exam = false, reveal }: {
  root: HTMLElement; editor(): EditorHandle | undefined; note: string; live?: LiveTutor; pin(reply: TutorReply): Promise<boolean>;
  magnets: GlassMagnet[]; reload(): Promise<void> | undefined; exam?: boolean; reveal?(id: string): void;
}) {
  const scroller = root.parentElement!;
  const cache = useRef<{ text: string; elements: PageElement[] } | undefined>(undefined);
  const saved = useMemo(() => magnets.flatMap(magnet => bubbleFrom(magnet) ?? []), [magnets]);
  const [draft, setDraft] = useState<Bubble>();
  const [openId, setOpenId] = useState<string>(), [question, setQuestion] = useState(""), [sentText, setSentText] = useState("");
  const [xray, setXray] = useState(false), [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [asking, setAsking] = useState(false), [error, setError] = useState(""), [pinned, setPinned] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  const frame = useRef(0), textarea = useRef<HTMLTextAreaElement>(null);
  // G21: speaking into the bubble only fills the question; Send still needs the X-ray pass.
  const recorder = useRef<VoiceRecorder | undefined>(undefined);
  const [mic, setMic] = useState<"idle" | "recording" | "transcribing">("idle");
  const [voiceReady, setVoiceReady] = useState(false);
  const [voiceLanguage, setVoiceLanguage] = useState("auto");

  useEffect(() => {
    let live = true;
    void voiceInfo().then(info => {
      if (!live) return;
      setVoiceReady(info.configured);
      setVoiceLanguage(info.language);
    });
    return () => { live = false; };
  }, []);

  useEffect(() => () => { recorder.current?.cancel(); recorder.current = undefined; }, []);

  async function dictate() {
    if (mic === "recording") {
      const capture = recorder.current;
      if (!capture) return;
      setMic("transcribing");
      try {
        const part = await capture.stop();
        const result = await transcribeCapture(part.wav, { mode: "ask", language: voiceLanguage });
        if (!result.ok || !result.text) setError(result.message ?? t("No speech was heard."));
        else setQuestion(current => (current.trim() ? `${current.trim()} ${result.text}` : result.text!).slice(0, maxQuestion));
      } catch (failure) { setError((failure as Error).message); }
      finally { recorder.current = undefined; setMic("idle"); }
      return;
    }
    if (mic !== "idle") return;
    const capture = new VoiceRecorder();
    try { await capture.start(); }
    catch (failure) { setError((failure as Error).message); return; }
    recorder.current = capture;
    setError("");
    setMic("recording");
  }

  useEffect(() => {
    if (!exam) return;
    setOpenId(undefined);
    setDraft(undefined);
  }, [exam]);

  function model() {
    const text = editor()?.readingContext()?.text;
    if (text === undefined) return cache.current?.elements ?? [];
    if (cache.current?.text === text) return cache.current.elements;
    cache.current = { text, elements: markdownElements(text) };
    return cache.current.elements;
  }

  async function store(bubble: Bubble, create = false) {
    if (!note || !window.desktop?.glass) throw new Error(t("Glass storage is unavailable."));
    const fields = { kind: "comment", text: bubble.text, element: bubble.element, elementKind: bubble.elementKind,
      line: bubble.line, headings: bubble.headings, thread: bubble.thread, marked: bubble.marked,
      ...(bubble.selection ? { selection: bubble.selection } : {}) };
    const response = await window.desktop.glass({ action: "add", note, magnet: bubble.id, ...(create ? { anchor: bubble.anchor } : {}), fields });
    if (!response?.ok) throw new Error(response?.error || t("The bubble could not be saved."));
    await reload();
  }

  function open(bubble: Bubble, text: string) {
    setOpenId(bubble.id);
    setQuestion(bubble.thread.filter(entry => entry.role === "you").at(-1)?.text ?? "");
    setSentText(text); setXray(false); setConfirmed(new Set()); setError(""); setAsking(false);
  }

  // Typed words are never lost: closing without Send keeps them as a plain comment.
  async function flush() {
    const target = draft;
    const said = question.trim();
    if (!target || !said) return;
    const entry: Entry = { role: "you", text: said, at: new Date().toISOString() };
    const bubble: Bubble = { ...target, text: said, thread: [...target.thread, entry] };
    try { await store(bubble, !saved.some(item => item.id === bubble.id)); setDraft(undefined); }
    catch { /* the draft stays in memory */ }
  }

  async function close() {
    if (openId === draft?.id) await flush();
    recorder.current?.cancel();
    recorder.current = undefined;
    setMic("idle");
    setOpenId(undefined); setError("");
  }

  const start = useEffectEvent((detail: { id?: string; line?: number; kind?: string; quote?: string }) => {
    window.dispatchEvent(new CustomEvent("omarkie:element-dismiss"));
    const context = editor()?.readingContext();
    if (!context) return;
    const elements = model();
    const element = (detail.id ? elements.find(item => item.id === detail.id) : undefined) ??
      (detail.line !== undefined ? elements.find(item => item.line === detail.line && (!detail.kind || item.kind === detail.kind)) : undefined) ??
      (detail.line !== undefined ? elements.find(item => item.line === detail.line) : undefined);
    if (!element) return;
    const blocks = liveBlocks(context, root);
    const block = blocks.find(item => item.line === element.blockLine || item.line === element.line);
    const anchor = (block ? captureAnchor(block, blocks) : element.landmarks) as GlassAnchor;
    const quote = detail.quote ?? (typeof window.getSelection()?.toString === "function" ? window.getSelection()!.toString() : "");
    const bundle = bubbleBundle(elements, element, { note: note ?? "", quote });
    if (!bundle) return;
    const bubble: Bubble = { id: `b-${crypto.randomUUID()}`, element: element.id, elementKind: element.kind, line: element.line,
      headings: bundle.headings, text: "", thread: [], anchor, marked: false, ...(quote.trim() ? { selection: bundle.quote } : {}) };
    setDraft(bubble);
    open(bubble, bundle.text);
    requestAnimationFrame(() => textarea.current?.focus());
  });

  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.action === "comment") start(detail);
    };
    const onRequest = (event: Event) => start((event as CustomEvent).detail ?? {});
    // Undoing a circle gesture closes the bubble draft it opened; nothing is stored.
    const onCancel = () => { setDraft(undefined); setOpenId(undefined); setQuestion(""); setError(""); };
    window.addEventListener("omarkie:element-action", onAction);
    window.addEventListener("omarkie:comment-request", onRequest);
    window.addEventListener("omarkie:comment-cancel", onCancel);
    return () => {
      window.removeEventListener("omarkie:element-action", onAction);
      window.removeEventListener("omarkie:comment-request", onRequest);
      window.removeEventListener("omarkie:comment-cancel", onCancel);
    };
  }, []);
  const hasBubbles = !!draft || saved.length > 0;

  useEffect(() => {
    if (!hasBubbles) return;
    const schedule = () => { if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; setTick(value => value + 1); }); };
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-line"] });
    const sizes = new ResizeObserver(schedule);
    sizes.observe(scroller); sizes.observe(root);
    return () => {
      if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
      observer.disconnect(); sizes.disconnect();
    };
  }, [hasBubbles, root, scroller]);

  useEffect(() => {
    if (!openId) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.stopPropagation();
      void close();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [openId, draft, question, saved]);

  const bubbles = draft ? [...saved.filter(item => item.id !== draft.id), draft] : saved;
  const context = bubbles.length ? editor()?.readingContext() : undefined;
  const elements = context ? model() : [];
  const blocks = context ? liveBlocks(context, root) : [];
  const shown: Shown[] = [];
  for (const bubble of bubbles) {
    const resolution = resolveAnchor(bubble.anchor, blocks);
    if (resolution.line === null) continue;
    const line = resolution.line;
    const element = elements.find(item => item.id === bubble.element && (item.line === line || item.blockLine === line)) ??
      elements.find(item => item.line === line && item.kind === bubble.elementKind) ?? elements.find(item => item.line === line);
    if (!element) continue;
    const node = elementNode(root, element, elements);
    const bundle = bubbleBundle(elements, element, { note: note ?? "", quote: bubble.selection });
    if (!node || !bundle) continue;
    const order = shown.filter(item => item.node === node).length;
    shown.push({ bubble, bundle, node, order });
  }

  const current = shown.find(item => item.bubble.id === openId);
  // The quote is what the user sends: a selected range, or the editable text once redacted.
  const quote = current?.bubble.selection ?? sentText.trim().slice(0, 240);
  const payload = current ? { ...bubblePayload(current.bundle, question, sentText)!, quote } : undefined;
  // Flag every string the bridge receives, not only the editable text: neighbours and headings count too.
  const flags = findIdentifiers(payloadText(payload), { limit: Infinity });
  const blocked = flags.filter(flag => !confirmed.has(flag.signature));

  async function send(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!current || !payload || !live || asking) return;
    const asked = payload.question;
    if (!asked || !payload.text.trim()) return;
    if (blocked.length) { setXray(true); setError(t("Remove or confirm the flagged identifiers before sending.")); return; }
    const target: ReadingTarget = { block: payload.text, quote: payload.quote, line: payload.line, headings: payload.headings };
    const asked_at = new Date().toISOString();
    const mine: Entry = { role: "you", text: asked, at: asked_at };
    const bubble: Bubble = { ...current.bubble, text: asked, thread: [...current.bubble.thread, mine] };
    setError(""); setAsking(true);
    try {
      await store(bubble, !saved.some(item => item.id === bubble.id));
      setDraft(undefined);
      const reply = await live.send({ anchor: target, verb: "answer", context: payload.neighbours }, asked, "bubble");
      if (!reply) { setError(t("The agent did not reply. Your question is saved in the bubble.")); return; }
      const answer: Entry = { role: "agent", text: reply.body, at: new Date().toISOString() };
      await store({ ...bubble, thread: [...bubble.thread, answer].slice(-maxEntries) });
      setQuestion("");
      setXray(false);
    } catch (failure) { setError(t((failure as Error).message)); }
    finally { setAsking(false); }
  }

  async function comment(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!current) return;
    const said = question.trim();
    if (!said) return;
    const next: Entry = { role: "you", text: said, at: new Date().toISOString() };
    const bubble: Bubble = { ...current.bubble, text: said, thread: [...current.bubble.thread, next] };
    setError("");
    try {
      await store(bubble, !saved.some(item => item.id === bubble.id));
      setDraft(undefined); setQuestion(""); setXray(false);
    } catch (failure) { setError(t((failure as Error).message)); }
  }

  async function card(entry: Entry, index: number) {
    if (!current) return;
    const target: ReadingTarget = { block: current.bundle.text, quote: current.bundle.quote, line: current.bubble.line, headings: current.bubble.headings };
    let previous = index - 1;
    while (previous >= 0 && current.bubble.thread[previous]?.role !== "you") previous -= 1;
    const asked = current.bubble.thread[previous]?.text ?? "";
    const reply: TutorReply = { id: `${current.bubble.id}:${index}`, anchor: target, verb: "answer", body: entry.text, question: asked };
    if (await pin(reply)) setPinned(values => new Set(values).add(reply.id));
  }

  return createPortal(<div className="bubble-layer" data-bubble-layer="on" data-glass-layer="comments" data-bubble-tick={tick}>
    {shown.map(({ bubble, bundle, node, order }) => <div key={bubble.id}>
      <Anchored node={node} placement="right-start" gap={6} along={order * 26}>
        <button type="button" className="bubble-chip" data-bubble={bubble.id} data-bubble-state={bubble.thread.length ? "thread" : "empty"}
          aria-label={t("Comment bubble")} aria-expanded={openId === bubble.id}
          onClick={() => {
            if (exam) { reveal?.(bubble.id); return; }
            if (openId === bubble.id) { void close(); return; }
            window.dispatchEvent(new CustomEvent("omarkie:element-dismiss"));
            void flush().then(() => open(bubble, bundle.text));
          }}>
          {t("Comment")}{bubble.thread.length ? <small>{bubble.thread.length}</small> : null}
        </button>
      </Anchored>
      {openId === bubble.id && <Anchored node={node} placement="bottom-start" gap={8}>
        <article className="glass-bubble" role="dialog" aria-label={t("Comment bubble")} data-bubble-panel={bubble.id}>
          <header className="bubble-head">
            <span className="bubble-kind">{t(elementKindName(bubble.elementKind))}</span>
            <span className="bubble-path">{bundle.headings.join(" › ") || t("No heading")}</span>
            <button type="button" className="bubble-mark" data-bubble-mark aria-pressed={bubble.marked}
              title={bubble.marked ? t("Marked for exam") : t("Mark for exam")}
              onClick={() => void store({ ...bubble, marked: !bubble.marked }).catch(failure => setError(failure.message))}>★</button>
            <button type="button" className="bubble-close" aria-label={t("Close comment")} onClick={() => void close()}>×</button>
          </header>
          <details className="bubble-context" data-bubble-context={bubble.element}>
            <summary>{t("Context bundle")}</summary>
            <p className="bubble-quote">{bundle.quote}</p>
            {bundle.neighbours.before && <p className="bubble-neighbour"><strong>{t("Before")}</strong>{bundle.neighbours.before}</p>}
            {bundle.neighbours.after && <p className="bubble-neighbour"><strong>{t("After")}</strong>{bundle.neighbours.after}</p>}
            {bundle.images.length > 0 && <p className="bubble-images">{t("Images")}: {bundle.images.join(", ")}</p>}
          </details>
          {bubble.thread.length > 0 && <ol className="bubble-thread">
            {bubble.thread.map((entry, index) => <li key={`${entry.at}:${index}`} data-bubble-role={entry.role}>
              {entry.role === "agent"
                ? <div className="payload-result" dangerouslySetInnerHTML={{ __html: renderPayload(entry.text) }} />
                : <p>{entry.text}</p>}
              {entry.role === "agent" && <button type="button" className="bubble-pin"
                disabled={pinned.has(`${bubble.id}:${index}`)} onClick={() => void card(entry, index)}>
                {pinned.has(`${bubble.id}:${index}`) ? t("Pinned as card") : t("Pin as cue card")}
              </button>}
            </li>)}
          </ol>}
          <form className="bubble-form" onSubmit={event => void (live ? send(event) : comment(event))}>
            <label className="bubble-question">{t("Question")}
              <textarea ref={textarea} value={question} maxLength={maxQuestion} rows={2} onChange={event => setQuestion(event.target.value)}
                placeholder={t("Ask one thing about this element")} />
            </label>
            <div className="bubble-actions">
              {voiceReady && <button type="button" className="bubble-mic" data-bubble-mic={mic} aria-pressed={mic === "recording"}
                aria-label={mic === "recording" ? t("Stop dictation") : t("Dictate the question")}
                title={mic === "recording" ? t("Stop and transcribe") : t("Speak the question; the transcript stays local")}
                disabled={mic === "transcribing" || asking} onClick={() => void dictate()}>
                {mic === "recording" ? <Square size={11} /> : <Mic size={12} />}
              </button>}
              <button type="button" className="bubble-xray-toggle" aria-expanded={xray} onClick={() => setXray(value => !value)}>{t("X-ray preview")}</button>
              {live
                ? <button type="submit" className="primary-button" data-bubble-send disabled={asking || blocked.length > 0 || !question.trim() || !sentText.trim()}>
                  {asking ? t("Waiting for the agent…") : t("Send")}
                </button>
                : <button type="submit" className="primary-button" data-bubble-comment disabled={!question.trim()}>{t("Save comment")}</button>}
            </div>
            {blocked.length > 0 && <p className="bubble-blocked" role="note">{t("Send is blocked until each identifier is removed or confirmed.")}</p>}
            {!live && <p className="bubble-offline">{t("No agent connected: this bubble stays a local comment.")}</p>}
            {error && <p role="alert" className="form-error">{error}</p>}
          </form>
          {xray && <section className="bubble-xray" aria-label={t("X-ray preview")}>
            <h3>{t("What will be sent")}</h3>
            {flags.length > 0 && <div className="bubble-flags" role="alert">
              <p>{t("Identifiers found")}: {flags.length}</p>
              <ul>{flags.map(flag => <li key={flag.signature}>
                <code title={flag.value}>{flag.value}</code>
                <label><input type="checkbox" checked={confirmed.has(flag.signature)} onChange={event => setConfirmed(values => {
                  const next = new Set(values);
                  if (event.target.checked) next.add(flag.signature); else next.delete(flag.signature);
                  return next;
                })} />{t("Not identifying")}</label>
              </li>)}</ul>
            </div>}
            <dl>
              <dt>{t("Note")}</dt><dd>{payload?.document || "—"}</dd>
              <dt>{t("Element")}</dt><dd>{t(elementKindName(bubble.elementKind))} · {t("Line")} {payload?.line}</dd>
              <dt>{t("Heading path")}</dt><dd>{payload?.headings.join(" › ") || t("No heading")}</dd>
              <dt>{t("Before")}</dt><dd>{bundle.neighbours.before || "—"}</dd>
              <dt>{t("After")}</dt><dd>{bundle.neighbours.after || "—"}</dd>
              <dt>{t("Images")}</dt><dd>{bundle.images.length ? `${bundle.images.join(", ")} (${t("names only, bytes stay on this machine")})` : t("None")}</dd>
              <dt>{t("Quote")}</dt><dd data-bubble-quote="">{payload?.quote || "—"}</dd>
            </dl>
            <label className="bubble-text">{t("Text to send (edit to remove identifiers)")}
              <textarea value={sentText} rows={4} onChange={event => setSentText(event.target.value)} />
            </label>
          </section>}
        </article>
      </Anchored>}
    </div>)}
  </div>, scroller);
}
