import { useState } from "react";
import { payloadEndpoint } from "../../shared/payload-endpoint.mjs";
import { host } from "../host";
import { t } from "../i18n";
import type { Preferences } from "../preferences";

export function PayloadSettings({ value, change }: { value: Preferences; change(next: Preferences): void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const endpoint = payloadEndpoint(value.payloadBaseUrl);
  async function storeKey(next: string) {
    setBusy(true);
    try {
      await host.payloadKey!(value.payloadBaseUrl, next.trim());
      setKey("");
      setFailed(false);
      setStatus(next ? t("API key set for this session.") : t("API key cleared."));
    } catch (error) {
      setFailed(true);
      setStatus((error as Error).message);
    } finally { setBusy(false); }
  }
  return <fieldset>
    <legend>{t("Payload")}</legend>
    <label className="checkbox-option"><input type="checkbox" checked={value.payloadEnabled} onChange={e => change({ ...value, payloadEnabled: e.target.checked })} />{t("Enable Payload")}</label>
    {value.payloadEnabled && <>
      <label className="workspace-field">{t("Payload base URL")}<input type="url" spellCheck={false} maxLength={2048} value={value.payloadBaseUrl} onChange={e => { setKey(""); setStatus(""); change({ ...value, payloadBaseUrl: e.target.value }); }} /></label>
      {!endpoint && <p className="form-error">{t("Use a loopback URL or an HTTPS base URL without credentials, queries, or fragments.")}</p>}
      <label className="workspace-field">{t("Payload model")}<input spellCheck={false} maxLength={256} value={value.payloadModel} onChange={e => change({ ...value, payloadModel: e.target.value })} /></label>
      <label className="checkbox-option"><input type="checkbox" checked={value.payloadModernLimit} onChange={e => change({ ...value, payloadModernLimit: e.target.checked })} />{t("Use max_completion_tokens instead of max_tokens")}</label>
      <label className="workspace-field">{t("Payload API key (optional)")}<input type="password" autoComplete="off" spellCheck={false} maxLength={2048} disabled={busy} value={key} onChange={e => setKey(e.target.value)} /></label>
      <p className="dialog-note">{t("The key stays in memory for this origin until you quit or clear it.")}</p>
      <button type="button" disabled={!endpoint || !key.trim() || busy} onClick={() => void storeKey(key)}>{t("Set session key")}</button>
      <button type="button" disabled={busy} onClick={() => void storeKey("")}>{t("Clear session key")}</button>
      {status && <p role={failed ? "alert" : "status"} className={failed ? "form-error" : "dialog-note"}>{status}</p>}
      {endpoint && !endpoint.local && <label className="checkbox-option">
        <input type="checkbox" checked={value.payloadAllowedOrigins.includes(endpoint.origin)} onChange={e => change({ ...value, payloadAllowedOrigins: e.target.checked ? [endpoint.origin, ...value.payloadAllowedOrigins].slice(0, 50) : value.payloadAllowedOrigins.filter(origin => origin !== endpoint.origin) })} />
        {t("Allow Payload requests to {{origin}}", { origin: endpoint.origin })}
      </label>}
    </>}
  </fieldset>;
}
