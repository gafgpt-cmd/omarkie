import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { runOcr } from "../electron/ocr.mjs";

const scratch = [];
after(async () => { for (const root of scratch) await rm(root, { recursive: true, force: true }); });

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function command(script) {
  const home = await mkdtemp(path.join(os.tmpdir(), "omarkie-ocr-"));
  scratch.push(home);
  const file = path.join(home, "hook.mjs");
  await writeFile(file, script);
  return { ...process.env, OMARKIE_OCR: JSON.stringify([process.execPath, file, "{image}"]) };
}

test("OCR text keeps multi-byte characters when a chunk ends mid-character", async () => {
  const environment = await command(`
const text = "café — 神经";
const bytes = Buffer.from(text, "utf8");
for (let index = 0; index < bytes.length; index += 1) {
  process.stdout.write(bytes.subarray(index, index + 1));
  await new Promise(resolve => setTimeout(resolve, 2));
}
`);
  const result = await runOcr(png, { environment });
  assert.equal(result.text, "café — 神经");
});

test("OCR text is trimmed and its line endings are normalised", async () => {
  const environment = await command(`process.stdout.write("\\n first line \\r\\nsecond line \\n\\n");`);
  const result = await runOcr(png, { environment });
  assert.equal(result.text, "first line \nsecond line");
});
