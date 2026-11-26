import type { PageElement } from "../../shared/element-model.mjs";

const nestedKinds = new Set(["list-item", "table-cell", "image", "embed"]);

// One element → one DOM node: the halo boxes it, a comment bubble anchors to it.
export function elementNode(root: HTMLElement, element: PageElement, elements: PageElement[]) {
  const block = root.querySelector<HTMLElement>(`[data-cid][data-line="${element.blockLine}"]`);
  if (!block) return null;
  if (!nestedKinds.has(element.kind)) return block;
  const inBlock = elements.filter(other => other.blockLine === element.blockLine);
  if (element.kind === "table-cell") {
    const at = inBlock.filter(other => other.kind === "table-cell").indexOf(element);
    return block.querySelectorAll<HTMLElement>("td, th")[at] ?? block;
  }
  if (element.kind === "list-item") {
    const at = inBlock.filter(other => other.kind === "list-item").indexOf(element);
    return block.querySelectorAll<HTMLElement>("li")[at] ?? block;
  }
  const at = inBlock.filter(other => other.kind === "image" || other.kind === "embed").indexOf(element);
  return block.querySelectorAll<HTMLElement>("img")[at] ?? block;
}
