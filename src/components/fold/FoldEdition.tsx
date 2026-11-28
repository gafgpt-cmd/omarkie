import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Edition, EditionChange, EditionFact, EditionSide } from "../../../shared/fold-edition.mjs";
import { projectAt, squash } from "../../../shared/fold-project.mjs";
import { renderMarkdown } from "../../editor/markdown";
import { renderMath } from "../../editor/math";
import { t } from "../../i18n";
import { diffHtml } from "./edition";
import type { FoldMark } from "./fold-marks";
import { STOPS, type Stop } from "./stops";

/** A note that can stand as the earlier edition: an open document or a vault file. */
export interface EditionSource { key: string; name: string; detail: string }
export interface EditionSources {
  list(): EditionSource[];
  read(key: string): Promise<string | null>;
}
export type EditionStatus = { state: "loading" } | { state: "ready"; edition: Edition } | { state: "error" };

// Rendering one change costs a Markdown pass and a word diff: at most this long per slice, so no frame stalls.
const SLICE_MS = 8;
const PICK_LIMIT = 60;
const SYMBOL = { added: "+", removed: "−", changed: "~" } as const;

function factLabel(fact: EditionFact) {
  switch (fact.class) {
    case "negation": return fact.change === "removed" ? t("Never-do lifted") : t("New never-do");
    case "number": return t("Number");
    case "condition": return t("Condition");
    case "restriction": return t("Restriction");
    case "uncertainty": return t("Certainty");
    case "scope": return t("Scope");
    case "attribution": return t("Source");
  }
}

function Fact({ fact }: { fact: EditionFact }) {
  const what = factLabel(fact);
  const spoken = fact.class === "negation" ? t("{{what}}: {{value}}", { what, value: fact.new ?? fact.old ?? "" })
    : fact.change === "changed" ? t("{{what}}: {{old}} → {{new}}", { what, old: fact.old ?? "", new: fact.new ?? "" })
    : fact.change === "added" ? t("{{what}} added: {{value}}", { what, value: fact.new ?? "" }) : t("{{what}} removed: {{value}}", { what, value: fact.old ?? "" });
  return <li className="fold-edition-fact" data-class={fact.class} data-change={fact.change} aria-label={spoken}>
    <span className="fold-edition-fact-label" aria-hidden="true">{fact.change === "changed" ? "" : SYMBOL[fact.change]}{what}</span>
    {fact.old !== null && <del aria-hidden="true">{fact.old}</del>}
    {fact.old !== null && fact.new !== null && <span className="fold-edition-arrow" aria-hidden="true">→</span>}
    {fact.new !== null && <ins aria-hidden="true">{fact.new}</ins>}
  </li>;
}

interface CardProps {
  change: EditionChange; index: number; section: string; html: string | undefined; stale: boolean; open: boolean;
  phase: Stop; marks: number; toggle(index: number): void; reveal?(index: number): void;
}

const Card = memo(function Card({ change, index, section, html, stale, open, phase, marks, toggle, reveal }: CardProps) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (body.current && html) void renderMath(body.current).catch(() => {}); }, [html]);
  const label = change.kind === "added" ? t("Added") : change.kind === "removed" ? t("Removed") : t("Changed");
  return <article className="fold-edition-card" data-kind={change.kind} data-index={index} data-open={open || undefined} tabIndex={0}
    aria-label={section ? `${label} · ${section}` : label}>
    <header className="fold-edition-card-head">
      <span className="fold-edition-badge" data-kind={change.kind}><span aria-hidden="true">{SYMBOL[change.kind]}</span>{label}</span>
      {marks > 0 && <span className="fold-edition-marks" title={t("Your marks · {{n}}", { n: marks })} aria-label={t("Your marks · {{n}}", { n: marks })}>◆ {marks}</span>}
      <span className="fold-edition-tools">
        <button type="button" tabIndex={-1} aria-pressed={open} title={t("Full") + " · Enter"} onClick={() => toggle(index)}>{t("Full")}</button>
        {reveal && <button type="button" tabIndex={-1} title={t("Open on the page") + " · Shift+Enter"} onClick={() => reveal(index)}>{t("Open on the page")}</button>}
      </span>
    </header>
    {change.facts.length > 0 && <ul className="fold-edition-facts" aria-label={t("What changed")}>
      {change.facts.map((fact, at) => <Fact key={at} fact={fact} />)}
    </ul>}
    {html === undefined ? <div className="fold-edition-body" data-pending="" aria-busy="true" />
      : html && <div ref={body} key={phase} className="rich-document fold-edition-body" data-stale={stale || undefined} dangerouslySetInnerHTML={{ __html: html }} />}
  </article>;
});

