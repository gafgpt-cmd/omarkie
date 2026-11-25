// G18 labels and reading order: shared by the export builder and the export dialog,
// so the cheatsheet order on screen is the order written to disk.
import { stickerName } from "./glass-art.mjs";

export const kindOf = magnet => magnet?.fields?.kind ?? magnet?.kind ?? "";

const label = (kind, fields) => {
  if (kind === "sticky") return String(fields.text ?? "").split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 60) || "Sticky note";
  if (kind === "comment") return "Comment";
  if (kind === "card") {
    const title = String(fields.title ?? "").trim();
    if (title) return title.slice(0, 60);
    return fields.card === "menu" ? "Menu card" : fields.card === "ai" ? "AI card" : "Card";
  }
  if (kind === "image") return String(fields.name ?? "").trim() || "Picture";
  if (kind === "ink") return "Ink";
  if (kind === "sticker") return stickerName(fields.sticker);
  if (kind === "arrow") return "Arrow";
  return kind ? `${kind} magnet` : "Magnet";
};
export const magnetLabel = (kind, fields = {}) => label(kind, fields);

export function sourceQuote(fields = {}) {
  const landmarks = Array.isArray(fields.anchor?.landmarks) ? fields.anchor.landmarks : [];
  const block = landmarks.find(landmark => landmark?.kind === "block" && typeof landmark.block === "string");
  if (block) return { quote: block.block.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 160) ?? "", line: block.line ?? null };
  const quote = landmarks.find(landmark => landmark?.kind === "quote" && typeof landmark.value?.exact === "string");
  if (quote) return { quote: quote.value.exact.split(/\r?\n/).find(line => line.trim())?.slice(0, 160) ?? "", line: null };
  if (fields.source && typeof fields.source.line === "number") return { quote: "", line: fields.source.line };
  return { quote: "", line: null };
}

export function anchorLine(fields = {}) {
  const source = sourceQuote(fields);
  if (source.line !== null) return source.line;
  const landmarks = Array.isArray(fields.anchor?.landmarks) ? fields.anchor.landmarks : [];
  const position = landmarks.find(landmark => landmark?.kind === "position");
  return position?.value?.line ?? Number.MAX_SAFE_INTEGER;
}

// Reading order: anchored paragraphs first, then the magnet offset inside its paragraph.
export function readingOrder(magnets) {
  return [...magnets].map((magnet, index) => ({ magnet, index })).sort((left, right) => {
    const line = anchorLine(left.magnet.fields) - anchorLine(right.magnet.fields);
    if (line) return line;
    const y = (Number(left.magnet.fields?.y) || 0) - (Number(right.magnet.fields?.y) || 0);
    if (y) return y;
    const x = (Number(left.magnet.fields?.x) || 0) - (Number(right.magnet.fields?.x) || 0);
    if (x) return x;
    return left.index - right.index;
  }).map(item => item.magnet);
}

function arrowEndLabel(end, magnets) {
  if (end?.kind === "magnet") {
    const magnet = magnets.find(item => item.id === end.magnet);
    if (!magnet) return `magnet ${end.magnet}`;
    return magnetLabel(kindOf(magnet), magnet.fields);
  }
  if (end?.kind === "element") return sourceQuote({ anchor: end.anchor }).quote || "page element";
  return "page element";
}

export function arrowConnections(magnets) {
  return magnets.filter(magnet => kindOf(magnet) === "arrow").map(magnet => ({
    magnet, from: arrowEndLabel(magnet.fields.from, magnets), to: arrowEndLabel(magnet.fields.to, magnets),
    label: String(magnet.fields.label ?? "").trim(),
  }));
}
