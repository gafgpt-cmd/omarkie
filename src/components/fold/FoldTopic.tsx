import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { OPENING, topicCardAt, topicCards, type FoldTopic as Topic, type TopicItem, type TopicSection } from "../../../shared/fold-topic.mjs";
import type { RawMeta } from "../../../shared/fold-units.mjs";
import { renderMarkdownEach } from "../../editor/markdown";
import { renderMath } from "../../editor/math";
import { t } from "../../i18n";
import { stopLabel } from "./stops";

export type TopicView = "cards" | "map";
const VIEW_KEY = "omarkie-fold-topic-view";
export const savedTopicView = (): TopicView => localStorage.getItem(VIEW_KEY) === "map" ? "map" : "cards";
export const saveTopicView = (view: TopicView) => localStorage.setItem(VIEW_KEY, view);

const MAP_PAD = 16, MAP_GAP_X = 40, MAP_GAP_LEAF = 6, MAP_GAP_BRANCH = 14;
const RAW_GLYPH = { table: "▦", code: "{ }", math: "∑", image: "▣" } as const;
// Cards (map nodes four times as many) mounted per frame, so entering Topic never blocks for long.
const SLICE = 6;
// Rendered lines per topic, kept across Topic visits.
const rendered = new WeakMap<Topic, { documentId: string; cache: Map<string, string> }>();

function cacheOf(topic: Topic, documentId: string) {
  let entry = rendered.get(topic);
  if (entry?.documentId !== documentId) { entry = { documentId, cache: new Map() }; rendered.set(topic, entry); }
  return entry.cache;
}

const strings = (sources: (string | null | undefined)[]) => sources.filter((source): source is string => typeof source === "string");
// The Markdown a card or a map branch shows.
const sectionSources = (section: TopicSection, eyebrow: string | null = null) =>
  strings([eyebrow, section.heading, ...section.items.map(item => item.kind === "line" ? item.markdown : null)]);

// Renders what is missing in one sanitizer pass.
function fill(cache: Map<string, string>, sources: string[], documentId: string) {
  const missing = [...new Set(sources)].filter(source => !cache.has(source));
  if (missing.length) renderMarkdownEach(missing, documentId).forEach((html, index) => cache.set(missing[index], html));
}

/** Renders the topic's lines in idle time, a few milliseconds at a time, so Topic opens on a warm cache. Returns a cancel. */
export function warmTopic(topic: Topic, documentId: string) {
  const cache = cacheOf(topic, documentId);
  const pending = [...new Set(strings([topic.title?.markdown, ...topicCards(topic).map(card => card.eyebrow),
    ...topic.sections.flatMap(section => sectionSources(section))]))].filter(source => !cache.has(source));
  let handle = 0;
  const slice = (deadline: IdleDeadline) => {
    const start = performance.now();
    while (pending.length && deadline.timeRemaining() > 0 && performance.now() - start < 12) fill(cache, pending.splice(0, 1), documentId);
    if (pending.length) handle = requestIdleCallback(slice);
  };
  if (pending.length) handle = requestIdleCallback(slice);
  return () => cancelIdleCallback(handle);
}

// How many of `total` entries are mounted: `first` at once, then one more slice each frame.
function useSlices(total: number, first: number, slice: number) {
  const [shown, setShown] = useState(() => Math.min(total, first));
  useEffect(() => {
    if (shown >= total) return;
    const frame = requestAnimationFrame(() => setShown(count => Math.min(total, count + slice)));
    return () => cancelAnimationFrame(frame);
  }, [shown, total, slice]);
  return shown;
}

// A single rendered paragraph without its <p>, for headings and the title.
function inline(html: string) {
  const match = /^<p\b[^>]*>([\s\S]*)<\/p>$/.exec(html.trim());
  return match && !/<p\b/.test(match[1]) ? match[1] : html;
}

function rawLabel(raw: RawMeta) {
  if (raw.class === "table") return `${t("Table")} · ${t("{{count}} rows", { count: raw.rows })}`;
  if (raw.class === "code") return `${t("Code")} · ${t("{{count}} lines", { count: raw.lines })}`;
  if (raw.class === "math") return t("Formula");
  const kind = raw.kind === "embed" ? t("Embed") : t("Image");
  return raw.alt ? `${kind} · ${raw.alt}` : kind;
}

function Item({ item, html }: { item: TopicItem; html(markdown: string): string }) {
  if (item.kind === "raw") return <div className="fold-topic-raw" data-raw={item.raw.class}>
    <span aria-hidden="true">{RAW_GLYPH[item.raw.class]}</span> {rawLabel(item.raw)}
  </div>;
  return <div className="fold-topic-line" dangerouslySetInnerHTML={{ __html: html(item.markdown) }} />;
}

