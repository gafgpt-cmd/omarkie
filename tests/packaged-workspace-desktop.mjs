import { createPackage } from "@electron/asar";
import electron from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { prepareElectronApplication } from "../scripts/prepare-electron.mjs";
import { headlessArguments, isolatedEnvironment } from "./desktop-window.mjs";
const exec = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), "omarkie-packaged-workspace-")), staged = path.join(root, "application");
await exec(process.execPath, ["scripts/icon.mjs"]);
const prepared = await prepareElectronApplication(process.platform === "win32" ? "windows" : process.platform);
await cp(prepared, staged, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(staged, "package.json"), "utf8"));
await writeFile(path.join(staged, "package.json"), JSON.stringify({ ...manifest, main: "probe.mjs" }), "utf8");
await writeFile(path.join(staged, "probe.mjs"), `import { app } from "electron";
import { mkdir, writeFile, readFile, realpath, stat, access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Workspace } from "./electron/workspace.mjs";
import { DocumentStore } from "./electron/store.mjs";
app.setPath("userData", process.env.OMARKIE_DATA_DIR);
app.whenReady().then(async () => {
  const root = await realpath(process.env.OMARKIE_DATA_DIR), results = [];
  const require = createRequire(import.meta.url);
  const modules = [require.resolve("koffi"), require.resolve("@koromix/koffi-" + process.platform + "-" + process.arch)];
  if (modules.some(file => !file.startsWith(app.getAppPath() + path.sep))) throw new Error("Native bridge resolved outside the package");
  for (const action of ["rename", "move", "undo"]) for (const directory of [false, true]) {
    const scope = path.join(root, action + (directory ? "-directory" : "-file")); await mkdir(scope);
    const source = path.join(scope, directory ? "source" : "source.md"), child = path.join(scope, "child"); await mkdir(child);
    if (directory) { await mkdir(source); await writeFile(path.join(source, "sentinel.md"), "source sentinel"); } else await writeFile(source, "source sentinel");
    const store = new DocumentStore(path.join(scope, "session")), workspace = new Workspace(store.dataDir); await store.scan(scope);
    const record = await store.open(directory ? path.join(source, "sentinel.md") : source); store.require(record.id).content = "dirty draft";
    let operation = { action, path: source, ...(action === "move" ? { target: child } : { name: directory ? "renamed" : "renamed.md" }) };
    if (action === "undo") { const change = await workspace.execute({ action: "rename", path: source, name: directory ? "renamed" : "renamed.md" }, store); workspace.apply(change, store); operation = { action: "undo" }; }
    const from = action === "undo" ? workspace.undo.from : source;
    const destination = action === "undo" ? workspace.undo.to : action === "move" ? path.join(child, path.basename(source)) : path.join(scope, operation.name);
    const recordPath = store.require(record.id).path, undo = workspace.undo, absent = workspace.absent.bind(workspace); let independent;
    workspace.absent = async file => { await absent(file); if (file === destination) { if (directory) { await mkdir(file); independent = (await stat(file)).ino; } else await writeFile(file, "independent sentinel", { flag: "wx" }); } };
    let refused = false;
    try { await workspace.execute(operation, store); } catch (error) { refused = error.code === "EEXIST"; }
    let missing = false; if (directory) try { await access(path.join(destination, "sentinel.md")); } catch (error) { if (error.code !== "ENOENT") throw error; missing = true; }
    results.push({ action, directory, refused, source: await readFile(directory ? path.join(from, "sentinel.md") : from, "utf8"), destination: directory ? missing && (await stat(destination)).ino === independent : await readFile(destination, "utf8"), draft: store.require(record.id).content, path: store.require(record.id).path === recordPath, undo: workspace.undo === undo });
  }
  const store = new DocumentStore(path.join(root, "session")), workspace = new Workspace(store.dataDir), folder = path.join(root, "folder");
  await mkdir(folder); await writeFile(path.join(folder, "note.md"), "nested sentinel"); await store.scan(root);
  const change = await workspace.execute({ action: "rename", path: folder, name: "renamed" }, store); await workspace.execute({ action: "undo" }, store);
  await writeFile(path.join(root, "result.json"), JSON.stringify({ modules, results, nested: await readFile(path.join(folder, "note.md"), "utf8"), moved: change.toPath.endsWith("renamed") }), "utf8");
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
`, "utf8");
const archive = path.join(root, "app.asar"); await createPackage(staged, archive);
const results = {};
for (const [name, application] of [["unpacked", staged], ["asar", archive]]) {
  const profile = path.join(root, name); await mkdir(profile);
  const env = await isolatedEnvironment({ ...process.env, HOME: profile, OMARKIE_DATA_DIR: profile, OMARKIE_LANGUAGE: "en", NODE_PATH: "" });
  delete env.ELECTRON_RUN_AS_NODE; delete env.OMARKIE_DEV_URL;
  await exec(electron, [application, ...headlessArguments], { env, timeout: 30000 });
  const observed = JSON.parse(await readFile(path.join(profile, "result.json"), "utf8"));
  const expected = ["rename", "move", "undo"].flatMap(action => [false, true].map(directory => ({ action, directory, refused: true, source: "source sentinel", destination: directory ? true : "independent sentinel", draft: "dirty draft", path: true, undo: true })));
  assert.deepEqual(observed.results, expected);
  assert.equal(observed.nested, "nested sentinel"); assert.equal(observed.moved, true);
  results[name] = observed;
  console.log(`PASS: real prepared ${name} package loads its own native bytes; six collision refusals preserve sentinels/records; directory undo works`);
}
const qa = process.env.OMARKIE_QA_DIR || root; await mkdir(qa, { recursive: true });
await writeFile(path.join(qa, "packaged-workspace-results.json"), JSON.stringify(results, null, 2) + "\n", "utf8");
