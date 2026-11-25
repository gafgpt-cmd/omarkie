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
- Each journal line is one change: `{opId, op, magnetId, field, value, hlc, device}`. `opId` is deterministic (device + clock + op + magnet + field), so a duplicated line from a union merge or a sync copy applies once. Lines are appended and fsynced one by one. A half-written last line is ignored on open. `field: "anchor"` holds the versioned landmark stack; see `glass-anchors.md`.
- Conflicts resolve per field by hybrid logical clock (time + counter + device), not wall time. Clocks compare at fixed width, so a legacy short clock keeps its order without being rewritten.
- `op: "delete"` is a tombstone with `op: "restore"` as its undo. The newest delete or restore wins, so an older device merging a late delete cannot resurrect a note the user already undid, and a field edit never clears a tombstone. Unknown operation kinds are kept and ignored, never rewritten.
- A repeated `opId` with a different payload is quarantined whole: neither copy is applied, the lines stay on disk, and the open reports the count and logs it. A line that does not parse is quarantined the same way, including mid-file.
- `.gitattributes` gives git a line union merge for every JSONL file, so two devices can both keep their lines. Union is only transport: dedupe, HLC order and tombstones all happen in the reader.

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
- Every append checks the byte count returned by the write. A short write (a full disk can return fewer bytes with no exception) is a failure: the file is truncated back to the last complete line, the operation stays queued, and the status says the change was not saved. A torn line is never left behind.
- A partial append is rolled back to the previous complete line before retry.
- Crash or `kill -9`: the next open ignores the incomplete tail and repairs it before the next append. An unparsable line anywhere else is quarantined, not applied.
- Saving later works without restarting Omarkie.

## Sticky notes

- In Learning mode, press `G` to show Glass. Select the sticky-note tool, then click a paragraph, or press `N`.
- Drag the top grip to move. Drag a right or bottom edge to resize.
- Pick a colour, fold to a dot, or delete. Open the pencil-case trash to undo.
- On a focused note: `Enter` edits, `F` folds, `Delete` trashes, `Esc` exits editing.
- G19 scale gap: a local 203-sticky test took 152 ms on its first open against the 100 ms target. Warm runs took 34–41 ms.

## Pictures

A glass image is a photo magnet: it anchors to one paragraph like a sticky note and never writes the `.md`.

- Drop a file on the page, paste a copied picture, or use the pencil case Image tool. With Glass on, Learning mode hands file drops to the glass; its own image scraps are the legacy form, imported the first time a note's glass is listed.
- Original bytes stay untouched in `.omarkie/assets/<note> ~<id>/<human name>.<ext>`. Big photos (over 2 MB, 12 MP or 2400 px) also get `<name> ~display.webp`, so the page never decodes the original while scrolling. HEIC and TIFF need an external converter (`OMARKIE_IMAGE_CONVERT` or `image-convert` in app data) for that light copy; without one the magnet shows its file name.
- Chromium decodes EXIF orientation, so a phone photo keeps its upright aspect.
- Move: drag the picture. Free modes save x and y offsets from the paragraph; wrap modes re-anchor to the paragraph under the pointer when dropped.
- Resize: drag the corner handle, hold Shift to keep the ratio. Rotate: drag the round handle above the frame, Shift snaps to 15°.
- Wrap: left or right pushes the paragraph text aside with a real CSS float, capped at 60% of the measure so a readable column stays beside it; behind paints the picture under the page text and keeps its frame as the handle; in front paints above the text.
- Washi tape is decorative and rotates with the picture. Lock makes it refuse every gesture; unlock to move again.
- On a selected picture: `Delete` trashes it, `L` locks, `T` toggles tape, `[` and `]` turn 15°, arrows nudge (Shift arrows resize on free modes).
- The pencil-case trash restores it. Bytes are never removed by delete; the magnet's trash state is a journal tombstone.
- The renderer asks for bytes lazily near the viewport and caches one copy per magnet per session. No network.
- Limits: 64 MB per file, 48–4000 px per side, rotation ±360°.

## Pen, highlighter and eraser

- In Learning mode, press `G`, then Pen (`P`), Highlighter (`H`) or Eraser (`E`).
- Pen: three widths, three colours. Highlighter: chisel nib, translucent, multiplies under the text. Eraser: bite (partial) or whole stroke. Undo/redo per stroke in the pencil case; one bite is one undo step.
- A stroke splits per element box (paragraph, list item, table cell, formula, code block) and each part stays glued to its box through edits, reflow and scrolling. Margin doodles anchor to the nearest element.
- Pressure widens the nib. With a stylus present, fingers and palms leave no marks; a mouse works too.
- The page is never written; strokes live in the glass journal.
- Live ink repaints at most once per frame. Dense settled pen strokes share a bounded bitmap; translucent marks keep their SVG blending.