function Heading({ section, html, id, className }: { section: TopicSection; html(markdown: string): string; id?: string; className: string }) {
  return section.heading === null
    ? <div className={className} id={id}>{t("Opening")}</div>
    : <div className={className} id={id} dangerouslySetInnerHTML={{ __html: inline(html(section.heading)) }} />;
}

// Rendered Markdown by source; `prepare` renders a coming slice in one pass.
type Html = { (markdown: string): string; prepare(sources: string[]): void };

function Cards({ topic, html, current, onKeyDown }: {
  topic: Topic; html: Html; current: string | null; onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void;
}) {
  const cards = useMemo(() => topicCards(topic), [topic]);
  const [active, setActive] = useState(() => current ?? cards[0]?.section.id ?? null);
  const shown = useSlices(cards.length, Math.max(SLICE, cards.findIndex(card => card.section.id === current) + 1), SLICE);
  const list = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => { void renderMath(list.current!).catch(() => {}); }, [shown]);
  const mounted = cards.slice(0, shown);
  html.prepare(mounted.flatMap(({ section, eyebrow }) => sectionSources(section, eyebrow)));
  return <ul ref={list} className="fold-cards" aria-label={t("Topic cards")} onKeyDown={onKeyDown}>
    {mounted.map(({ section, eyebrow }) => {
      const id = `fold-card-${section.id}`;
      return <li key={section.id}>
        <div className="fold-card" role="button" tabIndex={section.id === active ? 0 : -1} data-anchor={section.anchor ?? undefined}
          data-current={section.id === current || undefined} aria-labelledby={`${id}-title`}
          aria-describedby={section.items.length ? `${id}-body` : undefined} onFocus={() => setActive(section.id)}>
          {eyebrow !== null && <div className="fold-card-eyebrow" dangerouslySetInnerHTML={{ __html: inline(html(eyebrow)) }} />}
          <Heading section={section} html={html} id={`${id}-title`} className="fold-card-title" />
          {section.items.length > 0 && <div className="fold-card-body" id={`${id}-body`}>
            {section.items.map(item => <Item key={item.unitId} item={item} html={html} />)}
          </div>}
        </div>
      </li>;
    })}
  </ul>;
}

interface MapNode {
  key: string;
  kind: "root" | "section" | "line" | "raw";
  depth: number;
  parent: number;
  anchor: string | null;
  section?: TopicSection;
  item?: TopicItem;
  children: number[];
}

// The same topic as a tree in reading order: title, then each section with its lines before its subsections.
function mapNodes(topic: Topic) {
  const nodes: MapNode[] = [];
  const byId = new Map(topic.sections.map(section => [section.id, section]));
  const add = (node: Omit<MapNode, "children">) => {
    nodes.push({ ...node, children: [] });
    if (node.parent >= 0) nodes[node.parent].children.push(nodes.length - 1);
    return nodes.length - 1;
  };
  const items = (section: TopicSection, parent: number, depth: number) => {
    for (const item of section.items) add({ key: item.unitId, kind: item.kind, depth, parent, anchor: item.unitId, item });
  };
  const walk = (section: TopicSection, parent: number, depth: number) => {
    if (section.id === OPENING) { items(section, parent, depth); return; }
    const index = add({ key: section.id, kind: "section", depth, parent, anchor: section.anchor, section });
    items(section, index, depth + 1);
    for (const child of section.children) walk(byId.get(child)!, index, depth + 1);
  };
  add({ key: "root", kind: "root", depth: 0, parent: -1, anchor: topic.title?.unitId ?? topic.sections[0]?.anchor ?? null });
  for (const section of topic.sections) if (section.parent === null) walk(section, 0, 1);
  return nodes;
}

