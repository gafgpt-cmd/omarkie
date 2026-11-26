import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { cleanHookResult, runImageHook } from "../electron/image-hooks.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNNsAAAAASUVORK5CYII=";
const scratch = [];
after(async () => { for (const root of scratch) await rm(root, { recursive: true, force: true }); });

async function area() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-hooks-"));
  scratch.push(root);
  return root;
}

// `node -e` receives the hook arguments as argv.slice(1): the hook's input, then its output path.
function configure(variable, body) {
  const script = `const { writeFileSync, appendFileSync } = require("node:fs");\nconst [source, out] = process.argv.slice(1);\n${body}`;
  process.env[variable] = JSON.stringify([process.execPath, "-e", script]);
}

test("Generate receives the prompt, not the word undefined", async t => {
  t.after(() => { delete process.env.OMARKIE_IMAGEGEN; });
  const root = await area();
  configure("OMARKIE_IMAGEGEN", `if (source !== "median nerve") { console.error("prompt=" + JSON.stringify(source)); process.exit(3); }\nwriteFileSync(out, Buffer.from(${JSON.stringify(png)}, "base64"));`);
  const result = await runImageHook("generate", { prompt: "median nerve", appData: root });
  assert.equal(result.ok, true, result.hint);
  assert.equal(result.type, "png");
  assert.deepEqual(result.bytes, Buffer.from(png, "base64"));
  await cleanHookResult(result);
  await assert.rejects(stat(result.scratch), { code: "ENOENT" });
});

test("Enhance receives the source picture and its own output path", async t => {
  t.after(() => { delete process.env.OMARKIE_ENHANCE; });
  const root = await area();
  const input = path.join(root, "badge.png");
  configure("OMARKIE_ENHANCE", `if (source !== ${JSON.stringify(input)}) { console.error("input=" + JSON.stringify(source)); process.exit(3); }\nwriteFileSync(out, Buffer.from(${JSON.stringify(png)}, "base64"));`);
  const result = await runImageHook("enhance", { input, appData: root });
  assert.equal(result.ok, true, result.hint);
  assert.equal(result.type, "png");
  await cleanHookResult(result);
  await assert.rejects(stat(result.scratch), { code: "ENOENT" });
});
