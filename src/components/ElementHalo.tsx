import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorHandle } from "../editor/MarkdownEditor";
import { resolveAnchor } from "../glass/anchor-map";
import { elementNode } from "../glass/element-node";
import { elementKindName } from "../glass/element-label";
import { elementById, markdownElements, type PageElement } from "../../shared/element-model.mjs";
import { t } from "../i18n";
import "./element-halo.css";

// G4 element boxes: hover shows the kind, click or Tab selects, the pill only announces intent.
// The page keeps its own caret and typing; nothing here takes a click away from the editor.
const nestedKinds = new Set(["list-item", "table-cell", "image", "embed"]);
const walkedKinds = new Set(["paragraph", "heading", "list-item", "table-cell", "image", "embed", "formula", "code", "callout", "quote", "html", "divider"]);

interface Shown { id: string; kind: string; text: string }

function shown(element: PageElement): Shown {
  return { id: element.id, kind: element.kind, text: element.text.length > 60 ? `${element.text.slice(0, 60)}…` : element.text };
}

export default function ElementHalo({ root, editor }: { root: HTMLElement; editor(): EditorHandle | undefined }) {
  const scroller = root.parentElement!;
  const layer = useRef<HTMLDivElement>(null), hoverBox = useRef<HTMLDivElement>(null), selectBox = useRef<HTMLDivElement>(null), pill = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Shown>(), [selected, setSelected] = useState<Shown>(), [announce, setAnnounce] = useState("");
  const hoverId = useRef<string | undefined>(undefined), selectedId = useRef<string | undefined>(undefined);
  const hoverElement = useRef<PageElement | undefined>(undefined), selectElement = useRef<PageElement | undefined>(undefined);
  const hoverNode = useRef<HTMLElement | undefined>(undefined), selectNode = useRef<HTMLElement | undefined>(undefined);
  const cache = useRef<{ text: string; elements: PageElement[] } | null>(null);
  const pending = useRef<Element | undefined>(undefined), frame = useRef(0);

  function model() {
    const text = editor()?.readingContext()?.text;
    if (text === undefined) return cache.current?.elements ?? [];
    if (cache.current?.text === text) return cache.current.elements;
    cache.current = { text, elements: markdownElements(text) };
    return cache.current.elements;
  }

  function nodeOf(element: PageElement, elements: PageElement[]) {
    return elementNode(root, element, elements);
  }

  function resolved(target: Element | null, elements: PageElement[]) {
    if (!target || !root.contains(target)) return null;
    const block = target.closest<HTMLElement>("[data-cid]");
    if (!block || !root.contains(block)) return null;
    const inBlock = elements.filter(element => element.blockLine === Number(block.dataset.line));
    if (!inBlock.length) return null;
    const cell = target.closest<HTMLElement>("td, th");
    if (cell) {
      const cells = inBlock.filter(element => element.kind === "table-cell");
      const element = cells[Array.from(block.querySelectorAll<HTMLElement>("td, th")).indexOf(cell)];
      if (element) return { element, node: cell };
    }
    const item = target.closest<HTMLElement>("li");
    if (item) {
      const items = inBlock.filter(element => element.kind === "list-item");
      const element = items[Array.from(block.querySelectorAll<HTMLElement>("li")).indexOf(item)];
      if (element) return { element, node: item };
    }
    const image = target.closest<HTMLElement>("img");
    if (image) {
      const media = inBlock.filter(element => element.kind === "image" || element.kind === "embed");
      const element = media[Array.from(block.querySelectorAll<HTMLElement>("img")).indexOf(image)];
      if (element) return { element, node: image };
    }
    const element = inBlock.find(other => !nestedKinds.has(other.kind) && other.line === Number(block.dataset.line)) ?? inBlock.find(other => !other.parent) ?? inBlock[0];
    return element ? { element, node: block } : null;
  }

  function recover(element: PageElement, elements: PageElement[]) {
    const blocks = elements.map(other => ({ block: other.markdown, headings: other.headings, line: other.line, kind: other.kind }));
    const { line } = resolveAnchor(element.landmarks, blocks);
    if (line === null) return;
    return elements.find(other => other.line === line && other.kind === element.kind);
  }

  function layout() {
    const frameBox = layer.current?.getBoundingClientRect();
    if (!frameBox) return;
    const place = (box: HTMLDivElement | null, node: HTMLElement | null) => {
      if (!box) return;
      if (!node?.isConnected || !node.getBoundingClientRect) { box.hidden = true; return; }
      const rect = node.getBoundingClientRect();
      box.hidden = false;
      box.style.left = `${rect.left - frameBox.left}px`;
      box.style.top = `${rect.top - frameBox.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
    };
    place(hoverBox.current, hoverNode.current ?? null);
    place(selectBox.current, selectNode.current ?? null);
    if (!pill.current) return;
    if (!selectNode.current?.isConnected) { pill.current.hidden = true; return; }
    const rect = selectNode.current.getBoundingClientRect();
    pill.current.hidden = false;
    pill.current.style.top = `${rect.bottom - frameBox.top + 4}px`;
    pill.current.style.left = `${Math.max(4, rect.right - frameBox.left)}px`;
  }

  function select(element: PageElement, node: HTMLElement | null) {
    selectElement.current = element;
    selectNode.current = node ?? undefined;
    selectedId.current = element.id;
    setSelected(shown(element));
    setAnnounce(t("Selected {{kind}}: {{text}}", { kind: t(elementKindName(element.kind)), text: shown(element).text }));
    schedule();
  }

  function clear() {
    const fromPill = !!pill.current?.contains(document.activeElement);
    selectElement.current = undefined;
    selectNode.current = undefined;
    selectedId.current = undefined;
    setSelected(undefined);
    setAnnounce("");
    if (fromPill) editor()?.focus();
    schedule();
  }

  function step(direction: number) {
    const elements = model().filter(element => walkedKinds.has(element.kind));
    if (!elements.length) return;
    const at = selectElement.current ? elements.findIndex(element => element.id === selectElement.current!.id) : -1;
    const next = elements[at < 0 ? (direction > 0 ? 0 : elements.length - 1) : (at + direction + elements.length) % elements.length];
    const node = nodeOf(next, model());
    select(next, node);
    node?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function emit(action: string) {
    const element = selectElement.current;
    if (!element) return;
    window.dispatchEvent(new CustomEvent("omarkie:element-action", { detail: { id: element.id, kind: element.kind, line: element.line, headings: [...element.headings], action } }));
  }

  function schedule() {
    if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; draw(); });
  }

  const draw = useEffectEvent(() => {
    const elements = model();
    const target = pending.current;
    pending.current = undefined;
    if (target) {
      const hit = resolved(target, elements);
      if (hit) {
        hoverElement.current = hit.element;
        hoverNode.current = hit.node;
        if (hoverId.current !== hit.element.id) { hoverId.current = hit.element.id; setHover(shown(hit.element)); }
      } else if (hoverElement.current) {
        hoverElement.current = undefined;
        hoverNode.current = undefined;
        hoverId.current = undefined;
        setHover(undefined);
      }
    }
    if (selectElement.current) {
      const current = elementById(elements, selectElement.current.id);
      const kept = current ?? recover(selectElement.current, elements);
      if (kept) {
        selectElement.current = kept;
        if (!selectNode.current?.isConnected) selectNode.current = nodeOf(kept, elements) ?? undefined;
        if (selectedId.current !== kept.id) { selectedId.current = kept.id; setSelected(shown(kept)); }
      } else clear();
    }
    layout();
  });

  useEffect(() => {
    const surface = layer.current;
    if (!surface) return;
    const onMove = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || surface.contains(target) || target.closest("[data-glass='on']")) return;
      pending.current = target;
      schedule();
    };
    const onLeave = () => {
      pending.current = undefined;
      hoverElement.current = undefined;
      hoverNode.current = undefined;
      hoverId.current = undefined;
      setHover(undefined);
      schedule();
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || surface.contains(target) || target.closest("[data-glass='on']")) return;
      const hit = resolved(target, model());
      if (hit) select(hit.element, hit.node);
      else clear();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !["Escape", "Enter", "Tab"].includes(event.key)) return;
      if (event.target instanceof Element && event.target.closest("[data-glass='on']")) return;
      if (document.querySelector('[role="dialog"], dialog[open]')) return;
      if (event.key === "Escape") {
        if (!selectElement.current) return;
        event.stopPropagation();
        clear();
        return;
      }
      const active = document.activeElement;
      if (active && (pill.current?.contains(active) || active !== document.body && !scroller.contains(active))) return;
      if (event.key === "Enter" && selectElement.current) {
        const button = pill.current?.querySelector("button");
        if (!button) return;
        event.preventDefault();
        button.focus();
        return;
      }
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      step(event.shiftKey ? -1 : 1);
    };
    const onDismiss = () => { if (selectElement.current) clear(); };
    window.addEventListener("omarkie:element-dismiss", onDismiss);
    scroller.addEventListener("pointermove", onMove, { passive: true });
    scroller.addEventListener("pointerleave", onLeave);
    scroller.addEventListener("click", onClick, true);
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("keydown", onKeyDown, true);
    const observer = new MutationObserver(() => schedule());
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-line"] });
    schedule();
    return () => {
      if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
      window.removeEventListener("omarkie:element-dismiss", onDismiss);
      scroller.removeEventListener("pointermove", onMove);
      scroller.removeEventListener("pointerleave", onLeave);
      scroller.removeEventListener("click", onClick, true);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("keydown", onKeyDown, true);
      observer.disconnect();
    };
  }, [root, scroller]);

  return createPortal(<div className="element-halo" ref={layer} data-element-halo="on">
    <div className="element-halo-box" ref={hoverBox} hidden data-element-hover={hover?.id} data-element-kind={hover?.kind}>
      {hover && <span className="element-halo-label">{t(elementKindName(hover.kind))}</span>}
    </div>
    <div className="element-halo-box is-selected" ref={selectBox} hidden data-element-selected={selected?.id} data-element-kind={selected?.kind}>
      {selected && <span className="element-halo-label">{t(elementKindName(selected.kind))}</span>}
    </div>
    {selected && <div className="element-halo-pill" ref={pill} role="group" aria-label={t("Element actions")}>
      <button type="button" data-element-action="change" onClick={() => emit("change")}>{t("Change")}</button>
      <button type="button" data-element-action="comment" onClick={() => emit("comment")}>{t("Comment")}</button>
    </div>}
    <p className="element-halo-live" role="status" aria-live="polite">{announce}</p>
  </div>, scroller);
}