/** The reader's marks over the changes with a new side, at one stop: on a card's lines they ride the card; on unchanged text they are orphans. `cards[unit]` is the change index. */
export function projectEdition(edition: Edition, marks: readonly FoldMark[], at: number) {
  const level = STOPS[at], cards: number[] = [], units: EditionSide[] = [];
  edition.changes.forEach((change, index) => { if (change.new) { cards.push(index); units.push(change.new); } });
  return { cards, at: projectAt(units, marks, units.map(side => !!side.stops[level]),
    (mark, unit) => !mark.quote || squash(units[unit].stops[level]).includes(squash(mark.quote))) };
}

/** Changed units only, at the bar's stop: each a card with its kind, its payload facts, and the new text marked against the old. */
export function FoldEdition({ status, name, documentId, stop, marks, reveal, leave }: {
  status: EditionStatus;
  name: string;
  documentId: string;
  stop: Stop;
  marks: readonly FoldMark[];
  reveal(line: number, y: number): void;
  leave(): void;
}) {
  const edition = status.state === "ready" ? status.edition : null;
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const cache = useRef(new Map<string, string>()), settled = useRef(new Map<number, string>());
  const [, setPainted] = useState(0);
  const list = useRef<HTMLDivElement>(null), seen = useRef(new Set<number>());
  useEffect(() => { cache.current.clear(); settled.current.clear(); setOpened(new Set()); }, [edition]);
  const levelOf = (index: number) => opened.has(index) ? "full" : stop;
  const keyOf = (index: number) => `${index}:${levelOf(index)}`;
  // Cards on screen first, the rest in short slices; a card keeps its last text (dimmed) until the new one is ready.
  useEffect(() => {
    if (!edition) return;
    const missing = edition.changes.map((_, index) => index).filter(index => !cache.current.has(keyOf(index)));
    missing.sort((left, right) => Number(seen.current.has(right)) - Number(seen.current.has(left)));
    let timer = 0;
    const slice = () => {
      const begin = performance.now();
      while (missing.length && performance.now() - begin < SLICE_MS) {
        const index = missing.shift()!, change = edition.changes[index], level = levelOf(index);
        const html = change.new && change.old ? diffHtml(change.new.stops[level], change.old.stops[level], documentId)
          : (() => { const text = (change.new ?? change.old)!.stops[level]; return text ? renderMarkdown(text, documentId) : ""; })();
        cache.current.set(keyOf(index), html);
      }
      setPainted(count => count + 1);
      if (missing.length) timer = window.setTimeout(slice, 0);
    };
    slice();
    return () => clearTimeout(timer);
  }, [edition, stop, opened, documentId]);
  useEffect(() => {
    const root = list.current;
    if (!root || !edition) return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.index);
        if (entry.isIntersecting) seen.current.add(index); else seen.current.delete(index);
      }
    }, { root: root.closest(".fold-edition"), rootMargin: "200px 0px" });
    for (const card of root.querySelectorAll(".fold-edition-card")) observer.observe(card);
    return () => observer.disconnect();
  }, [edition]);
  const projection = useMemo(() => edition ? projectEdition(edition, marks, STOPS.indexOf(stop)) : null, [edition, marks, stop]);
  const markCount = useMemo(() => {
    const counts = new Map<number, number>();
    if (!projection) return counts;
    for (const map of [projection.at.own, projection.at.decks, projection.at.words])
      for (const [unit, list] of map) if (unit >= 0) counts.set(projection.cards[unit], (counts.get(projection.cards[unit]) ?? 0) + list.length);
    return counts;
  }, [projection]);
  const toggle = (index: number) => setOpened(current => { const next = new Set(current); if (!next.delete(index)) next.add(index); return next; });
  const revealCard = (index: number) => {
    const side = edition?.changes[index]?.new, card = list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (side && card) reveal(side.line, card.getBoundingClientRect().top);
  };
  const head = <header className="fold-edition-head">
    <p className="fold-edition-title"><strong>{t("New edition")}</strong><span>{t("Compared with {{name}}", { name })}</span></p>
    <button type="button" className="fold-edition-leave" onClick={leave}>{t("Back to fold · Esc")}</button>
  </header>;
  if (!edition) return <div className="fold-edition" tabIndex={-1} aria-busy={status.state === "loading" || undefined}>
    {head}
    <p className="fold-edition-state" role="status">{status.state === "loading" ? t("Comparing editions…") : t("Could not compare the editions")}</p>
  </div>;
  const facts = edition.changes.flatMap(change => change.facts);
  const numbers = facts.filter(fact => fact.class === "number").length, nevers = facts.filter(fact => fact.class === "negation" && fact.change === "added").length;
  const orphans = projection ? projection.at.orphans.length : 0;
  let lastSection: string | null = null;
  return <div className="fold-edition" tabIndex={-1} data-stop={stop} onKeyDown={event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const card = (event.target as HTMLElement).closest<HTMLElement>(".fold-edition-card"), index = card ? Number(card.dataset.index) : -1;
    let handled = true;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const all = [...list.current?.querySelectorAll<HTMLElement>(".fold-edition-card") ?? []], current = card ? all.indexOf(card) : -1, step = event.key === "ArrowDown" ? 1 : -1;
      const next = all[current < 0 ? (step > 0 ? 0 : all.length - 1) : Math.max(0, Math.min(all.length - 1, current + step))];
      next?.focus({ preventScroll: true }); next?.scrollIntoView({ block: "nearest" });
    }
    else if (event.key === "Enter" && card && event.target === card && event.shiftKey) revealCard(index);
    else if (event.key === "Enter" && card && event.target === card) toggle(index);
    else if (event.key === "Escape" && card && opened.has(index)) toggle(index);
    else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  }}>
    {head}
    <ul className="fold-edition-counts" aria-label={t("What changed")}>
      <li data-kind="changed"><span aria-hidden="true">{SYMBOL.changed}</span>{t("Changed · {{n}}", { n: edition.counts.changed })}</li>
      <li data-kind="added"><span aria-hidden="true">{SYMBOL.added}</span>{t("Added · {{n}}", { n: edition.counts.added })}</li>
      <li data-kind="removed"><span aria-hidden="true">{SYMBOL.removed}</span>{t("Removed · {{n}}", { n: edition.counts.removed })}</li>
      {numbers > 0 && <li data-class="number">{t("Numbers · {{n}}", { n: numbers })}</li>}
      {nevers > 0 && <li data-class="negation">{t("New never-dos · {{n}}", { n: nevers })}</li>}
      <li className="fold-edition-quiet">{t("Unchanged, hidden · {{n}}", { n: edition.counts.unchanged })}</li>
      {orphans > 0 && <li className="fold-edition-quiet">{t("Your marks on unchanged text · {{n}}", { n: orphans })}</li>}
    </ul>
    <p className="fold-edition-keys">{t("↑↓ move · Enter full · Shift+Enter open on the page · [ ] level · Esc back")}</p>
    <div ref={list} className="fold-edition-list">
      {!edition.changes.length && <p className="fold-edition-state" role="status">{t("Same text: nothing changed")}</p>}
      {edition.changes.map((change, index) => {
        const headings = (change.new ?? change.old)!.headings, section = (headings.length > 1 ? headings.slice(1) : headings).join(" › ");
        const label = section !== lastSection && section ? <h3 className="fold-edition-section">{section}</h3> : null;
        lastSection = section;
        const fresh = cache.current.get(keyOf(index));
        if (fresh !== undefined) settled.current.set(index, fresh);
        return <div key={index} className="fold-edition-group">{label}
          <Card change={change} index={index} section={section} html={fresh ?? settled.current.get(index)} stale={fresh === undefined && settled.current.has(index)}
            open={opened.has(index)} phase={levelOf(index)} marks={markCount.get(index) ?? 0} toggle={toggle} reveal={change.new ? revealCard : undefined} />
        </div>;
      })}
    </div>
  </div>;
}

