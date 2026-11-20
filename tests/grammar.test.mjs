import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { checkGrammar } from "../electron/grammar.mjs";
import { grammarDefault, grammarEndpoint, grammarMatches } from "../shared/grammar.mjs";

test("only loopback may use HTTP; remote approval is exact scheme, host and port", async () => {
  assert.equal(grammarEndpoint(grammarDefault)?.local, true);
  assert.equal(grammarEndpoint("http://[::1]:8081/v2/check")?.local, true);
  for (const url of ["http://language.invalid/v2/check", "file:///v2/check", "https://user@language.invalid/v2/check", "https://language.invalid/v2/check?text=x", "https://language.invalid/v2/check#", "https://language.invalid/v2"]) assert.equal(grammarEndpoint(url), null, url);
  const endpoint = "https://language.invalid:8443/v2/check";
  assert.equal(grammarEndpoint(endpoint)?.origin, "https://language.invalid:8443");
  for (const approved of ["", "https://language.invalid", "https://other.invalid:8443"]) await assert.rejects(checkGrammar(endpoint, approved, "Example."), /Invalid LanguageTool request/);
});

test("POST sends text exactly once without following a redirect", async () => {
  const called = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request.setEncoding("utf8")) body += chunk;
    called.push([request.method, request.url, new URLSearchParams(body).get("text"), new URLSearchParams(body).get("language")]);
    response.writeHead(307, { location: "/redirect-target" }).end();
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const endpoint = `http://127.0.0.1:${server.address().port}/v2/check`;
    await assert.rejects(checkGrammar(endpoint, "", "A😀 + &?"));
    assert.deepEqual(called, [["POST", "/v2/check", "A😀 + &?", "auto"]]);
  } finally { server.close(); }
});

test("invalid ranges cannot split UTF-16 pairs or escape the input", () => {
  const match = (offset, length, ...fixes) => ({ offset, length, message: "Test finding", replacements: fixes.map(value => ({ value })) });
  assert.deepEqual(grammarMatches({ matches: [match(1, 2, "x"), match(2, 1, ""), match(-1, 1), match(3, 5), match(3, 2, " ok", " ok", "\n", "")] }, "A😀 no"), [
    { from: 1, to: 3, message: "Test finding", fixes: ["x"] },
    { from: 3, to: 5, message: "Test finding", fixes: [" ok", ""] },
  ]);
});
