export interface ReadingAPI {
  root(): HTMLElement | null;
  own(cleanup: () => void): void;
  onPaint(callback: () => void): void;
  documentId(): string;
  headings(): { line: number; level: number; text: string; id: string }[];
  jump(line: number): void;
  imageOffset(image: HTMLImageElement): number | undefined;
  selection(): { from: number; to: number; context: string } | undefined;
  editable(): boolean;
  replaceRange(from: number, to: number, text: string, expected: string): boolean;
  width(): number;
  setWidth(columns: number): void;
}
export function listen(api: ReadingAPI, target: EventTarget, name: string, callback: EventListener, options?: AddEventListenerOptions | boolean) {
  target.addEventListener(name, callback, options);
  api.own(() => target.removeEventListener(name, callback, options));
}
export function blockKey(element: Element, selector: string) {
  const block = element.closest("[data-cid]");
  return `${block?.getAttribute("data-cid") || ""}:${block === element ? 0 : [...(block?.querySelectorAll(selector) || [])].indexOf(element)}`;
}
export function button(label: string, action: () => void) {
  const node = document.createElement("button");
  node.type = "button"; node.textContent = label; node.setAttribute("aria-label", label);
  node.contentEditable = "false"; node.className = "md-ui";
  node.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); action(); });
  node.addEventListener("pointerdown", event => event.stopPropagation());
  node.addEventListener("keydown", event => { if (node.closest(".rich-document")) event.stopPropagation(); });
  return node;
}
