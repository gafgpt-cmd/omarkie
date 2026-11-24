import { payloadEndpoint, payloadInputBytes, payloadQuestionLength } from "../shared/payload-endpoint.mjs";
import { t } from "./i18n.mjs";
import recipe from "../shared/payload-recipe.json" with { type: "json" };

let credential;
let pending = false;

export function setPayloadKey(baseUrl, value) {
  if (value === "") { credential = undefined; return; }
  const endpoint = payloadEndpoint(baseUrl);
  if (!endpoint || typeof value !== "string" || !/^[\x21-\x7e]{1,2048}$/.test(value)) throw new Error(t("Invalid Payload endpoint or API key."));
  credential = { origin: endpoint.origin, value };
}

export async function requestPayload(request) {
  const { baseUrl, confirmedOrigin, allowedOrigin, model, source, question, modernLimit, proposal } = request ?? {};
  const endpoint = payloadEndpoint(baseUrl);
  if (!endpoint || endpoint.origin !== confirmedOrigin || (!endpoint.local && endpoint.origin !== allowedOrigin) || typeof model !== "string" || !model.trim() || model.length > 256) {
    throw new Error(t("Configure and allow the Payload endpoint in Preferences."));
  }
  if (typeof source !== "string" || source.length > payloadInputBytes || !source.trim() || Buffer.byteLength(source) > payloadInputBytes || (question !== undefined && (typeof question !== "string" || !question.trim() || question.length > payloadQuestionLength))) {
    throw new Error(t("Use non-empty text up to 24 KB and a question up to 1,000 characters."));
  }
  if (proposal !== undefined && (proposal !== true || question === undefined)) throw new Error(t("Use non-empty text up to 24 KB and a question up to 1,000 characters."));
  if (pending) throw new Error(t("Wait for the current Payload request to finish."));
  pending = true;
  try {
    const messages = [
      { role: "system", content: proposal ? recipe.proposal : question === undefined ? recipe.summary : `${recipe.summary}\n${recipe.followUp}` },
      { role: "user", content: source },
    ];
    if (question !== undefined) messages.push({ role: "user", content: question });
    const headers = { "Content-Type": "application/json" };
    if (credential?.origin === endpoint.origin) headers.Authorization = `Bearer ${credential.value}`;
    const response = await fetch(endpoint.url, {
      method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({ model: model.trim(), messages, stream: false, [modernLimit === true ? "max_completion_tokens" : "max_tokens"]: question === undefined ? 768 : 384 }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    const decoder = new TextDecoder();
    let bytes = 0, body = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 64_000) throw new Error();
        body += decoder.decode(value, { stream: true });
      }
    } finally { await reader.cancel(); }
    const text = JSON.parse(body + decoder.decode())?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error();
    return text.trim();
  } catch {
    throw new Error(t("Payload failed. Check the endpoint, model, and API key."));
  } finally { pending = false; }
}
