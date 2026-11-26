// A swap candidate can arrive from an agent, so its downloadUrl is untrusted input: it must be a
// host Omarkie itself searches, the vault's "never online" switch must stop it, and a redirect must
// never carry the request somewhere else.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GlassService } from "../electron/glass-service.mjs";
import { markdownElements } from "../shared/element-model.mjs";
import { writeGlassSettings } from "../electron/glass-state.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const source = "# Dose\n\nSecond paragraph with the swap target.\n";

async function vault() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-egress-"));
  const folder = path.join(root, "vault"), appData = path.join(root, "app-data");
  await mkdir(folder, { recursive: true });
  await mkdir(appData, { recursive: true });
  await writeFile(path.join(folder, "dose.md"), source);
  const service = await new GlassService({ root: folder, appData, device: "egress-device" }).open();
  return { folder, appData, service, element: markdownElements(source).find(row => row.text.startsWith("Second")) };
}

async function server(get) {
  const requests = [];
  const http = createServer(async (request, response) => {
    requests.push(request.url);
    if (get) return get(request, response);
    response.writeHead(200, { "content-type": "image/png" });
    response.end(png);
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${http.address().port}`, requests, close: () => new Promise(resolve => http.close(resolve)) };
}

const candidate = (downloadUrl) => ({ id: "cand-1", kind: "find", title: "dot.png", source: "vault", sourceLabel: "your vault",
  width: 640, height: 480, licence: { code: "own", required: false }, downloadUrl });

test("a candidate pointing at a host Omarkie does not use is refused before any request", async () => {
  const { service, element } = await vault();
  const local = await server();
  try {
    await assert.rejects(service.request({ action: "swap-apply", note: "dose.md", element: element.id, candidate: candidate(`${local.url}/dot.png`) }),
      error => error.code === "SOURCE_NOT_ALLOWED");
    assert.deepEqual(local.requests, [], "nothing was fetched from an unlisted host");
  } finally { await local.close(); await service.close(); }
});

test("a never-online vault refuses the download even from a listed host", async () => {
  const { folder, appData, service, element } = await vault();
  const local = await server();
  const previous = process.env.OMARKIE_SWAP_OPENVERSE;
  process.env.OMARKIE_SWAP_OPENVERSE = `${local.url}/v1/images/`;
  try {
    await writeGlassSettings(folder, { neverOnline: true }, { appData });
    await assert.rejects(service.request({ action: "swap-apply", note: "dose.md", element: element.id, candidate: candidate(`${local.url}/dot.png`) }),
      error => error.code === "SOURCE_OFFLINE");
    assert.deepEqual(local.requests, [], "never-online means no request leaves the machine");
  } finally {
    if (previous === undefined) delete process.env.OMARKIE_SWAP_OPENVERSE; else process.env.OMARKIE_SWAP_OPENVERSE = previous;
    await local.close();
    await service.close();
  }
});

test("a configured picture source is allowed and the picture lands in the vault", async () => {
  const { service, element } = await vault();
  const local = await server();
  const previous = process.env.OMARKIE_SWAP_OPENVERSE;
  process.env.OMARKIE_SWAP_OPENVERSE = `${local.url}/v1/images/`;
  try {
    const applied = await service.request({ action: "swap-apply", note: "dose.md", element: element.id, mode: "cover", candidate: candidate(`${local.url}/dot.png`) });
    assert.equal(applied.applied, true);
    assert.deepEqual(local.requests, ["/dot.png"]);
    assert.ok(applied.magnet?.id, "the picture became a magnet");
  } finally {
    if (previous === undefined) delete process.env.OMARKIE_SWAP_OPENVERSE; else process.env.OMARKIE_SWAP_OPENVERSE = previous;
    await local.close();
    await service.close();
  }
});

test("a redirect is refused instead of followed to another host", async () => {
  const { service, element } = await vault();
  const elsewhere = await server();
  const redirecting = await server((_request, response) => {
    response.writeHead(302, { location: `${elsewhere.url}/dot.png` });
    response.end();
  });
  const previous = process.env.OMARKIE_SWAP_OPENVERSE;
  process.env.OMARKIE_SWAP_OPENVERSE = `${redirecting.url}/v1/images/`;
  try {
    await assert.rejects(service.request({ action: "swap-apply", note: "dose.md", element: element.id, candidate: candidate(`${redirecting.url}/dot.png`) }));
    assert.deepEqual(elsewhere.requests, [], "the redirect target was never contacted");
  } finally {
    if (previous === undefined) delete process.env.OMARKIE_SWAP_OPENVERSE; else process.env.OMARKIE_SWAP_OPENVERSE = previous;
    await redirecting.close();
    await elsewhere.close();
    await service.close();
  }
});
