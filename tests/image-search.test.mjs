import assert from "node:assert/strict";
import { test } from "node:test";
import { searchCommons, searchOpenverse, searchOnline } from "../electron/image-search.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNNsAAAAASUVORK5CYII=";

function commonsPage(thumb) {
  return { query: { pages: [{
    title: "File:Median nerve.png",
    descriptionurl: "https://commons.wikimedia.org/wiki/File:Median_nerve.png",
    imageinfo: [{
      url: "https://upload.wikimedia.org/original.png", thumburl: thumb,
      width: 1_200, height: 800, size: 40_000_000,
      extmetadata: {
        ObjectName: { value: "Median nerve" },
        Artist: { value: "R. Descartes" },
        LicenseShortName: { value: "CC BY 4.0" },
        UsageTerms: { value: "" },
      },
    }],
  }] } };
}

test("a picture search fetches one preview and never the original, and stops at the thumbnail cap", async () => {
  const calls = [];
  let read = false, cancelled = false;
  const fetchImpl = async address => {
    calls.push(String(address));
    if (String(address).includes("/w/api.php")) return Response.json(commonsPage("https://upload.wikimedia.org/thumb.png"));
    const body = new ReadableStream({
      pull(controller) { read = true; controller.error(new Error("the body must not be read")); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    return new Response(body, { headers: { "content-type": "image/jpeg", "content-length": "9000000" } });
  };
  const rows = await searchCommons("median nerve", { fetchImpl });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].preview, null, "an oversized thumbnail is refused");
  assert.equal(read, false, "an oversized thumbnail is never buffered");
  assert.equal(cancelled, true, "the oversized body is cancelled");
  assert.equal(calls.length, 2, "one search call and one preview call");
  assert.equal(calls.some(address => address.includes("original.png")), false, "originals are never downloaded");
  assert.deepEqual(rows[0].licence, { code: "by", version: "4.0", url: null, attribution: "R. Descartes", required: true });
  assert.equal(rows[0].downloadUrl, "https://upload.wikimedia.org/original.png");
});

test("a thumbnail within the cap is kept byte-exact with its media type", async () => {
  const bytes = Buffer.from(png, "base64");
  const fetchImpl = async address => String(address).includes("/w/api.php")
    ? Response.json(commonsPage("https://upload.wikimedia.org/thumb.png"))
    : new Response(bytes, { headers: { "content-type": "image/png; charset=binary" } });
  const [row] = await searchCommons("median nerve", { fetchImpl });
  assert.deepEqual(row.preview, { base64: bytes.toString("base64"), mime: "image/png" });
});

test("Openverse is asked only for the allow-listed licences and never for mature results", async () => {
  let asked;
  const fetchImpl = async address => { asked = new URL(String(address)); return Response.json({ results: [] }); };
  assert.deepEqual(await searchOpenverse("nerve", { fetchImpl }), []);
  assert.equal(asked.origin, "https://api.openverse.org");
  assert.equal(asked.searchParams.get("license"), "cc0,by,by-sa");
  assert.equal(asked.searchParams.get("mature"), "false");
});

test("one failing source names itself and the other still answers", async () => {
  const calls = [];
  const fetchImpl = async address => {
    calls.push(new URL(String(address)));
    if (String(address).includes("commons.wikimedia.org")) return new Response("down", { status: 500 });
    return Response.json({ results: [] });
  };
  const result = await searchOnline("nerve", { fetchImpl });
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.errors.map(error => error.source), ["commons"]);
  assert.equal(calls.at(-1).origin, "https://api.openverse.org", "the second source still runs");
  assert.equal(calls.some(address => address.protocol !== "https:"), false);
});

test("an API redirect never carries the query to another host", async t => {
  const { createServer } = await import("node:http");
  const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  let asked = 0, leaked = 0;
  const sink = createServer((request, response) => { leaked += 1; response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); });
  const sinkPort = await listen(sink);
  const api = createServer((request, response) => {
    asked += 1;
    response.writeHead(302, { location: `http://127.0.0.1:${sinkPort}/collect${request.url}` });
    response.end();
  });
  const apiPort = await listen(api);
  t.after(() => { sink.close(); api.close(); });
  process.env.OMARKIE_SWAP_COMMONS = `http://127.0.0.1:${apiPort}/w/api.php`;
  try {
    const result = await searchOnline("median nerve of a patient", { sources: ["commons"] });
    assert.deepEqual(result.candidates, []);
    assert.equal(asked, 1, "the allow-listed endpoint is asked once");
    assert.equal(leaked, 0, "the query is never forwarded to the redirect target");
  } finally { delete process.env.OMARKIE_SWAP_COMMONS; }
});