// Each parent sits level with the middle of its first child; children stack below one another. Only mounted nodes
// (a prefix in reading order, so a whole subtree) take part.
function layoutMap(canvas: HTMLElement, links: SVGSVGElement, nodes: MapNode[]) {
  const elements = [...canvas.querySelectorAll<HTMLElement>("[data-node]")];
  const size = elements.map(element => [element.offsetWidth, element.offsetHeight] as const);
  const children = (index: number) => nodes[index].children.filter(child => child < elements.length);
  const position: [number, number][] = [];
  let right = 0, bottom = 0;
  const place = (index: number, x: number, y: number): number => {
    const [width, height] = size[index], below = children(index);
    right = Math.max(right, x + width);
    if (!below.length) { position[index] = [x, y]; bottom = Math.max(bottom, y + height); return height; }
    let next = y;
    below.forEach((child, order) => {
      next += place(child, x + width + MAP_GAP_X, next);
      const after = below[order + 1];
      if (after !== undefined) next += nodes[child].children.length || nodes[after].children.length ? MAP_GAP_BRANCH : MAP_GAP_LEAF;
    });
    const first = below[0], top = Math.max(y, position[first][1] + size[first][1] / 2 - height / 2);
    position[index] = [x, top];
    bottom = Math.max(bottom, top + height);
    return Math.max(next - y, top + height - y);
  };
  place(0, MAP_PAD, MAP_PAD);
  elements.forEach((element, index) => { element.style.transform = `translate(${position[index][0]}px, ${position[index][1]}px)`; });
  const paths = elements.flatMap((_, index) => children(index).map(child => {
    const x1 = position[index][0] + size[index][0], y1 = position[index][1] + size[index][1] / 2;
    const x2 = position[child][0], y2 = position[child][1] + Math.min(size[child][1] / 2, 12), middle = (x1 + x2) / 2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M${x1},${y1} C${middle},${y1} ${middle},${y2} ${x2},${y2}`);
    return path;
  }));
  links.replaceChildren(...paths);
  const width = right + MAP_PAD, height = bottom + MAP_PAD;
  links.setAttribute("viewBox", `0 0 ${width} ${height}`);
  links.setAttribute("width", String(width));
  links.setAttribute("height", String(height));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

function TopicMap({ topic, title, html, current, onKeyDown }: {
  topic: Topic; title: string; html: Html; current: string | null; onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void;
}) {
  const nodes = useMemo(() => mapNodes(topic), [topic]);
  const canvas = useRef<HTMLDivElement>(null), links = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState(() => Math.max(0, nodes.findIndex(node => node.section?.id === current)));
  const shown = useSlices(nodes.length, Math.max(SLICE * 4, active + 1), SLICE * 4);
  useLayoutEffect(() => {
    const element = canvas.current!, svg = links.current!;
    let live = true;
    layoutMap(element, svg, nodes);
    void renderMath(element).then(() => { if (live) layoutMap(element, svg, nodes); }).catch(() => {});
    return () => { live = false; };
  }, [nodes, shown]);
  const mounted = nodes.slice(0, shown);
  html.prepare(strings(mounted.flatMap(node => node.kind === "root" ? [topic.title?.markdown]
    : node.section ? [node.section.heading] : [node.item?.kind === "line" ? node.item.markdown : null])));
  return <div className="fold-map">
    <div ref={canvas} className="fold-map-canvas" role="tree" aria-label={t("Topic map")} onKeyDown={onKeyDown}>
      <svg ref={links} className="fold-map-links" aria-hidden="true" />
      {mounted.map((node, index) => <div key={node.key} className="fold-map-node" role="treeitem" aria-level={node.depth + 1}
        tabIndex={index === active ? 0 : -1} data-node={index} data-kind={node.kind} data-anchor={node.anchor ?? undefined}
        data-current={(node.section && node.section.id === current) || undefined} onFocus={() => setActive(index)}>
        {node.kind === "root"
          ? topic.title ? <div dangerouslySetInnerHTML={{ __html: inline(html(topic.title.markdown)) }} /> : title
          : node.section ? <Heading section={node.section} html={html} className="fold-map-heading" />
          : <Item item={node.item!} html={html} />}
      </div>)}
    </div>
  </div>;
}

const focusOn = (element: HTMLElement | null | undefined) => {
  if (!element) return;
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
};

// Next card in reading direction, or the nearest card in the row above or below.
function cardStep(cards: HTMLElement[], from: number, key: string) {
  if (key === "ArrowRight") return cards[from + 1];
  if (key === "ArrowLeft") return cards[from - 1];
  if (key === "Home") return cards[0];
  if (key === "End") return cards[cards.length - 1];
  const rect = cards[from].getBoundingClientRect(), center = rect.left + rect.width / 2, down = key === "ArrowDown";
  const candidates = cards.filter(card => {
    const box = card.getBoundingClientRect();
    return down ? box.top >= rect.bottom - 1 : box.bottom <= rect.top + 1;
  });
  if (!candidates.length) return undefined;
  const row = down
    ? Math.min(...candidates.map(card => card.getBoundingClientRect().top))
    : Math.max(...candidates.map(card => card.getBoundingClientRect().top));
  const inRow = candidates.filter(card => Math.abs(card.getBoundingClientRect().top - row) < 2);
  return inRow.reduce((best, card) => {
    const box = card.getBoundingClientRect(), bestBox = best.getBoundingClientRect();
    return Math.abs(box.left + box.width / 2 - center) < Math.abs(bestBox.left + bestBox.width / 2 - center) ? card : best;
  });
}

// Topic stop (design §3.D): the note's sections as cards or as a map, both from one topic model. Opening a card or
// node moves the Fold view to Key at that unit, kept at the height it was clicked.
export function FoldTopic({ topic, title, documentId, view, setView, reading, open }: {
  topic: Topic;
  title: string;
  documentId: string;
  view: TopicView;
  setView(view: TopicView): void;
  /** Source line the reader was at when Topic opened. */
  reading(): number;
  open(unitId: string, top: number): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [current] = useState(() => topicCardAt(topic, reading())?.id ?? null);
  const html = useMemo<Html>(() => {
    const cache = cacheOf(topic, documentId);
    const prepare = (sources: string[]) => fill(cache, sources, documentId);
    return Object.assign((markdown: string) => { prepare([markdown]); return cache.get(markdown)!; }, { prepare });
  }, [topic, documentId]);
  useLayoutEffect(() => {
    void renderMath(root.current!).catch(() => {});
  }, [view, topic]);
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (focused && focused !== document.body && !focused.closest(".fold-scroller")) return;
    focusOn(root.current!.querySelector<HTMLElement>('[data-anchor][tabindex="0"]'));
  }, []);
  const activate = (element: HTMLElement) => {
    const anchor = element.dataset.anchor;
    if (anchor) open(anchor, element.getBoundingClientRect().top);
  };
  const cardKeys = (event: ReactKeyboardEvent<HTMLElement>) => {
    const card = (event.target as Element).closest<HTMLElement>(".fold-card");
    if (!card || event.altKey || event.ctrlKey || event.metaKey) return;
    const cards = [...event.currentTarget.querySelectorAll<HTMLElement>(".fold-card")];
    if (event.key === "Enter" || event.key === " ") activate(card);
    else if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) focusOn(cardStep(cards, cards.indexOf(card), event.key));
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const mapKeys = (event: ReactKeyboardEvent<HTMLElement>) => {
    const node = (event.target as Element).closest<HTMLElement>(".fold-map-node");
    if (!node || event.altKey || event.ctrlKey || event.metaKey) return;
    const all = [...event.currentTarget.querySelectorAll<HTMLElement>(".fold-map-node")];
    const index = all.indexOf(node), level = Number(node.getAttribute("aria-level"));
    if (event.key === "Enter" || event.key === " ") activate(node);
    else if (event.key === "ArrowDown") focusOn(all[index + 1]);
    else if (event.key === "ArrowUp") focusOn(all[index - 1]);
    else if (event.key === "ArrowLeft") focusOn(all.slice(0, index).reverse().find(other => Number(other.getAttribute("aria-level")) === level - 1));
    else if (event.key === "ArrowRight") focusOn(Number(all[index + 1]?.getAttribute("aria-level")) === level + 1 ? all[index + 1] : undefined);
    else if (event.key === "Home") focusOn(all[0]);
    else if (event.key === "End") focusOn(all[all.length - 1]);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const viewKeys = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const next = view === "cards" ? "map" : "cards";
    setView(next);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[role="radio"][data-view="${next}"]`)?.focus());
  };
  const option = (value: TopicView, label: string) => <button type="button" role="radio" data-view={value} aria-checked={view === value}
    tabIndex={view === value ? 0 : -1} onClick={() => setView(value)}>{label}</button>;
  return <div ref={root} className="fold-topic" onClick={event => {
    const target = (event.target as Element).closest<HTMLElement>(".fold-card,.fold-map-node");
    if (target && !window.getSelection()?.toString()) activate(target);
  }}>
    <div className="rich-document fold-topic-page" data-view={view}>
      <header className="fold-topic-head">
        <h2 className="fold-topic-title">
          {topic.title ? <span dangerouslySetInnerHTML={{ __html: inline(html(topic.title.markdown)) }} /> : title}
        </h2>
        <div className="fold-topic-views" role="radiogroup" aria-label={t("How Topic shows")} onKeyDown={viewKeys}>
          {option("cards", t("Cards"))}
          {option("map", t("Map"))}
        </div>
        <p className="fold-topic-hint">{t("Open any line at {{level}} with a click or Enter", { level: stopLabel("key") })}</p>
      </header>
      {view === "cards"
        ? <Cards topic={topic} html={html} current={current} onKeyDown={cardKeys} />
        : <TopicMap topic={topic} title={title} html={html} current={current} onKeyDown={mapKeys} />}
    </div>
  </div>;
}
