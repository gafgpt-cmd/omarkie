// Adapted from obgnail/typora_plugin image_viewer ImageOperations (MIT); see READING-NOTICE.
import { t } from "../../i18n.ts";
import { button, listen, type ReadingAPI } from "./dom.ts";
export default ({ BasePlugin, utils }: any) => class extends BasePlugin {
  openImage?: (image: HTMLImageElement) => void;
  hotkey() { return [{ hotkey: "mod+alt+v", callback: () => this.call() }]; }
  call() { const image = utils.reading.root()?.querySelector("img"); if (image) this.openImage?.(image); }
  process() {
    const api: ReadingAPI = utils.reading;
    const dialog = document.createElement("dialog"), image = document.createElement("img"), toolbar = document.createElement("div"), status = document.createElement("output");
    dialog.className = "reading-image-viewer"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-label", t("Image viewer"));
    toolbar.className = "reading-viewer-tools"; image.draggable = false;
    let scale = 1, x = 0, y = 0, previous: HTMLElement | null = null;
    let drag: { id: number; x: number; y: number; initialX: number; initialY: number } | null = null;
    const apply = () => { image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; status.textContent = `${Math.round(scale * 100)}%`; };
    const reset = () => { scale = 1; x = 0; y = 0; image.classList.remove("original-size"); apply(); };
    const zoom = (delta: number) => { scale = Math.max(0.1, Math.min(10, scale + delta)); apply(); };
    const close = () => { if (dialog.open) dialog.close(); drag = null; image.removeAttribute("src"); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
    toolbar.append(button(t("Zoom out"), () => zoom(-0.2)), status, button(t("Zoom in"), () => zoom(0.2)), button(t("Fit image"), reset), button(t("Original size"), () => { reset(); image.classList.add("original-size"); }), button(t("Close image"), close));
    dialog.append(image, toolbar); document.body.append(dialog);
    utils.insertStyle("viewer", `.reading-image-viewer{position:fixed;inset:0;margin:0;border:0;padding:0;width:100vw;height:100vh;max-width:none;max-height:none;background:#101014f5;color:#fff;overflow:hidden}.reading-image-viewer[open]{display:flex;align-items:center;justify-content:center}.reading-image-viewer::backdrop{background:#101014}.reading-image-viewer>img{max-width:94vw;max-height:85vh;object-fit:contain;cursor:grab;touch-action:none;user-select:none}.reading-image-viewer>img.original-size{max-width:none;max-height:none}.reading-viewer-tools{position:absolute;display:flex;align-items:center;gap:12px;bottom:16px;padding:10px;background:#24242b;z-index:1;flex-wrap:wrap}.reading-viewer-tools button{padding:8px}.reading-viewer-tools output{min-width:4ch;text-align:center}`);
    api.own(() => { close(); dialog.remove(); this.openImage = undefined; });
    this.openImage = target => {
      const source = target.getAttribute("src"); if (!source || !api.root()?.contains(target)) return;
      previous = document.activeElement as HTMLElement; reset(); image.alt = target.alt;
      if (source.startsWith("omarkie-asset:")) { const url = new URL(source); url.searchParams.delete("preview"); image.src = url.href; } else image.src = source;
      if (!dialog.open) dialog.showModal();
      toolbar.querySelector("button")?.focus();
    };
    listen(api, document, "click", ((event: MouseEvent) => {
      if (!(event.target instanceof HTMLImageElement) || !api.root()?.contains(event.target) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault(); event.stopImmediatePropagation(); this.openImage?.(event.target);
    }) as EventListener, true);
    listen(api, document, "dblclick", (event => { if (event.target instanceof HTMLImageElement && api.root()?.contains(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); } }) as EventListener, true);
    listen(api, dialog, "click", event => { if (event.target === dialog) close(); });
    listen(api, dialog, "cancel", event => { event.preventDefault(); close(); });
    listen(api, dialog, "keydown", ((event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      const actions: Record<string, () => void> = { Escape: close, "+": () => zoom(0.2), "=": () => zoom(0.2), "-": () => zoom(-0.2), "0": reset, "1": () => { reset(); image.classList.add("original-size"); }, ArrowLeft: () => { x -= 40; apply(); }, ArrowRight: () => { x += 40; apply(); }, ArrowUp: () => { y -= 40; apply(); }, ArrowDown: () => { y += 40; apply(); } };
      if (actions[event.key]) { event.preventDefault(); event.stopPropagation(); actions[event.key](); }
    }) as EventListener);
    listen(api, dialog, "wheel", ((event: WheelEvent) => { event.preventDefault(); zoom(event.deltaY > 0 ? -0.2 : 0.2); }) as EventListener, { passive: false });
    listen(api, image, "pointerdown", ((event: PointerEvent) => { if (event.button !== 0) return; event.preventDefault(); drag = { id: event.pointerId, x: event.clientX, y: event.clientY, initialX: x, initialY: y }; image.setPointerCapture(event.pointerId); }) as EventListener);
    listen(api, image, "pointermove", ((event: PointerEvent) => { if (!drag || drag.id !== event.pointerId) return; x = drag.initialX + event.clientX - drag.x; y = drag.initialY + event.clientY - drag.y; apply(); }) as EventListener);
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) listen(api, image, name, () => { drag = null; });
    utils.eventHub.on("fileOpened", close);
  }
};
