import { AGENTS } from "../../shared/fold-format.mjs";
import { foldRoute, type FoldSlotSetting, type SlotRoute } from "../../shared/fold-route.mjs";
import { t } from "../i18n";
import type { Preferences } from "../preferences";

// Estudio keeps its stored route; its row appears with the Estudio engine.
const shownSlots = ["ladder"] as const;
const agentNames: Record<FoldSlotSetting["agent"], string> = { claude: "Claude Code", codex: "Codex", opencode: "opencode" };

/** Where a destination is, in words: an agent's own service or a Payload origin. */
function place(destination: string) {
  const agent = /^agent:(\w+)$/.exec(destination)?.[1] as FoldSlotSetting["agent"] | undefined;
  return agent ? t("{{agent}} (its own service)", { agent: agentNames[agent] ?? agent }) : destination;
}

/** Backtick spans in a translated note render as code, so translators keep one sentence. */
const withCode = (text: string) => text.split("`").map((part, index) => index % 2 ? <code key={index}>{part}</code> : part);

export function FoldSettings({ value, change }: { value: Preferences; change(next: Preferences): void }) {
  const update = (slot: (typeof shownSlots)[number], patch: Partial<FoldSlotSetting>) =>
    change({ ...value, foldSlots: { ...value.foldSlots, [slot]: { ...value.foldSlots[slot], ...patch } } });
  return <fieldset data-fold-settings>
    <legend>{t("Fold", { context: "settings" })}</legend>
    <p className="dialog-note">{t("Fold writes shorter lines for each section of a note. Local fold calls no model; a model route is opt-in, slot by slot.")}</p>
    {shownSlots.map(slot => {
      const setting = value.foldSlots[slot];
      const route = foldRoute({ slot, preferences: value });
      const { kind, destination } = route.egress;
      const allowed = kind === "remote" && destination !== null && setting.allow === destination;
      const state = kind === "remote" && !allowed ? "blocked" : kind;
      const chip = kind === "none" ? t("Stays on this computer")
        : kind === "loopback" ? t("Loopback: {{origin}}", { origin: destination ?? "" })
        : destination === null ? t("Blocked until the Payload URL is valid")
        : allowed ? t("Leaves this computer: {{destination}}", { destination: place(destination) })
        : t("Blocked until you allow {{destination}}", { destination: place(destination) });
      return <div className="fold-slot" data-fold-slot={slot} key={slot}>
        <div className="fold-slot-head">
          <span>{t("Ladder: Key, Takeaway, Topic")}</span>
          <span className="fold-egress" data-egress={state} role="status" aria-label={t("Where note text goes")}>{chip}</span>
        </div>
        <label className="workspace-field">{t("Model route")}
          <select value={setting.route} onChange={e => update(slot, { route: e.target.value as SlotRoute })}>
            <option value="local">{t("Local only: no model call")}</option>
            <option value="agent">{t("Agent session on this computer")}</option>
            <option value="payload">{t("Payload endpoint")}</option>
          </select>
        </label>
        {setting.route === "agent" && <>
          <div className="form-grid">
            <label>{t("Agent")}<select value={setting.agent} onChange={e => update(slot, { agent: e.target.value as FoldSlotSetting["agent"] })}>
              {AGENTS.map(agent => <option key={agent} value={agent}>{agentNames[agent]}</option>)}
            </select></label>
            <label>{t("Model")}<input spellCheck={false} maxLength={256} value={setting.agentModel} onChange={e => update(slot, { agentModel: e.target.value })} /></label>
          </div>
          <p className="dialog-note">{withCode(t("The agent folds under its own login: run `omarkie-axi fold poll --wait` in its session. Omarkie reads no API key."))}</p>
        </>}
        {setting.route === "payload" && <>
          <label className="workspace-field">{t("Model")}<input spellCheck={false} maxLength={256} placeholder={value.payloadModel} value={setting.payloadModel} onChange={e => update(slot, { payloadModel: e.target.value })} /></label>
          <p className="dialog-note">{t("Empty uses the Payload model.")}</p>
          {route.code === "FOLD_PAYLOAD_UNSET" && <p className="form-error">{t("Enable Payload and allow its endpoint above first.")}</p>}
        </>}
        {route.code === "FOLD_MODEL_UNSET" && <p className="form-error">{t("Name a model for this route.")}</p>}
        {kind === "remote" && destination !== null && <>
          <label className="checkbox-option">
            <input type="checkbox" checked={allowed} onChange={e => update(slot, { allow: e.target.checked ? destination : null })} />
            {t("Allow this slot to send note text to {{destination}}", { destination: place(destination) })}
          </label>
          <p className="dialog-note">{t("Note text leaves this computer. Do not send identifiable medical data.")}</p>
        </>}
      </div>;
    })}
    <p className="dialog-note">{t("A vault set to never go online runs only local and loopback routes.")}</p>
  </fieldset>;
}
