// Folder search for the phone companion. Runs off the page so a runaway pattern can be stopped.
// Same match shape and limits as the desktop search in electron/workspace.mjs.
interface Job { notes: { path: string; text: string }[]; query: string; regex: boolean; caseSensitive: boolean }
self.onmessage = ({ data }: MessageEvent<Job>) => {
  try {
    const expression = new RegExp(data.regex ? data.query : data.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), data.caseSensitive ? "g" : "gi");
    const matches = [];
    for (const note of data.notes) {
      const lines = note.text.replace(/\r\n?/g, "\n").split("\n");
      for (let line = 0; line < lines.length; line++) for (const match of lines[line].matchAll(expression)) {
        if (matches.length >= 500) { postMessage({ matches, truncated: true }); return; }
        const index = match.index ?? 0, length = match[0].length;
        matches.push({ token: note.path, path: note.path, name: note.path, line: line + 1, column: index + 1, length, preview: lines[line].slice(Math.max(0, index - 70), Math.max(index + length, index + 110)) });
      }
    }
    postMessage({ matches, truncated: false });
  } catch (error) { postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
