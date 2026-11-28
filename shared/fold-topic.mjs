// Topic model (design §3.D): one tree from the fold ladder. Topic cards and the Topic map both draw from it,
// so the two views can never disagree. Lines are the ladder's own stop text, verbatim; nothing is written here.
import { audioEmbed } from "./embeds.mjs";
import { transcriptStamp } from "./voice.mjs";

export const OPENING = "opening";
const EMBED = /^!\[\[([^\]|#^]+)(?:[|#^][^\]]*)?\]\]$/;

/** A lecture note (design §9.5): its first audio embed, and the second each stamped paragraph starts at, in document
 *  order. Null without an audio embed, so a clock at the start of an ordinary line never becomes a seek. */
export function foldLecture(ladder) {
  let audio = null;
  const times = [];
  for (const { unit } of ladder.byUnit) {
    if (unit.raw) {
      const target = audio ? null : EMBED.exec(unit.markdown.trim())?.[1].trim();
      if (target && audioEmbed(target)) audio = { unitId: unit.elementId, target };
      continue;
    }
    const stamp = unit.kind === "heading" ? null : transcriptStamp(unit.markdown);
    if (stamp) times.push({ unitId: unit.elementId, time: stamp.seconds });
  }
  return audio && { ...audio, times };
}

// A heading's own words, without its ATX hashes or setext underline.
export function headingMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").trim().split("\n");
  const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(lines[0]);
  if (atx) return (atx[1] ?? "").trim();
  return lines.filter(line => !/^ {0,3}(?:=+|-+)[ \t]*$/.test(line)).join(" ").trim();
}

/**
 * The note as sections in document order. The note's single leading H1 is its title, not a section; text before the
 * first section heading forms the opening. Each prose unit gives its Topic line, else its Takeaway line; raw blocks
 * (table, code, math, image) give a chip from their metadata, so they never vanish. In a lecture note the audio embed
 * is the player, not an item, and stamped lines carry their second with the stamp moved out of the words.
 */
export function foldTopic(ladder) {
  const units = ladder.byUnit, audio = foldLecture(ladder);
  const timeOf = new Map(audio?.times.map(({ unitId, time }) => [unitId, time]));
  const headings = units.filter(({ unit }) => unit.kind === "heading");
  const first = headings[0]?.unit;
  const titled = !!first && first.level === 1 && headings.filter(({ unit }) => unit.level === 1).length === 1
    && units.slice(0, units.findIndex(({ unit }) => unit === first)).every(({ unit, stops }) => unit.raw === null && !stops.takeaway);
  const title = titled ? { unitId: first.elementId, markdown: headingMarkdown(first.markdown) } : null;
  const opening = { id: OPENING, heading: null, level: 0, line: units[0]?.unit.line ?? 1, parent: null, anchor: null, items: [], children: [], time: null };
  const sections = [opening], stack = [];
  let current = opening;
  for (const { unit, stops } of units) {
    if (unit.kind === "heading") {
      if (title && unit.elementId === title.unitId) continue;
      const level = unit.level ?? 1;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const parent = stack[stack.length - 1] ?? null;
      current = { id: unit.elementId, heading: headingMarkdown(unit.markdown), level, line: unit.line, parent: parent?.id ?? null, anchor: unit.elementId, items: [], children: [], time: null };
      parent?.children.push(current.id);
      sections.push(current);
      stack.push(current);
      continue;
    }
    if (unit.elementId === audio?.unitId) continue;
    const time = timeOf.get(unit.elementId) ?? null;
    if (time !== null) current.time ??= time;
    if (unit.raw && unit.rawMeta) current.items.push({ kind: "raw", unitId: unit.elementId, line: unit.line, raw: { ...unit.rawMeta } });
    else {
      let markdown = stops.topic || stops.takeaway;
      const stamp = time === null ? null : transcriptStamp(markdown);
      if (stamp) markdown = markdown.slice(stamp.length);
      if (markdown) current.items.push({ kind: "line", unitId: unit.elementId, line: unit.line, markdown, time });
    }
    if (current === opening && !opening.anchor && current.items.length) opening.anchor = current.items[0].unitId;
  }
  if (!opening.items.length) sections.shift();
  return { title, sections, audio };
}

/** The sections that get a card: every one with its own items, and every leaf heading. Branch-only headings live
 *  on as the eyebrow of their children. */
export function topicCards(topic) {
  const byId = new Map(topic.sections.map(section => [section.id, section]));
  return topic.sections
    .filter(section => section.items.length || (section.id !== OPENING && !section.children.length))
    .map(section => ({ section, eyebrow: section.parent ? byId.get(section.parent).heading : null }));
}

/** The card the reader is in at a source line: the last card section starting at or before it. */
export function topicCardAt(topic, line) {
  const cards = topicCards(topic);
  let found = cards[0]?.section ?? null;
  for (const { section } of cards) { if (section.line > line) break; found = section; }
  return found;
}
