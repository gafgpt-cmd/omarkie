import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLevelId } from "../shared/fold-format.mjs";

// Electron development has an extra app-directory argument. Installed file
// associations pass the document after the executable on Windows.
export function launchFiles(argv, packaged, cwd = process.cwd()) {
  return [...new Set(argv.slice(packaged ? 1 : 2).map(value => {
    if (!value.startsWith("file:")) return value;
    try { return fileURLToPath(value); } catch { return ""; }
  })
    .filter(value => !value.startsWith("-") && !/^omarkie:/i.test(value) && /\.(md|markdown|mdown|pdf)$/i.test(value))
    .map(value => path.resolve(cwd, value)))];
}

// `omarkie://open?note=<vault-relative>&line=<n>&stop=<level>` from a dragged fold line; anything else is ignored.
// An unknown stop opens the note at the line without the fold.
export function launchLinks(argv) {
  return argv.flatMap(value => {
    if (!/^omarkie:\/\/open\b/i.test(value)) return [];
    try {
      const url = new URL(value), note = url.searchParams.get("note") ?? "", line = Number(url.searchParams.get("line") ?? 1), stop = url.searchParams.get("stop");
      const parts = note.split("/");
      if (!note || note.length > 1024 || note.includes("\\") || note.includes("\0") || parts.some(part => !part || part === "." || part === "..")
        || !/\.(md|markdown|mdown)$/i.test(note) || !Number.isInteger(line) || line < 1) return [];
      return [isLevelId(stop) ? { note, line, stop } : { note, line }];
    } catch { return []; }
  });
}
