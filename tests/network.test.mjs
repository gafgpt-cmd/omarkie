import test from "node:test";
import assert from "node:assert/strict";
import { blocksRequest } from "../electron/network.mjs";

test("with remote images off the app window reaches only its dev server and loopback services", () => {
  const dev = "http://127.0.0.1:5186";
  for (const url of ["https://tracker.example/p.gif", "http://cdn.example/a.mp3", "https://127.0.0.1.example/x", "http://localhost.evil.example/"]) assert.equal(blocksRequest(url, dev, false), true, url);
  for (const url of [`${dev}/src/main.tsx`, "http://127.0.0.1:36677/upload", "http://localhost:8080/", "http://[::1]:3000/", "omarkie-asset://local/a/b.png", "data:image/png;base64,AA=="]) assert.equal(blocksRequest(url, dev, false), false, url);
  assert.equal(blocksRequest("https://dev.example:5186/app", "https://dev.example:5186", false), false);
  assert.equal(blocksRequest("https://dev.example:5186/app", null, false), true);
  for (const url of ["https://tracker.example/p.gif", "http://cdn.example/a.mp3"]) assert.equal(blocksRequest(url, dev, true), false, url);
});
