// G23 daily-life chaos suite runner.
// Unprivileged rows run everywhere; the fuse group needs /dev/fuse; the drives group needs root and loop devices.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { cleanup } from "./lib.mjs";

const groups = {
  js: async () => (await import("./rows/journal.mjs")).rows.concat(
    (await import("./rows/vault.mjs")).rows,
    (await import("./rows/merge.mjs")).rows,
    (await import("./rows/agents.mjs")).rows,
  ),
  regressions: async () => (await import("./rows/regressions.mjs")).rows,
  fuse: async () => (await import("./rows/fuse.mjs")).rows,
  drives: async () => (await import("./rows/drives.mjs")).rows,
};

function options(argv) {
  const result = { group: "js", json: null, only: null, timeout: 120_000, allowSkip: true };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split("=");
    const value = inline ?? argv[index + 1];
    if (flag === "--group") { result.group = value; if (!inline) index += 1; }
    else if (flag === "--json") { result.json = value; if (!inline) index += 1; }
    else if (flag === "--only") { result.only = value.split(",").map(Number); if (!inline) index += 1; }
    else if (flag === "--timeout") { result.timeout = Number(value) * 1_000; if (!inline) index += 1; }
    else if (flag === "--strict") result.allowSkip = false;
  }
  return result;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${Math.round(ms / 1_000)} s`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const config = options(process.argv.slice(2));
  const load = groups[config.group];
  if (!load) throw new Error(`Unknown group ${config.group}; use one of ${Object.keys(groups).join(", ")}`);
  const rows = (await load()).filter(row => !config.only || config.only.includes(row.id));
  const results = [];
  const started = Date.now();
  for (const row of rows) {
    const rowStarted = Date.now();
    let result;
    try {
      const detail = await withTimeout(row.run(), config.timeout, `row ${row.id}`);
      result = { status: "pass", detail: detail ?? null };
    } catch (error) {
      if (error?.skip) result = { status: "skip", detail: error.message };
      else result = { status: "fail", detail: error.stack ?? error.message };
    }
    const entry = { id: row.id, name: row.name, group: config.group, seconds: Math.round((Date.now() - rowStarted) / 100) / 10, ...result };
    results.push(entry);
    const mark = entry.status === "pass" ? "PASS" : entry.status === "skip" ? "SKIP" : "FAIL";
    process.stdout.write(`${mark} ${String(entry.id).padStart(2)} ${entry.name}${entry.status === "pass" ? "" : `\n     ${String(entry.detail).split("\n").slice(0, 8).join("\n     ")}`}\n`);
  }
  const failed = results.filter(entry => entry.status === "fail");
  const skipped = results.filter(entry => entry.status === "skip");
  const summary = { group: config.group, rows: results.length, passed: results.length - failed.length - skipped.length,
    failed: failed.length, skipped: skipped.length, seconds: Math.round((Date.now() - started) / 100) / 10, results };
  process.stdout.write(`\n${summary.group}: ${summary.passed} pass, ${summary.failed} fail, ${summary.skipped} skip of ${summary.rows} rows in ${summary.seconds} s\n`);
  if (config.json) {
    await mkdir(path.dirname(path.resolve(config.json)), { recursive: true });
    await writeFile(config.json, `${JSON.stringify(summary, null, 2)}\n`);
  }
  await cleanup();
  process.exitCode = failed.length || (skipped.length && !config.allowSkip) ? 1 : 0;
}

main().catch(async error => {
  process.stderr.write(`chaos suite failed: ${error.stack ?? error.message}\n`);
  await cleanup();
  process.exitCode = 1;
});
