import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookMarked, ChevronDown, ExternalLink, ListChecks, Sparkles, Trash2 } from "lucide-react";
import { findIdentifiers } from "../../shared/bubble-context.mjs";
import type { CardKind } from "../../shared/glass-cards.mjs";
import { anchorOf, nearestBlock } from "../glass/glass-model";
import type { GlassBlock } from "../glass/anchor-map";
import { newCardId, cardBlock, type GlassCard } from "../glass/card-model";
import { renderPayload } from "./payload-controls";
import { Dialog } from "./Dialog";
import type { LiveTutor } from "./tutor-live";
import { t } from "../i18n";

interface Place { x: number; y: number; width: number }
interface StaticState { status: "ok" | "empty" | "section-missing" | "missing" | "invalid" | "error"; markdown?: string; target?: string | null; section?: string | null; message?: string }

const kindLabel = (kind: CardKind) => kind === "ai" ? t("AI") : kind === "menu" ? t("Menu") : t("Section");
const KindIcon = ({ kind, size = 14 }: { kind: CardKind; size?: number }) =>
  kind === "ai" ? <Sparkles size={size} aria-hidden="true" /> : kind === "menu" ? <ListChecks size={size} aria-hidden="true" /> : <BookMarked size={size} aria-hidden="true" />;

function brokenText(state: StaticState) {
  if (state.status === "missing") return t("Note not found: {{name}}", { name: state.target });
  if (state.status === "section-missing") return t("Section not found: {{name}}", { name: state.section });
  if (state.status === "invalid") return t("This link is not a note or section link.");
  if (state.status === "empty") return t("That section is empty.");
  if (state.status === "error") return state.message || t("The linked note could not be read.");
  return "";
}

// G9: a card is one pill in the margin; unfolding stays on the glass and never reflows the page.
// The wrapper stays mounted across fold/unfold, so keyboard focus survives; the body's state only exists while open.
function GlassCardView({ card, place, note, live, onToggle, onCached, onDelete, onMerge }: {
  card: GlassCard; place: Place; note: string; live?: LiveTutor;
  onToggle(): void; onCached(answer: string, answerAt: string): void; onDelete(): void; onMerge(): void;
}) {
  return <div className="glass-card" data-card={card.id} data-card-kind={card.card} data-card-layer="ai-cards"
    data-folded={card.folded || undefined} style={{ left: `${place.x}px`, top: `${place.y}px`, width: `${place.width}px` }}
    tabIndex={0} aria-label={t("{{kind}} card: {{title}}", { kind: kindLabel(card.card), title: card.title })}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement, typing = !!target.closest("input, textarea, select, [contenteditable='true']");
      if (event.key === "Escape" && !card.folded) { event.preventDefault(); event.stopPropagation(); onToggle(); return; }
      if (!typing && (event.key === "f" || event.key === "F")) { event.preventDefault(); onToggle(); return; }
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(); }
      else if (!typing && (event.key === "Delete" || event.key === "Backspace")) { event.preventDefault(); onDelete(); }
    }}>
    <button type="button" className="glass-card-pill" data-card-pill aria-expanded={!card.folded}
      title={card.title} onClick={onToggle}>
      <KindIcon kind={card.card} />
      <span className="glass-card-title">{card.title}</span>
      <small className="glass-card-kind">{kindLabel(card.card)}</small>
      <ChevronDown size={12} className="glass-card-chevron" aria-hidden="true" />
    </button>
    {!card.folded && <CardBody card={card} note={note} live={live} onCached={onCached} onDelete={onDelete} />}
  </div>;
}

// Card callbacks only close over the card id, so a fold or cache patch must not re-render the other pills.
export default memo(GlassCardView, (previous, next) =>
  previous.card === next.card && previous.note === next.note && previous.live === next.live
  && previous.place.x === next.place.x && previous.place.y === next.place.y && previous.place.width === next.place.width);