Agents read ink as SVG paths in percent of the anchored element box:

```sh
omarkie-axi glass ink list --note notes/map.md
omarkie-axi glass ink list --note notes/map.md --full
omarkie-axi glass ink delete --note notes/map.md --magnet m-6f2a1c
```

Each listed part names its `box`, the element it follows (`element.id`, `element.kind`, `element.line`), and the path in the box's own coordinates.

## Stickers and arrows

- Sticker tool: pick a built-in mark (star, check, cross, warning, question, heart, 1–9, emoji) or choose a custom PNG/JPEG/WebP/GIF under 300 KB, then click a paragraph.
- Stickers are paper on the Notes & stickers layer: drag to move, drag the corner grip to scale, turn with the circular handle, `Delete` or the × to trash.
- Arrow tool: drag from a paragraph or sticker to another. Both ends stay anchored, so edits and reflow re-route the line.
- Selected arrows offer straight/curved, ink/red/blue/green, solid/open/no head, a label, and delete. Dragging an end near the viewport edge scrolls the page.
- When the other end is off-screen, the arrow ends in a labelled jump chip; click it to scroll there.
- Agent parity: `omarkie-axi glass add --note <note.md> --kind sticker --sticker star --near <quote> --magnet m-star`, or `--kind arrow --from element:<id> --to magnet:<id> --style curved --color red --head open --label "dose → mechanism"`.

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
omarkie-axi glass add --note notes/map.md --kind image --file photos/harbour.png --near "Closely spaced contour lines" --wrap right
omarkie-axi glass edit --note notes/map.md --magnet m-6f2a1c --wrap behind --tape --lock
omarkie-axi glass move --note notes/map.md --magnet m-6f2a1c --x 64 --y 24 --rot -8
omarkie-axi glass move --note notes/map.md --magnet m-6f2a1c --x 403 --y 391 --snap --grid 16
```

A sticky note or picture anchors to the one paragraph holding `--near`; x and y are offsets from that paragraph, so the magnet follows it through edits and reflow. `--wrap` takes `left`, `right`, `behind` or `front`; `--tape`, `--lock`, `--rot` change a picture. Every CLI change reaches an open glass immediately. `--snap` runs the app's own guide rules on what a note can measure offline — the grid (`--grid 8|16|24|0`) and the magnets on the same paragraph — and returns the guides it used; the rendered text column and line glue are applied by the app on a real drag.

The verbs need the vault open in Omarkie, because Omarkie is the only writer.

## Moves, folders and drives

The vault's Markdown structure is owned by the vault, not by glass. A watcher sees moves and the next scan reconciles them.

- A single note moved to another folder keeps its id and journals; `notes.jsonl` gets one `move` line.
- A renamed folder that holds many notes gets one `folder old/ -> new/` line, not one line per note.
- A copy-then-delete move is treated like a sync tool: wait for the folder to go quiet, then pair it once.
- A move made while Omarkie was closed is paired on the next open by hash, then by name and heading shape.
- mtime is only a hint. On FAT/exFAT, where timestamps are loose, the hash decides; name matching folds NFC and case on drives that need it.
- Glass that cannot be paired goes to the lost-glass list. It is never deleted.
- The index lives at `~/.cache/omarkie/<vault-id>/index.db`, never in the vault, and can be rebuilt at any time.

`notes.jsonl` and the per-note journals are the truth. The index only answers search and move questions faster.

```sh
omarkie-axi vault map              # counts per kind, biggest folders, unindexed files, lost glass
omarkie-axi find "dose units"      # note text and glass magnets
omarkie-axi glass finder           # glass this computer knows from other folders
omarkie-axi glass bring --note notes/map.md
```

Opening another vault that contains notes this computer already has glass for shows a banner; **Bring glass** copies the known journals into that vault.

## Privacy and backups

Glass journals are plain files inside the vault, so the vault's existing git, Syncthing, Drive or backup setup carries them. The local index and previews live in Omarkie's cache, outside the vault, and can always be rebuilt. No network request is made for storage.

Secrets never live in `.omarkie/`: that folder syncs to every device and backup. A future sync token belongs in the OS keychain, and the app refuses to open a store whose settings carry one.
