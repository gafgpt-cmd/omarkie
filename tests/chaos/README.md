# Daily-life chaos suite (G23)

One run per daily-life failure the study tables list. Every row gets a real vault, a real `GlassService`, and asserts on files, not pixels.

## Run

```sh
node tests/chaos/run.mjs --group js           # unprivileged, every machine and CI
node tests/chaos/run.mjs --group fuse         # needs /dev/fuse + fuse3 headers + gcc
node tests/chaos/run.mjs --group regressions  # heavy note, copy without hidden files, cross-vault moves
node tests/chaos/run.mjs --group drives       # needs root: loop device + mount + mkfs
node tests/chaos/run.mjs --only 1,3,11        # pick rows
node tests/chaos/run.mjs --group fuse --json out.json
```

`js` and `regressions` are separate groups; the CI job runs both.

## Groups

| Group | Needs | Rows |
|---|---|---|
| `js` | node only | 1, 2, 3, 4–10, 13–17, 19–25, 26–28, 30, 31, 35 |
| `fuse` | `/dev/fuse`, `fusermount3`, `gcc`, `pkg-config fuse3` | 2, 3, 11, 12, 36 |
| `regressions` | node only | 18 (cross-ref), 25, 27, 28 |
| `drives` | root, `losetup`, `mount`, `mkfs.vfat`, `mkfs.exfat`, `mkfs.ntfs` (or `ntfs-3g`) | 26, 29, 30, 32, 33, 34, 37 |

`tests/chaos/fuse/faultfs.c` is the local FUSE helper: passthrough with ENOSPC byte budget, EIO on the second write, EIO on page renames, and per-op delay. Built on demand into a scratch dir, never committed as a binary.

## Row map

| # | Situation | Where | Proof |
|---|---|---|---|
| 1 | `kill -9` mid-save, 50 trials | `rows/journal.mjs` | zero unparsable complete lines, one tail at most |
| 2 | power cut mid Merge down | `rows/fuse.mjs` (rename EIO), `rows/merge.mjs` (kill child) | page old-or-complete, automatic undo |
| 3 | disk full | `rows/journal.mjs` (short write), `rows/fuse.mjs` (byte budget) | rollback, queue, replay |
| 4 | external edit while open | `rows/vault.mjs` | one reload, stale merge refused |
| 5 | plugin rewrite burst | `rows/vault.mjs` | batched, no journal write |
| 6 | two instances | `rows/vault.mjs` | second read-only, host+pid, no writes |
| 7 | sync conflict copies | `rows/merge.mjs` | union merge, dedupe, moved to `merged/` |
| 8 | git union merge | `rows/merge.mjs` | zero `<<<<<<<`, dedupe by op id |
| 9 | wrong clock | `rows/vault.mjs` | HLC order kept, skew marked |
| 10 | note deleted then restored | `rows/vault.mjs` | lost glass, re-attach by fingerprint |
| 11 | vault unmounts mid-write | `rows/fuse.mjs`, `rows/vault.mjs` | queue + banner, replay, no partial line |
| 12 | read-only vault | `rows/fuse.mjs` (`-o ro`) | outside mode, zero writes inside |
| 13 | laptop sleep | `rows/vault.mjs` | one rescan on wake |
| 14 | NFD vs NFC, case-only rename | `rows/vault.mjs` | one note, one journal |
| 15 | weird titles | `rows/vault.mjs` | portable journal names ≤120 bytes |
| 16 | symlinks and loops | `rows/vault.mjs` | loop ends, symlinked note refused |
| 17 | HEIC photo | `rows/merge.mjs` | original hash kept |
| 18 | screen, zoom, theme | `rows/regressions.mjs` → `tests/glass-visual-desktop.mjs` | ratio geometry in the desktop suite |
| 19 | AI offline | `rows/agents.mjs` | fail fast, ops <50 ms p95, retry works |
| 20 | 500 agent proposals | `rows/agents.mjs` | page untouched until Accept |
| 21 | never-online vault | `rows/agents.mjs` | gate denies, glass in a network namespace with no interfaces |
| 22 | newer-build op | `rows/journal.mjs` | unknown line byte-identical |
| 23 | export | `rows/merge.mjs` | every magnet id exported |
| 24 | restore from backup | `rows/merge.mjs` | same ids, cache not required |
| 25 | 5 000 lines, 200 magnets | `rows/regressions.mjs` | no cost growth with magnet count |
| 26 | vault to a stick | `rows/drives.mjs` (exFAT), `rows/vault.mjs` | same vault id, same manifest |
| 27 | copy without hidden files | `rows/regressions.mjs`, `rows/drives.mjs` | offer from the old vault, no writes on the drive |
| 28 | one note changes vault | `rows/regressions.mjs` | lost glass + offer, nothing deleted |
| 29 | drive on another computer (NFD) | `rows/drives.mjs` (vfat) | one note, one journal |
| 30 | unplug, replug elsewhere | `rows/drives.mjs`, `rows/vault.mjs` | pause, replay, recognised at new path |
| 31 | hand the vault over | `rows/merge.mjs` | clean profile restores, Obsidian sees only `map.md` |
| 32 | FAT name traps | `rows/drives.mjs` | portable names, clean refusals |
| 33 | case-insensitive drive | `rows/drives.mjs`, `rows/vault.mjs` | one note after case-only rename |
| 34 | FAT 2 s stamps | `rows/drives.mjs`, `rows/vault.mjs` | content decides the change |
| 35 | no live events | `rows/vault.mjs` | polling + focus rescan |
| 36 | slow stick | `rows/fuse.mjs` | index on host disk, ops bounded |
| 37 | FAT32 limits and symlinks | `rows/drives.mjs` | no media copy, symlink ignored, 5 GB refused by the FS |

## Known limits

- Rows 26–37 need root. No unprivileged loop devices on any OS (study M12). The `drives` CI job runs them on a sudo-capable runner; on a runner without passwordless sudo it prints the requirement and skips.
- Queued glass ops live in memory. A hard quit while the vault is offline loses ops not yet flushed; the banner and the retry loop cover a drive that comes back in the same session. Persisting the queue is a design decision, not a bug fix.
- Row 18 is proven by `tests/glass-visual-desktop.mjs`; the chaos row only checks that coverage still exists.
- FUSE rows skip with the exact missing requirement; `--strict` turns skips into failures.
- Row 5 asserts at most two batches for a burst that completes inside 2 s. On a slow disk the burst itself takes longer, so the bound becomes one batch per 400 ms (still coalescing, never per-event work); the observed count is in the evidence table.
