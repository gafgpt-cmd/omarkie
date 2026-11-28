// Conflict copies that a folder-sync app or Omarkie leaves beside a note. Names only; no file access.
// Syncthing: <name>.sync-conflict-<YYYYMMDD>-<HHMMSS>-<device>.<ext>
//   https://docs.syncthing.net/users/syncing.html#conflicting-changes
// Omarkie:   <name>.omarkie-conflict-<YYYYMMDD>-<HHMMSS>-<origin>.<ext>, origin = draft | disk | companion
// The time in a name is a label for people. Omarkie never picks a winner by it.

const pattern = /^(.+?)\.(sync|omarkie)-conflict-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-([A-Za-z0-9]+))?(\.[^./\\]+)?$/;
const pad = value => String(value).padStart(2, "0");

export function conflictCopy(name) {
  const match = pattern.exec(name);
  if (!match) return null;
  const [, stem, app, year, month, day, hour, minute, second, origin = "", extension = ""] = match;
  return {
    base: stem + extension,
    app: app === "sync" ? "syncthing" : "omarkie",
    at: `${year}-${month}-${day}T${hour}:${minute}:${second}`,
    origin,
  };
}

export function conflictName(name, origin, date = new Date()) {
  if (!/^[A-Za-z0-9]+$/.test(origin)) throw new Error("Conflict copy origin must be letters or digits.");
  const extension = /\.[^.]+$/.exec(name)?.[0] ?? "", stem = name.slice(0, name.length - extension.length) || name;
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${stem}.omarkie-conflict-${stamp}-${origin}${extension}`;
}

// Copies of `notePath` among scanned entries: same folder, base name matches.
export function copiesOf(notePath, entries) {
  const slash = Math.max(notePath.lastIndexOf("/"), notePath.lastIndexOf("\\"));
  const folder = notePath.slice(0, slash + 1), name = notePath.slice(slash + 1);
  return entries
    .filter(entry => entry.path.startsWith(folder) && entry.path.length - folder.length === entry.name.length && conflictCopy(entry.name)?.base === name)
    .map(entry => ({ ...entry, copy: conflictCopy(entry.name) }))
    .sort((a, b) => (a.copy.at < b.copy.at ? 1 : a.copy.at > b.copy.at ? -1 : a.name.localeCompare(b.name)));
}
