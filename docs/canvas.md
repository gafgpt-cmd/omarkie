# Canvas boards

`.canvas` files in the open folder, in the [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/) format Obsidian uses.

- Open: **Display → Canvas boards…**, or **Papercut board** in the Learning rail (reopens the board used last in the folder).
- Cards: text (Markdown), note (live, optional `#Heading` subpath), link, group. Edges keep sides, ends, colour, label.
- Save: after a short pause; closing flushes. Writes are atomic and check the file hash first.
- Off until opened: the board UI is a lazy chunk; no `.canvas` read at startup.

## Round-trip rules

| Kept as is | How |
|---|---|
| ids, node/edge order, geometry, colours, subpaths | written back unchanged |
| unknown fields on canvas, nodes, edges | carried through |
| unknown node types | board opens read-only |
| edges to missing cards | hidden, kept in the file |

Viewport lives in local storage, not in the file.

## Keyboard

| Key | Does |
|---|---|
| Tab, Enter / Space | focus, select a card |
| Arrows (Shift = 4 steps) | move selected cards one grid step; one undo step each |
| Enter / F2 | edit the selected text card or group name |
| Ctrl+Enter | new text card |
| Ctrl+G / Ctrl+L | group selection / connect first to second selected |
| Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y | undo, redo |
| Delete | remove selection |
| Escape | close (nothing selected) |

## Outside edits

- Clean board: window focus reloads it from disk.
- Unsaved edits: banner offers keep mine, load disk, or save mine as a copy. Nothing is overwritten silently.

## Papercut clips

- Learning selection → **Clip to board**: a text card `> quote` plus `Snapshot · [[note#Heading|…]]`. Obsidian follows the link.
- Source kept in `x-omarkie-clip` (`file`, `quote`, `line`, `heading`): an unknown field, so other apps keep it.
- Snapshot never changes. Note edited so the words are gone: **Source moved** chip; jump to source refuses.
- **Heading to board**: a live note card on that section; it follows the note.
- **Ask Tutor**: user-triggered only. A preview shows exactly the selected clips first. No Tutor state in the `.canvas`.

## Offline

- Link cards render URL text only; no fetch, no favicon, no preview.
- Desktop test (`tests/canvas-desktop.mjs`) asserts zero HTTP(S) requests through open, clip, edit, reload, conflict, jump and Tutor preview.

## Dependency: @xyflow/react

Installed npm dependency, not vendored or ported. Adoption gate:

| Package | Version | Licence | Install script |
|---|---|---|---|
| @xyflow/react | 13.0.3 (exact pin) | MIT | none |
| @xyflow/system | 1.0.1 | MIT | none |
| zustand (nested) | 5.1.0 | MIT | none |
| classcat | 5.0.5 | MIT | none |
| react-compiler-runtime | 1.0.0 | MIT | none |
| d3-drag, d3-selection, d3-zoom, d3-interpolate, d3-transition | 3.x | ISC | none, already in tree |

- Egress: only URLs in the code are `reactflow.dev` help/attribution strings; never fetched.
- Attribution badge hidden (`proOptions.hideAttribution`, allowed by the MIT licence); credited here.
- No telemetry or phone-home in the package.
- Update owner: whoever bumps the pin re-runs `tests/canvas-desktop.mjs` and the egress grep.
