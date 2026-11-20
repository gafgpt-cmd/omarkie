import test from "node:test";
import assert from "node:assert/strict";
import { requestPayload, setPayloadKey } from "../electron/payload.mjs";
import { payloadEndpoint } from "../shared/payload-endpoint.mjs";
import { t } from "../electron/i18n.mjs";
import { createTranslator } from "../shared/i18n.mjs";

const remote = "https://inference.example.test:8443";
const baseUrl = `${remote}/openai/v1/`;
const source = "Synthetic fixture: a triangle has three sides.";
const request = { baseUrl, confirmedOrigin: remote, allowedOrigin: remote, model: "fixture", source };

test("Payload normalizes the API path and rejects insecure or ambiguous URLs", () => {
  assert.deepEqual(payloadEndpoint(baseUrl), { url: `${remote}/openai/v1/chat/completions`, origin: remote, local: false });
  assert.equal(payloadEndpoint("http://[::1]:11434/v1").local, true);
  for (const input of ["http://localhost.example.test/v1", "https://name@localhost/v1", "https://example.test/v1?q=1", "https://example.test/#", "file:///tmp/v1"]) {
    assert.equal(payloadEndpoint(input), null, input);
  }
});

test("Payload binds consent and the session key to an exact origin; requests are bounded and stateless", async context => {
  const fetch = context.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content: " **Three sides.** " } }] }));
  await assert.rejects(requestPayload({ ...request, allowedOrigin: "https://inference.example.test" }));
  await assert.rejects(requestPayload({ ...request, confirmedOrigin: undefined }));
  await assert.rejects(requestPayload({ ...request, source: "漢".repeat(8001) }));
  await assert.rejects(requestPayload({ ...request, question: "x".repeat(1001) }));
  assert.equal(fetch.mock.callCount(), 0);
  setPayloadKey(baseUrl, "fixture-only");
  try {
    assert.equal(await requestPayload(request), "**Three sides.**");
    const [url, options] = fetch.mock.calls[0].arguments;
    assert.equal(url, `${remote}/openai/v1/chat/completions`);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer fixture-only");
    const summary = JSON.parse(options.body);
    assert.equal(summary.max_tokens, 768);
    assert.deepEqual(summary.messages.slice(1), [{ role: "user", content: source }]);
    const question = "How many sides?";
    await requestPayload({ ...request, baseUrl: "http://127.0.0.1:11434/v1", confirmedOrigin: "http://127.0.0.1:11434", allowedOrigin: undefined, question, modernLimit: true });
    const [, followUp] = fetch.mock.calls[1].arguments;
    assert.equal(followUp.headers.Authorization, undefined);
    const answer = JSON.parse(followUp.body);
    assert.equal(answer.max_completion_tokens, 384);
    assert.deepEqual(answer.messages.slice(1), [{ role: "user", content: source }, { role: "user", content: question }]);
  } finally { setPayloadKey(baseUrl, ""); }
});

test("Payload refuses overlapping requests, oversized responses and provider error bodies", async context => {
  const { promise, resolve } = Promise.withResolvers();
  const fetch = context.mock.method(globalThis, "fetch", () => promise);
  const first = requestPayload(request);
  await assert.rejects(requestPayload(request), { message: t("Wait for the current Payload request to finish.") });
  resolve(new Response("x".repeat(64_001)));
  const failure = t("Payload failed. Check the endpoint, model, and API key.");
  await assert.rejects(first, { message: failure });
  fetch.mock.mockImplementation(async () => new Response("private provider error details", { status: 400 }));
  await assert.rejects(requestPayload(request), { message: failure });
});

test("Payload notices localize in Chinese as well as the English-source catalogs", () => {
  for (const language of ["en", "es", "ca", "ro", "zh"]) {
    const notice = createTranslator(language)("Sends the selected text to {{origin}}.", { origin: remote });
    assert.ok(notice.includes(remote));
    if (language !== "en") assert.notEqual(notice, `Sends the selected text to ${remote}.`);
  }
});
