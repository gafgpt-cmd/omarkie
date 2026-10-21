import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const keys = ["accent", "selection", "muted", "background", "dark_background", "lighter_background", "foreground", "dark_foreground", "bright_foreground", "red", "yellow", "orange", "green", "cyan", "blue", "magenta"];

export function omarchyRoot(env = process.env) {
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "omarchy", "current");
}

// colors.toml is flat `key = "#rrggbb"`; anything else is ignored so a hostile file cannot inject CSS.
export function parseOmarchyColors(text) {
  const colors = {};
  let mode = "dark";
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([a-z_]+)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "mode" && (value === "dark" || value === "light")) mode = value;
    else if (keys.includes(key) && /^#[0-9a-f]{6}$/i.test(value)) colors[key] = value.toLowerCase();
  }
  return ["background", "foreground", "accent"].every(key => colors[key]) ? { mode, colors } : null;
}

function monospaceFamily() {
  return new Promise(resolve => execFile("fc-match", ["monospace", "-f", "%{family}"], { timeout: 2000 }, (error, stdout) => {
    const family = error ? "" : stdout.split(",")[0].trim();
    resolve(/^[\w .+-]{1,64}$/.test(family) ? family : null);
  }));
}

export async function readOmarchyTheme(root = omarchyRoot()) {
  let text;
  try { text = await readFile(path.join(root, "theme", "colors.toml"), "utf8"); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
  const palette = parseOmarchyColors(text);
  return palette && { ...palette, font: await monospaceFamily() };
}

export function fontconfigRoot(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "fontconfig");
}

// omarchy-theme-set swaps the whole theme directory, then rewrites theme.name; omarchy-font-set rewrites fonts.conf.
export function watchOmarchyTheme(onChange, root = omarchyRoot(), fonts = fontconfigRoot()) {
  let timer;
  const watchers = [[root, ["theme", "theme.name"]], [fonts, ["fonts.conf"]]].flatMap(([folder, names]) => {
    try {
      const watcher = watch(folder, (_, name) => {
        if (!names.includes(name)) return;
        clearTimeout(timer);
        timer = setTimeout(onChange, 250);
      });
      watcher.on("error", () => watcher.close());
      return [watcher];
    } catch { return []; }
  });
  return () => { clearTimeout(timer); for (const watcher of watchers) watcher.close(); };
}
