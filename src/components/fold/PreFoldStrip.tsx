import { useId, useRef } from "react";
import { keeps, setKeep, suggested, type StripChoice, type StripGroup } from "../../../shared/fold-strip.mjs";
import { t } from "../../i18n";
import { stopLabel } from "./stops";

function countLabel(group: StripGroup, count: number) {
  switch (group) {
    case "highlight": return t("{{count}} highlights", { count });
    case "ink": return t("{{count}} ink marks", { count });
    case "card": return t("{{count}} cards", { count });
    case "magnet": return t("{{count}} magnets", { count });
    case "navigation": return t("{{count}} labels and arrows", { count });
    case "redflag": return t("{{count}} red flags", { count });
  }
}

// Local rules, said as they are: the reader sees why each group is suggested.
function reason(group: StripGroup) {
  switch (group) {
    case "highlight": return t("Suggested: keep · you marked them");
    case "ink": return t("Suggested: keep · you circled or underlined them");
    case "card": return t("Suggested: keep · you study them as cards");
    case "magnet": return t("Suggested: keep · your notes explain these lines");
    case "navigation": return t("Suggested: let fold · they point the way, they are not facts");
    case "redflag": return t("Suggested: keep · contraindications, dose limits, warnings");
  }
}

// Pre-fold strip: one quiet line above the first fold line saying what the fold keeps, a checklist to adjust it,
// and highlights still without a card. Nothing here applies itself: every change is the reader's click.
export function PreFoldStrip({ groups, choice, setChoice, open, setOpen, uncarded, makeCards }: {
  groups: readonly { group: StripGroup; count: number }[];
  choice: StripChoice;
  setChoice(next: StripChoice): void;
  open: boolean;
  setOpen(open: boolean): void;
  uncarded: number;
  makeCards(): void;
}) {
  const list = useId(), first = useRef<HTMLInputElement>(null);
  const kept = groups.filter(({ group }) => keeps(choice, group));
  const custom = groups.some(({ group }) => keeps(choice, group) !== suggested(group));
  return <div className="fold-strip-body" role="group" aria-label={t("What the fold keeps")}>
    <div className="fold-strip-line">
      <span className="fold-strip-keeps">{kept.length
        ? t("Fold keeps {{list}}", { list: kept.map(({ group, count }) => countLabel(group, count)).join(" · ") })
        : t("Fold keeps none of your marks")}</span>
      {groups.length > 0 && <button type="button" className="fold-strip-adjust" aria-expanded={open} aria-controls={open ? list : undefined}
        onClick={() => setOpen(!open)}>{t("Adjust")}</button>}
      {uncarded > 0 && <span className="fold-strip-cards">
        <span>{t("{{count}} highlights have no card", { count: uncarded })}</span>
        <button type="button" onClick={makeCards}>{t("Make cards")}</button>
      </span>}
    </div>
    {open && groups.length > 0 && <fieldset id={list} className="fold-strip-list">
      <legend>{t("Ticked marks reach {{level}} in the author's words", { level: stopLabel("takeaway") })}</legend>
      {groups.map(({ group, count }, at) => <label key={group} data-group={group}>
        <input ref={at ? undefined : first} type="checkbox" checked={keeps(choice, group)}
          onChange={event => setChoice(setKeep(choice, [group], event.target.checked))} />
        <span className="fold-strip-name">{countLabel(group, count)}</span>
        <span className="fold-strip-reason">{reason(group)}</span>
      </label>)}
      {custom && <button type="button" className="fold-strip-reset" onClick={() => { setChoice({ ...choice, keep: {} }); first.current?.focus(); }}>
        {t("Use suggestions")}</button>}
    </fieldset>}
  </div>;
}
