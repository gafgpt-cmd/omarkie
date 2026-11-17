// Adapted from obgnail/typora_plugin resize_image width calculation (MIT); see READING-NOTICE.
import { t } from "../../i18n.ts";
import { imageRange, resizedImage } from "./imageSyntax.ts";
import { button, listen, type ReadingAPI } from "./dom.ts";
export default ({ BasePlugin, utils }: any) => class extends BasePlugin {
  process() {
    const api: ReadingAPI = utils.reading, handle = button(t("Resize image"), () => {});
    handle.className = "reading-image-resize md-ui"; handle.textContent = "↔"; handle.hidden = true;
    document.body.append(handle);
    utils.insertStyle("resize", `.reading-image-resize{position:fixed;z-index:30;width:28px;height:28px;background:var(--accent);color:var(--paper);cursor:nwse-resize;touch-action:none;border-radius:4px}.reading-image-resize[hidden]{display:none}`);
    let target: HTMLImageElement | null = null;
    let drag: { id: number; x: number; width: number; height: number; range: { from: number; to: number; source: string }; document: string; css: string } | null = null;
    const position = () => {
      if (!target?.isConnected || !api.root()?.contains(target) || !api.editable()) { handle.hidden = true; return; }
      const rect = target.getBoundingClientRect();
      handle.hidden = rect.bottom < 0 || rect.top > innerHeight;
      handle.style.left = `${Math.min(innerWidth - 28, rect.right - 14)}px`; handle.style.top = `${Math.min(innerHeight - 28, rect.bottom - 14)}px`;
    };
    const cancel = () => { if (drag && target) target.style.cssText = drag.css; drag = null; position(); };
    api.own(() => { cancel(); handle.remove(); });
    listen(api, document, "pointerover", ((event: PointerEvent) => { if (!drag && event.target instanceof HTMLImageElement && api.root()?.contains(event.target)) { target = event.target; position(); } }) as EventListener);
    listen(api, document, "scroll", (() => { if (drag) cancel(); position(); }) as EventListener, true);
    listen(api, window, "resize", position);
    api.onPaint(() => { if (!drag) position(); });
    listen(api, handle, "pointerdown", ((event: PointerEvent) => {
      if (event.button !== 0 || !target || !api.editable()) return;
      const from = api.imageOffset(target), text = utils.getCurrentFileContent(), range = from === undefined ? undefined : imageRange(text, from);
      if (!range) return;
      event.preventDefault(); event.stopPropagation();
      const rect = target.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, width: rect.width, height: rect.height, range, document: api.documentId(), css: target.style.cssText };
      handle.setPointerCapture(event.pointerId);
    }) as EventListener);
    listen(api, handle, "pointermove", ((event: PointerEvent) => {
      if (!drag || !target || event.pointerId !== drag.id) return;
      if (!api.editable() || drag.document !== api.documentId()) { cancel(); return; }
      const width = Math.max(16, Math.min(10000, drag.width + event.clientX - drag.x));
      target.style.width = `${width}px`; target.style.height = `${drag.height * width / drag.width}px`; target.style.maxWidth = "none"; position();
    }) as EventListener);
    listen(api, handle, "pointerup", ((event: PointerEvent) => {
      if (!drag || !target || event.pointerId !== drag.id) return;
      const current = drag, width = Math.max(16, Math.min(10000, current.width + event.clientX - current.x));
      cancel();
      if (Math.abs(width - current.width) < 1 || !api.editable() || current.document !== api.documentId()) return;
      const next = resizedImage(current.range.source, width, current.height * width / current.width);
      api.replaceRange(current.range.from, current.range.to, next, current.range.source);
      handle.hidden = true; target = null;
    }) as EventListener);
    for (const name of ["pointercancel", "lostpointercapture"]) listen(api, handle, name, cancel);
    listen(api, document, "keydown", ((event: KeyboardEvent) => { if (event.key === "Escape" && drag) { event.preventDefault(); cancel(); } }) as EventListener, true);
    utils.eventHub.on("fileOpened", () => { cancel(); target = null; handle.hidden = true; });
  }
};
