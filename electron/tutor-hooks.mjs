import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const registrations = {
  claude: [".claude", "settings.local.json"],
  codex: [".codex", "hooks.json"],
  opencode: [".opencode/plugins", "omarkie-tutor.js"],
};
const missing = error => { if (error.code !== "ENOENT") throw error; return null; };
const command = agent => `omarkie-axi context --agent ${agent}`;
const openCode = `import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "omarkie-tutor",
  async setup(ctx) {
    await ctx.session.hook("context", async event => {
      const result = await promisify(execFile)("omarkie-axi", ["context", "--agent", "opencode"], { cwd: ctx.location.directory, timeout: 2500 }).catch(() => null);
      const text = result?.stdout.trim();
      if (text) event.system.push({ type: "text", text });
    });
  },
});
`;

async function directories(root, dir, create = false) {
  let current = root;
  for (const part of dir.split("/")) {
    current = path.join(current, part);
    if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(current).catch(missing);
    if (!stat) return false;
    if (!stat.isDirectory()) throw new Error("Refusing to follow a hook directory symlink.");
  }
  return true;
}

async function readConfig(file) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)).catch(missing);
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new Error("Expected a regular project hook file under 256 KB.");
    return { mode: stat.mode & 0o777, source: await handle.readFile("utf8") };
  } finally { await handle.close(); }
}
function jsonHook(current, agent) {
  const entry = command(agent), config = current ? JSON.parse(current) : {};
  if (!config || typeof config !== "object" || Array.isArray(config) || config.hooks && typeof config.hooks !== "object") throw new Error("Invalid project hook config.");
  const hooks = config.hooks ??= {}, sessions = hooks.SessionStart ??= [];
  if (!Array.isArray(sessions) || Array.isArray(hooks)) throw new Error("Invalid SessionStart hooks.");
  if (sessions.some(group => Array.isArray(group?.hooks) && group.hooks.some(hook => hook?.type === "command" && hook.command === entry))) return current;
  sessions.push({ hooks: [{ type: "command", command: entry, timeout: 3 }] });
  return `${JSON.stringify(config, null, 2)}\n`;
}

export async function setupHooks(folder, agent) {
  if (agent && !Object.hasOwn(registrations, agent)) throw new Error("Use --agent claude, codex, or opencode.");
  const root = await realpath(folder);
  if (root === await realpath(os.homedir()) || root === path.dirname(root)) throw new Error("Choose a project directory, not a home directory or filesystem root.");
  const installed = [], updates = [];
  for (const name of agent ? [agent] : Object.keys(registrations)) {
    const [directory, basename] = registrations[name], file = path.join(root, directory, basename);
    const previous = await directories(root, directory) ? await readConfig(file) : null;
    let source;
    if (name === "opencode") {
      if (previous && previous.source !== openCode) throw new Error("An OpenCode plugin already owns omarkie-tutor.js. No files were changed.");
      source = openCode;
    } else source = jsonHook(previous?.source, name);
    if (source !== previous?.source) updates.push({ directory, file, previous, source });
    installed.push({ agent: name, file: `${directory}/${basename}`, status: source === previous?.source ? "unchanged" : "installed" });
  }
  for (const { directory, file, previous, source } of updates) {
    await directories(root, directory, true);
    const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", previous?.mode ?? 0o600);
    try {
      try { await handle.writeFile(source, "utf8"); }
      finally { await handle.close(); }
      if ((await readConfig(file))?.source !== previous?.source) throw new Error("Hook config changed during setup. Run setup again.");
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(missing); }
  }
  return { hooks: installed, help: "Ensure omarkie-axi is on PATH. In Codex, review the SessionStart command with /hooks." };
}

export async function hookRoot(cwd, agent) {
  if (!Object.hasOwn(registrations, agent)) return null;
  const [dir, basename] = registrations[agent];
  const home = await realpath(os.homedir());
  for (let root = cwd; root !== home && path.dirname(root) !== root; root = path.dirname(root)) {
    if (!await directories(root, dir)) continue;
    const current = (await readConfig(path.join(root, dir, basename)))?.source;
    if (current && (agent === "opencode" ? current === openCode : jsonHook(current, agent) === current)) return root;
  }
  return null;
}
