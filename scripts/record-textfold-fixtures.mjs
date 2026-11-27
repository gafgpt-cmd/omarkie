#!/usr/bin/env node
// Record or verify TextFold (`textfold/doc` v0) baseline snapshots for the Omarkie Fold golden eval set.
// Runs TextFold in an isolated temporary library directory so no machine paths or user state leak into fixtures.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TEXTFOLD_FORMAT = "textfold/doc";
export const TEXTFOLD_VERSION = 0;
export const TEXTFOLD_LEVELS = Object.freeze(["topic", "takeaway", "key", "brief", "full"]);
export const TEXTFOLD_WRITTEN = Object.freeze(["topic", "takeaway", "key"]);

const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL("../tests/fixtures/fold", import.meta.url));
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const HOST_PATH_LEAK = /(?:^|[\s"'(=])(?:\/home\/[^/\s]+|\/Users\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isString = value => typeof value === "string";
const isNonEmptyString = value => typeof value === "string" && value.trim().length > 0;

function checkNoHostPathLeak(value, fieldPath, problems) {
  if (typeof value === "string") {
    if (HOST_PATH_LEAK.test(value)) problems.push(`${fieldPath}: contains host-specific user path`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkNoHostPathLeak(item, `${fieldPath}[${index}]`, problems));
    return;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) checkNoHostPathLeak(entry, `${fieldPath}.${key}`, problems);
  }
}

export function validateTextfoldDoc(doc) {
  const problems = [];
  if (!isObject(doc)) return ["doc: expected a JSON object"];
  if (doc.format !== TEXTFOLD_FORMAT) problems.push(`doc.format: expected "${TEXTFOLD_FORMAT}"`);
  if (doc.version !== TEXTFOLD_VERSION) problems.push(`doc.version: expected ${TEXTFOLD_VERSION}`);
  if (!isNonEmptyString(doc.id)) problems.push("doc.id: expected a non-empty string");
  if (!isNonEmptyString(doc.lang)) problems.push("doc.lang: expected a language code");
  if (!isString(doc.title)) problems.push("doc.title: expected a string");
  if (!Array.isArray(doc.authors) || !doc.authors.every(isString)) problems.push("doc.authors: expected a list of strings");
  if (!isString(doc.date)) problems.push("doc.date: expected a string");

  if (!isObject(doc.source)) {
    problems.push("doc.source: expected an object");
  } else {
    if (!isNonEmptyString(doc.source.kind)) problems.push("doc.source.kind: expected a non-empty string");
    for (const key of ["url", "snapshot", "label", "license"]) {
      if (!isString(doc.source[key])) problems.push(`doc.source.${key}: expected a string`);
    }
  }

  if (!Array.isArray(doc.levels) || doc.levels.join(",") !== TEXTFOLD_LEVELS.join(",")) {
    problems.push(`doc.levels: expected ${JSON.stringify(TEXTFOLD_LEVELS)}`);
  }
  if (!Array.isArray(doc.written) || doc.written.join(",") !== TEXTFOLD_WRITTEN.join(",")) {
    problems.push(`doc.written: expected ${JSON.stringify(TEXTFOLD_WRITTEN)}`);
  }

  if (!isObject(doc.provenance)) {
    problems.push("doc.provenance: expected an object");
  } else {
    if (!isNonEmptyString(doc.provenance.made_with)) problems.push("doc.provenance.made_with: expected a non-empty string");
    if (!isString(doc.provenance.exported) || !ISO_UTC.test(doc.provenance.exported)) {
      problems.push("doc.provenance.exported: expected an ISO timestamp");
    }
    if (typeof doc.provenance.ai_generated !== "boolean") problems.push("doc.provenance.ai_generated: expected a boolean");
    if (!isString(doc.provenance.model)) problems.push("doc.provenance.model: expected a string");
    if (!isString(doc.provenance.levels_made)) problems.push("doc.provenance.levels_made: expected a string");
    if (typeof doc.provenance.local !== "boolean") problems.push("doc.provenance.local: expected a boolean");
  }

  if (!Array.isArray(doc.sections) || doc.sections.length === 0) {
    problems.push("doc.sections: expected a non-empty list");
  } else {
    doc.sections.forEach((section, sIdx) => {
      const sp = `doc.sections[${sIdx}]`;
      if (!isObject(section)) return problems.push(`${sp}: expected an object`);
      if (!isNonEmptyString(section.id)) problems.push(`${sp}.id: expected a non-empty string`);
      for (const key of ["num", "title", "takeaway", "topic"]) {
        if (!isString(section[key])) problems.push(`${sp}.${key}: expected a string`);
      }
      if (!Number.isSafeInteger(section.depth) || section.depth < 1) problems.push(`${sp}.depth: expected integer >= 1`);
      if (!Array.isArray(section.units)) {
        problems.push(`${sp}.units: expected a list`);
        return;
      }
      section.units.forEach((unit, uIdx) => {
        const up = `${sp}.units[${uIdx}]`;
        if (!isObject(unit)) return problems.push(`${up}: expected an object`);
        for (const key of ["id", "kind", "role"]) {
          if (!isNonEmptyString(unit[key])) problems.push(`${up}.${key}: expected a non-empty string`);
        }
        for (const key of ["full", "key", "takeaway", "topic"]) {
          if (!isString(unit[key])) problems.push(`${up}.${key}: expected a string`);
        }
        if (!Array.isArray(unit.sentences) || !unit.sentences.every(isString)) {
          problems.push(`${up}.sentences: expected a list of strings`);
        }
        if (!Array.isArray(unit.brief) || !unit.brief.every(isString)) {
          problems.push(`${up}.brief: expected a list of strings`);
        }
        if (!Array.isArray(unit.evidence) || !unit.evidence.every(i => Number.isSafeInteger(i) && i >= 0)) {
          problems.push(`${up}.evidence: expected a list of non-negative integers`);
        } else if (Array.isArray(unit.sentences) && Array.isArray(unit.brief)) {
          const outOfRange = unit.evidence.filter(i => i >= unit.sentences.length);
          if (outOfRange.length) {
            problems.push(`${up}.evidence: out-of-range sentence index ${outOfRange.join(",")}`);
          } else {
            const expectedBrief = unit.evidence.map(i => unit.sentences[i]);
            if (expectedBrief.length !== unit.brief.length || expectedBrief.some((s, i) => s !== unit.brief[i])) {
              problems.push(`${up}.brief: must match sentences indexed by evidence`);
            }
          }
        }
      });
    });
  }

  if (!Array.isArray(doc.links)) {
    problems.push("doc.links: expected a list");
  } else {
    doc.links.forEach((link, idx) => {
      const lp = `doc.links[${idx}]`;
      if (!isObject(link)) return problems.push(`${lp}: expected an object`);
      for (const key of ["from", "to", "rel"]) {
        if (!isNonEmptyString(link[key])) problems.push(`${lp}.${key}: expected a non-empty string`);
      }
    });
  }

  checkNoHostPathLeak(doc, "doc", problems);
  return problems;
}

async function atomicWriteUtf8(filePath, content) {
  const dir = path.dirname(filePath);
  const tmpName = `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function runTextfoldCli({
  inputPath,
  python = process.env.TEXTFOLD_PYTHON || "python3",
  mode = "local",
  dataDir,
  lang,
  timeoutMs = 180_000,
  runner = execFileAsync,
}) {
  if (mode !== "local" && mode !== "model") {
    throw new Error(`Invalid mode "${mode}": expected "local" or "model"`);
  }
  const args = ["-m", "textfold", "get", inputPath, "--json"];
  if (mode === "local") args.push("--no-generate");
  if (lang) args.push("--lang", lang);

  const env = { ...process.env, PYTHONUTF8: "1" };
  if (dataDir) env.TEXTFOLD_DATA = dataDir;
  if (mode === "local") env.TEXTFOLD_NO_MODELS = "1";
  else delete env.TEXTFOLD_NO_MODELS;

  const { stdout } = await runner(python, args, {
    env,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`TextFold output was not valid JSON: ${error.message}`);
  }
  return parsed;
}

export async function recordFixture({
  fixtureDir,
  python = process.env.TEXTFOLD_PYTHON || "python3",
  mode = "local",
  dataDir,
  lang,
  timeoutMs = 180_000,
  dryRun = false,
  runner = execFileAsync,
}) {
  const inputPath = path.join(fixtureDir, "input.md");
  const outputPath = path.join(fixtureDir, "textfold.json");
  await readFile(inputPath, "utf8");

  if (dryRun) {
    return { fixtureDir, outputPath, status: "dry-run", units: 0, sections: 0 };
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), "omarkie-textfold-record-"));
  const stagedInput = path.join(scratch, "input.md");
  const isolatedDataDir = dataDir ? path.resolve(dataDir) : path.join(scratch, "library");

  try {
    await mkdir(isolatedDataDir, { recursive: true });
    await copyFile(inputPath, stagedInput);

    const doc = await runTextfoldCli({
      inputPath: stagedInput,
      python,
      mode,
      dataDir: isolatedDataDir,
      lang,
      timeoutMs,
      runner,
    });
    const problems = validateTextfoldDoc(doc);
    if (problems.length) {
      throw new Error(`Recorded TextFold JSON failed validation:\n- ${problems.join("\n- ")}`);
    }

    await atomicWriteUtf8(outputPath, `${JSON.stringify(doc, null, 2)}\n`);
    const units = doc.sections.reduce((total, section) => total + section.units.length, 0);
    return {
      fixtureDir,
      outputPath,
      status: "recorded",
      docId: doc.id,
      lang: doc.lang,
      local: doc.provenance.local,
      sections: doc.sections.length,
      units,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function checkFixtureRecording(fixtureDir) {
  const outputPath = path.join(fixtureDir, "textfold.json");
  let raw;
  try {
    raw = await readFile(outputPath, "utf8");
  } catch (error) {
    return { fixtureDir, outputPath, ok: false, problems: [`missing or unreadable textfold.json: ${error.message}`] };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    return { fixtureDir, outputPath, ok: false, problems: [`invalid JSON: ${error.message}`] };
  }
  const problems = validateTextfoldDoc(doc);
  return {
    fixtureDir,
    outputPath,
    ok: problems.length === 0,
    problems,
    sections: Array.isArray(doc.sections) ? doc.sections.length : 0,
    units: Array.isArray(doc.sections) ? doc.sections.reduce((n, s) => n + (Array.isArray(s?.units) ? s.units.length : 0), 0) : 0,
  };
}

export async function loadManifest(fixturesDir = DEFAULT_FIXTURES_DIR) {
  const manifestPath = path.join(fixturesDir, "manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  if (!isObject(manifest) || !Array.isArray(manifest.fixtures)) {
    throw new Error(`Invalid manifest at ${manifestPath}: expected { fixtures: [...] }`);
  }
  return manifest;
}

function matchesSelector(entry, selectors) {
  if (!selectors || selectors.length === 0) return true;
  const numStr = String(entry.number);
  const padded = numStr.padStart(2, "0");
  return selectors.some(sel => sel === entry.id || sel === numStr || sel === padded);
}

export async function recordAllFixtures({
  fixturesDir = DEFAULT_FIXTURES_DIR,
  fixtures = [],
  python = process.env.TEXTFOLD_PYTHON || "python3",
  mode = "local",
  dataDir,
  timeoutMs = 180_000,
  check = false,
  dryRun = false,
  runner = execFileAsync,
} = {}) {
  const manifest = await loadManifest(fixturesDir);
  const selected = manifest.fixtures.filter(entry => matchesSelector(entry, fixtures));
  if (selected.length === 0) {
    throw new Error(`No fixtures matched selector(s): ${fixtures.join(", ")}`);
  }

  const results = [];
  for (const entry of selected) {
    const fixtureDir = path.join(fixturesDir, entry.id);
    if (check) {
      const checked = await checkFixtureRecording(fixtureDir);
      results.push({ id: entry.id, number: entry.number, ...checked });
    } else {
      const recorded = await recordFixture({
        fixtureDir,
        python,
        mode,
        dataDir,
        timeoutMs,
        dryRun,
        runner,
      });
      results.push({ id: entry.id, number: entry.number, ...recorded });
    }
  }
  return results;
}

export function parseArgs(argv) {
  const options = {
    fixturesDir: DEFAULT_FIXTURES_DIR,
    fixtures: [],
    python: process.env.TEXTFOLD_PYTHON || "python3",
    mode: "local",
    dataDir: undefined,
    timeoutMs: 180_000,
    check: false,
    dryRun: false,
    help: false,
  };
  const takeValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) throw new Error(`Missing value for ${flag}`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--fixtures-dir") { options.fixturesDir = path.resolve(takeValue(i, arg)); i += 1; }
    else if (arg === "--fixture") {
      const value = takeValue(i, arg);
      options.fixtures.push(...value.split(",").map(part => part.trim()).filter(Boolean));
      i += 1;
    } else if (arg === "--python") { options.python = takeValue(i, arg); i += 1; }
    else if (arg === "--mode") { options.mode = takeValue(i, arg); i += 1; }
    else if (arg === "--data-dir") { options.dataDir = takeValue(i, arg); i += 1; }
    else if (arg === "--timeout-ms") {
      const value = Number(takeValue(i, arg));
      if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid --timeout-ms: ${argv[i + 1]}`);
      options.timeoutMs = Math.trunc(value);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

const HELP_TEXT = `Usage: node scripts/record-textfold-fixtures.mjs [options]

Record or verify TextFold (textfold/doc v0) baselines for the Omarkie Fold golden eval set.

Options:
  --fixtures-dir <dir>   Fixture root directory (default: tests/fixtures/fold)
  --fixture <id|num>     Record/check only matching fixture(s); repeatable or comma-separated
  --python <bin>         Python executable with textfold installed (or TEXTFOLD_PYTHON env)
  --mode <local|model>   local = --no-generate + TEXTFOLD_NO_MODELS=1 (default); model = live TextFold agent
  --data-dir <dir>       Override isolated TEXTFOLD_DATA directory
  --timeout-ms <ms>      Per-fixture subprocess timeout in ms (default: 180000)
  --check                Validate existing textfold.json files without invoking TextFold
  --dry-run              List matching fixtures without running TextFold
  -h, --help             Show this help
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  const results = await recordAllFixtures(options);
  if (options.check) {
    const failed = results.filter(item => !item.ok);
    for (const item of results) {
      const mark = item.ok ? "OK" : "FAIL";
      process.stdout.write(`${mark} ${item.id} (${item.sections} sections, ${item.units} units)\n`);
      for (const problem of item.problems) process.stderr.write(`  - ${problem}\n`);
    }
    if (failed.length) process.exitCode = 1;
    return;
  }
  for (const item of results) {
    process.stdout.write(`${item.status} ${item.id}: ${item.sections} sections, ${item.units} units -> ${path.relative(process.cwd(), item.outputPath)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`record-textfold-fixtures: ${error.message}\n`);
    process.exitCode = 1;
  });
}
