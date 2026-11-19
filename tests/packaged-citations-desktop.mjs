import { createPackage } from "@electron/asar";
import electron from "electron";
import { _electron, expect } from "playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import manifest from "../package.json" with { type: "json" };
import { pandocPath } from "../electron/interchange.mjs";
import { nodeBridgeModules, nativeBridgeModule } from "../scripts/prepare-electron.mjs";
import { fullSize, headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";
const exec = promisify(execFile), source = process.cwd(), pandoc = await pandocPath();
assert.ok(pandoc, "Real Pandoc is required for packaged citation acceptance");
await mkdir(path.join(source, "test-results"), { recursive: true });
const directory = await mkdtemp(path.join(source, "test-results", "packaged-citations-"));
const staged = path.join(directory, "application"); await mkdir(staged);
for (const folder of ["electron", "shared", "third-party/csl"]) await cp(path.join(source, folder), path.join(staged, folder), { recursive: true });
for (const name of [...nodeBridgeModules, nativeBridgeModule()]) await cp(path.join(source, "node_modules", name), path.join(staged, "node_modules", name), { recursive: true });
await writeFile(path.join(staged, "package.json"), JSON.stringify({ name: "citation-regression", version: "1.0.0", type: "module", main: "probe.mjs" }), "utf8");
await writeFile(path.join(staged, "probe.mjs"), `import { app } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { convertExport } from "./electron/interchange.mjs";
app.setPath("userData", process.env.OMARKIE_DATA_DIR);
app.whenReady().then(async () => {
  try {
    const destination = path.join(process.env.OMARKIE_DATA_DIR, "citation.docx");
    const bibliography = JSON.stringify([{ id: "example", type: "article-journal", title: "Fictional reference", author: [{ family: "Example", given: "A" }], issued: { "date-parts": [[2020]] }, "container-title": "Example Journal", volume: "1", page: "1-2" }]);
    await convertExport(process.env.OMARKIE_DATA_DIR, "docx", "# Citation proof\\n\\nCitation [@example].\\n", "<p>Citation proof</p>", destination, { style: "vancouver", bibliography });
    const bytes = await readFile(destination);
    await writeFile(process.env.OMARKIE_CITATION_RESULT, JSON.stringify({ destination, bytes: bytes.length, signature: bytes.subarray(0, 2).toString() }), "utf8");
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
}).catch(error => { console.error(error); app.exit(2); });
`, "utf8");
const archive = path.join(directory, "app.asar"); await createPackage(staged, archive);
const results = {};
for (const [label, application] of [["unpacked", staged], ["asar", archive]]) {
  const profile = path.join(directory, label); await mkdir(profile);
  const resultFile = path.join(profile, "result.json");
  const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: profile, OMARKIE_LANGUAGE: "en", OMARKIE_PANDOC: pandoc, OMARKIE_CITATION_RESULT: resultFile });
  delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL;
  await exec(electron, [application, ...headlessArguments], { env, timeout: 30000 });
  const observed = JSON.parse(await readFile(resultFile, "utf8"));
  assert.equal(observed.signature, "PK"); assert.ok(observed.bytes > 1000);
  const { stdout } = await exec(pandoc, [observed.destination, "--to=plain"], { timeout: 10000 });
  assert.match(stdout, /Citation\s*\(1\)/); assert.match(stdout, /Fictional reference/); assert.match(stdout, /Example Journal/); assert.doesNotMatch(stdout, /@example/);
  assert.deepEqual((await readdir(profile)).filter(name => name.startsWith("conversion-")), []);
  results[label] = { ...observed, text: stdout };
  console.log(`PASS: ${label} real convertExport resolves Vancouver citation/reference in DOCX and cleans temporary files`);
}
const env = await isolatedEnvironment({ ...process.env, OMARKIE_DATA_DIR: path.join(directory, "about"), OMARKIE_LANGUAGE: "en" });
delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL;
const application = await _electron.launch({ args: [source, ...headlessArguments], env, timeout: 30000 });
try {
  const page = await application.firstWindow(); await fullSize(application, page);
  await expect(page.locator(".document-editor:not([hidden]) .rich-document")).toBeVisible();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("app:command", { action: "about" }));
  const dialog = page.getByRole("dialog", { name: "About Omarkie", exact: true });
  await expect(dialog).toContainText(manifest.version);
  results.about = { declaredVersion: manifest.version, observed: await dialog.innerText() };
  console.log("PASS: actual About dialog shows the declared release version");
} finally { await application.close(); }
const qa = process.env.OMARKIE_QA_DIR || directory; await mkdir(qa, { recursive: true });
await writeFile(path.join(qa, "packaged-citations-results.json"), JSON.stringify(results, null, 2) + "\n", "utf8");
