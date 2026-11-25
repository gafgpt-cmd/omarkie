import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";
import electron from "electron";

const entry = fileURLToPath(new URL("../electron/omarkie-axi.mjs", import.meta.url));
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", OMARKIE_LANGUAGE: "en" };
async function run(cwd, ...args) {
  try {
    const { stdout, stderr } = await promisify(execFile)(electron, [entry, ...args], { cwd, env, timeout: 5000 });
    assert.equal(stderr, "");
    return decode(stdout);
  } catch (error) {
    if (typeof error.code !== "number" || !error.stdout) throw error;
    return { exit: error.code, ...decode(error.stdout) };
  }
}

test("closed vault writes exact-anchor scraps and proposals without writing Markdown", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omarkie-axi-test-"));
  const doc = "chapter.md", source = "---\r\ntitle: Fixture\r\n---\r\n\r\n# A **map**\r\n\r\nTwo ridges have a low saddle between them.\r\n\r\n## Other\r\n\r\nTwo ridges have a low saddle between them.\r\n";
  const file = path.join(root, doc), after = path.join(root, "after.txt");
  await writeFile(file, source);
  await writeFile(after, "A saddle is a low point between two ridges.\n");
  const before = await stat(file);
  const listing = await run(root, "doc", "view", doc, "--blocks");
  assert.deepEqual(listing.blocks.map(block => [block.line, block.kind]), [[5, "heading_open"], [7, "paragraph_open"], [9, "heading_open"], [11, "paragraph_open"]]);
  const blocks = listing.blocks.filter(block => block.kind === "paragraph_open");
  assert.notEqual(blocks[0].hash, blocks[1].hash);
  const ambiguous = await run(root, "scrap", "add", "--doc", doc, "--quote", "low saddle", "--text", "Ambiguous");
  assert.equal(ambiguous.exit, 1);
  assert.match(ambiguous.error, /ambiguous/);
  assert.equal((await run(root, "scrap", "add", "--doc", doc, "--block", blocks[0].hash, "--text", 'Review the saddle: "two ridges".')).scrap.status, "saved");
  const made = await run(root, "propose", "--doc", doc, "--block", blocks[1].hash, "--after-file", after, "--reason", "Clarify the relationship");
  assert.equal(made.proposal.status, "awaiting Accept in Omarkie");
  const scraps = await run(root, "scraps", "list", "--doc", doc);
  assert.deepEqual(scraps.scraps.map(scrap => [scrap.line, scrap.text]), [[7, 'Review the saddle: "two ridges".']]);
  const proposals = await run(root, "proposals");
  assert.deepEqual(proposals.proposals.map(item => [item.id, item.doc, item.line, item.reason]), [[made.proposal.id, doc, 11, "Clarify the relationship"]]);
  assert.equal((await run(root, "glass")).glass, "off");
  const glassFile = path.join(root, ".omarkie", "glass", "vault.json");
  assert.deepEqual(await run(root, "glass", "--on"), { vault: root, glass: "on", state: glassFile });
  assert.deepEqual(JSON.parse(await readFile(glassFile, "utf8")), { version: 1, visible: true, neverOnline: false });
  assert.equal((await run(root, "glass")).glass, "on");
  assert.deepEqual(await run(root, "glass", "--off", "--vault", root), { vault: root, glass: "off", state: glassFile });
  assert.deepEqual(JSON.parse(await readFile(glassFile, "utf8")), { version: 1, visible: false, neverOnline: false });
  const conflict = await run(root, "glass", "--on", "--off");
  assert.equal(conflict.exit, 2);
  assert.match(conflict.error, /--on or --off/);
  const error = await run(root, "scraps", "list", "--doc", doc, "--unexpected");
  assert.equal(error.exit, 2);
  assert.equal(error.code, "VALIDATION_ERROR");
  assert.match(error.error, /--unexpected/);
  assert.match(error.help[0], /^omarkie-axi scraps list/);
  assert.equal((await run(root, "accept", made.proposal.id)).exit, 2);
  assert.deepEqual(await run(root, "poll", "--wait"), { app: "closed", asks: [] });
  if (process.platform !== "win32") {
    await symlink(doc, path.join(root, "alias.md"));
    assert.match((await run(root, "doc", "view", "alias.md")).error, /symlink/);
  }
  assert.equal(await readFile(file, "utf8"), source);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
});

test("skill drift check and opt-in project hooks preserve existing config on repeat", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omarkie-hooks-test-"));
  assert.deepEqual(await run(root, "skill", "--check"), { skill: "up to date" });
  await mkdir(path.join(root, ".claude"));
  const file = path.join(root, ".claude", "settings.local.json");
  const existing = { hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "printf fixture" }] }] } };
  await writeFile(file, JSON.stringify(existing));
  const first = await run(root, "setup", "hooks");
  assert.deepEqual(first.hooks.map(hook => [hook.agent, hook.status]), [["claude", "installed"], ["codex", "installed"], ["opencode", "installed"]]);
  const paths = first.hooks.map(hook => path.join(root, hook.file));
  const before = await Promise.all(paths.map(async value => [await readFile(value, "utf8"), (await stat(value)).mtimeMs]));
  const repeat = await run(root, "setup", "hooks");
  assert.ok(repeat.hooks.every(hook => hook.status === "unchanged"));
  assert.deepEqual(await Promise.all(paths.map(async value => [await readFile(value, "utf8"), (await stat(value)).mtimeMs])), before);
  const settings = JSON.parse(before[0][0]);
  assert.deepEqual(settings.hooks.SessionStart[0], existing.hooks.SessionStart[0]);
  assert.equal(settings.hooks.SessionStart[1].hooks[0].command, "omarkie-axi context --agent claude");
  const { stdout } = await promisify(execFile)(electron, [entry, "context", "--agent", "claude"], { cwd: root, env, timeout: 5000 });
  assert.equal(stdout, "");
});

test("glass layers verbs parse like the other glass commands", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omarkie-axi-layers-"));
  await writeFile(path.join(root, "note.md"), "# Note\n\nBody.\n");
  const help = await run(root, "glass", "layers", "list", "--help");
  assert.match(help.usage, /^omarkie-axi glass layers list/);
  assert.equal((await run(root, "glass", "layers", "hide", "--note", "note.md")).exit, 2);
  assert.equal((await run(root, "glass", "layers", "opacity", "--note", "note.md", "notes", "40")).exit, 1);
  const invalid = await run(root, "glass", "layers", "opacity", "--note", "note.md", "notes", "half");
  assert.equal(invalid.exit, 2);
  assert.match(invalid.error, /Opacity must be a number/);
  const unknown = await run(root, "glass", "layers", "hide", "--note", "note.md", "per-element");
  assert.equal(unknown.exit, 2);
  assert.match(unknown.error, /Layer must be one of/);
});
