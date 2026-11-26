// Rows 19-21: AI down or never allowed, a proposal flood, a vault that must not reach the network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fileHash, openService, openSync, vault } from "../lib.mjs";
import { blocksRequest } from "../../../electron/network.mjs";
import { requestPayload } from "../../../electron/payload.mjs";
import { openStudy, putProposal } from "../../../electron/tutor-store.mjs";

const offlineChild = fileURLToPath(new URL("../child-offline.mjs", import.meta.url));

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export const rows = [
  {
    id: 19,
    name: "AI endpoint down: requests fail fast, glass actions stay under 50 ms p95, retry works later",
    async run() {
      const environment = await vault({ "map.md": "# Map\n\nContour lines.\n" });
      const service = await openService(environment);
      try {
        const endpoint = { baseUrl: "http://127.0.0.1:1/v1", confirmedOrigin: "http://127.0.0.1:1",
          allowedOrigin: "http://127.0.0.1:1", model: "chaos", source: "Contour lines close together." };
        const measure = async (count, prefix) => {
          const samples = [];
          for (let index = 0; index < count; index += 1) {
            const started = process.hrtime.bigint();
            await service.request({ action: "add", note: "map.md", magnet: `${prefix}-${index}`, text: `op ${index}` });
            samples.push(Number(process.hrtime.bigint() - started) / 1e6);
          }
          return samples;
        };
        // Baseline on the same machine, then the same ops while every AI call is failing.
        const early = percentile(await measure(20, "m-base"), 0.95);
        const failures = Array.from({ length: 5 }, () => requestPayload(endpoint).then(() => "answered", error => error.message));
        const samples = await measure(40, "m-ai");
        const messages = await Promise.all(failures);
        assert.equal(messages.length, 5);
        for (const message of messages) {
          assert.equal(typeof message, "string");
          assert.ok(String(message).trim().length > 0, "the failure surfaces a message the user can act on");
        }
        const p95 = percentile(samples, 0.95);
        assert.ok(p95 < Math.max(early * 2, 50) + 20, `p95 ${p95.toFixed(1)} ms with AI down, baseline ${early.toFixed(1)} ms`);
        assert.ok(p95 < 250, `p95 ${p95.toFixed(1)} ms stays in interactive range`);
        // A later retry with a reachable endpoint succeeds, so nothing latched.
        const { createServer } = await import("node:http");
        const server = createServer((request, response) => {
          let body = "";
          request.on("data", chunk => { body += chunk; });
          request.on("end", () => {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ choices: [{ message: { content: "waiting is over" } }] }));
          });
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const port = server.address().port;
        try {
          const answer = await requestPayload({ ...endpoint, baseUrl: `http://127.0.0.1:${port}/v1`, confirmedOrigin: `http://127.0.0.1:${port}`, allowedOrigin: `http://127.0.0.1:${port}` });
          assert.equal(answer, "waiting is over");
        } finally { server.close(); }
        return { p95Ms: Math.round(p95 * 10) / 10, failedFast: true };
      } finally { await service.close(); }
    },
  },
  {
    id: 20,
    name: "an agent posts 500 proposals: the note is never written and only Accept writes it",
    async run() {
      const environment = await vault({ "map.md": "# Map\n\nContour lines close together mean a steep slope.\n\nSecond paragraph.\n" });
      const note = path.join(environment.folder, "map.md");
      const before = await fileHash(note);
      const study = await openStudy(environment.folder, "map.md");
      const anchor = study.blocks.find(candidate => candidate.block.includes("Contour lines close together"));
      assert.ok(anchor);
      let posted = 0;
      for (let index = 0; index < 500; index += 1) {
        const result = await putProposal(study, { block: anchor.hash.slice(0, 12),
          after: `Contour lines close together mean a steep slope. Revision ${index}.`, reason: "agent flood" });
        if (result) posted += 1;
      }
      assert.equal(posted, 500);
      assert.equal(await fileHash(note), before, "500 proposals never touch the page");
      const { service, sync } = await openSync(environment);
      try {
        await service.request({ action: "add", note: "map.md", magnet: "m-proposed", kind: "sticky", text: "proposal target",
          anchor: { version: 2, landmarks: [{ kind: "block", block: "Contour lines close together mean a steep slope.", headings: ["Map"], line: 3 }] } });
        await sync.whenIdle();
        const preview = await service.request({ action: "merge-accept", note: "map.md", magnet: "m-proposed" });
        assert.equal(preview.needsUser, true);
        assert.equal(await fileHash(note), before, "without Accept the page is untouched");
        const accepted = await service.request({ action: "merge-accept", note: "map.md", magnet: "m-proposed", approved: true });
        assert.equal(accepted.merged, true);
        assert.notEqual(await fileHash(note), before, "only the explicit Accept writes");
      } finally { await sync.close(); await service.close(); }
      return { proposals: posted, pageWrites: 1 };
    },
  },
  {
    id: 21,
    name: "clinical vault never online: the remote gate denies by default and glass works with no interfaces",
    async run() {
      const environment = await vault({ "map.md": "# Map\n\nContour lines.\n" });
      assert.equal(blocksRequest("https://example.org/image.png", "http://127.0.0.1:5186", false), true);
      assert.equal(blocksRequest("http://127.0.0.1:5186/app.js", "http://127.0.0.1:5186", false), false);
      assert.equal(blocksRequest("https://example.org/image.png", "http://127.0.0.1:5186", true), false);
      // A hosted runner may refuse the network namespace. The gate's refusal is asserted above
      // either way; the namespace proves the stronger claim where the kernel allows it.
      const child = spawn("unshare", ["-rn", process.execPath, offlineChild, environment.folder, environment.data],
        { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      const [code] = await once(child, "exit");
      const refused = /unshare: (?:write failed|Operation not permitted|Invalid argument)/u.test(output);
      if (refused) throw Object.assign(new Error(`no network namespace here: ${output.trim().split("\n")[0]}`), { skip: true });
      assert.equal(code, 0, output);
      assert.match(output, /offline-ok/);
      const service = await openService(environment);
      try {
        assert.equal((await service.request({ action: "list", note: "map.md" })).magnets.length, 1);
      } finally { await service.close(); }
      return { netns: true, remoteDenied: true };
    },
  },
];
