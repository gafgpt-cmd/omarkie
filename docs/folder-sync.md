# Folder sync

Omarkie reads and writes plain files. A folder-sync app (Syncthing, Nextcloud, Drive) moves them between devices. Omarkie never uploads anything and never picks a winner by timestamp.

**Sync is not a backup.** A sync app copies mistakes and deletions to every device within seconds. Keep a real backup (versioned, offline or off-site) of every vault.

## What Omarkie does when files change underneath it

The desktop app checks every open note by content hash about every two seconds.

| Change from another device | Note clean | Note has an unsaved draft |
| --- | --- | --- |
| Content replaced | Loads the new text | Keeps the draft, shows **The file changed on disk**. **Compare versions** opens both side by side |
| Renamed or moved | Follows the identical file, tells you | Same, if exactly one unopened file has the same hash |
| Deleted | Keeps the text in the window, offers **Restore file** | Same |
| Conflict copy appears beside the note | Shows **A sync app kept another version of this note** | Same, after you save |

Choices in **Compare versions**:

- Disk changed: **Keep my draft** or **Use disk version**. The version you drop is written beside the note as `Name.omarkie-conflict-YYYYMMDD-HHMMSS-disk.md` (or `-draft`).
- Conflict copy: **Keep this note** or **Use other version**. The version you drop goes to the system Trash.
- Nothing is overwritten without a choice. Every dropped version stays recoverable: beside the note or in the Trash.

Conflict copies Omarkie knows:

- Syncthing: `Name.sync-conflict-<date>-<time>-<device>.md`
- Omarkie: `Name.omarkie-conflict-<date>-<time>-<origin>.md`, origin `disk`, `draft` or `companion`

Omarkie copies use their own name, so Syncthing's `maxConflicts` cleanup never deletes them. The file tree marks both kinds. Opening a copy links back to its note, or offers **Restore as "Name.md"** when the note is gone.

Scope: the desktop compares Markdown notes. `.base`, `.canvas` and photos get the same rule from the sync app itself (conflict copy, never a silent overwrite); open the copy and the original side by side to merge them.

## Syncthing setup

Peer to peer, no account, no cloud. One folder = one vault.

1. Install Syncthing on each computer (`syncthing` package on Linux; the official installers on Windows and macOS).
2. Android: the official app is discontinued (archived December 2024). Use **Syncthing-Fork** from F-Droid.
3. iOS: no Syncthing client from the project. Use the [phone companion](#phone-companion) with import and export instead.
4. In the Syncthing web UI (`http://127.0.0.1:8384`), on every device:
   - **Settings → General → Anonymous Usage Reporting**: Disabled.
   - **Settings → Connections**: turn off **Global Discovery** and **Enable Relaying**. Keep **Local Discovery** only on a trusted network.
   - Add each peer by device ID with an explicit address, e.g. `tcp://192.168.1.20:22000`, not `dynamic`.
5. Share the vault folder with the peers. **File Versioning**: **Trash Can** (keeps replaced and deleted files in `.stversions`) or **Staggered** for a timeline.
6. Add `.stignore` in the vault root so machine-local files stay put:

   ```text
   .*.tmp
   .omarkie/writer.lock
   .omarkie/journal.lock
   ```

   `.*.tmp` covers Omarkie's atomic-save temp files. Syncthing already skips its own `.syncthing.*.tmp`.

Rules:

- One sync engine per folder. Do not also run [git sync](git-sync.md), Drive or Nextcloud on the same vault.
- Do not put patient or other regulated data in a synced vault.
- Close Omarkie on one device before a big reorganisation on another; renames are followed, but only for notes that match by hash.

### Restore from a versioned copy

1. Syncthing web UI → the folder → **Versions**, or open `.stversions/` in the vault.
2. Pick the version, restore it (or copy it beside the note under a new name).
3. In Omarkie the restored file arrives as a disk change. With a draft open you get **Compare versions**; nothing is lost either way.

## Phone companion

The browser build doubles as an offline phone companion (installable PWA). It keeps one vault in the browser's storage on that device.

- **Phone companion** button (phone icon, bottom bar) → **Import folder…** or **Import .zip…**. Notes and photos are copied in; other files are skipped and counted.
- After the first load it works offline: open, read, search (Ctrl/Cmd+Shift+F), edit, save. A draft survives the browser being suspended or killed.
- **Export changes** downloads a `.zip` of the notes changed since the last export, each named `Name.omarkie-conflict-<date>-<time>-companion.md`. Unzip it into the desktop vault: nothing is overwritten, and the desktop offers **Compare versions** for each.
- **Remove from this device** deletes the vault from the browser. Open notes come back as unsaved drafts, not as a broken folder.
- No account, no server, no background sync. The companion sends nothing anywhere; import and export are always a deliberate action.

Install: serve the built `dist/` over HTTPS (or `localhost`), open it on the phone, **Add to Home screen**. The service worker caches the whole app on first load.

## Proof

- `tests/folder-sync-conflicts.test.mjs`: two isolated synthetic vaults exchange Syncthing-style changes (rename a note, update a `.base`, move a `.canvas`, copy a photo, delete). Every loser is a conflict copy or a versioned file; hashes converge; nothing is decided by mtime.
- `tests/folder-sync-desktop.mjs`: the desktop app with a dirty draft, a replaced file, a Syncthing conflict copy, a delete and a move; English and Spanish; no network request.
- `tests/companion-browser.mjs`: companion import, offline reopen through the service worker, search, suspend-safe draft, export as conflict copies, clean removal; no outbound request.
