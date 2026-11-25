# Glass storage

Glass lives beside a vault, never inside its notes. The first glass change may add one hidden folder; merely opening a vault adds nothing. Notes, attachments, `.obsidian/` and their timestamps stay untouched. Deleting `.omarkie/` restores the folder exactly.

## Layout

```
My Vault/
└─ .omarkie/                              the only added folder
   ├─ README.md                           one line per item
   ├─ settings.json                       vault id and storage mode
   ├─ notes.jsonl                         id ↔ vault-relative path ↔ fingerprint
   ├─ .gitattributes                      *.jsonl merge=union
   ├─ writer.lock                         one writer's host and pid
   ├─ glass/
   │  └─ Note title ~a1b2c3.jsonl          one append-only journal per note with glass
   └─ assets/
      └─ Note title ~a1b2c3/              that note's glass images
```

- One journal per note, flat, even for 50,000 notes. The short id decides identity; the title is for people and is sanitized for Windows and exFAT (NFC, no `<>:"/\|?*`, no reserved names like `CON`, at most 120 bytes).
- Each journal line is one change: `{op, magnetId, field, value, hlc, device}`. Lines are appended and fsynced one by one. A half-written last line is ignored on open.
- Conflicts resolve per field by hybrid logical clock (time + counter + device), not wall time.
- `op: "delete"` is a tombstone with `op: "restore"` as its undo. The newest delete or restore wins, so an older device merging a late delete cannot resurrect a note the user already undid. Unknown operation kinds are kept and ignored, never rewritten.
- `.gitattributes` gives git a line union merge for every JSONL file, so two devices can both keep their lines.

## Modes

| Mode | When | Where |
| --- | --- | --- |
| Inside | Default; the vault is writable | `<vault>/.omarkie/` |
| Outside | Read-only vault, or a vault that already has an outside store | Omarkie app data, `glass-vaults/<vault-id>/`, same layout |

The vault id in `settings.json` identifies the vault if its path changes. Outside mode records the vault path in app data so the next open finds the same store; an existing outside store stays outside after the vault becomes writable, so glass never seems to disappear. A registry file is a convenience only; the journals are the truth.

## One writer

`writer.lock` holds the host, process id and a random token. A second Omarkie window on the same vault opens read-only and says so; it reads journals but never writes. Closing the owner removes its own lock. A lock from a dead process on the same host is reclaimed.

## Failure behavior

- Disk full or any append error: the operation stays in memory, status reports the error and pending count, and the same line is retried with backoff. No existing byte is truncated.
- A partial append is rolled back to the previous complete line before retry.
- Crash or `kill -9`: the next open ignores the incomplete tail and repairs it before the next append.
- Saving later works without restarting Omarkie.

## Renderer and agents

The Electron main process owns one `GlassService` per open vault. The renderer calls `window.desktop.glass({action})` and subscribes to `window.desktop.onGlassStorage(status)` for read-only, disk-full and recovery notices.

Agents use the same service through the local bridge:

```sh
omarkie-axi glass add --note notes/map.md --kind sticky --near "Closely spaced contour lines" --text "Steep here" --color rose
omarkie-axi glass move --note notes/map.md --magnet m-6f2a1c --x 64 --y 24
omarkie-axi glass edit --note notes/map.md --magnet m-6f2a1c --text "Steep here" --folded
omarkie-axi glass delete --note notes/map.md --magnet m-6f2a1c
omarkie-axi glass restore --note notes/map.md --magnet m-6f2a1c
omarkie-axi glass list --note notes/map.md
omarkie-axi glass show --note notes/map.md --magnet m-6f2a1c
omarkie-axi glass status
```

A sticky note anchors to the one paragraph holding `--near`; x and y are offsets from that paragraph, so the note follows it through edits and reflow. Every CLI change reaches an open glass immediately.

The verbs need the vault open in Omarkie, because Omarkie is the only writer.

## Privacy and backups

Glass journals are plain files inside the vault, so the vault's existing git, Syncthing, Drive or backup setup carries them. The local index and previews live in Omarkie's cache, outside the vault, and can always be rebuilt. No network request is made for storage.
