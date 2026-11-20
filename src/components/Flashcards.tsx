import { useEffect, useRef, useState } from "react";
import { cardsPerNote, dueCards, sourceDraft, suggestCards, type CardDraft, type StoredCard } from "../flashcards";
import type { RecallRating } from "../flashcard-schedule";
import type { ReadingEntry, ReadingStore, ReadingTarget } from "../../shared/reading-store.ts";
import { collectReadingItems } from "../../shared/reading-collector.ts";
import { host } from "../host";
import { t } from "../i18n";
import { Dialog } from "./Dialog";
import "./flashcards.css";

export interface FlashcardPanel {
  target?: ReadingTarget;
}

type Draft = CardDraft & { selected: boolean };
type Session = { queue: StoredCard[]; revealed: boolean; rated: number };

function fallback(target: ReadingTarget) {
  const heading = target.headings.at(-1);
  return heading && !heading.includes(target.quote.trim()) ? t("“{{heading}}”这一节的重点是什么？", { heading }) : t("这段选中文字是什么？");
}

export default function Flashcards({ id, content, panel, close }: {
  id: string; content: string; panel: FlashcardPanel;
  close(): void;
}) {
  const [store] = useState<ReadingStore>(() => host.readingStore!);
  const [entries, setEntries] = useState<ReadingEntry[] | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const locked = useRef(false), action = useRef<HTMLButtonElement>(null);
  const selected = drafts?.filter(draft => draft.selected) || [];
  const cards = entries?.filter(entry => entry.type === "card") ?? [];
  const card = session?.queue[0];

  useEffect(() => {
    let current = true;
    void store(id, { action: "list", types: ["card", "note"] }).then(items => {
      if (!current) return;
      setEntries(items);
      if (panel.target && items.filter(item => item.type === "card").length < cardsPerNote) {
        setDrafts([{ ...sourceDraft(panel.target, t("[…]"), fallback(panel.target)), id: crypto.randomUUID(), type: "card", selected: true }]);
      }
    }).catch(error => { if (current) setError((error as Error).message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [id, panel, store]);

  useEffect(() => { if (!busy) action.current?.focus(); }, [busy, card?.id, session?.revealed]);

  async function run(operation: () => void | Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true); setError("");
    try { await operation(); }
    catch (error) { setError((error as Error).message); }
    finally { locked.current = false; setBusy(false); }
  }

  function generate() {
    const candidates = collectReadingItems(content);
    const notes = entries?.filter(entry => entry.type === "note") ?? [];
    const suggestions = suggestCards(cards, candidates.filter(item => item.kind === "highlight").map(item => item.target), notes, t("[…]"), fallback);
    setDrafts(suggestions.map(draft => ({ ...draft, id: crypto.randomUUID(), type: "card", selected: true })));
  }

  async function saveCards() {
    for (const draft of selected) {
      const { id: cardId, type, anchor } = draft;
      const entry = await store(id, { action: "put", item: { id: cardId, type, anchor, front: draft.front.trim(), back: draft.back.trim() } });
      setEntries(items => [...(items ?? []), entry]);
      setDrafts(items => items?.filter(item => item.id !== draft.id) ?? null);
    }
    setDrafts(null);
  }

  async function review() {
    const items = await store(id, { action: "list", scope: "vault", types: ["card", "answer"] });
    setSession({ queue: dueCards(items, Date.now()), revealed: false, rated: 0 });
  }

  async function rate(rating: RecallRating) {
    if (!card || !session?.revealed) return;
    await store(id, { action: "put", item: { type: "answer", id: crypto.randomUUID(), cardId: card.id, rating } });
    const remaining = session.queue.slice(1);
    if (rating < 4) remaining.push(card);
    setSession({ queue: remaining, revealed: false, rated: session.rated + 1 });
  }

  const grades = [t("完全想不起来"), t("错误，看到答案才想起"), t("错误，但答案熟悉"), t("正确，但很费力"), t("正确，略有迟疑"), t("完全正确")];
  return <Dialog title={session ? t("考考我") : t("学习卡片")} close={() => { if (!locked.current) close(); }}>
    <div className="flashcards" aria-busy={loading || busy}>
      {loading && <p role="status">{t("正在读取卡片…")}</p>}
      {error && <p role="alert">{error}</p>}
      {session ? <>
        <p className="dialog-note" role="status">{t("已作答：{{rated}} · 待复习：{{remaining}}", { rated: session.rated, remaining: session.queue.length })}</p>
        {card ? <>
          <article className="recall-card" aria-live="polite">
            <small>{[card.document, ...(card.anchor?.headings ?? [])].join(" › ")}</small>
            <p>{card.front}</p>
            {session.revealed && <div className="recall-back"><small>{t("答案")}</small><p>{card.back}</p></div>}
          </article>
          {session.revealed ? <div className="dialog-actions recall-grades" role="group" aria-label={t("给回忆打分")}>
            {grades.map((grade, index) => <button type="button" key={grade} ref={index === 0 ? action : undefined} disabled={busy}
              onClick={() => void run(() => rate(index as RecallRating))}>{index} · {grade}</button>)}
          </div> : <div className="dialog-actions"><button ref={action} className="primary-button" type="button" onClick={() => setSession({ ...session, revealed: true })}>{t("显示答案")}</button></div>}
        </> : <p role="status">{session.rated ? t("复习完成。") : t("资料库没有到期的新卡或复习卡。")}</p>}
        <div className="dialog-actions"><button type="button" disabled={busy} onClick={() => setSession(null)}>{t("返回卡片")}</button></div>
      </> : drafts ? <form onSubmit={event => { event.preventDefault(); void run(saveCards); }}>
        {drafts.length === 0 && <p role="status">{t("没有可用的新高亮或页边笔记。")}</p>}
        {drafts.length > 0 && <p className="dialog-note">{t("检查并编辑卡片，然后保存选中的卡片。")}</p>}
        {drafts.map((draft, index) => <fieldset key={draft.id} disabled={busy}>
          <legend><label className="checkbox-option"><input type="checkbox" checked={draft.selected} disabled={busy} onChange={event => {
            const checked = event.target.checked;
            setDrafts(current => current!.map(item => item.id === draft.id ? { ...item, selected: checked } : item));
          }} />{t("卡片 {{number}}", { number: index + 1 })}</label></legend>
          {draft.selected && <>
            <label>{t("问题")}<textarea value={draft.front} maxLength={65536} required onChange={event => {
              const front = event.target.value;
              setDrafts(current => current!.map(item => item.id === draft.id ? { ...item, front } : item));
            }} /></label>
            <label>{t("答案")}<textarea value={draft.back} maxLength={65536} required onChange={event => {
              const back = event.target.value;
              setDrafts(current => current!.map(item => item.id === draft.id ? { ...item, back } : item));
            }} /></label>
          </>}
        </fieldset>)}
        <div className="dialog-actions"><button type="button" disabled={busy} onClick={() => setDrafts(null)}>{t("取消")}</button>
          <button type="submit" className="primary-button" disabled={busy || !selected.length || selected.some(draft => !draft.front.trim() || !draft.back.trim())}>{t("保存选中卡片")}</button></div>
      </form> : !loading && entries && <>
        <p className="dialog-note">{t("本笔记卡片：{{total}} / {{limit}}", { total: cards.length, limit: cardsPerNote })}</p>
        {cards.length > 0 && <ul className="flashcard-list">{cards.map(item => <li key={item.id}><details><summary>{item.front}</summary><p>{item.back}</p></details></li>)}</ul>}
        {cards.length >= cardsPerNote && <p>{t("此笔记已达到卡片上限。")}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={busy || cards.length >= cardsPerNote} onClick={() => void run(generate)}>{t("从高亮和笔记生成卡片")}</button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void run(review)}>{t("考考我")}</button>
        </div>
      </>}
    </div>
  </Dialog>;
}
