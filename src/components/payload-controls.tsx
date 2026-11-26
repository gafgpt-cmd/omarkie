import MarkdownIt from "markdown-it";
import mark from "markdown-it-mark";
import { payloadEndpoint, payloadInputBytes } from "../../shared/payload-endpoint.mjs";
import { t } from "../i18n";
import type { Preferences } from "../preferences";

const preview = new MarkdownIt({ html: false, breaks: true }).use(mark).disable(["image", "link", "autolink", "reference"]);
export const renderPayload = (text: string) => preview.render(text);
export const validPayloadSource = (source: string) => source.length <= payloadInputBytes && !!source.trim() && new TextEncoder().encode(source).length <= payloadInputBytes;

export function payloadConnection(preferences: Preferences) {
  const endpoint = payloadEndpoint(preferences.payloadBaseUrl);
  if (!preferences.payloadEnabled || !endpoint || !preferences.payloadModel.trim() ||
      (!endpoint.local && !preferences.payloadAllowedOrigins.includes(endpoint.origin))) return undefined;
  return {
    baseUrl: preferences.payloadBaseUrl, confirmedOrigin: endpoint.origin, ...(endpoint.local ? {} : { allowedOrigin: endpoint.origin }),
    model: preferences.payloadModel, modernLimit: preferences.payloadModernLimit,
  };
}

export function PayloadNotice({ origin, enabled, selection, paragraph, configure }: {
  origin?: string; enabled: boolean; selection?: boolean; paragraph?: boolean; configure(): void;
}) {
  return origin ? <div className="payload-notice" id="payload-send-notice">
    <p>{paragraph ? t("Sends this paragraph and your request to {{origin}}.", { origin }) : selection ?
      t("Sends the selected text to {{origin}}.", { origin }) : t("Sends this note’s text to {{origin}}.", { origin })}</p>
    <p>{t("Do not send identifiable medical data. Even a local server can forward requests.")}</p>
  </div> : <p id="payload-send-notice">{t(enabled ? "Configure and allow the Payload endpoint in Preferences." : "Enable Payload")} <button type="button" onClick={configure}>{t("偏好设置")}</button></p>;
}