const stem = (name: string) => name.toLowerCase().replace(/\.(?:md|markdown|mdown)$/u, "").replace(/[\p{N}_\-.()[\]\s]+/gu, " ").trim();

/** Picks the earlier edition: notes whose name matches this one first (years and digits aside), filter by typing. */
export function EditionPicker({ sources, current, pick, close }: { sources: EditionSources; current: string; pick(source: EditionSource): void; close(): void }) {
  const [query, setQuery] = useState(""), [active, setActive] = useState(0), id = useId();
  const all = useMemo(() => {
    const target = new Set(stem(current).split(" ").filter(Boolean));
    const score = (source: EditionSource) => { const words = stem(source.name).split(" ").filter(Boolean); return words.length ? words.filter(word => target.has(word)).length / Math.max(words.length, target.size) : 0; };
    return sources.list().map(source => ({ source, score: score(source) })).sort((left, right) => right.score - left.score || left.source.name.localeCompare(right.source.name)).map(entry => entry.source);
  }, [sources, current]);
  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (needle ? all.filter(source => `${source.name} ${source.detail}`.toLowerCase().includes(needle)) : all).slice(0, PICK_LIMIT);
  }, [all, query]);
  const chosen = Math.min(active, items.length - 1);
  useEffect(() => { document.getElementById(`${id}-${chosen}`)?.scrollIntoView({ block: "nearest" }); }, [id, chosen]);
  return <div className="fold-pop fold-edition-pick" role="dialog" aria-label={t("Compare with an earlier edition")} onKeyDown={event => {
    // Typing a filter must never reach the fold's own keys.
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive(Math.max(0, Math.min(items.length - 1, chosen + (event.key === "ArrowDown" ? 1 : -1)))); }
    else if (event.key === "Enter" && items[chosen]) { event.preventDefault(); pick(items[chosen]); }
  }}>
    <p className="fold-pop-head">{t("Compare with an earlier edition")}</p>
    <p className="fold-edition-hint">{t("This note is the new edition.")}</p>
    <input type="search" autoFocus value={query} placeholder={t("Filter notes")} aria-label={t("Filter notes")} role="combobox" aria-expanded="true"
      aria-controls={`${id}-list`} aria-activedescendant={items.length ? `${id}-${chosen}` : undefined} onChange={event => { setQuery(event.target.value); setActive(0); }} />
    {items.length ? <ul id={`${id}-list`} role="listbox" aria-label={t("Compare with an earlier edition")}>
      {items.map((source, index) => <li key={source.key} id={`${id}-${index}`} role="option" aria-selected={index === chosen}
        onPointerDown={event => event.preventDefault()} onClick={() => pick(source)}>
        <span>{source.name}</span><small>{source.detail}</small>
      </li>)}
    </ul> : <p className="fold-edition-hint" role="status">{t("No other notes to compare")}</p>}
  </div>;
}
