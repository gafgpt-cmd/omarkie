import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";

const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
const run = spawnSync(electron, [entry, ...process.argv.slice(2)], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit",
});
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
