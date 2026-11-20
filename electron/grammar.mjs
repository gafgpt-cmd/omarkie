import { grammarEndpoint, grammarTextLimit } from "../shared/grammar.mjs";

export async function checkGrammar(url, approvedOrigin, text) {
  const endpoint = grammarEndpoint(url);
  if (!endpoint || (!endpoint.local && endpoint.origin !== approvedOrigin) ||
      typeof text !== "string" || !text.trim() || text.length > grammarTextLimit) throw new Error("Invalid LanguageTool request");
  const response = await fetch(endpoint.url, {
    method: "POST",
    body: new URLSearchParams({ text, language: "auto" }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const reader = response.body?.getReader();
  if (!response.ok || !reader) { await reader?.cancel(); throw new Error("LanguageTool request failed"); }
  const decoder = new TextDecoder();
  let size = 0, json = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return JSON.parse(json + decoder.decode());
    size += value.length;
    if (size > 2_000_000) { await reader.cancel(); throw new Error("LanguageTool response too large"); }
    json += decoder.decode(value, { stream: true });
  }
}
