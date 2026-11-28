// Spaced Repetition port: imports cards written in the Spaced Repetition plugin's note syntax into Study cards.
// Card syntax from st3v3nmw/obsidian-spaced-repetition and clozecraft (MIT); see third-party/obsidian-ports/NOTICE.
// Notes are only read. Cards are proposed for review; saving and scheduling stay with Study cards.
import { t } from "../../i18n.ts";
import type { PortContext } from "./capabilities.ts";
import { BOLD_CLOZE, cardDrafts, CURLY_CLOZE, defaultSyntax, HIGHLIGHT_CLOZE, type CardSyntax } from "./srs-cards.ts";

export function syntaxFrom(config: Record<string, unknown>): CardSyntax {
  const text = (key: string, fallback: string) => typeof config[key] === "string" ? config[key] : fallback;
  const clozes: [string, string][] = [["HIGHLIGHT_CLOZE", HIGHLIGHT_CLOZE], ["BOLD_CLOZE", BOLD_CLOZE], ["CURLY_CLOZE", CURLY_CLOZE]];
  return {
    singleLine: text("SINGLE_LINE", defaultSyntax.singleLine),
    singleLineReversed: text("SINGLE_LINE_REVERSED", defaultSyntax.singleLineReversed),
    multiline: text("MULTILINE", defaultSyntax.multiline),
    multilineReversed: text("MULTILINE_REVERSED", defaultSyntax.multilineReversed),
    endMarker: text("END_MARKER", defaultSyntax.endMarker),
    clozePatterns: clozes.filter(([key]) => config[key] ?? key === "HIGHLIGHT_CLOZE").map(([, pattern]) => pattern),
  };
}

export default ({ BasePlugin, utils }: PortContext) => class SpacedRepetition extends BasePlugin {
  staticActions = [{ act_value: "import", act_name: t("Import flashcards from this note") }];

  hotkey() {
    const hotkey = this.config.HOTKEY;
    return typeof hotkey === "string" && hotkey ? [{ hotkey, callback: () => this.call("import") }] : [];
  }

  // Failures are reported, not thrown: a thrown error would turn the plugin off.
  call(action?: string) {
    if (action !== "import") return;
    try {
      const drafts = cardDrafts(utils.ports.note.active().content, syntaxFrom(this.config));
      if (!drafts.length) { utils.notification.show(t("No Spaced Repetition cards in this note. Write Question::Answer, a ? line between question and answer, or ==cloze==.")); return; }
      utils.ports.cards.draft(drafts, drafts.length);
    } catch (error) { utils.notification.show((error as Error).message); }
  }
};
