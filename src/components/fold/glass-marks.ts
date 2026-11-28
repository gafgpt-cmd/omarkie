// Glass magnets as fold marks, each resolved to the line it rides the way the page resolves it:
// exact block, then the landmark resolver; a guess the tray must confirm keeps no line.
import { indexBlocks, liveBlocks, type GlassAnchor } from "../../glass/anchor-map";
import type { GlassMagnet } from "../../glass/glass-model";
import { anchorFrom } from "../../glass/glass-state";
import { inkStrokeFromMagnet } from "../../glass/ink-model";
import { bulkReanchor } from "../../glass/reanchor";
import type { ReadingContext } from "../../editor/MarkdownEditor";
import type { FoldMark, MagnetType } from "./fold-marks";

const magnetTypes: Readonly<Record<string, MagnetType>> = {
  clip: "clip", "extra-page": "clip", card: "card", image: "image", sticker: "image", cutout: "image", trace: "image",
  arrow: "arrow", label: "label", "sheet-label": "label", comment: "comment", voice: "voice",
};

const words = (value: unknown) => typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, 120) : "";

// A clip folds to its title; any other magnet shows the words it carries, if any.
function magnetText(fields: Record<string, unknown>, type: MagnetType) {
  if (type === "clip") return words(fields.title) || words(fields.text);
  return words(fields.text) || words(fields.title) || words(fields.label) || words(fields.question) || words(fields.name);
}

// An arrow has no anchor of its own; it rides the paragraph one of its ends is tied to.
function endAnchor(value: unknown) {
  return value && typeof value === "object" && "anchor" in value ? anchorFrom(value.anchor) : undefined;
}

export function glassMarks(magnets: readonly GlassMagnet[], context: ReadingContext | undefined): FoldMark[] {
  const blocks = liveBlocks(context, document.createElement("div")), index = indexBlocks(blocks);
  const marks: FoldMark[] = [], entries: { id: string; anchor: GlassAnchor }[] = [];
  for (const magnet of magnets) {
    if (magnet.deleted) continue;
    const fields = magnet.fields ?? {}, kind = String(fields.kind ?? magnet.kind ?? "");
    if (kind === "ink") {
      const stroke = inkStrokeFromMagnet(magnet);
      stroke?.parts.forEach((part, at) => {
        const id = `${stroke.id}:${at}`;
        marks.push({ id, kind: "ink", line: null, ink: { stroke: stroke.id, tool: stroke.tool, color: stroke.color, size: stroke.size, part } });
        entries.push({ id, anchor: part.anchor });
      });
      continue;
    }
    const anchor = anchorFrom(fields.anchor) ?? endAnchor(fields.from) ?? endAnchor(fields.to);
    const type = magnetTypes[kind] ?? "other";
    marks.push(kind === "sticky"
      ? { id: magnet.id, kind: "sticky", line: null, text: words(fields.text) }
      : { id: magnet.id, kind: "magnet", line: null, type, text: magnetText(fields, type) });
    if (anchor?.landmarks.length) entries.push({ id: magnet.id, anchor });
  }
  const rows = new Map(bulkReanchor(entries, blocks, index).map(row => [row.id, row]));
  for (const mark of marks) {
    const row = rows.get(mark.id);
    if (!row || row.state === "tray") continue;
    mark.line = row.line;
    if (row.state === "check") mark.check = true;
  }
  return marks;
}