function CardBody({ card, note, live, onCached, onDelete }: {
  card: GlassCard; note: string; live?: LiveTutor; onCached(answer: string, answerAt: string): void; onDelete(): void;
}) {
  const [staticState, setStaticState] = useState<StaticState>({ status: "ok" });
  const [choice, setChoice] = useState<number>();
  const [asking, setAsking] = useState(false), [error, setError] = useState(""), [page, setPage] = useState("");
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const block = cardBlock(card);
  const flags = useMemo(() => card.card === "ai" ? findIdentifiers(`${card.question}\n${block?.block ?? ""}`, { limit: 6 }) : [], [card.card, card.question, block?.block]);
  const blocked = flags.filter(flag => !confirmed.has(flag.signature));
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const resolve = useCallback(async () => {
    const api = window.desktop?.glass;
    if (!api || !note) return;
    try {
      const reply = await api({ action: "card", mode: "resolve", note, magnet: card.id });
      if (!reply?.ok) { if (mounted.current) setStaticState({ status: "error", message: reply?.error ?? "" }); return; }
      const value = reply.value as StaticState;
      if (!mounted.current) return;
      setStaticState(previous => previous.markdown === value.markdown && previous.status === value.status
        && previous.target === value.target && previous.section === value.section ? previous : value);
    } catch (failure) {
      if (mounted.current) setStaticState({ status: "error", message: failure instanceof Error ? failure.message : String(failure) });
    }
  }, [card.id, note]);

  // The source section can change in another app; an open static card asks again on focus and on a slow timer.
  useEffect(() => {
    if (card.card !== "static") return;
    void resolve();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void resolve(); }, 1500);
    const focus = () => void resolve();
    window.addEventListener("focus", focus);
    return () => { clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [card.card, resolve]);

  async function ask() {
    if (!live || asking || !card.question.trim() || blocked.length) return;
    setAsking(true); setError("");
    const reply = await live.send({ anchor: { block: block?.block ?? "", quote: (block?.block ?? "").slice(0, 240),
      line: block?.line ?? 0, headings: block?.headings ?? [] }, verb: "answer", context: undefined }, card.question, "bubble");
    if (!mounted.current) return;
    if (reply) onCached(reply.body, new Date().toISOString());
    else setError(t("No agent replied. The cached answer stays."));
    setAsking(false);
  }

  async function openPage() {
    const api = window.desktop?.glass;
    if (!api || !note) return;
    setError("");
    try {
      const reply = await api({ action: "card", mode: "page", note, magnet: card.id });
      if (!reply?.ok) { setError(reply?.error ?? t("Could not write the page.")); return; }
      const value = reply.value as { path?: string };
      setPage(value.path ?? "");
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }

  const answer = card.answer.trim();
  return <section className="glass-card-panel" data-card-panel>
    <header className="glass-card-head">
      <span className="glass-card-heading"><KindIcon kind={card.card} size={13} />{card.card === "ai" ? t("AI cue") : card.title}</span>
      <div className="glass-card-actions">
        <button type="button" data-card-open-page title={t("Open as its own note")} onClick={() => void openPage()}>
          <ExternalLink size={13} aria-hidden="true" /><span>{t("Open as page")}</span>
        </button>
        <button type="button" data-card-delete aria-label={t("Move card to trash")} title={t("Move to trash")} onClick={onDelete}>
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
    </header>
    {card.card === "static" && <>
      <p className="glass-card-source" data-card-source>{card.link || t("No link")}</p>
      {staticState.status === "ok"
        ? <div className="payload-result" data-card-content dangerouslySetInnerHTML={{ __html: renderPayload(staticState.markdown ?? "") }} />
        : <p className="glass-card-broken" role="status" data-card-broken>{brokenText(staticState)}</p>}
    </>}
    {card.card === "ai" && <>
      <p className="glass-card-question" data-card-question>{card.question}</p>
      {answer
        ? <div className="payload-result" data-card-answer dangerouslySetInnerHTML={{ __html: renderPayload(card.answer) }} />
        : <p className="glass-card-empty" data-card-empty>{t("No cached answer yet.")}</p>}
      {flags.length > 0 && <div className="glass-card-flags" role="alert">
        <p>{t("Identifiers found; confirm before sending")}:</p>
        <ul>{flags.map(flag => <li key={flag.signature}>
          <code title={flag.value}>{flag.value}</code>
          <label><input type="checkbox" checked={confirmed.has(flag.signature)} onChange={event => setConfirmed(values => {
            const next = new Set(values);
            if (event.target.checked) next.add(flag.signature); else next.delete(flag.signature);
            return next;
          })} />{t("Not identifying")}</label>
        </li>)}</ul>
      </div>}
      <div className="glass-card-foot">
        <button type="button" className="glass-card-ask" data-card-ask disabled={!live || asking || blocked.length > 0 || !card.question.trim()}
          onClick={() => void ask()}>{asking ? t("Waiting for the agent…") : answer ? t("Regenerate") : t("Ask Tutor")}</button>
        <span className="glass-card-cache" data-card-cache>{live ? t("Cached after one ask") : t("Tutor offline: the cached answer stays")}</span>
      </div>
    </>}
    {card.card === "menu" && <div className="glass-card-menu" data-card-menu>
      {card.choices.map((item, index) => <div key={`${item.label}:${index}`} className="glass-card-choice" data-card-choice={index}>
        <button type="button" aria-expanded={choice === index} onClick={() => setChoice(current => current === index ? undefined : index)}>
          <span>{item.label}</span><ChevronDown size={12} aria-hidden="true" />
        </button>
        {choice === index && <div className="payload-result" data-card-choice-body dangerouslySetInnerHTML={{ __html: renderPayload(item.body || item.label) }} />}
      </div>)}
    </div>}
    {page && <p className="glass-card-page" role="status" data-card-page>{t("Saved as {{path}}", { path: page })}</p>}
    {error && <p className="glass-card-error" role="alert">{error}</p>}
  </section>;
}

// Creation stays explicit: one dialog for the three kinds, anchored to the paragraph under the first visible block.
export function NewCardDialog({ blocks, point, close, create }: {
  blocks: GlassBlock[]; point: { x: number; y: number };
  close(): void; create(card: GlassCard): void;
}) {
  const [kind, setKind] = useState<CardKind>("static");
  const [title, setTitle] = useState(""), [link, setLink] = useState(""), [question, setQuestion] = useState("");
  const [choiceText, setChoiceText] = useState("");
  const anchorBlock = nearestBlock(blocks, point) ?? blocks[0];
  const choices = choiceText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const at = line.indexOf("|");
    return at < 0 ? { label: line, body: "" } : { label: line.slice(0, at).trim(), body: line.slice(at + 1).trim() };
  }).filter(choice => choice.label);
  const valid = kind === "static" ? !!link.trim() : kind === "ai" ? !!question.trim() : choices.length > 0;

  function submit(event: { preventDefault(): void }) {
    event.preventDefault();
    if (!valid || !anchorBlock) return;
    create({
      id: newCardId(), card: kind, title: title.trim(),
      link: kind === "static" ? link.trim() : "", question: kind === "ai" ? question.trim() : "",
      answer: "", answerAt: "", choices: kind === "menu" ? choices : [],
      anchor: anchorOf(anchorBlock), x: 0, y: 0, w: 300, folded: false,
    });
    close();
  }

  return <Dialog title={t("New card")} close={close}>
    <form className="glass-card-new" data-card-new onSubmit={submit}>
      <div className="glass-card-kinds" role="group" aria-label={t("Card kind")}>
        {(["static", "ai", "menu"] as const).map(value => <button type="button" key={value} data-card-new-kind={value}
          aria-pressed={kind === value} onClick={() => setKind(value)}><KindIcon kind={value} /><span>{kindLabel(value)}</span></button>)}
      </div>
      <label>{t("Title")}<input value={title} maxLength={200} placeholder={t("Shown in the margin")}
        onChange={event => setTitle(event.target.value)} data-card-new-title /></label>
      {kind === "static" && <label>{t("Link")}<input value={link} maxLength={2048} placeholder="[[Note#Section]]"
        onChange={event => setLink(event.target.value)} data-card-new-link required /></label>}
      {kind === "ai" && <label>{t("Question")}<textarea value={question} maxLength={4000} rows={2} placeholder={t("Ask one thing; the answer is cached")}
        onChange={event => setQuestion(event.target.value)} data-card-new-question required /></label>}
      {kind === "menu" && <label>{t("Choices, one per line as Label | content")}<textarea value={choiceText} rows={4}
        placeholder={t("What is kerma? | Energy released per unit mass")}
        onChange={event => setChoiceText(event.target.value)} data-card-new-choices required /></label>}
      <p className="glass-card-note">{t("Anchor: {{block}}", { block: (anchorBlock?.block ?? t("the first paragraph")).slice(0, 90) })}</p>
      <div className="glass-card-new-actions">
        <button type="button" onClick={close}>{t("Cancel")}</button>
        <button type="submit" className="primary-button" data-card-new-submit disabled={!valid || !anchorBlock}>{t("Add card")}</button>
      </div>
    </form>
  </Dialog>;
}
