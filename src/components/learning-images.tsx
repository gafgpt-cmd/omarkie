import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent, type ReactNode } from "react";
import { Check, FilePlus, Grip, RotateCcw, UnfoldHorizontal, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { ScrapImage } from "../../shared/reading-store.ts";
import { host } from "../host";
import { t } from "../i18n";

const imageData = /^data:image\/(?:png|jpeg|gif|webp);base64,([a-z\d+/]+=*)$/i;
const maxBytes = 20 * 1024 * 1024;
export const scrapDrag = "application/x-omarkie-scrap";
export const imageWidth = (width: number) => Math.max(96, Math.min(1600, Math.round(width)));

export function imageTransfer(data: DataTransfer): { local: { name: string; image: File | string }[]; url?: string } {
  const local = Array.from(data.files).filter(file => file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(file.name))
    .map(file => ({ name: file.name || t("图片"), image: file }));
  if (local.length) return { local };
  // A template keeps dropped HTML inert, including image URLs other than the one requested.
  const template = document.createElement("template");
  template.innerHTML = data.getData("text/html");
  const img = template.content.querySelector("img[src]");
  const urls = data.getData("text/uri-list");
  const source = img?.getAttribute("src") || urls.split(/\r?\n/).find(line => line && !line.startsWith("#")) || data.getData("text/plain").trim();
  const match = imageData.exec(source);
  if (match) return { local: [{ name: img?.getAttribute("alt")?.trim() || t("图片"), image: match[1] }] };
  return { local, url: /^https?:\/\//i.test(source) && (img || urls || /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.test(source)) ? source : undefined };
}

export function readImageBytes(image: File | string): Promise<string> {
  if (typeof image === "string") return Promise.resolve(image);
  if (image.size > maxBytes) return Promise.reject(new Error(t("图片超过 20 MB。")));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result);
      resolve(data.slice(data.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(image);
  });
}

export function FloatImages({ root, images }: { root: HTMLElement; images: { blockId: string; content: ReactNode }[] }) {
  const mounts = useRef(new Map<string, HTMLSpanElement>());
  const [visible, setVisible] = useState<string[]>([]);
  const blockIds = useRef(new Set<string>());
  function update() {
    const mounted = new Set<string>();
    for (const child of root.children) {
      const id = (child as HTMLElement).dataset.cid;
      if (!id || !blockIds.current.has(id)) continue;
      let mount = mounts.current.get(id);
      if (!mount) {
        mount = document.createElement("span");
        mount.className = "study-floats";
        mount.contentEditable = "false";
        mounts.current.set(id, mount);
      }
      if (mount.parentElement !== child) child.prepend(mount);
      mounted.add(id);
    }
    for (const [id, mount] of mounts.current) if (!mounted.has(id)) { mount.remove(); mounts.current.delete(id); }
    setVisible(previous => previous.length === mounted.size && previous.every(id => mounted.has(id)) ? previous : [...mounted]);
  }
  useLayoutEffect(() => {
    blockIds.current = new Set(images.map(image => image.blockId));
    update();
  });
  useLayoutEffect(() => {
    const changes = new MutationObserver(update);
    changes.observe(root, { childList: true, subtree: true });
    return () => { changes.disconnect(); for (const mount of mounts.current.values()) mount.remove(); mounts.current.clear(); };
  }, [root]);
  return images.filter(image => visible.includes(image.blockId) && mounts.current.has(image.blockId))
    .map(image => createPortal(image.content, mounts.current.get(image.blockId)!, image.blockId));
}

export function StudyImage({ id, name, image, busy, floating, drag, resize, peel, accept, move }: {
  id: string; name: string; image: ScrapImage; busy: boolean; floating?: boolean;
  drag(event: DragEvent): void; resize(width: number): void; peel(): void; accept?(source: string): void; move(): void;
}) {
  const [source, setSource] = useState<string>(), [error, setError] = useState(false), [proposal, setProposal] = useState(false);
  const figure = useRef<HTMLSpanElement>(null);
  const handle = useRef<{ pointer: number; start: number; width: number; next: number } | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void host.readingStore!(id, { action: "readImage", hash: image.hash }).then(url => { if (current) setSource(url); })
      .catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [id, image.hash]);
  const direction = image.side === "left" ? 1 : -1;
  function resizeEnd(event: PointerEvent, commit: boolean) {
    const current = handle.current;
    if (current?.pointer !== event.pointerId) return;
    handle.current = undefined;
    figure.current?.style.setProperty("--scrap-width", `${image.width}px`);
    if (commit && current.next !== current.width) resize(current.next);
  }
  return <span className="study-image" ref={figure} style={{ "--scrap-width": `${image.width}px` } as CSSProperties}
    data-side={image.side} data-floating={floating || undefined} contentEditable={false} role="group" aria-label={name}>
    {source && !error ? <img src={source} alt={name} draggable={!busy} onDragStart={drag} onError={() => setError(true)} /> :
      <span className="study-image-message">{error ? t("Image unavailable") : name}</span>}
    <span className="study-image-tools">
      <button type="button" draggable={!busy} onDragStart={drag} onClick={move} disabled={busy} aria-label={t("Move")} title={t("Move")}><Grip size={14} /></button>
      {accept && source && !error && <button type="button" disabled={busy} onClick={() => setProposal(true)} aria-label={t("Write into note…")} title={t("Write into note…")}><FilePlus size={14} /></button>}
      <button type="button" disabled={busy} onClick={peel} aria-label={t("Peel off")} title={t("Peel off")}><X size={14} /></button>
      {floating && <button type="button" className="study-image-resize" aria-label={t("Resize image")} title={t("Resize image")} disabled={busy}
        onPointerDown={event => {
          if (event.button !== 0) return;
          const width = Math.round(figure.current!.getBoundingClientRect().width);
          handle.current = { start: event.clientX, width, next: width, pointer: event.pointerId };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const current = handle.current;
          if (current?.pointer !== event.pointerId) return;
          current.next = imageWidth(current.width + direction * (event.clientX - current.start));
          figure.current?.style.setProperty("--scrap-width", `${current.next}px`);
        }} onPointerUp={event => resizeEnd(event, true)} onLostPointerCapture={event => resizeEnd(event, false)}
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault(); resize(imageWidth(image.width + (event.key === "ArrowRight" ? 16 : -16)));
        }}><UnfoldHorizontal size={14} /></button>}
    </span>
    {proposal && source && <span className="study-image-confirm" role="group" aria-label={t("Write into note…")}>
      <span>{t("Add this image to the Markdown note?")}</span>
      <button type="button" disabled={busy} onClick={() => accept?.(source)}><Check size={13} />{t("Accept")}</button>
      <button type="button" disabled={busy} onClick={() => setProposal(false)}><RotateCcw size={13} />{t("取消")}</button>
    </span>}
  </span>;
}
